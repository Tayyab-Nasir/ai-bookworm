import type { FastifyInstance, FastifyRequest } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember } from "../lib/authorize.js";
import { availableStoryBlueprintModels, storyBlueprintCatalogSnapshot } from "../lib/story-blueprint-pricing.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { quoteUsage, type UsageQuote } from "../lib/usage-pricing.js";
import { storyBlueprintCandidateSchema, storyBlueprintSourceSnapshotSchema } from "../lib/story-blueprint-generation-contract.js";
import { storyBlueprintRpcError } from "./story-blueprints.js";

const id = z.string().uuid();
const authorRoles = new Set(["owner", "admin", "editor", "writer"]);
const proposalRequestBody = z.object({
  modelId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  idempotencyKey: z.string().trim().min(8).max(200),
  // Exact counting sends the saved blueprint snapshot to OpenAI. Consent must
  // be explicit even though it is not text generation and cannot publish.
  allowProviderTokenCounting: z.literal(true),
}).strict();
const acceptanceBody = z.object({ expectedCredits: z.number().int().positive().max(2147483647) }).strict();
const applyBody = z.object({ expectedRevision: z.number().int().min(1) }).strict();
const requestSchema = z.object({
  id, user_id: id, workspace_id: id, book_id: id, blueprint_id: id, source_revision: z.number().int().min(1),
  source_snapshot_json: z.unknown(), source_sha256: z.string().regex(/^[a-f0-9]{64}$/), catalog_json: z.unknown(),
  generation_job_id: id, status: z.enum(["queued", "counting", "ready", "failed"]),
}).passthrough();
const proposalSchema = z.object({
  id, request_id: id, user_id: id, workspace_id: id, book_id: id, blueprint_id: id,
  source_revision: z.number().int().min(1), source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation_request_sha256: z.string().regex(/^[a-f0-9]{64}$/), generation_job_id: id,
  usage_quote_json: z.unknown(), reserved_credits: z.number().int().positive().max(2147483647),
  expires_at: z.string().datetime(), accepted_at: z.string().datetime().nullable(), accepted_job_id: id.nullable(),
}).passthrough();

type BookScope = { id: string; workspace_id: string; title: string; author_name: string; language: string };

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, message: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, message, { issues: result.error.issues });
  return result.data;
}

function one(value: unknown) {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item) throw new AppError(503, "Story Blueprint quote storage returned no result.");
  return item;
}

async function scopedBook(app: FastifyInstance, req: FastifyRequest, edit = false) {
  const bookId = parse(id, (req.params as { bookId: string }).bookId, "Valid book ID required.");
  const sb = app.supabaseFactory(req.userToken);
  const { data, error } = await sb.from("books").select("id,workspace_id,title,author_name,language").eq("id", bookId).maybeSingle();
  const book = data as BookScope | null;
  if (error) throw new AppError(500, "Could not load this book.");
  if (!book) throw new AppError(404, "Book not found.");
  const role = await (edit ? requireWorkspaceEditor : requireWorkspaceMember)(sb, book.workspace_id, req.userId);
  if (edit && !authorRoles.has(role)) throw new AppError(403, "Writing access is required for paid Story Blueprint proposals.");
  return { sb, book, bookId, role };
}

function safeProposal(value: unknown, now = Date.now()) {
  const row = proposalSchema.safeParse(value);
  if (!row.success) throw new AppError(503, "Story Blueprint quote is unavailable.");
  let quote: UsageQuote;
  try {
    quote = quoteUsage(row.data.usage_quote_json as UsageQuote);
    if (!isDeepStrictEqual(quote, row.data.usage_quote_json)
      || quote.scope.jobId !== row.data.generation_job_id
      || quote.scope.userId !== row.data.user_id
      || quote.scope.workspaceId !== row.data.workspace_id
      || quote.scope.inputSha256 !== row.data.generation_request_sha256
      || quote.reservedCredits !== String(row.data.reserved_credits)) throw new Error("mismatch");
  } catch { throw new AppError(503, "Story Blueprint quote is unavailable."); }
  const expires = Date.parse(row.data.expires_at);
  if (!Number.isFinite(expires)) throw new AppError(503, "Story Blueprint quote is unavailable.");
  return {
    id: row.data.id, requestId: row.data.request_id, sourceRevision: row.data.source_revision,
    model: quote.price.model, reservedCredits: row.data.reserved_credits, expiresAt: row.data.expires_at,
    acceptedJobId: row.data.accepted_job_id,
    status: row.data.accepted_job_id ? "accepted" : expires <= now ? "expired" : "ready",
  } as const;
}

