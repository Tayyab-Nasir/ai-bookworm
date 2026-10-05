import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook, parseNodes } from "../lib/authoring.js";
import { requireWorkspaceEditor } from "../lib/authorize.js";
import { buildMetadataGenerationRequest, metadataQuoteCatalog, prepareMetadataQuote } from "../lib/metadata-quote.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { quoteUsage, type UsageQuote } from "../lib/usage-pricing.js";
import { candidateFromJob } from "./metadata-generation.js";

const id = z.string().uuid();
const roles = new Set(["owner", "admin", "editor", "writer"]);
const quoteRequestBody = z.object({
  modelId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), idempotencyKey: z.string().trim().min(8).max(200),
  allowProviderTokenCounting: z.literal(true), chapterIds: z.array(id).min(1).max(5).optional(),
  audience: z.string().trim().min(1).max(500).optional(), tone: z.string().trim().min(1).max(200).optional(),
  maxTokens: z.number().int().min(4_096).max(16_000).default(12_000),
}).strict().superRefine((value, ctx) => {
  if (value.chapterIds && new Set(value.chapterIds).size !== value.chapterIds.length) {
    ctx.addIssue({ code: "custom", path: ["chapterIds"], message: "Do not repeat chapter IDs." });
  }
});
const acceptBody = z.object({ expectedCredits: z.number().int().positive().max(2_147_483_647) }).strict();

type Book = { id: string; workspace_id: string; title: string; subtitle?: string | null; author_name: string | null; language: string };
type QuoteRow = {
  id: string; user_id: string; book_id: string; workspace_id: string; generation_job_id: string;
  generation_request_json: Record<string, unknown>; catalog_json: Record<string, unknown>; status: "counting" | "ready" | "failed";
  lease_token: string | null; usage_quote_json: unknown; quote_expires_at: string | null;
  accepted_job_id: string | null; error_code: string | null; created_at: string;
  generation_request_sha256: string | null;
};

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, message: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, message, { issues: result.error.issues });
  return result.data;
}

function one(value: unknown) { return Array.isArray(value) ? value[0] : value; }

function metadataInstruction(body: Pick<z.infer<typeof quoteRequestBody>, "audience" | "tone">) {
  return ["Create a reviewable retailer-neutral book description, discovery keywords, and categories from selected saved manuscript evidence.",
    body.audience ? `Requested audience: ${body.audience}` : "", body.tone ? `Requested tone: ${body.tone}` : ""].filter(Boolean).join("\n");
}

async function scopedBook(app: FastifyInstance, req: FastifyRequest, edit = false) {
  const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
  const user = app.supabaseFactory(req.userToken);
  const { book } = await loadBook(user, bookId, req.userId, edit);
  if (edit) {
    const role = await requireWorkspaceEditor(user, book.workspace_id, req.userId);
    if (!roles.has(role)) throw new AppError(403, "Writing access is required for paid metadata generation.");
  }
  return { book: book as Book, bookId, user };
}

function boundedBible(rows: Record<string, unknown>[]) {
  const result: Record<string, unknown>[] = [];
  let bytes = 20_000;
  for (const row of rows.slice(0, 50)) {
    const candidate = {
      id: row.id, type: row.type, name: String(row.name ?? "").slice(0, 320),
      description: String(row.description ?? "").slice(0, 2_000),
      attributes: row.attributes_json && typeof row.attributes_json === "object" ? row.attributes_json : {},
      sourceRefs: Array.isArray(row.source_refs_json) ? row.source_refs_json.slice(0, 10) : [],
    };
    const size = Buffer.byteLength(JSON.stringify(candidate));
    if (size > bytes) break;
    bytes -= size;
    result.push(candidate);
  }
  return result;
}

