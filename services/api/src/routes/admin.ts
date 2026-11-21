import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { logAdminAudit } from "../lib/admin.js";
import { recoverHeldAiReviewReceipt } from "../lib/ai-review-worker.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";

// All routes run behind plugins/admin.ts requireAdmin and use the
// service-role client (bypasses RLS): admin-only by construction.

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const publishingChecksum = z.string().regex(/^[a-f0-9]{64}$/);
const publishingDate = z.string().datetime({ offset: true });
const publishingListingUrl = z.string().max(1024).regex(/^https:\/\/[a-z0-9.]+\/[A-Za-z0-9/_~.%+?=-]+$/);
const managedPackageMaxBytes = 200 * 1024 * 1024;
const managedPackageDescriptor = z.object({
  storage_path: z.string().regex(/^workspaces\/[a-f0-9-]{36}\/assets\/[a-f0-9-]{36}\/v1\/(kdp|apple|barnesnoble|lulu|googleplay)-export\.zip$/),
  filename: z.string().regex(/^(kdp|apple|barnesnoble|lulu|googleplay)-export\.zip$/),
  package_sha256: publishingChecksum,
  size_bytes: z.number().int().min(1).max(managedPackageMaxBytes),
});
const publishingQueueEntry = z.object({
  package_job_id: z.guid(),
  channel: z.enum(["kdp", "apple", "barnesnoble", "lulu", "googleplay"]),
  title: z.string().min(1).max(500),
  package_sha256: publishingChecksum,
  requested_at: publishingDate,
  claimed_at: publishingDate.nullable(),
  confirmed_at: publishingDate.nullable(),
  listing_url: publishingListingUrl.nullable(),
});

function isPublishingOperator(userId: string) {
  const operators = (process.env.MANAGED_PUBLISHING_OPERATOR_IDS ?? "").split(",").map(value => value.trim());
  return process.env.MANAGED_PUBLISHING_ENABLED === "true" && operators.includes(userId);
}

function requirePublishingOperator(req: FastifyRequest) {
  if (process.env.MANAGED_PUBLISHING_ENABLED !== "true") throw new AppError(404, "Managed publishing is unavailable.");
  if (!isPublishingOperator(req.userId)) throw new AppError(403, "Publishing operator access is required.");
  if (req.headers["x-bookworm-actor"] !== req.userId) throw new AppError(422, "The original operator account is required.");
}
const moderationReportRow = z.object({
  id: z.guid(),
  entity_type: z.enum(["post", "comment"]),
  entity_id: z.guid(),
  reason: z.string().min(1).max(1000),
  status: z.enum(["open", "actioned", "dismissed"]),
  created_at: z.string().datetime({ offset: true }),
  resolution_action: z.enum(["remove", "dismiss"]).nullable().optional(),
}).strip();

const documentJobView = z.object({
  id: z.guid(), book_id: z.guid(), source_asset_id: z.guid(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  attempts: z.number().int().min(0).max(5), error_code: z.string().max(80).nullable(),
  created_at: z.string(), available_at: z.string(), completed_at: z.string().nullable(),
}).strip();
const aiJobView = z.object({
  id: z.guid(), book_id: z.guid().nullable(), agent_type: z.string().min(1).max(100),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), attempts: z.number().int().min(0),
  error_code: z.string().max(80).nullable(), error_message: z.string().max(2_000).nullable(), model: z.string().max(200).nullable(),
  usage_json: z.record(z.string(), z.unknown()), created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
}).strip();

