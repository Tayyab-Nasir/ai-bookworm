import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook } from "../lib/authoring.js";
import { requireWorkspaceEditor } from "../lib/authorize.js";
import { availableBookBibleModels, bookBibleCatalog, prepareBookBibleQuote, type BookBibleTextRequest } from "../lib/book-bible-pricing.js";
import { loadBibleReadingPlan } from "./book-bible-generation.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { quoteUsage, type UsageQuote } from "../lib/usage-pricing.js";

const id = z.string().uuid();
const bodySchema = z.object({
  modelId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u), idempotencyKey: z.string().trim().min(8).max(200),
  chapterIds: z.array(id).min(1).max(3), maxTokens: z.number().int().min(4096).max(16000).default(12000),
  reading: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), pageIndex: z.number().int().min(0).max(4999) }).strict().optional(),
  allowProviderTokenCounting: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.chapterIds).size !== value.chapterIds.length) ctx.addIssue({ code: "custom", path: ["chapterIds"], message: "Do not repeat chapter IDs." });
});
const acceptSchema = z.object({ expectedCredits: z.number().int().positive().max(2_147_483_647) }).strict();
const requestRow = z.object({
  id, user_id: id, workspace_id: id, book_id: id, generation_job_id: id, idempotency_key: z.string(),
  generation_request_json: z.unknown(), catalog_json: z.unknown(), source_versions_json: z.unknown(), source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation_request_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), counted_input_tokens: z.number().int().positive().nullable(),
  usage_quote_json: z.unknown().nullable(), status: z.enum(["counting", "ready", "failed"]), lease_token: id.nullable(),
  lease_expires_at: z.string().nullable(), error_code: z.string().nullable(), accepted_job_id: id.nullable(), accepted_at: z.string().nullable(), created_at: z.string(),
}).passthrough();
type Book = { id: string; workspace_id: string; title: string; author_name: string | null; language: string };
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, message: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, message, { issues: result.error.issues });
  return result.data;
}
function stableJobId(userId: string, key: string) {
  const bytes = createHash("sha256").update(`book-bible-token-quote:${userId}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function scopedBook(app: FastifyInstance, req: FastifyRequest, bookId: string, edit = false) {
  const user = app.supabaseFactory(req.userToken);
  const { book } = await loadBook(user, bookId, req.userId, edit);
  if (edit) {
    const role = await requireWorkspaceEditor(user, book.workspace_id, req.userId);
    if (!new Set(["owner", "admin", "editor", "writer"]).has(role)) throw new AppError(403, "Writing access is required for a paid Book Bible quote.");
  }
  return { user, book: book as Book };
}
function quoteView(raw: unknown, expected: { id: string; userId: string; bookId: string; workspaceId: string }) {
  const parsed = requestRow.safeParse(raw);
  if (!parsed.success || parsed.data.id !== expected.id || parsed.data.user_id !== expected.userId
    || parsed.data.book_id !== expected.bookId || parsed.data.workspace_id !== expected.workspaceId) throw new AppError(503, "Book Bible quote is unavailable.");
  const saved = parsed.data;
  if (saved.status !== "ready" || saved.usage_quote_json === null || saved.counted_input_tokens === null) {
    return { requestId: saved.id, status: saved.status, errorCode: saved.status === "failed" ? saved.error_code : null } as const;
  }
  try {
    const quote = quoteUsage(saved.usage_quote_json as UsageQuote);
    if (!isDeepStrictEqual(quote, saved.usage_quote_json) || quote.scope.jobId !== saved.generation_job_id
      || quote.scope.userId !== saved.user_id || quote.scope.workspaceId !== saved.workspace_id
      || quote.scope.inputSha256 !== saved.generation_request_sha256) throw new Error("quote identity mismatch");
    const request = z.object({ model: z.string(), maxOutputTokens: z.number().int().positive() }).passthrough().parse(saved.generation_request_json);
    const maximum = new Map(quote.maximumTokens.map((quantity) => [quantity.dimension, quantity.tokens]));
    if (quote.price.model !== request.model || maximum.get("text_input") !== String(saved.counted_input_tokens)
      || maximum.get("text_cached_input") !== String(saved.counted_input_tokens)
      || maximum.get("text_output") !== String(request.maxOutputTokens)) throw new Error("quote bounds mismatch");
    return { requestId: saved.id, status: "ready" as const, model: request.model,
      countedInputTokens: saved.counted_input_tokens, maxOutputTokens: request.maxOutputTokens,
      reservedCredits: Number(quote.reservedCredits), expiresAt: quote.expiresAt,
      ...(saved.accepted_job_id ? { acceptedJobId: saved.accepted_job_id } : {}) };
  } catch { throw new AppError(503, "Book Bible quote is unavailable."); }
}
function countRpcError(error: { code?: string }) {
  if (error.code === "42501") throw new AppError(403, "Writing access is required for a Book Bible quote.");
  if (error.code === "40001") throw new AppError(409, "A selected saved chapter changed. Refresh it and request a new quote.");
  if (error.code === "23505") throw new AppError(409, "This Book Bible quote key is in use or another quote is being counted.");
  if (error.code === "54000") throw new AppError(429, "Book Bible quote limit reached. Try again later.");
  throw new AppError(503, "Book Bible quote storage is unavailable.");
}
function acceptRpcError(error: { code?: string }): never {
  if (error.code === "42501") throw new AppError(403, "Writing access is required to accept this Book Bible quote.");
  if (error.code === "P0002") throw new AppError(404, "Book Bible quote not found.");
  if (["22023", "23514", "23505", "40001", "40P01"].includes(error.code ?? "")) throw new AppError(409, "Book Bible quote expired, changed, or conflicts with another request. Refresh before continuing.");
  throw new AppError(503, "Book Bible quote acceptance could not be confirmed. Recover this same quote before retrying.");
}

export function bookBibleQuoteRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  app.get("/books/:bookId/bible/models", async (req, reply) => {
    const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
    await scopedBook(app, req, bookId);
    reply.header("cache-control", "private, no-store");
    return availableBookBibleModels(process.env.BOOK_BIBLE_PRICING_CATALOG_JSON, new Date().toISOString());
  });

  app.post("/books/:bookId/bible/quotes", async (req, reply) => {
    const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
    const body = parse(bodySchema, req.body, "Choose a model and consent to token counting.");
    const { user, book } = await scopedBook(app, req, bookId, true);
    const now = new Date().toISOString();
    const catalog = bookBibleCatalog(process.env.BOOK_BIBLE_PRICING_CATALOG_JSON, now);
    const entry = catalog.entries.find((item) => item.id === body.modelId);
    if (!entry) throw new AppError(422, "Choose an available Book Bible model.");
    const plan = await loadBibleReadingPlan(user, bookId, body.chapterIds, body.maxTokens);
    if (body.reading && body.reading.fingerprint !== plan.fingerprint) throw new AppError(409, "The saved manuscript or reading budget changed. Refresh the reading plan.");
    if (!body.reading && plan.pages.length > 1) throw new AppError(422, "Prepare a reading plan and choose one batch before requesting a quote.");
    const pageIndex = body.reading?.pageIndex ?? 0;
    const page = plan.pages[pageIndex];
    if (!page) throw new AppError(422, "This reading batch is outside the saved plan.");
    const chapterVersions = Object.values(page.chapters).map((raw) => z.object({ id, version: z.number().int().positive(), documentVersionId: id }).passthrough().parse(raw));
    const sourceVersions = { versions: chapterVersions.map(({ id: chapterId, version, documentVersionId }) => ({ chapterId, version, documentVersionId })),
      reading: { fingerprint: plan.fingerprint, pageIndex } };
    const generationJobId = stableJobId(req.userId, body.idempotencyKey);
    const selectedOutputTokens = Math.min(6000, entry.maxOutputTokens);
    const generationRequest: BookBibleTextRequest = {
      jobId: generationJobId, workspaceId: book.workspace_id, bookId, agentType: "bookbible",
      model: entry.price.model, maxOutputTokens: selectedOutputTokens,
      contextPolicy: { includeBookBible: false, includeStyleGuide: false, includeRelatedContext: false, semanticTopK: 5, maxTokens: body.maxTokens },
      input: { chapterIds: Object.keys(page.chapters), chapters: page.chapters,
        book: { title: book.title, author: book.author_name, language: book.language },
        bookBible: [], relatedContext: [], styleGuide: {},
        userInstruction: "Extract only reviewable entities grounded in the supplied saved manuscript excerpts. A passage may be only part of a node; do not infer facts from omitted text. Citation hashes identify the full saved node, not only this excerpt." },
    };
    const service = app.supabaseFactory();
    const requested = await service.rpc("request_book_bible_token_quote", {
      p_user_id: req.userId, p_book_id: bookId, p_workspace_id: book.workspace_id,
      p_generation_job_id: generationJobId, p_generation_request: generationRequest,
      p_catalog: catalog, p_source_versions: sourceVersions, p_idempotency_key: body.idempotencyKey,
      p_provider_counting_consent: body.allowProviderTokenCounting,
    });
    if (requested.error) countRpcError(requested.error);
    const envelope = z.object({ request: z.unknown(), claimed: z.boolean() }).strict().safeParse(requested.data);
    const saved = envelope.success ? requestRow.safeParse(envelope.data.request) : null;
    if (!envelope.success || !saved?.success || saved.data.user_id !== req.userId || saved.data.book_id !== bookId
      || saved.data.workspace_id !== book.workspace_id || saved.data.generation_job_id !== generationJobId
      || !isDeepStrictEqual(saved.data.generation_request_json, generationRequest)
      || !isDeepStrictEqual(saved.data.source_versions_json, sourceVersions)) throw new AppError(503, "Book Bible quote storage returned an invalid request.");
    if (saved.data.status === "ready") {
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send({ quote: quoteView(saved.data, { id: saved.data.id, userId: req.userId, bookId, workspaceId: book.workspace_id }) });
    }
    if (saved.data.status === "failed") throw new AppError(409, "This Book Bible quote request failed. Use a fresh request key.");
    if (!envelope.data.claimed) {
      reply.header("cache-control", "private, no-store");
      return reply.status(202).send({ request: { id: saved.data.id, status: "counting" }, quote: null });
    }
    try {
      const prepared = await prepareBookBibleQuote(JSON.stringify(catalog), { modelId: body.modelId, now,
        scope: { jobId: generationJobId, workspaceId: book.workspace_id, userId: req.userId, bookId },
        request: generationRequest, allowProviderTokenCounting: body.allowProviderTokenCounting }, { fetcher: options.fetcher });
      const completed = await service.rpc("complete_book_bible_token_quote_count", { p_request_id: saved.data.id,
        p_user_id: req.userId, p_lease_token: saved.data.lease_token, p_request_sha256: prepared.quote.scope.inputSha256,
        p_counted_input_tokens: prepared.countedInputTokens, p_usage_quote: prepared.quote });
      if (completed.error) countRpcError(completed.error);
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send({ quote: quoteView(completed.data, { id: saved.data.id, userId: req.userId, bookId, workspaceId: book.workspace_id }) });
    } catch (error) {
      await service.rpc("fail_book_bible_token_quote_count", { p_request_id: saved.data.id, p_user_id: req.userId,
        p_lease_token: saved.data.lease_token, p_error_code: error instanceof AppError ? `quote_${error.code}` : "quote_count_unavailable" });
      throw error;
    }
  });

  app.get("/books/:bookId/bible/quotes/:requestId", async (req, reply) => {
    const params = parse(z.object({ bookId: id, requestId: id }), req.params, "Valid Book Bible quote IDs required.");
    const { book } = await scopedBook(app, req, params.bookId);
    const service = app.supabaseFactory();
    const found = await service.from("book_bible_token_quote_requests").select("*")
      .eq("id", params.requestId).eq("user_id", req.userId).eq("book_id", params.bookId).maybeSingle();
    if (found.error) throw new AppError(503, "Could not load Book Bible quote status.");
    if (!found.data) throw new AppError(404, "Book Bible quote not found.");
    const saved = parse(requestRow, found.data, "Book Bible quote is unavailable.");
    let job: { id: string; status: string; errorCode?: string } | null = null;
    if (saved.accepted_job_id) {
      const current = await service.from("ai_jobs").select("id,status,error_code").eq("id", saved.accepted_job_id)
        .eq("book_id", params.bookId).eq("created_by", req.userId).eq("billing_mode", "quoted").maybeSingle();
      if (current.error || !current.data) throw new AppError(503, "Could not recover accepted Book Bible job status.");
      job = { id: current.data.id, status: current.data.status, ...(current.data.error_code ? { errorCode: current.data.error_code } : {}) };
    }
    reply.header("cache-control", "private, no-store");
    return { quote: quoteView(saved, { id: params.requestId, userId: req.userId, bookId: params.bookId, workspaceId: book.workspace_id }), job };
  });

  app.post("/books/:bookId/bible/quotes/:requestId/accept", async (req, reply) => {
    const params = parse(z.object({ bookId: id, requestId: id }), req.params, "Valid Book Bible quote IDs required.");
    const body = parse(acceptSchema, req.body, "Confirm the exact Book Bible credit total.");
    const { book } = await scopedBook(app, req, params.bookId, true);
    const service = app.supabaseFactory();
    const found = await service.from("book_bible_token_quote_requests").select("*")
      .eq("id", params.requestId).eq("user_id", req.userId).eq("book_id", params.bookId).maybeSingle();
    if (found.error) throw new AppError(503, "Could not verify Book Bible quote before acceptance.");
    if (!found.data) throw new AppError(404, "Book Bible quote not found.");
    const safeQuote = quoteView(found.data, { id: params.requestId, userId: req.userId, bookId: params.bookId, workspaceId: book.workspace_id });
    if (!("reservedCredits" in safeQuote) || safeQuote.reservedCredits !== body.expectedCredits) throw new AppError(409, "Confirm the current ready quote's exact credit total.");
    const accepted = await service.rpc("accept_book_bible_token_quote", { p_request_id: params.requestId, p_user_id: req.userId, p_expected_credits: body.expectedCredits });
    if (accepted.error) acceptRpcError(accepted.error);
    const job = z.object({ id, status: z.enum(["queued", "running", "succeeded", "failed"]), billing_mode: z.literal("quoted") }).passthrough().safeParse(first(accepted.data));
    if (!job.success) throw new AppError(503, "Book Bible acceptance reply was invalid. Recover this same quote before retrying.");
    reply.header("cache-control", "private, no-store");
    return reply.status(202).send({ jobId: job.data.id, status: job.data.status });
  });
}