async function quoteContext(user: SupabaseClient, book: Book, body: z.infer<typeof quoteRequestBody>) {
  let query = user.from("chapters").select("id,title,order_index,current_document_version_id")
    .eq("book_id", book.id).order("order_index").limit(5);
  if (body.chapterIds) query = query.in("id", body.chapterIds);
  const { data: rows, error } = await query;
  if (error) throw new AppError(500, "Could not load manuscript evidence for token counting.");
  if (!rows?.length || (body.chapterIds && rows.length !== body.chapterIds.length)) {
    throw new AppError(422, "Choose saved chapters from this book before requesting a quote.");
  }
  const chapters: Record<string, unknown> = {};
  const chapterIds: string[] = [];
  let totalNodes = 0;
  const manuscriptBytes = Math.min(30_000, Math.floor(body.maxTokens * 1.8));
  const chapterBytes = Math.max(1, Math.floor(manuscriptBytes / rows.length));
  for (const chapter of rows) {
    if (!chapter.current_document_version_id) continue;
    const { data: version, error: versionError } = await user.from("document_versions").select("id,version_number,content_json")
      .eq("id", chapter.current_document_version_id).eq("chapter_id", chapter.id).maybeSingle();
    if (versionError) throw new AppError(500, "Could not load the current manuscript version.");
    if (!version) continue;
    const nodes: { id: string; text: string; textHash: string; truncated: boolean }[] = [];
    let remaining = chapterBytes;
    for (const node of parseNodes(version.content_json)) {
      if (totalNodes >= 200 || remaining <= 0) break;
      const original = typeof node.text === "string" ? node.text.trim() : "";
      if (!original) continue;
      let text = original;
      while (Buffer.byteLength(text) > Math.min(30_000, remaining)) text = text.slice(0, -1);
      if (!text) continue;
      remaining -= Buffer.byteLength(text);
      nodes.push({ id: node.id, text, textHash: createHash("sha256").update(text).digest("hex"), truncated: text.length < original.length });
      totalNodes++;
    }
    if (nodes.length) {
      chapterIds.push(chapter.id);
      chapters[chapter.id] = { id: chapter.id, documentVersionId: version.id, version: version.version_number,
        title: chapter.title, order: chapter.order_index, nodes };
    }
  }
  if (!chapterIds.length) throw new AppError(422, "Add saved manuscript text before requesting a metadata quote.");
  const [{ data: bible, error: bibleError }, { data: style, error: styleError }] = await Promise.all([
    user.from("book_bible_items").select("id,type,name,description,attributes_json,source_refs_json")
      .eq("book_id", book.id).order("created_at").limit(50),
    user.from("style_guides").select("rules_json,tone,spelling_variant").eq("book_id", book.id).maybeSingle(),
  ]);
  if (bibleError || styleError) throw new AppError(500, "Could not load the approved book context.");
  return {
    chapterIds, chapters,
    book: { title: book.title, subtitle: book.subtitle ?? null, author: book.author_name, language: book.language },
    styleGuide: style ? { rules: style.rules_json, tone: style.tone, spellingVariant: style.spelling_variant } : {},
    bookBible: boundedBible((bible ?? []) as Record<string, unknown>[]), relatedContext: [],
    userInstruction: metadataInstruction(body),
  };
}

function rpcError(error: { code?: string }, action: string): never {
  if (error.code === "42501") throw new AppError(403, "Writing access is required for this metadata quote.");
  if (error.code === "P0002") throw new AppError(404, "Metadata quote request not found.");
  if (error.code === "54000") throw new AppError(429, "Too many metadata quote requests. Try again later.");
  if (["22023", "23514", "23505", "40001", "40P01"].includes(error.code ?? "")) {
    throw new AppError(409, "Metadata quote changed, expired, or conflicts with another request. Refresh before continuing.");
  }
  throw new AppError(503, action === "accept"
    ? "Could not confirm metadata quote acceptance. Recover this same request before trying again."
    : `Could not ${action} the metadata quote. No generation was started.`);
}

function publicRequest(row: QuoteRow) {
  return { id: row.id, status: row.status, createdAt: row.created_at,
    ...(row.error_code === "counting_outcome_unknown" ? { errorCode: row.error_code } : {}) };
}

