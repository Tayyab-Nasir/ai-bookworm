import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import { imageCatalog, imageRequestHash, prepareImageQuote, type ImageQuoteRequest } from "../lib/image-pricing.js";
import { imageQuoteContext } from "../lib/image-quote-context.js";
import { quoteUsage, type UsageQuote } from "../lib/usage-pricing.js";

const id = z.string().uuid();
export function imageQuoteRoutes(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/image-quotes/:quoteId/job", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Valid workspace and quote IDs required.");
    const { workspaceId, quoteId } = params.data;
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const snapshot = await service.from("image_quote_snapshots").select("id,user_id,workspace_id,generation_job_id")
      .eq("id", quoteId).eq("user_id", req.userId).eq("workspace_id", workspaceId).maybeSingle();
    if (snapshot.error) throw new AppError(503, "Image quote recovery is unavailable.");
    if (!snapshot.data) throw new AppError(404, "Image quote not found.");
    if (snapshot.data.id !== quoteId || snapshot.data.user_id !== req.userId || snapshot.data.workspace_id !== workspaceId) throw new AppError(503, "Image quote identity could not be verified.");
    const accepted = await service.from("image_quote_acceptances").select("job_id").eq("quote_id", quoteId).maybeSingle();
    if (accepted.error) throw new AppError(503, "Image acceptance recovery is unavailable.");
    if (!accepted.data) return { quoteId, accepted: false, job: null };
    if (accepted.data.job_id !== snapshot.data.generation_job_id) throw new AppError(503, "Image acceptance identity could not be verified.");
    const found = await service.from("ai_jobs").select("id,workspace_id,created_by,billing_mode,agent_type,status,output_ref,error_code")
      .eq("id", accepted.data.job_id).eq("workspace_id", workspaceId).eq("created_by", req.userId).maybeSingle();
    const job = found.data;
    if (found.error || !job || job.id !== accepted.data.job_id || job.workspace_id !== workspaceId || job.created_by !== req.userId
      || job.billing_mode !== "quoted" || !["illustrator", "cover_designer"].includes(job.agent_type)
      || !["queued", "running", "succeeded", "failed", "cancelled"].includes(job.status)) throw new AppError(503, "Image job recovery could not be verified.");
    const asset = id.safeParse(job.output_ref?.assetId);
    if (job.status === "succeeded" && !asset.success) throw new AppError(503, "Completed image identity could not be verified.");
    return { quoteId, accepted: true, job: { id: job.id, status: job.status,
      assetId: job.status === "succeeded" && asset.success ? asset.data : null } };
  });
  app.post("/workspaces/:workspaceId/image-quotes/:quoteId/accept", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    const body = z.object({ expectedCredits: z.string().regex(/^[1-9][0-9]{0,9}$/), consentToGenerate: z.literal(true) }).strict().safeParse(req.body);
    if (!params.success || !body.success || BigInt(body.data.expectedCredits) > 2147483647n) {
      throw new AppError(422, "Confirm the exact quoted credits and consent to image generation.");
    }
    const { workspaceId, quoteId } = params.data;
    await requireWorkspaceEditor(app.supabaseFactory(req.userToken), workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const found = await service.from("image_quote_snapshots").select("id,user_id,workspace_id,generation_job_id")
      .eq("id", quoteId).eq("user_id", req.userId).eq("workspace_id", workspaceId).maybeSingle();
    if (found.error) throw new AppError(503, "Image quote lookup is unavailable.");
    if (!found.data) throw new AppError(404, "Image quote not found.");
    if (found.data.id !== quoteId || found.data.user_id !== req.userId || found.data.workspace_id !== workspaceId) throw new AppError(503, "Image quote identity could not be verified.");
    const previous = await service.from("image_quote_acceptances").select("job_id").eq("quote_id", quoteId).maybeSingle();
    if (previous.error) throw new AppError(503, "Image acceptance recovery is unavailable.");
    let catalog: unknown = {};
    if (!previous.data) {
      if (process.env.IMAGE_QUOTE_PURCHASE_ENABLED !== "true") throw new AppError(503, "Image quote purchases are not enabled.");
      catalog = imageCatalog(process.env.IMAGE_PRICING_CATALOG_JSON, new Date().toISOString());
    } else if (previous.data.job_id !== found.data.generation_job_id) throw new AppError(503, "Image acceptance identity could not be verified.");
    const accepted = await service.rpc("accept_image_quote", { p_quote_id: quoteId, p_user_id: req.userId,
      p_expected_credits: Number(body.data.expectedCredits), p_catalog: catalog });
    if (accepted.error?.code === "42501") throw new AppError(403, "Image quote access changed.");
    if (["23514", "22023", "23505"].includes(accepted.error?.code ?? "")) throw new AppError(409, "The quote, available credits, or source changed. Recover the offer before trying again.");
    const job = Array.isArray(accepted.data) ? accepted.data[0] : accepted.data;
    if (accepted.error || !job || job.id !== found.data.generation_job_id || job.workspace_id !== workspaceId
      || job.created_by !== req.userId || job.billing_mode !== "quoted") throw new AppError(503, "Acceptance is unconfirmed. Recover this same quote; do not create another purchase.");
    return { quoteId, jobId: job.id, status: job.status };
  });
  app.post("/workspaces/:workspaceId/image-quotes/recover", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    const body = z.object({ idempotencyKey: z.string().min(8).max(200) }).strict().safeParse(req.body);
    if (!workspace.success || !body.success) throw new AppError(422, "Valid workspace and original quote key required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspace.data, req.userId);
    reply.header("cache-control", "private, no-store");
    // This is a lookup, not a re-quote. Do not require a current catalog or
    // reread mutable manuscripts/references after an uncertain save response.
    const found = await app.supabaseFactory().from("image_quote_snapshots").select("id,user_id,workspace_id")
      .eq("workspace_id", workspace.data).eq("user_id", req.userId)
      .eq("idempotency_key", body.data.idempotencyKey).maybeSingle();
    if (found.error) throw new AppError(503, "Image quote recovery is unavailable. Keep the original request key.");
    if (!found.data) throw new AppError(404, "No saved image quote was found for this request key.");
    if (!id.safeParse(found.data.id).success || found.data.user_id !== req.userId || found.data.workspace_id !== workspace.data) {
      throw new AppError(503, "Image quote recovery could not be verified.");
    }
    return { quoteId: found.data.id, purchaseAvailable: false };
  });
  app.post("/workspaces/:workspaceId/image-quotes", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    const body = z.object({ modelId: z.string().min(1).max(128), idempotencyKey: z.string().min(8).max(200),
      bookId: id.optional(), kind: z.enum(["illustration", "cover"]), prompt: z.string().trim().min(1).max(8000),
      referenceAssetIds: z.array(id).max(3).default([]), consentToQuoteStorage: z.literal(true),
    }).strict().safeParse(req.body);
    if (!workspace.success || !body.success) throw new AppError(422, "Choose image settings and consent to saving the quote context.");
    const input = body.data; const workspaceId = workspace.data;
    if (new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length) throw new AppError(422, "Reference images must be unique.");
    const user = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(user, workspaceId, req.userId);
    const now = new Date().toISOString();
    const rawCatalog = process.env.IMAGE_PRICING_CATALOG_JSON;
    const catalog = imageCatalog(rawCatalog, now);
    const entry = catalog.entries.find((item) => item.id === input.modelId);
    if (!entry || input.referenceAssetIds.length > entry.maxReferenceImages) throw new AppError(422, "Choose an available image option.");
    const context = await imageQuoteContext(user, { ...input, workspaceId });
    const digest = createHash("sha256").update(`image-quote:${req.userId}:${input.idempotencyKey}`).digest();
    digest[6] = (digest[6]! & 15) | 80; digest[8] = (digest[8]! & 63) | 128;
    const hex = digest.subarray(0, 16).toString("hex");
    const jobId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const prepared = prepareImageQuote(rawCatalog, { modelId: input.modelId, now: new Date().toISOString(), request: {
      jobId, workspaceId, userId: req.userId, bookId: input.bookId ?? null, kind: input.kind,
      model: entry.price.model, size: entry.size, quality: entry.quality, ...context,
    } });
    const saved = await app.supabaseFactory().rpc("save_image_quote_snapshot", {
      p_user_id: req.userId, p_workspace_id: workspaceId, p_book_id: input.bookId ?? null, p_job_id: jobId,
      p_idempotency_key: input.idempotencyKey, p_request_sha256: imageRequestHash(prepared.request),
      p_request: prepared.request, p_catalog_version: prepared.catalogVersion, p_model_option_id: input.modelId, p_quote: prepared.quote,
    });
    if (saved.error?.code === "23505") throw new AppError(409, "This quote key belongs to changed settings or context. Recover the existing offer or request a new quote.");
    if (saved.error?.code === "42501") throw new AppError(403, "Image quote access changed.");
    const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
    if (saved.error || !row || !id.safeParse(row.id).success || row.user_id !== req.userId || row.workspace_id !== workspaceId) {
      throw new AppError(503, "Quote save is unconfirmed. Retry the same request key; no generation or charge was started.");
    }
    reply.header("cache-control", "private, no-store");
    return { quoteId: row.id, purchaseAvailable: false };
  });
  app.get("/workspaces/:workspaceId/image-models", async (req, reply) => {
    const parsed = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    if (!parsed.success) throw new AppError(422, "Valid workspace ID required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), parsed.data, req.userId);
    reply.header("cache-control", "private, no-store");
    const catalog = imageCatalog(process.env.IMAGE_PRICING_CATALOG_JSON, new Date().toISOString());
    return { catalogVersion: catalog.version, pricingBasis: "maximum_token_budget",
      purchaseAvailable: process.env.IMAGE_QUOTE_PURCHASE_ENABLED === "true",
      models: catalog.entries.map((entry) => ({ id: entry.id, label: entry.label, model: entry.price.model,
        size: entry.size, quality: entry.quality, maxReferenceImages: entry.maxReferenceImages,
        maxPromptBytes: entry.maxPromptBytes, priceVersion: entry.price.version, policyVersion: entry.policy.version })) };
  });

  app.get("/workspaces/:workspaceId/image-quotes/:quoteId", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Valid workspace and quote IDs required.");
    const { workspaceId, quoteId } = params.data;
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    const found = await app.supabaseFactory().from("image_quote_snapshots").select("*")
      .eq("id", quoteId).eq("workspace_id", workspaceId).eq("user_id", req.userId).maybeSingle();
    if (found.error) throw new AppError(503, "Image quote recovery is unavailable.");
    if (!found.data) throw new AppError(404, "Image quote not found.");
    try {
      const saved = found.data;
      const quote = quoteUsage(saved.quote_json as UsageQuote);
      const request = saved.request_json as ImageQuoteRequest;
      if (saved.id !== quoteId || saved.workspace_id !== workspaceId || saved.user_id !== req.userId
        || !isDeepStrictEqual(quote, saved.quote_json) || quote.scope.jobId !== saved.generation_job_id
        || quote.scope.workspaceId !== workspaceId || quote.scope.userId !== req.userId
        || request.jobId !== saved.generation_job_id || request.workspaceId !== workspaceId || request.userId !== req.userId
        || request.bookId !== saved.book_id || request.model !== quote.price.model
        || imageRequestHash(request) !== saved.request_sha256 || quote.scope.inputSha256 !== saved.request_sha256
        || Date.parse(saved.expires_at) !== Date.parse(quote.expiresAt)) throw new Error("snapshot mismatch");
      return { quote: { id: quoteId, status: Date.now() >= Date.parse(quote.expiresAt) ? "expired" : "ready",
        model: quote.price.model, size: request.size, quality: request.quality, kind: request.kind,
        reservedCredits: quote.reservedCredits, expiresAt: quote.expiresAt, pricingBasis: "maximum_token_budget",
        purchaseAvailable: false } };
    } catch { throw new AppError(503, "The saved image quote could not be verified."); }
  });
}
