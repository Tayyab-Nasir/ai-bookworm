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

export function adminRoutes(app: FastifyInstance) {
  app.adminRoutes((a) => {
    // ---- users -------------------------------------------------------------
    a.get("/admin/users", async (req) => {
      const q = pagination.extend({ search: z.string().trim().max(200).optional() }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let profQ = svc.from("profiles").select("*").order("created_at", { ascending: false });
      if (q.search) profQ = profQ.or(`display_name.ilike.%${q.search}%,id.eq.${q.search}`);
      const { data: profiles, error } = await profQ.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(500, error.message);
      const ids = (profiles ?? []).map((p: { id: string }) => p.id);
      const { data: memberships } = ids.length
        ? await svc.from("organization_members").select("*").in("user_id", ids)
        : { data: [] };
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
    const JOB_TABLES: Record<string, string> = { ai: "ai_jobs", publishing: "publishing_jobs" };

    a.get("/admin/jobs", async (req) => {
      const q = pagination.extend({
        type: z.enum(["ai", "publishing"]).default("ai"),
        status: z.string().max(40).optional(),
      }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let jq = svc.from(JOB_TABLES[q.type]).select("*").order("created_at", { ascending: false });
      if (q.status) jq = jq.eq("status", q.status);
      const { data, error } = await jq.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(500, error.message);
      return { jobs: data ?? [], type: q.type, limit: q.limit, offset: q.offset };
    });

    a.post("/admin/jobs/:type/:id/retry", async (req) => {
      const { type, id } = req.params as { type: string; id: string };
      const table = JOB_TABLES[type];
      if (!table) throw new AppError(422, "type must be ai|publishing");
      const svc = app.supabaseFactory();
      const { data: job } = await svc.from(table).select("id,status,attempts").eq("id", id).maybeSingle();
      if (!job) throw new AppError(404, "job not found");
      const j = job as { status: string; attempts?: number };
      if (j.status !== "failed" && j.status !== "dead") throw new AppError(422, "only failed/dead jobs can retry");
      const { data, error } = await svc
        .from(table)
        .update({ status: "queued", attempts: (j.attempts ?? 0) + 1, error_code: null, error_message: null, started_at: null, completed_at: null })
        .eq("id", id)
        .select()
        .single();
      if (error) throw new AppError(500, error.message);
      await logAdminAudit(svc, { actorId: req.userId, action: "job.retry", entityType: `${type}_job`, entityId: id });
      return { job: data };
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
      const parsed = z.object({
        scopeType: z.string().max(40).default("global"),
        scopeId: z.string().max(120).nullable().default(null),
        enabled: z.boolean(),
        config: z.record(z.unknown()).default({}),
      }).safeParse(req.body ?? {});
      if (!parsed.success) throw new AppError(422, "invalid flag", { issues: parsed.error.issues });
      const svc = app.supabaseFactory();
      const { data, error } = await svc
        .from("feature_flags")
        .upsert({
          key, scope_type: parsed.data.scopeType, scope_id: parsed.data.scopeId,
          enabled: parsed.data.enabled, config_json: parsed.data.config,
        }, { onConflict: "key,scope_type,scope_id" })
        .select()
        .single();
      if (error) throw new AppError(500, error.message);
      await logAdminAudit(svc, {
        actorId: req.userId, action: "flag.update", entityType: "feature_flag", entityId: key,
        after: { enabled: parsed.data.enabled },
      });
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
      const patch: Record<string, unknown> = { status: parsed.data.status };
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