function publicQuote(row: QuoteRow) {
  try {
    const quote = quoteUsage(row.usage_quote_json as UsageQuote);
    if (!isDeepStrictEqual(quote, row.usage_quote_json) || quote.scope.jobId !== row.generation_job_id || quote.scope.userId !== row.user_id
      || quote.scope.workspaceId !== row.workspace_id || quote.scope.inputSha256 !== row.generation_request_sha256
      || (row.accepted_job_id !== null && row.accepted_job_id !== row.generation_job_id)
      || !row.quote_expires_at || Date.parse(quote.expiresAt) !== Date.parse(row.quote_expires_at)) throw new Error("scope");
    // Rebuild from the immutable saved snapshot at quote time, never current
    // manuscript/catalog. This verifies expired/accepted recovery too.
    const saved = z.object({ model: z.string(), contextPolicy: z.object({ maxTokens: z.number() }).passthrough(), input: z.unknown() }).passthrough().parse(row.generation_request_json);
    const catalog = metadataQuoteCatalog(JSON.stringify(row.catalog_json), quote.createdAt);
    const entry = catalog.entries.find((item) => item.price.model === saved.model
      && isDeepStrictEqual(item.price, quote.price) && isDeepStrictEqual(item.policy, quote.policy));
    if (!entry) throw new Error("catalog binding");
    const prepared = buildMetadataGenerationRequest({ rawCatalog: JSON.stringify(row.catalog_json), modelId: entry.id,
      scope: { jobId: row.generation_job_id, workspaceId: row.workspace_id, userId: row.user_id, bookId: row.book_id },
      context: saved.input, maxTokens: saved.contextPolicy.maxTokens, allowProviderTokenCounting: true }, quote.createdAt);
    const maximum = new Map(quote.maximumTokens.map((quantity) => [quantity.dimension, quantity.tokens]));
    if (!isDeepStrictEqual(prepared.generationRequest, row.generation_request_json) || maximum.size !== 3
      || !maximum.has("text_input") || BigInt(maximum.get("text_input")!) <= 0n
      || BigInt(maximum.get("text_input")!) > BigInt(entry.maxInputTokens)
      || maximum.get("text_cached_input") !== maximum.get("text_input")
      || maximum.get("text_output") !== String(entry.maxOutputTokens)
      || BigInt(quote.reservedCredits) > 2147483647n
      || Date.parse(quote.expiresAt) > Math.min(Date.parse(catalog.expiresAt), Date.parse(quote.createdAt) + catalog.quoteLifetimeSeconds * 1000)) throw new Error("quote bounds");
    return { id: row.id, model: quote.price.model, reservedCredits: Number(quote.reservedCredits),
      expiresAt: row.quote_expires_at, status: row.accepted_job_id ? "accepted" : Date.parse(row.quote_expires_at) <= Date.now() ? "expired" : "ready",
      acceptedJobId: row.accepted_job_id };
  } catch { throw new AppError(503, "Metadata quote is unavailable."); }
}

async function requestForUser(service: SupabaseClient, requestId: string, userId: string, bookId: string, workspaceId: string) {
  const { data, error } = await service.from("metadata_token_quote_requests").select("*")
    .eq("id", requestId).eq("user_id", userId).eq("book_id", bookId).maybeSingle();
  if (error) throw new AppError(503, "Could not recover metadata quote status.");
  if (!data) throw new AppError(404, "Metadata quote request not found.");
  if (data.id !== requestId || data.user_id !== userId || data.book_id !== bookId || data.workspace_id !== workspaceId) {
    throw new AppError(503, "Metadata quote identity could not be verified.");
  }
  return data as QuoteRow;
}

async function savedQuoteStatus(service: SupabaseClient, saved: QuoteRow) {
  const quote = saved.status === "ready" ? publicQuote(saved) : null;
  let job: { id: string; status: string; errorCode?: string } | null = null;
  let candidate: unknown = null;
  if (saved.accepted_job_id) {
    const { data, error } = await service.from("ai_jobs").select("id,status,error_code,output_ref,workspace_id,book_id,created_by,agent_type,billing_mode")
      .eq("id", saved.accepted_job_id).eq("book_id", saved.book_id).eq("created_by", saved.user_id).eq("agent_type", "metadata").maybeSingle();
    if (error || !data || data.id !== saved.generation_job_id || data.workspace_id !== saved.workspace_id
      || data.book_id !== saved.book_id || data.created_by !== saved.user_id || data.agent_type !== "metadata"
      || data.billing_mode !== "quoted" || !["queued", "running", "succeeded", "failed", "cancelled"].includes(data.status)) {
      throw new AppError(503, "Could not recover metadata generation status.");
    }
    job = { id: data.id, status: data.status,
      ...(typeof data.error_code === "string" && ["metadata_generation_requires_review", "metadata_source_changed_before_dispatch",
        "metadata_request_mismatch_before_dispatch", "metadata_quote_expired_before_dispatch", "metadata_permission_revoked_before_dispatch"].includes(data.error_code) ? { errorCode: data.error_code } : {}) };
    if (data.status === "succeeded") {
      candidate = candidateFromJob(data);
      if (!candidate) throw new AppError(503, "The saved metadata result could not be verified.");
    }
  }
  return { request: publicRequest(saved), quote, ...(job ? { job, candidate } : {}) };
}