export function adminRoutes(app: FastifyInstance) {
  let managedDelivery: object | null = null;
  app.adminRoutes((a) => {
    a.get("/admin/access", async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      return { admin: true, viewerId: req.userId, ...(isPublishingOperator(req.userId) ? { managedPublishing: true } : {}) };
    });
    a.get("/admin/managed-publishing", async (req, reply) => {
      requirePublishingOperator(req);
      const page = pagination.extend({ limit: z.coerce.number().int().min(1).max(50).default(50),
        offset: z.coerce.number().int().min(0).max(10_000).default(0) }).strict().safeParse(req.query);
      if (!page.success) throw new AppError(422, "Invalid publishing queue page.");
      const { limit, offset } = page.data;
      const { data, error } = await app.supabaseFactory().rpc("list_managed_publishing_queue", {
        p_operator: req.userId, p_limit: limit + 1, p_offset: offset,
      });
      const parsed = z.array(publishingQueueEntry).max(limit + 1).safeParse(data);
      if (error || !parsed.success) throw new AppError(503, "The publishing queue could not be verified.");
      reply.header("cache-control", "private, no-store");
      return {
        requests: parsed.data.slice(0, limit).map(row => ({ jobId: row.package_job_id, channel: row.channel, title: row.title,
          packageSha256: row.package_sha256, requestedAt: row.requested_at, claimedAt: row.claimed_at,
          confirmedAt: row.confirmed_at, listingUrl: row.listing_url })),
        nextOffset: parsed.data.length > limit && offset + limit <= 10_000 ? offset + limit : null,
      };
    });
    a.put("/admin/managed-publishing/:jobId/claim", async (req, reply) => {
      requirePublishingOperator(req);
      const path = z.object({ jobId: z.guid().transform(value => value.toLowerCase()) }).safeParse(req.params);
      const body = z.object({ packageSha256: publishingChecksum }).strict().safeParse(req.body);
      if (!path.success || !body.success) throw new AppError(422, "The package and its checksum are required.");
      const { jobId } = path.data;
      const { packageSha256 } = body.data;
      const { data, error } = await app.supabaseFactory().rpc("claim_managed_publishing", {
        p_job_id: jobId, p_sha256: packageSha256, p_operator: req.userId,
      });
      if (error?.code === "PT409") throw new AppError(409, "This request is no longer available to claim. Refresh the queue.");
      const receipt = publishingQueueEntry.pick({ package_job_id: true, package_sha256: true }).extend({
        claimed_by: z.guid(), claimed_at: publishingDate, withdrawn_at: z.null(),
      }).safeParse(Array.isArray(data) && data.length === 1 ? data[0] : data);
      if (error || !receipt.success || receipt.data.package_job_id !== jobId
        || receipt.data.package_sha256 !== packageSha256 || receipt.data.claimed_by !== req.userId) {
        throw new AppError(503, "The publishing assignment could not be confirmed.");
      }
      reply.header("cache-control", "private, no-store");
      return { claim: { jobId, packageSha256, claimedAt: receipt.data.claimed_at } };
    });
    a.get("/admin/managed-publishing/:jobId/package", async (req, reply) => {
      requirePublishingOperator(req);
      const path = z.object({ jobId: z.guid().transform(value => value.toLowerCase()) }).safeParse(req.params);
      const query = z.object({ checksum: publishingChecksum }).strict().safeParse(req.query);
      if (!path.success || !query.success) throw new AppError(422, "The package and its checksum are required.");
      if (managedDelivery) throw new AppError(503, "Package delivery is busy. Try again shortly.");
      const operation = {};
      managedDelivery = operation;
      const release = () => { if (managedDelivery === operation) managedDelivery = null; };
      let streaming = false;
      try {
        const signal = AbortSignal.timeout(90_000);
        const service = app.supabaseFactory(undefined, boundedSupabaseFetch(signal, fetch, managedPackageMaxBytes));
        const read = async () => {
          const { data, error } = await service.rpc("read_managed_publishing_package", {
            p_job_id: path.data.jobId, p_operator: req.userId,
          });
          if (error) throw new AppError(503, "The private package could not be verified.");
          const parsed = z.array(managedPackageDescriptor).max(1).safeParse(data);
          if (!parsed.success) throw new AppError(503, "The private package could not be verified.");
          const descriptor = parsed.data[0];
          if (!descriptor || descriptor.package_sha256 !== query.data.checksum
            || !descriptor.storage_path.endsWith("/" + descriptor.filename)) {
            throw new AppError(404, "The claimed package is unavailable.");
          }
          return descriptor;
        };
        const descriptor = await read();
        const { data, error } = await service.storage.from("book-assets").download(descriptor.storage_path);
        if (error || !data || data.size !== descriptor.size_bytes) throw new AppError(409, "The stored package could not be verified.");
        const sha = createHash("sha256");
        for await (const chunk of data.stream() as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted();
          sha.update(chunk);
        }
        if (sha.digest("hex") !== descriptor.package_sha256) throw new AppError(409, "The stored package could not be verified.");
        if (JSON.stringify(await read()) !== JSON.stringify(descriptor)) throw new AppError(409, "The claimed package changed.");
        signal.throwIfAborted();
        requirePublishingOperator(req);
        reply.header("cache-control", "private, no-store")
          .header("content-disposition", `attachment; filename="${descriptor.filename}"`)
          .header("content-length", String(descriptor.size_bytes))
          .header("x-content-type-options", "nosniff").type("application/zip");
        const stream = Readable.from(data.stream() as unknown as AsyncIterable<Uint8Array>);
        reply.raw.once("finish", release);
        reply.raw.once("close", () => { stream.destroy(); release(); });
        const response = reply.send(stream);
        streaming = true;
        return response;
      } finally {
        if (!streaming) release();
      }
    });
    a.put("/admin/managed-publishing/:jobId/confirmation", async (req, reply) => {
      requirePublishingOperator(req);
      const path = z.object({ jobId: z.guid().transform(value => value.toLowerCase()) }).safeParse(req.params);
      const body = z.object({ packageSha256: publishingChecksum, listingUrl: publishingListingUrl }).strict().safeParse(req.body);
      if (!path.success || !body.success) throw new AppError(422, "The package checksum and retailer listing URL are required.");
      const { jobId } = path.data;
      const { packageSha256, listingUrl } = body.data;
      const { data, error } = await app.supabaseFactory().rpc("confirm_managed_publishing", {
        p_job_id: jobId, p_sha256: packageSha256, p_operator: req.userId, p_listing_url: listingUrl,
      });
      if (error?.code === "22023") throw new AppError(422, "Enter a public HTTPS listing URL for this retailer.");
      if (error?.code === "PT404") throw new AppError(404, "Completed retailer package not found.");
      if (error?.code === "PT409") throw new AppError(409, "The assignment or confirmation changed. Refresh the queue.");
      const receipt = publishingQueueEntry.pick({ package_job_id: true, package_sha256: true }).extend({
        claimed_by: z.guid(), confirmed_at: publishingDate, listing_url: publishingListingUrl, withdrawn_at: z.null(),
      }).safeParse(Array.isArray(data) && data.length === 1 ? data[0] : data);
      if (error || !receipt.success || receipt.data.package_job_id !== jobId || receipt.data.package_sha256 !== packageSha256
        || receipt.data.claimed_by !== req.userId || receipt.data.listing_url !== listingUrl) {
        throw new AppError(503, "Publication confirmation could not be verified.");
      }
      reply.header("cache-control", "private, no-store");
      return { confirmation: { jobId, packageSha256, listingUrl, confirmedAt: receipt.data.confirmed_at } };
    });
    // Platform-wide community reports. This route intentionally selects only
    // community data and omits reporter/author identifiers and private books.
    a.get("/admin/moderation/reports", async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      const parsedQuery = pagination.extend({
        status: z.enum(["open", "actioned", "dismissed", "all"]).default("open"),
        entityType: z.enum(["post", "comment"]).optional(),
      }).safeParse(req.query ?? {});
      if (!parsedQuery.success) throw new AppError(422, "Invalid moderation queue filters.");
      const q = parsedQuery.data;
      const svc = app.supabaseFactory();
      let query = svc.from("reports")
        .select("id,entity_type,entity_id,reason,status,created_at,resolution_action")
        .order("created_at", { ascending: false });
      if (q.status !== "all") query = query.eq("status", q.status);
      if (q.entityType) query = query.eq("entity_type", q.entityType);
      const { data, error } = await query.range(q.offset, q.offset + q.limit - 1);
      if (error) throw new AppError(503, "Could not load the moderation queue.");
      const parsed = z.array(moderationReportRow).safeParse(data ?? []);
      if (!parsed.success) throw new AppError(503, "The moderation queue returned invalid report data.");
      const reports = parsed.data;
      const postIds = [...new Set(reports.filter((r) => r.entity_type === "post").map((r) => r.entity_id))];
      const commentIds = [...new Set(reports.filter((r) => r.entity_type === "comment").map((r) => r.entity_id))];

      const postResult = postIds.length
        ? await svc.from("community_posts").select("id,community_id,title,body,status").in("id", postIds)
        : { data: [], error: null };
      if (postResult.error) throw new AppError(503, "Could not load reported community content.");
      const directPostRows = (postResult.data ?? []).filter((row: { id: string }) => postIds.includes(row.id)) as {
        id: string; community_id: string; title: string | null; body: string; status: string;
      }[];
      const commentResult = commentIds.length
        ? await svc.from("community_comments").select("id,post_id,body,moderation_state").in("id", commentIds)
        : { data: [], error: null };
      if (commentResult.error) throw new AppError(503, "Could not load reported community content.");
      const commentRows = (commentResult.data ?? []) as {
        id: string; post_id: string; body: string; moderation_state: string;
      }[];
      const parentPostIds = [...new Set(commentRows.map((row) => row.post_id))];
      const parentResult = parentPostIds.length
        ? await svc.from("community_posts").select("id,community_id,title,body,status").in("id", parentPostIds)
        : { data: [], error: null };
      if (parentResult.error) throw new AppError(503, "Could not load reported community context.");
      const postRows = [...directPostRows, ...(parentResult.data ?? [])] as {
        id: string; community_id: string; title: string | null; body: string; status: string;
      }[];
      const communityIds = [...new Set(postRows.map((row) => row.community_id))];
      const communityResult = communityIds.length
        ? await svc.from("communities").select("id,name").in("id", communityIds)
        : { data: [], error: null };
      if (communityResult.error) throw new AppError(503, "Could not load reported community context.");
      const communities = new Map(((communityResult.data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
      const posts = new Map(postRows.map((row) => [row.id, row]));
      const comments = new Map(commentRows.map((row) => [row.id, row]));
      return {
        reports: reports.map((report) => {
          if (report.entity_type === "post") {
            const post = posts.get(report.entity_id);
            return {
              ...report, resolution_action: report.resolution_action ?? null,
              target: post ? {
                type: "post" as const, title: post.title, body: post.body,
                status: post.status, communityName: communities.get(post.community_id) ?? null,
              } : null,
            };
          }
          const comment = comments.get(report.entity_id);
          const parentPost = comment ? posts.get(comment.post_id) : undefined;
          return {
            ...report, resolution_action: report.resolution_action ?? null,
            target: comment ? {
              type: "comment" as const, body: comment.body,
              moderationState: comment.moderation_state,
              communityName: parentPost ? communities.get(parentPost.community_id) ?? null : null,
              parentTitle: parentPost?.title ?? null,
              parentBody: parentPost?.body ?? null,
            } : null,
          };
        }),
        limit: q.limit,
        offset: q.offset,
      };
    });

    a.post("/admin/moderation/reports/:id/resolve", async (req, reply) => {
      reply.header("cache-control", "private, no-store");
      const params = z.object({ id: z.guid() }).safeParse(req.params);
      if (!params.success) throw new AppError(422, "Invalid report ID.");
      const body = z.object({ action: z.enum(["remove", "dismiss"]) }).strict().safeParse(req.body ?? {});
      if (!body.success) throw new AppError(422, "Choose a supported moderation action.");
      const svc = app.supabaseFactory();
      const { data, error } = await svc.rpc("admin_resolve_community_report", {
        p_report_id: params.data.id,
        p_action: body.data.action,
        p_actor_id: req.userId,
      });
      if (error?.code === "P0002") throw new AppError(404, "Report or reported content not found.");
      if (error?.code === "22023") throw new AppError(422, "This report cannot be resolved with that action.");
      if (error) throw new AppError(503, "Could not confirm the moderation decision. Refresh the queue before trying again.");
      const outcome = Array.isArray(data) ? data[0] : data;
      const parsed = z.object({
        report_id: z.literal(params.data.id),
        status: z.enum(["actioned", "dismissed"]),
        resolution_action: z.enum(["remove", "dismiss"]).nullable(),
        already_resolved: z.boolean(),
      }).refine((row) => row.already_resolved && row.resolution_action === null
        || (row.status === "actioned" ? row.resolution_action === "remove" : row.resolution_action === "dismiss")
          && (row.already_resolved || row.resolution_action === body.data.action)).safeParse(outcome);
      if (!parsed.success) throw new AppError(503, "The moderation decision could not be verified. Refresh the queue.");
      return {
        reportId: parsed.data.report_id,
        status: parsed.data.status,
        action: parsed.data.resolution_action,
        alreadyResolved: parsed.data.already_resolved,
      };
    });

    // ---- users -------------------------------------------------------------
    a.get("/admin/users", async (req) => {
      const q = pagination.extend({ search: z.string().trim().max(200).optional() }).parse(req.query ?? {});
      const svc = app.supabaseFactory();
      let profQ = svc.from("profiles").select("*").order("created_at", { ascending: false });
      if (q.search) {
        profQ = z.guid().safeParse(q.search).success
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
      if (!z.guid().safeParse(id).success) throw new AppError(422, "Invalid publishing job ID.");
      const { data, error } = await svc.rpc("retry_publishing_job", { p_job_id: id, p_actor_id: req.userId });
      if (error?.code === "P0002") throw new AppError(404, "Job not found.");
      if (error?.code === "22023") throw new AppError(422, "Only failed, supported publishing jobs can retry.");
      if (error?.code === "PGRST202" || error?.code === "42883") throw new AppError(503, "Publishing worker migration is not installed.");
      if (error) throw new AppError(500, "Could not queue publishing retry.");
      return { job: Array.isArray(data) ? data[0] : data };
    });

    a.post("/admin/jobs/ai/:id/release-image-hold", async (req, reply) => {
      const id = z.guid().safeParse((req.params as { id: string }).id);
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
      const id = z.guid().safeParse((req.params as { id: string }).id);
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

    a.post("/admin/jobs/ai/:id/release-bible-hold", async (req, reply) => {
      const id = z.guid().safeParse((req.params as { id: string }).id);
      const body = z.object({ incidentRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{5,63}$/),
        receiptReviewed: z.literal(true), providerReviewed: z.literal(true) }).strict().safeParse(req.body);
      if (!id.success || !body.success) throw new AppError(422, "Provide an incident reference and confirm receipt and provider review.");
      const { data, error } = await app.supabaseFactory().rpc("release_unconfirmed_book_bible_job", {
        p_job_id: id.data, p_actor_id: req.userId, p_incident_ref: body.data.incidentRef,
        p_receipt_reviewed: true, p_provider_reviewed: true,
      });
      if (error?.code === "P0002") throw new AppError(404, "Book Bible request not found.");
      if (error?.code === "22023") throw new AppError(409, "This Book Bible request cannot be released. Recheck its receipt, age, output and debit.");
      if (error?.code === "PGRST202" || error?.code === "42883") throw new AppError(503, "Book Bible hold release migration is not installed.");
      if (error || !z.object({ id: z.literal(id.data), status: z.literal("failed"),
        error_code: z.literal("book_bible_hold_released") }).passthrough().safeParse(data).success) {
        throw new AppError(503, "Book Bible hold release was not confirmed. Refresh the job and audit record before retrying.");
      }
      reply.header("cache-control", "private, no-store");
      return { jobId: id.data, status: "failed" as const, incidentRef: body.data.incidentRef };
    });

    a.post("/admin/jobs/ai/:id/settle-review-receipt", async (req, reply) => {
      const id = z.guid().safeParse((req.params as { id: string }).id);
      const body = z.object({ incidentRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{5,63}$/),
        receiptReviewed: z.literal(true), providerReviewed: z.literal(true) }).strict().safeParse(req.body);
      if (!id.success || !body.success) throw new AppError(422, "Provide an incident reference and confirm receipt and provider review.");
      const outcome = await recoverHeldAiReviewReceipt(app.supabaseFactory(), {
        jobId: id.data, actorId: req.userId, incidentRef: body.data.incidentRef,
      });
      if (outcome.status !== "succeeded") throw new AppError(503, "Receipt settlement is unconfirmed. Refresh the job and audit record; do not dispatch generation again.");
      reply.header("cache-control", "private, no-store");
      return { jobId: id.data, status: "succeeded" as const, incidentRef: body.data.incidentRef };
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
        config: z.record(z.string(), z.unknown()).optional(),
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