function safeQuoteRequest(value: unknown) {
  const row = requestSchema.safeParse(value);
  if (!row.success) throw new AppError(503, "Story Blueprint quote request is unavailable.");
  return { id: row.data.id, status: row.data.status } as const;
}

async function proposalForRequest(service: SupabaseClient, requestId: string) {
  const { data, error } = await service.from("story_blueprint_quote_proposals").select("*").eq("request_id", requestId).maybeSingle();
  if (error) throw new AppError(503, "Could not load the Story Blueprint quote.");
  return data;
}

async function quoteRequestForUser(service: SupabaseClient, requestId: string, userId: string, bookId: string) {
  const { data, error } = await service.from("story_blueprint_quote_requests").select("*")
    .eq("id", requestId).eq("user_id", userId).eq("book_id", bookId).maybeSingle();
  if (error) throw new AppError(503, "Could not load the Story Blueprint quote request.");
  if (!data) throw new AppError(404, "Story Blueprint quote request not found.");
  return requestSchema.parse(data);
}

async function proposalForUser(service: SupabaseClient, proposalId: string, userId: string, bookId: string) {
  const { data, error } = await service.from("story_blueprint_quote_proposals").select("*")
    .eq("id", proposalId).eq("user_id", userId).eq("book_id", bookId).maybeSingle();
  if (error) throw new AppError(503, "Could not load the Story Blueprint quote.");
  if (!data) throw new AppError(404, "Story Blueprint quote not found.");
  return proposalSchema.parse(data);
}

type ProposalReviewStatus = "pending" | "ready" | "requires_review" | "failed";

async function proposalReviewStatus(service: SupabaseClient, acceptedJobId: string | null): Promise<ProposalReviewStatus> {
  if (!acceptedJobId) return "pending";
  const [fundedResult, jobResult] = await Promise.all([
    service.from("funded_usage_quotes").select("status").eq("job_id", acceptedJobId).maybeSingle(),
    service.from("ai_jobs").select("status").eq("id", acceptedJobId).maybeSingle(),
  ]);
  if (fundedResult.error || jobResult.error) throw new AppError(503, "Could not confirm Story Blueprint billing.");
  const billing = (fundedResult.data as { status?: unknown } | null)?.status;
  const job = (jobResult.data as { status?: unknown } | null)?.status;
  if (billing === "requires_review") return "requires_review";
  if (job === "failed") return "failed";
  // A settled receipt alone is not public review output. The completion RPC
  // must also clear the lease and mark the private-candidate job succeeded.
  return billing === "settled" && job === "succeeded" ? "ready" : "pending";
}

function quoteRpcError(error: { code?: string }) {
  if (error.code === "42501") throw new AppError(403, "Writing access is required for this Story Blueprint quote.");
  if (error.code === "P0002") throw new AppError(422, "Save a Story Blueprint before requesting an AI proposal.");
  if (error.code === "23505") throw new AppError(409, "This quote request conflicts with a saved request. Retry with its original key.");
  if (error.code === "54000") throw new AppError(429, "Too many Story Blueprint quote requests. Try again later.");
  if (["22023", "23514", "40001", "40P01"].includes(error.code ?? "")) {
    throw new AppError(409, "Story Blueprint quote changed or expired. Refresh before confirming it.");
  }
  throw new AppError(503, "Story Blueprint quote storage is unavailable. No generation was started.");
}