export function metadataQuoteRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  app.get("/books/:bookId/metadata/models", async (req, reply) => {
    await scopedBook(app, req);
    const now = new Date().toISOString();
    const catalog = metadataQuoteCatalog(process.env.METADATA_PRICING_CATALOG_JSON, now);
    reply.header("cache-control", "private, no-store");
    return { catalogVersion: catalog.version, models: catalog.entries.map((entry) => ({
      id: entry.id, label: entry.label, model: entry.price.model,
      priceVersion: entry.price.version, policyVersion: entry.policy.version,
    })) };
  });

  app.post("/books/:bookId/metadata/quotes", async (req, reply) => {
    const body = parse(quoteRequestBody, req.body, "Choose a model and explicitly consent to provider token counting.");
    const { book, bookId, user } = await scopedBook(app, req, true);
    const service = app.supabaseFactory();
    const prior = await service.from("metadata_token_quote_requests").select("*")
      .eq("user_id", req.userId).eq("idempotency_key", body.idempotencyKey).maybeSingle();
    if (prior.error) throw new AppError(503, "Could not verify the metadata quote request key.");
    const existing = prior.data as QuoteRow | null;
    if (existing && (existing.book_id !== bookId || existing.workspace_id !== book.workspace_id)) {
      throw new AppError(409, "That metadata request key is already in use.");
    }
    if (existing) {
      const saved = z.object({ model: z.string(), contextPolicy: z.object({ maxTokens: z.number() }).passthrough(),
        input: z.object({ chapterIds: z.array(id), userInstruction: z.string() }).passthrough() }).passthrough().safeParse(existing.generation_request_json);
      const entries = z.object({ entries: z.array(z.object({ id: z.string(), price: z.object({ model: z.string() }).passthrough() }).passthrough()) }).passthrough().safeParse(existing.catalog_json);
      const entry = entries.success ? entries.data.entries.find((item) => item.id === body.modelId) : null;
      if (existing.user_id !== req.userId || !saved.success || !entry || entry.price.model !== saved.data.model
        || saved.data.contextPolicy.maxTokens !== body.maxTokens || saved.data.input.userInstruction !== metadataInstruction(body)
        || (body.chapterIds && !isDeepStrictEqual([...body.chapterIds].sort(), [...saved.data.input.chapterIds].sort()))) {
        throw new AppError(409, "The saved quote key belongs to different model settings. Recover the original offer instead.");
      }
      reply.header("cache-control", "private, no-store");
      return reply.status(existing.status === "counting" ? 202 : 200).send(await savedQuoteStatus(service, existing));
    }
    const generationJobId = randomUUID();
    const context = await quoteContext(user, book, body);
    const rawCatalog = process.env.METADATA_PRICING_CATALOG_JSON;
    const input = { rawCatalog, modelId: body.modelId,
      scope: { jobId: generationJobId, workspaceId: book.workspace_id, userId: req.userId, bookId },
      context, maxTokens: body.maxTokens, allowProviderTokenCounting: body.allowProviderTokenCounting };
    const now = new Date().toISOString();
    const prepared = buildMetadataGenerationRequest(input, now);
    const requested = await service.rpc("request_metadata_token_quote", {
      p_user_id: req.userId, p_book_id: bookId, p_workspace_id: book.workspace_id, p_generation_job_id: generationJobId,
      p_generation_request: prepared.generationRequest, p_catalog: prepared.catalog,
      p_idempotency_key: body.idempotencyKey, p_provider_counting_consent: true,
    });
    if (requested.error) rpcError(requested.error, "prepare");
    const saved = one(requested.data) as QuoteRow | null;
    if (!saved?.id || saved.user_id !== req.userId || saved.book_id !== bookId || saved.generation_job_id !== generationJobId) {
      // Another request won the key race. It may be polled, never recounted here.
      throw new AppError(409, "This quote key was claimed concurrently. Recover its saved request before retrying.");
    }
    let counted;
    try {
      counted = await prepareMetadataQuote(input, { fetcher: options.fetcher });
      if (!isDeepStrictEqual(counted.generationRequest, prepared.generationRequest)
        || counted.sourceSha256 !== prepared.sourceSha256) {
        throw new AppError(503, "Metadata request changed after it was saved for token counting.");
      }
      const completed = await service.rpc("complete_metadata_token_quote_count", {
        p_request_id: saved.id, p_user_id: req.userId, p_lease_token: saved.lease_token,
        p_generation_request_sha256: counted.quote.scope.inputSha256, p_usage_quote: counted.quote,
      });
      if (completed.error) rpcError(completed.error, "complete");
      const final = await requestForUser(service, saved.id, req.userId, bookId, book.workspace_id);
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send({ request: publicRequest(final), quote: publicQuote(final) });
    } catch (error) {
      await service.rpc("fail_metadata_token_quote_count", { p_request_id: saved.id, p_user_id: req.userId, p_lease_token: saved.lease_token });
      throw error;
    }
  });

  app.post("/books/:bookId/metadata/quotes/recover", async (req, reply) => {
    const body = parse(z.object({ idempotencyKey: z.string().trim().min(8).max(200) }).strict(), req.body, "The original metadata request key is required.");
    const { bookId, book } = await scopedBook(app, req);
    const service = app.supabaseFactory();
    const found = await service.from("metadata_token_quote_requests").select("*").eq("user_id", req.userId)
      .eq("book_id", bookId).eq("workspace_id", book.workspace_id).eq("idempotency_key", body.idempotencyKey).maybeSingle();
    if (found.error) throw new AppError(503, "Could not recover metadata quote status. Keep the original request key.");
    if (!found.data) throw new AppError(404, "No saved metadata quote was found for this request key.");
    if (!id.safeParse(found.data.id).success || found.data.user_id !== req.userId || found.data.book_id !== bookId
      || found.data.workspace_id !== book.workspace_id || found.data.idempotency_key !== body.idempotencyKey) {
      throw new AppError(503, "Metadata quote identity could not be verified.");
    }
    reply.header("cache-control", "private, no-store");
    return savedQuoteStatus(service, found.data as QuoteRow);
  });

  app.get("/books/:bookId/metadata/quote-requests/:requestId", async (req, reply) => {
    const requestId = parse(id, (req.params as { requestId: string }).requestId, "Valid quote request ID required.");
    const { bookId, book } = await scopedBook(app, req);
    const service = app.supabaseFactory();
    const saved = await requestForUser(service, requestId, req.userId, bookId, book.workspace_id);
    reply.header("cache-control", "private, no-store");
    return savedQuoteStatus(service, saved);
  });

  app.post("/books/:bookId/metadata/quotes/:requestId/accept", async (req, reply) => {
    const requestId = parse(id, (req.params as { requestId: string }).requestId, "Valid quote ID required.");
    const body = parse(acceptBody, req.body, "Confirm the exact metadata credit total.");
    const { bookId, book } = await scopedBook(app, req, true);
    const saved = await requestForUser(app.supabaseFactory(), requestId, req.userId, bookId, book.workspace_id);
    if (saved.status !== "ready") throw new AppError(409, "A ready metadata quote is required before acceptance.");
    const quote = publicQuote(saved);
    if (quote.reservedCredits !== body.expectedCredits) throw new AppError(409, "Confirm the exact saved metadata credit total.");
    const accepted = await app.supabaseFactory().rpc("accept_metadata_token_quote", {
      p_request_id: requestId, p_user_id: req.userId, p_expected_credits: body.expectedCredits,
    });
    if (accepted.error) rpcError(accepted.error, "accept");
    const job = z.object({ id, status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
      workspace_id: id, book_id: id, created_by: id, agent_type: z.literal("metadata"), billing_mode: z.literal("quoted"),
    }).safeParse(one(accepted.data));
    if (!job.success || job.data.id !== saved.generation_job_id || job.data.workspace_id !== saved.workspace_id
      || job.data.book_id !== saved.book_id || job.data.created_by !== saved.user_id) {
      throw new AppError(503, "Could not confirm metadata quote acceptance. Recover this same request before trying again.");
    }
    reply.header("cache-control", "private, no-store");
    return reply.status(202).send({ jobId: job.data.id, status: job.data.status });
  });
}
