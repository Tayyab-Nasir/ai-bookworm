import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import { latestVersion, loadBook } from "../lib/authoring.js";
import { requireWorkspaceEditor } from "../lib/authorize.js";
import { aiReviewCatalog, availableAiReviewModels, prepareAiReviewQuote, type AiReviewGenerationRequest } from "../lib/ai-review-pricing.js";
import { buildAiReviewContext, type AiReviewContextJob } from "../lib/ai-review-worker.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { quoteUsage, type UsageQuote } from "../lib/usage-pricing.js";

const id = z.string().uuid();
const agentType = z.enum(["writer", "proofreader", "copyeditor", "consistency"]);
const contextPolicySchema = z.object({
  includeBookBible: z.boolean().default(true), includeStyleGuide: z.boolean().default(true),
  includeRelatedContext: z.boolean().default(true), semanticTopK: z.number().int().min(1).max(20).default(5),
  maxTokens: z.number().int().min(256).max(16_000).default(4096),
}).strict();
const bodySchema = z.object({
  modelId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), agentType, chapterIds: z.array(id).min(1).max(5),
  userInstruction: z.string().trim().min(1).max(4_000).optional(), idempotencyKey: z.string().trim().min(8).max(200),
  contextPolicy: contextPolicySchema.default({}), allowProviderTokenCounting: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.agentType === "writer" && !value.userInstruction) ctx.addIssue({ code: "custom", path: ["userInstruction"], message: "Tell the writing assistant what to draft." });
  if (new Set(value.chapterIds).size !== value.chapterIds.length) ctx.addIssue({ code: "custom", path: ["chapterIds"], message: "Do not repeat chapter IDs." });
});
const acceptBodySchema = z.object({ expectedCredits: z.number().int().positive().max(2_147_483_647) }).strict();
const requestRow = z.object({ id, user_id: id, workspace_id: id, book_id: id, generation_job_id: id,
  generation_request_json: z.unknown(), catalog_json: z.unknown(), source_versions_json: z.unknown(),
  status: z.enum(["counting", "ready", "failed"]), lease_token: id.nullable(),
  lease_expires_at: z.string().nullable(),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), counted_input_tokens: z.number().int().positive().nullable(),
  usage_quote_json: z.unknown().nullable(), error_code: z.string().nullable(), created_at: z.string(),
  accepted_job_id: id.nullable(),
}).passthrough();