export function storyBlueprintProposalRoutes(app: FastifyInstance) {
  app.get("/books/:bookId/story-blueprint/models", async (req, reply) => {
    await scopedBook(app, req);
    reply.header("cache-control", "private, no-store");
    return availableStoryBlueprintModels(process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON, new Date().toISOString());
  });

  app.post("/books/:bookId/story-blueprint/quotes", async (req, reply) => {
    const body = parse(proposalRequestBody, req.body, "Choose a model and consent to provider token counting.");
    const { bookId } = await scopedBook(app, req, true);
    const now = new Date().toISOString();
    const catalog = storyBlueprintCatalogSnapshot(process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON, { modelId: body.modelId, now });
    const service = app.supabaseFactory();
    const queued = await service.rpc("request_story_blueprint_quote", {
      p_book_id: bookId, p_user_id: req.userId, p_catalog_json: catalog, p_idempotency_key: body.idempotencyKey,
    });
    if (queued.error) quoteRpcError(queued.error);
    const quoteRequest = requestSchema.safeParse(one(queued.data));
    if (!quoteRequest.success || quoteRequest.data.user_id !== req.userId || quoteRequest.data.book_id !== bookId) {
      throw new AppError(503, "Story Blueprint quote storage returned an invalid request.");
    }
    const existing = await proposalForRequest(service, quoteRequest.data.id);
    reply.header("cache-control", "private, no-store");
    if (existing) {
      return { request: safeQuoteRequest(quoteRequest.data), proposal: safeProposal(existing) };
    }
    return reply.status(202).send({ request: safeQuoteRequest(quoteRequest.data), proposal: null });
  });

  app.get("/books/:bookId/story-blueprint/quote-requests/:requestId", async (req, reply) => {
    const requestId = parse(id, (req.params as { requestId: string }).requestId, "Valid Story Blueprint quote request ID required.");
    const { bookId } = await scopedBook(app, req);
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const quoteRequest = await quoteRequestForUser(service, requestId, req.userId, bookId);
    const proposal = await proposalForRequest(service, quoteRequest.id);
    return { request: safeQuoteRequest(quoteRequest), proposal: proposal ? safeProposal(proposal) : null };
  });

  app.get("/books/:bookId/story-blueprint/quotes/:proposalId", async (req, reply) => {
    const proposalId = parse(id, (req.params as { proposalId: string }).proposalId, "Valid Story Blueprint quote ID required.");
    const { bookId } = await scopedBook(app, req);
    const proposal = await proposalForUser(app.supabaseFactory(), proposalId, req.userId, bookId);
    reply.header("cache-control", "private, no-store");
    return { proposal: safeProposal(proposal) };
  });

  app.post("/books/:bookId/story-blueprint/quotes/:proposalId/accept", async (req, reply) => {
    const proposalId = parse(id, (req.params as { proposalId: string }).proposalId, "Valid Story Blueprint quote ID required.");
    const body = parse(acceptanceBody, req.body, "Confirm the exact Story Blueprint credit total.");
    const { bookId } = await scopedBook(app, req, true);
    await proposalForUser(app.supabaseFactory(), proposalId, req.userId, bookId);
    const accepted = await app.supabaseFactory().rpc("accept_story_blueprint_quote", {
      p_proposal_id: proposalId, p_user_id: req.userId, p_expected_credits: body.expectedCredits,
    });
    if (accepted.error) quoteRpcError(accepted.error);
    const job = one(accepted.data) as { id?: unknown; status?: unknown };
    if (!id.safeParse(job.id).success || !["queued", "running", "succeeded", "failed"].includes(String(job.status))) {
      throw new AppError(503, "Could not confirm Story Blueprint generation. Retry this same quote.");
    }
    reply.header("cache-control", "private, no-store");
    return reply.status(202).send({ jobId: job.id, status: job.status });
  });

  app.get("/books/:bookId/story-blueprint/proposals/:proposalId", async (req, reply) => {
    const proposalId = parse(id, (req.params as { proposalId: string }).proposalId, "Valid Story Blueprint proposal ID required.");
    const { bookId } = await scopedBook(app, req);
    reply.header("cache-control", "private, no-store");
    const proposal = await proposalForUser(app.supabaseFactory(), proposalId, req.userId, bookId);
    const reviewStatus = await proposalReviewStatus(app.supabaseFactory(), proposal.accepted_job_id);
    const { data, error } = await app.supabaseFactory().from("story_blueprint_generation_results").select("candidate_json")
      .eq("proposal_id", proposalId).maybeSingle();
    if (error) throw new AppError(503, "Could not load Story Blueprint proposal output.");
    if (!data) {
      if (reviewStatus === "ready") throw new AppError(503, "Story Blueprint proposal output is unavailable.");
      return { proposal: safeProposal(proposal), candidate: null, reviewStatus };
    }
    const candidate = storyBlueprintCandidateSchema.safeParse((data as { candidate_json?: unknown }).candidate_json);
    if (!candidate.success) throw new AppError(503, "Story Blueprint proposal output is unavailable.");
    // Generation results are not reviewable until the worker settled the
    // funded quote and completed the job. This fails closed on any unknown state.
    if (reviewStatus !== "ready") {
      return { proposal: safeProposal(proposal), candidate: null, reviewStatus };
    }
    return { proposal: safeProposal(proposal), candidate: candidate.data, reviewStatus };
  });

  app.post("/books/:bookId/story-blueprint/proposals/:proposalId/apply", async (req, reply) => {
    const proposalId = parse(id, (req.params as { proposalId: string }).proposalId, "Valid Story Blueprint proposal ID required.");
    const body = parse(applyBody, req.body, "Use the source revision shown with this Story Blueprint proposal.");
    const { sb, bookId } = await scopedBook(app, req, true);
    const proposal = await proposalForUser(app.supabaseFactory(), proposalId, req.userId, bookId);
    if (body.expectedRevision !== proposal.source_revision) {
      throw new AppError(409, "This proposal was based on a different Story Blueprint revision. Reload before applying it.");
    }
    const { data, error } = await app.supabaseFactory().from("story_blueprint_generation_results").select("candidate_json")
      .eq("proposal_id", proposalId).maybeSingle();
    if (error || !data) throw new AppError(409, "Story Blueprint proposal is not ready to apply.");
    const candidate = storyBlueprintCandidateSchema.safeParse((data as { candidate_json?: unknown }).candidate_json);
    if (!candidate.success) throw new AppError(503, "Story Blueprint proposal output is unavailable.");
    if (await proposalReviewStatus(app.supabaseFactory(), proposal.accepted_job_id) !== "ready") {
      throw new AppError(409, "Story Blueprint billing is not settled for review.");
    }
    const source = storyBlueprintSourceSnapshotSchema.safeParse(proposal.source_snapshot_json);
    if (!source.success) throw new AppError(503, "Story Blueprint proposal source is unavailable.");
    const materialized = await sb.from("story_blueprint_materializations").select("blueprint_chapter_id")
      .eq("blueprint_id", proposal.blueprint_id);
    if (materialized.error) throw new AppError(503, "Could not verify Story Blueprint materializations.");
    const lockedIds = (materialized.data ?? []).map((row) => (row as { blueprint_chapter_id?: unknown }).blueprint_chapter_id)
      .filter((value): value is string => id.safeParse(value).success);
    for (const lockedId of lockedIds) {
      const original = source.data.chapterPlan.find((item) => item.id === lockedId);
      const proposed = candidate.data.chapterPlan.find((item) => item.id === lockedId);
      if (!original || !proposed || !isDeepStrictEqual(original, proposed)) {
        throw new AppError(409, "This AI proposal changes a materialized chapter plan item. Keep that item unchanged or merge the proposal manually.");
      }
    }
    const saved = await sb.rpc("save_story_blueprint", {
      p_book_id: bookId, p_expected_revision: proposal.source_revision,
      p_details: candidate.data.story, p_chapters: candidate.data.chapterPlan,
    });
    if (saved.error) storyBlueprintRpcError(saved.error);
    const stored = one(saved.data) as { revision?: unknown };
    if (!Number.isSafeInteger(stored.revision)) throw new AppError(503, "Story Blueprint apply returned no saved revision.");
    reply.header("cache-control", "private, no-store");
    return { applied: true, revision: stored.revision };
  });
}
