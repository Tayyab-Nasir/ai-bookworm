import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { logAdminAudit } from "../lib/admin.js";

// All routes run behind plugins/admin.ts requireAdmin and use the
// service-role client (bypasses RLS): admin-only by construction.

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const documentJobView = z.object({
  id: z.string().uuid(), book_id: z.string().uuid(), source_asset_id: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  attempts: z.number().int().min(0).max(5), error_code: z.string().max(80).nullable(),
  created_at: z.string(), available_at: z.string(), completed_at: z.string().nullable(),
}).strip();
const aiJobView = z.object({
  id: z.string().uuid(), book_id: z.string().uuid().nullable(), agent_type: z.string().min(1).max(100),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), attempts: z.number().int().min(0),
  error_code: z.string().max(80).nullable(), error_message: z.string().max(2_000).nullable(), model: z.string().max(200).nullable(),
  usage_json: z.record(z.unknown()), created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
}).strip();

export function adminRoutes(app: FastifyInstance) {
  app.adminRoutes((a) => {
    a.get("/admin/access", async () => ({ admin: true }));
    // ---- users -------------------------------------------------------------
    a.get("/admin/users", async (req) => {
      const q = pagination.extend({ search: z.string().trim().max(200).optional() }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let profQ = svc.from("profiles").select("*").order("created_at", { ascending: false });
      if (q.search) {
        profQ = z.string().uuid().safeParse(q.search).success
          ? profQ.eq("id", q.search)
          : profQ.ilike("display_name", `%${q.search.replace(/[\\%_]/g, "\\$&")}%`);
      }
      const { data: profiles, error } = await profQ.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(500, error.message);
      const ids = (profiles ?? []).map((p: { id: string }) => p.id);
      const { data: memberships, error: membershipError } = ids.length
        ? await svc.from("organization_members").select("*").in("user_id", ids)
        : { data: [], error: null };
      if (membershipError) throw new AppError(500, "Unable to load user memberships");
      return { users: profiles ?? [], memberships: memberships ?? [], limit: q.limit, offset: q.offset };
    });

    a.post("/admin/users/:id/suspend", async (req) => {
      const { id } = req.params as { id: string };
      const svc = app.supabaseFactory();
      const { data, error } = await svc
        .from("organization_members")
        .update({ status: "suspended" })
        .eq("user_id", id)
        .select();
      if (error) throw new AppError(500, error.message);
      await svc.from("workspace_members").update({ status: "suspended" }).eq("user_id", id);
      await logAdminAudit(svc, {
        actorId: req.userId, action: "user.suspend", entityType: "user", entityId: id,
        after: { suspendedMemberships: (data ?? []).length },
      });
      return { userId: id, suspended: true, memberships: (data ?? []).length };
    });

    // ---- jobs ---------------------------------------------------------------
    const JOB_TABLES: Record<string, string> = {
      ai: "ai_jobs", publishing: "publishing_jobs", document: "manuscript_import_jobs",
    };
    const DOCUMENT_JOB_COLUMNS = "id,book_id,source_asset_id,status,attempts,error_code,created_at,available_at,completed_at";
    const AI_JOB_COLUMNS = "id,book_id,agent_type,status,attempts,error_code,error_message,model,usage_json,created_at,started_at,completed_at";

    a.get("/admin/jobs", async (req) => {
      const q = pagination.extend({
        type: z.enum(["ai", "publishing", "document"]).default("ai"),
        status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
      }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let jq = svc.from(JOB_TABLES[q.type])
        .select(q.type === "document" ? DOCUMENT_JOB_COLUMNS : q.type === "ai" ? AI_JOB_COLUMNS : "*")
        .order("created_at", { ascending: false });
      if (q.status) jq = jq.eq("status", q.status);
      const { data, error } = await jq.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(500, error.message);
      const jobs = q.type === "document"
        ? z.array(documentJobView).parse(data ?? [])
        : q.type === "ai"
          ? z.array(aiJobView).parse(data ?? [])
        : data ?? [];
      return { jobs, type: q.type, limit: q.limit, offset: q.offset };
    });

    a.get("/admin/jobs/document/health", async () => {
      const svc = app.supabaseFactory();
      const { data, error } = await svc.rpc("get_manuscript_import_health");
      if (error?.code === "PGRST202" || error?.code === "42883") {
        throw new AppError(503, "Document queue health migration is not installed.");
      }
      if (error) throw new AppError(500, "Could not load document queue health.");
      const health = Array.isArray(data) ? data[0] : data;
      if (!health) throw new AppError(500, "Document queue health is unavailable.");
      return { health };
    });

    a.post("/admin/jobs/:type/:id/retry", async (req) => {
      const { type, id } = req.params as { type: string; id: string };
      if (!JOB_TABLES[type]) throw new AppError(422, "type must be ai|publishing|document");
      if (type === "document") throw new AppError(503, "Retry document imports from the owning book setup screen.");
      if (type === "ai") throw new AppError(503, "AI retry is not available. Start a new review from the saved manuscript.");
      const svc = app.supabaseFactory();
      if (!z.string().uuid().safeParse(id).success) throw new AppError(422, "Invalid publishing job ID.");
      const { data, error } = await svc.rpc("retry_publishing_job", { p_job_id: id, p_actor_id: req.userId });
      if (error?.code === "P0002") throw new AppError(404, "Job not found.");
      if (error?.code === "22023") throw new AppError(422, "Only failed, supported publishing jobs can retry.");
      if (error?.code === "PGRST202" || error?.code === "42883") throw new AppError(503, "Publishing worker migration is not installed.");
      if (error) throw new AppError(500, "Could not queue publishing retry.");
      return { job: Array.isArray(data) ? data[0] : data };
    });

    a.post("/admin/jobs/ai/:id/release-image-hold", async (req, reply) => {
      const id = z.string().uuid().safeParse((req.params as { id: string }).id);
      const body = z.object({ incidentRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{5,63}$/),
        storageChecked: z.literal(true), providerReviewed: z.literal(true) }).strict().safeParse(req.body);
      if (!id.success || !body.success) throw new AppError(422, "Provide an incident reference and confirm both review checks.");
      const svc = app.supabaseFactory();
      const { data, error } = await svc.rpc("release_unconfirmed_image_job", {
        p_job_id: id.data, p_actor_id: req.userId, p_incident_ref: body.data.incidentRef,
        p_storage_checked: true, p_provider_reviewed: true,
      });
      if (error?.code === "P0002") throw new AppError(404, "Image request not found.");
      if (error?.code === "22023") throw new AppError(409, "This image request cannot be released. Review its age, output, receipt and debit again.");
      if (error?.code === "PGRST202" || error?.code === "42883") throw new AppError(503, "Image hold release migration is not installed.");
      if (error) throw new AppError(503, "Image hold release was not confirmed. Refresh the job and audit record before retrying.");
      if (!z.object({ id: z.literal(id.data), status: z.literal("failed") }).passthrough().safeParse(data).success) {
        throw new AppError(503, "Image hold release reply was invalid. Refresh the job and audit record before retrying.");
      }
      reply.header("cache-control", "private, no-store");
      return { jobId: id.data, status: "failed" as const, incidentRef: body.data.incidentRef };
    });

    a.post("/admin/jobs/ai/:id/release-review-hold", async (req, reply) => {
      const id = z.string().uuid().safeParse((req.params as { id: string }).id);
      const body = z.object({ incidentRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{5,63}$/),
        receiptReviewed: z.literal(true), providerReviewed: z.literal(true) }).strict().safeParse(req.body);
      if (!id.success || !body.success) throw new AppError(422, "Provide an incident reference and confirm receipt and provider review.");
      const svc = app.supabaseFactory();
      const { data, error } = await svc.rpc("release_unconfirmed_ai_review_job", {
        p_job_id: id.data, p_actor_id: req.userId, p_incident_ref: body.data.incidentRef,
        p_receipt_reviewed: true, p_provider_reviewed: true,
      });
      if (error?.code === "P0002") throw new AppError(404, "AI review request not found.");
      if (error?.code === "22023") throw new AppError(409, "This AI review cannot be released. Recheck its receipt, age, output and debit.");
      if (error?.code === "PGRST202" || error?.code === "42883") throw new AppError(503, "AI review hold release migration is not installed.");
      if (error) throw new AppError(503, "AI review hold release was not confirmed. Refresh the job and audit record before retrying.");
      if (!z.object({ id: z.literal(id.data), status: z.literal("failed"),
        error_code: z.literal("ai_review_hold_released") }).passthrough().safeParse(data).success) {
        throw new AppError(503, "AI review hold release reply was invalid. Refresh the job and audit record before retrying.");
      }
      reply.header("cache-control", "private, no-store");
      return { jobId: id.data, status: "failed" as const, incidentRef: body.data.incidentRef };
    });

    // ---- audit ---------------------------------------------------------------
    a.get("/admin/audit", async (req) => {
      const q = pagination.extend({
        entity: z.string().max(80).optional(),
        action: z.string().max(80).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let aq = svc.from("audit_logs").select("*").order("created_at", { ascending: false });
      if (q.entity) aq = aq.eq("entity_type", q.entity);
      if (q.action) aq = aq.eq("action", q.action);
      if (q.from) aq = aq.gte("created_at", q.from);
      if (q.to) aq = aq.lte("created_at", q.to);
      const { data, error } = await aq.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(500, error.message);
      return { entries: data ?? [], limit: q.limit, offset: q.offset };
    });

    // ---- feature flags --------------------------------------------------------
    a.get("/admin/flags", async (req) => {
      const svc = app.supabaseFactory();
      const { data, error } = await svc.from("feature_flags").select("*").order("key");
      if (error) throw new AppError(500, error.message);
      return { flags: data ?? [] };
    });

    a.put("/admin/flags/:key", async (req) => {
      const { key } = req.params as { key: string };
      if (!key || key.length > 120) throw new AppError(422, "invalid flag key");
      const parsed = z.object({
        scopeType: z.string().min(1).max(40).default("global"),
        scopeId: z.string().max(120).nullable().default(null),
        enabled: z.boolean(),
        config: z.record(z.unknown()).optional(),
      }).strict().safeParse(req.body ?? {});
      if (!parsed.success) throw new AppError(422, "invalid flag", { issues: parsed.error.issues });
      const svc = app.supabaseFactory();
      const { data, error } = await svc.rpc("set_admin_feature_flag", {
        p_actor_id: req.userId, p_key: key,
        p_scope_type: parsed.data.scopeType, p_scope_id: parsed.data.scopeId,
        p_enabled: parsed.data.enabled, p_config: parsed.data.config ?? null,
      });
      if (error) throw new AppError(500, error.message);
      return { flag: data };
    });

    // ---- support tickets -------------------------------------------------------
    a.get("/admin/support", async (req) => {
      const q = pagination.extend({ status: z.string().max(40).optional() }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let tq = svc.from("support_tickets").select("*").order("created_at", { ascending: false });
      if (q.status) tq = tq.eq("status", q.status);
      const { data, error } = await tq.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(500, error.message);
      return { tickets: data ?? [], limit: q.limit, offset: q.offset };
    });

    a.post("/admin/support/:id", async (req) => {
      const { id } = req.params as { id: string };
      const parsed = z.object({
        status: z.enum(["open", "pending", "resolved", "closed"]),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      }).safeParse(req.body ?? {});
      if (!parsed.success) throw new AppError(422, "invalid ticket update", { issues: parsed.error.issues });
      const svc = app.supabaseFactory();
      const { data: ticket } = await svc.from("support_tickets").select("id").eq("id", id).maybeSingle();
      if (!ticket) throw new AppError(404, "ticket not found");
      const patch: Record<string, unknown> = { status: parsed.data.status, updated_at: new Date().toISOString() };
      if (parsed.data.priority) patch.priority = parsed.data.priority;
      const { data, error } = await svc.from("support_tickets").update(patch).eq("id", id).select().single();
      if (error) throw new AppError(500, error.message);
      await logAdminAudit(svc, {
        actorId: req.userId, action: "ticket.update", entityType: "support_ticket", entityId: id,
        after: { status: parsed.data.status },
      });
      return { ticket: data };
    });

    // ---- usage summary ---------------------------------------------------------
    // Top consumers per org. ponytail: aggregate in-process over a bounded
    // window — upgrade to a materialized view when usage_events outgrows it.
    a.get("/admin/usage/summary", async (req) => {
      const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query ?? {});
      const since = new Date(Date.now() - q.days * 86400000).toISOString();
      const svc = app.supabaseFactory();
      const { data, error } = await svc
        .from("usage_events")
        .select("organization_id,meter,quantity")
        .gte("created_at", since)
        .limit(10000);
      if (error) throw new AppError(500, error.message);
      const byOrg = new Map<string, { total: number; byMeter: Record<string, number> }>();
      for (const r of (data ?? []) as { organization_id: string | null; meter: string; quantity: number }[]) {
        const org = r.organization_id ?? "unknown";
        const e = byOrg.get(org) ?? { total: 0, byMeter: {} };
        const qty = Number(r.quantity) || 0;
        e.total += qty;
        e.byMeter[r.meter] = (e.byMeter[r.meter] ?? 0) + qty;
        byOrg.set(org, e);
      }
      const orgs = [...byOrg.entries()]
        .map(([organizationId, v]) => ({ organizationId, total: v.total, byMeter: v.byMeter }))
        .sort((a2, b2) => b2.total - a2.total)
        .slice(0, 50);
      return { days: q.days, orgs };
    });
  });
}