type Book = { id: string; workspace_id: string; title: string; author_name: string | null; language: string };

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, message: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, message, { issues: result.error.issues });
  return result.data;
}
function row(value: unknown) { return Array.isArray(value) ? value[0] : value; }
function stableJobId(userId: string, key: string) {
  const bytes = createHash("sha256").update(`ai-review-quote:${userId}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function toQuote(raw: unknown, expected: { id: string; userId: string; bookId: string; workspaceId: string }) {
  const value = requestRow.safeParse(raw);
  if (!value.success || value.data.id !== expected.id || value.data.user_id !== expected.userId
    || value.data.book_id !== expected.bookId || value.data.workspace_id !== expected.workspaceId) {
    throw new AppError(503, "AI review quote is unavailable.");
  }
  const saved = value.data;
  if (saved.status !== "ready" || saved.usage_quote_json === null || saved.counted_input_tokens === null) {
    return { requestId: saved.id, status: saved.status, errorCode: saved.status === "failed" ? saved.error_code : null } as const;
  }
  try {
    const quote = quoteUsage(saved.usage_quote_json as UsageQuote);
    if (!isDeepStrictEqual(quote, saved.usage_quote_json) || quote.scope.jobId !== saved.generation_job_id
      || quote.scope.userId !== saved.user_id || quote.scope.workspaceId !== saved.workspace_id
      || quote.scope.inputSha256 !== saved.request_sha256) throw new Error("quote identity mismatch");
    const request = z.object({ model: z.string().min(1), agentType, maxOutputTokens: z.number().int().positive() }).passthrough().parse(saved.generation_request_json);
    const maximum = new Map(quote.maximumTokens.map((quantity) => [quantity.dimension, quantity.tokens]));
    if (quote.price.model !== request.model || maximum.get("text_input") !== String(saved.counted_input_tokens)
      || maximum.get("text_cached_input") !== String(saved.counted_input_tokens)
      || maximum.get("text_output") !== String(request.maxOutputTokens)) throw new Error("quote bounds mismatch");
    return { requestId: saved.id, status: "ready" as const, agentType: request.agentType, model: request.model,
      countedInputTokens: saved.counted_input_tokens, maxOutputTokens: request.maxOutputTokens,
      reservedCredits: Number(quote.reservedCredits), expiresAt: quote.expiresAt };
  } catch { throw new AppError(503, "AI review quote is unavailable."); }
}

async function scopedBook(app: FastifyInstance, req: FastifyRequest, bookId: string, edit = false) {
  const user = app.supabaseFactory(req.userToken);
  const { book } = await loadBook(user, bookId, req.userId, edit);
  if (edit) {
    const role = await requireWorkspaceEditor(user, book.workspace_id, req.userId);
    if (!new Set(["owner", "admin", "editor", "writer"]).has(role)) throw new AppError(403, "Writing access is required for a paid AI review quote.");
  }
  return { user, book: book as Book };
}

function quoteRpcError(error: { code?: string }) {
  if (error.code === "42501") throw new AppError(403, "Writing access is required for an AI review quote.");
  if (error.code === "40001") throw new AppError(409, "A selected saved chapter changed. Reload it and prepare a fresh quote.");
  if (error.code === "23505") throw new AppError(409, "This AI review quote key is in use or another quote is being counted.");
  if (error.code === "54000") throw new AppError(429, "AI review quote limit reached. Try again later.");
  throw new AppError(503, "AI review quote storage is unavailable.");
}
function acceptanceRpcError(error: { code?: string }): never {
  if (error.code === "42501") throw new AppError(403, "Writing access is required to accept this AI review quote.");
  if (error.code === "P0002") throw new AppError(404, "AI review quote not found.");
  if (["22023", "23514", "23505", "40001", "40P01"].includes(error.code ?? "")) {
    throw new AppError(409, "AI review quote changed, expired, or conflicts with another job. Refresh before continuing.");
  }
  throw new AppError(503, "AI review quote acceptance could not be confirmed. Recover this same quote before retrying.");
}

export function aiReviewQuoteRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  app.get("/books/:bookId/ai-review/models", async (req, reply) => {
    const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
    await scopedBook(app, req, bookId);
    reply.header("cache-control", "private, no-store");
    return availableAiReviewModels(process.env.AI_REVIEW_PRICING_CATALOG_JSON, new Date().toISOString());
  });

  app.post("/books/:bookId/ai-review/quotes", async (req, reply) => {
    const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
    const body = parse(bodySchema, req.body, "Choose an AI task/model and consent to token counting.");
    const { user, book } = await scopedBook(app, req, bookId, true);
    const service = app.supabaseFactory();
    const now = new Date().toISOString();
    const { data: existingRaw, error: existingError } = await service.from("ai_review_token_quote_requests").select("*")
      .eq("user_id", req.userId).eq("idempotency_key", body.idempotencyKey).maybeSingle();
    if (existingError) throw new AppError(503, "Could not recover AI review quote request.");
    if (existingRaw) {
      const existing = parse(requestRow, existingRaw, "AI review quote is unavailable.");
      if (existing.book_id !== bookId || existing.workspace_id !== book.workspace_id) throw new AppError(409, "This quote key belongs to a different book.");
      const storedRequest = z.object({ model: z.string(), agentType, maxOutputTokens: z.number().int().positive(),
        contextPolicy: contextPolicySchema, input: z.object({ chapterIds: z.array(id), userInstruction: z.string().nullable() }).passthrough() }).passthrough()
        .safeParse(existing.generation_request_json);
      const storedCatalog = z.object({ entries: z.array(z.object({ id: z.string(), price: z.object({ model: z.string() }).passthrough() }).passthrough()) }).passthrough()
        .safeParse(existing.catalog_json);
      const savedEntry = storedCatalog.success ? storedCatalog.data.entries.find((item) => item.id === body.modelId) : null;
      if (!storedRequest.success || !savedEntry || savedEntry.price.model !== storedRequest.data.model
        || storedRequest.data.agentType !== body.agentType || storedRequest.data.input.userInstruction !== (body.userInstruction ?? null)
        || !isDeepStrictEqual(storedRequest.data.input.chapterIds, body.chapterIds)
        || !isDeepStrictEqual(storedRequest.data.contextPolicy, body.contextPolicy)) {
        throw new AppError(409, "This AI review quote key is already bound to different settings or saved inputs.");
      }
      if (existing.status === "ready") {
        reply.header("cache-control", "private, no-store");
        return reply.status(200).send({ quote: toQuote(existing, { id: existing.id, userId: req.userId, bookId, workspaceId: book.workspace_id }) });
      }
      if (existing.status === "failed") throw new AppError(409, "This quote request failed. Use a fresh request key to try again.");
      if (existing.lease_expires_at && Date.parse(existing.lease_expires_at) > Date.parse(now)) {
        reply.header("cache-control", "private, no-store");
        return reply.status(202).send({ request: { id: existing.id, status: "counting" }, quote: null });
      }
    }

    let catalog: ReturnType<typeof aiReviewCatalog>;
    let generationRequest: AiReviewGenerationRequest;
    let sourceVersions: { chapterId: string; version: number; documentVersionId: string }[];
    let jobId: string;
    if (existingRaw) {
      const existing = requestRow.parse(existingRaw);
      catalog = aiReviewCatalog(JSON.stringify(existing.catalog_json), now);
      generationRequest = z.custom<AiReviewGenerationRequest>().parse(existing.generation_request_json);
      sourceVersions = z.array(z.object({ chapterId: id, version: z.number().int().positive(), documentVersionId: id }).strict()).parse(existing.source_versions_json);
      jobId = existing.generation_job_id;
    } else {
      catalog = aiReviewCatalog(process.env.AI_REVIEW_PRICING_CATALOG_JSON, now);
      const entry = catalog.entries.find((item) => item.id === body.modelId);
      if (!entry) throw new AppError(422, "Choose an available AI writing model.");
      const { data: queriedChapters, error: chapterError } = await user.from("chapters")
        .select("id,title,order_index").eq("book_id", bookId).in("id", body.chapterIds);
      if (chapterError) throw new AppError(500, "Could not load selected saved chapters.");
      if (!queriedChapters || queriedChapters.length !== body.chapterIds.length) throw new AppError(422, "Every selected chapter must belong to this book.");
      const chapterMap = new Map(queriedChapters.map((chapter) => [chapter.id, chapter]));
      const chapterRows = body.chapterIds.map((chapterId) => chapterMap.get(chapterId));
      if (chapterRows.some((chapter) => !chapter)) throw new AppError(422, "Every selected chapter must belong to this book.");
      sourceVersions = [];
      for (const chapter of chapterRows as NonNullable<typeof chapterRows[number]>[]) {
        const current = await latestVersion(user, chapter.id);
        if (!current) throw new AppError(422, "Save each selected chapter before preparing a quote.");
        sourceVersions.push({ chapterId: chapter.id, version: current.version_number, documentVersionId: current.id });
      }
      jobId = stableJobId(req.userId, body.idempotencyKey);
      const contextJob = {
        id: jobId, workspace_id: book.workspace_id, book_id: bookId, created_by: req.userId,
        agent_type: body.agentType, lease_token: randomUUID(),
        input_ref: { chapterVersions: sourceVersions.map(({ chapterId, version }) => ({ chapterId, version })),
          userInstruction: body.userInstruction ?? null, contextPolicy: body.contextPolicy },
      } as AiReviewContextJob;
      const context = await buildAiReviewContext(user, contextJob);
      generationRequest = { jobId, workspaceId: book.workspace_id, bookId, agentType: body.agentType,
        model: entry.price.model, maxOutputTokens: entry.maxOutputTokens, contextPolicy: body.contextPolicy, input: context.body.input };
    }

    const requested = await service.rpc("request_ai_review_token_quote", {
      p_user_id: req.userId, p_book_id: bookId, p_workspace_id: book.workspace_id, p_generation_job_id: jobId,
      p_generation_request: generationRequest, p_catalog: catalog, p_source_versions: sourceVersions,
      p_idempotency_key: body.idempotencyKey, p_provider_counting_consent: body.allowProviderTokenCounting,
    });
    if (requested.error) quoteRpcError(requested.error);
    const envelope = z.object({ request: z.unknown(), claimed: z.boolean() }).strict().safeParse(requested.data);
    const saved = envelope.success ? requestRow.safeParse(envelope.data.request) : null;
    if (!envelope.success || !saved?.success) throw new AppError(503, "AI review quote storage returned an invalid request.");
    if (saved.data.user_id !== req.userId || saved.data.book_id !== bookId || saved.data.generation_job_id !== generationRequest.jobId) {
      throw new AppError(503, "AI review quote storage returned a foreign request.");
    }
    if (saved.data.status === "ready") {
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send({ quote: toQuote(saved.data, { id: saved.data.id, userId: req.userId, bookId, workspaceId: book.workspace_id }) });
    }
    if (saved.data.status === "failed") throw new AppError(409, "This quote request failed. Use a fresh request key to try again.");
    if (!envelope.data.claimed) {
      reply.header("cache-control", "private, no-store");
      return reply.status(202).send({ request: { id: saved.data.id, status: "counting" }, quote: null });
    }
    try {
      const prepared = await prepareAiReviewQuote(JSON.stringify(catalog), {
        modelId: body.modelId, now, scope: { jobId, workspaceId: book.workspace_id, userId: req.userId, bookId },
        request: generationRequest, allowProviderTokenCounting: body.allowProviderTokenCounting,
      }, { fetcher: options.fetcher });
      const completed = await service.rpc("complete_ai_review_token_quote_count", {
        p_request_id: saved.data.id, p_user_id: req.userId, p_lease_token: saved.data.lease_token,
        p_request_sha256: prepared.quote.scope.inputSha256, p_counted_input_tokens: prepared.countedInputTokens,
        p_usage_quote: prepared.quote,
      });
      if (completed.error) quoteRpcError(completed.error);
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send({ quote: toQuote(completed.data, { id: saved.data.id, userId: req.userId, bookId, workspaceId: book.workspace_id }) });
    } catch (error) {
      await service.rpc("fail_ai_review_token_quote_count", { p_request_id: saved.data.id, p_user_id: req.userId,
        p_lease_token: saved.data.lease_token, p_error_code: error instanceof AppError ? `quote_${error.code}` : "quote_count_unavailable" });
      throw error;
    }
  });

  app.get("/books/:bookId/ai-review/quotes/:requestId", async (req, reply) => {
    const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
    const requestId = parse(id, (req.params as { requestId: string }).requestId, "Valid quote request ID required.");
    const { book } = await scopedBook(app, req, bookId);
    const { data, error } = await app.supabaseFactory().from("ai_review_token_quote_requests").select("*")
      .eq("id", requestId).eq("user_id", req.userId).eq("book_id", bookId).maybeSingle();
    if (error) throw new AppError(503, "Could not load AI review quote status.");
    if (!data) throw new AppError(404, "AI review quote not found.");
    const saved = parse(requestRow, data, "AI review quote is unavailable.");
    let job: { id: string; status: string } | null = null;
    if (saved.accepted_job_id) {
      const found = await app.supabaseFactory().from("ai_jobs").select("id,status")
        .eq("id", saved.accepted_job_id).eq("book_id", bookId).eq("created_by", req.userId).eq("billing_mode", "quoted").maybeSingle();
      if (found.error || !found.data) throw new AppError(503, "Could not recover accepted AI review status.");
      job = { id: found.data.id, status: found.data.status };
    }
    reply.header("cache-control", "private, no-store");
    return { quote: toQuote(saved, { id: requestId, userId: req.userId, bookId, workspaceId: book.workspace_id }), ...(job ? { job } : {}) };
  });

  app.post("/books/:bookId/ai-review/quotes/:requestId/accept", async (req, reply) => {
    const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
    const requestId = parse(id, (req.params as { requestId: string }).requestId, "Valid quote request ID required.");
    const body = parse(acceptBodySchema, req.body, "Confirm the exact AI review credit total.");
    const { book } = await scopedBook(app, req, bookId, true);
    const service = app.supabaseFactory();
    const saved = await service.from("ai_review_token_quote_requests").select("*")
      .eq("id", requestId).eq("user_id", req.userId).eq("book_id", bookId).maybeSingle();
    if (saved.error) throw new AppError(503, "Could not verify AI review quote before acceptance.");
    if (!saved.data) throw new AppError(404, "AI review quote not found.");
    const quote = toQuote(saved.data, { id: requestId, userId: req.userId, bookId, workspaceId: book.workspace_id });
    if (quote.status !== "ready" || quote.reservedCredits !== body.expectedCredits) {
      throw new AppError(409, "Confirm the current ready quote's exact credit total.");
    }
    const accepted = await service.rpc("accept_ai_review_token_quote", {
      p_request_id: requestId, p_user_id: req.userId, p_expected_credits: body.expectedCredits,
    });
    if (accepted.error) acceptanceRpcError(accepted.error);
    const job = z.object({ id, status: z.enum(["queued", "running", "succeeded", "failed"]) }).safeParse(row(accepted.data));
    if (!job.success) throw new AppError(503, "AI review acceptance reply was invalid. Recover this quote before retrying.");
    reply.header("cache-control", "private, no-store");
    return reply.status(202).send({ jobId: job.data.id, status: job.data.status });
  });
}
