/** Immutable offers and explicit atomic chapter acceptance. Purchases are
 * disabled by default; these routes never dispatch a provider request. */
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceMember } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { REALTIME_NARRATION_VOICES } from "../lib/realtime-narration.js";
import { availableNarrationModels, readNarrationCatalog, narrationPromptHash, narrationQuoteRequestSchema,
  narrationRequestHash, narrationJobId, narrationChapterSegmentKey, prepareNarrationQuote, prepareNarrationChapterQuote, validatedNarrationQuote } from "../lib/narration-pricing.js";
import { segmentSpeechText } from "../lib/speech-generation.js";

const id = z.string().uuid();
const key = z.string().min(8).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bodySchema = z.object({ editionId: id, chapterId: id, modelId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  idempotencyKey: key, segmentIndex: z.number().int().min(0).max(249), voice: z.enum(REALTIME_NARRATION_VOICES),
  speed: z.number().min(0.25).max(1.5).refine(value => /^\d+(?:\.\d{1,2})?$/u.test(String(value))),
  instructions: narrationQuoteRequestSchema.innerType().shape.instructions.default(null), consentToQuoteStorage: z.literal(true),
}).strict();
const chapterBodySchema = bodySchema.omit({ segmentIndex: true });
const acceptanceBodySchema = z.object({
  expectedCredits: z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value => Number(value) <= 2_147_483_647),
  consentToAiVoice: z.literal(true), consentToGenerate: z.literal(true),
}).strict();
const snapshotSchema = z.object({ id, user_id: id, workspace_id: id, book_id: id, edition_id: id, chapter_id: id,
  document_version_id: id, generation_job_id: id, request_sha256: hash, request_json: z.unknown(), quote_json: z.unknown(),
  catalog_version: z.string().min(1).max(128), model_option_id: z.string().min(1).max(64), idempotency_key: key,
  expires_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
}).passthrough();
const fields = "id,user_id,workspace_id,book_id,edition_id,chapter_id,document_version_id,generation_job_id,request_sha256,request_json,quote_json,catalog_version,model_option_id,idempotency_key,expires_at";
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
function savedOffer(value: unknown, scope: { workspaceId: string; userId: string }) {
  try {
    const row = snapshotSchema.parse(value);
    const request = narrationQuoteRequestSchema.parse(row.request_json);
    const quote = validatedNarrationQuote(row.quote_json, request);
    if (row.workspace_id !== scope.workspaceId || row.user_id !== scope.userId
      || row.generation_job_id !== request.jobId || row.user_id !== request.userId || row.workspace_id !== request.workspaceId
      || row.book_id !== request.bookId || row.edition_id !== request.editionId || row.chapter_id !== request.chapterId
      || row.document_version_id !== request.documentVersionId || row.request_sha256 !== narrationRequestHash(request)
      || !isDeepStrictEqual(row.quote_json, quote) || quote.scope.jobId !== row.generation_job_id
      || quote.scope.workspaceId !== row.workspace_id || quote.scope.userId !== row.user_id || quote.scope.inputSha256 !== row.request_sha256
      || quote.price.model !== request.model || Date.parse(quote.expiresAt) !== Date.parse(row.expires_at)
      || BigInt(quote.reservedCredits) > 2_147_483_647n) throw new Error("identity mismatch");
    return { row, request, quote };
  } catch { throw new AppError(503, "Saved narration offer could not be verified. Keep the original request key."); }
}
function publicOffer(saved: ReturnType<typeof savedOffer>) {
  const { row, request, quote } = saved;
  return { quoteId: row.id, purchaseAvailable: false as const, pricingBasis: "maximum_token_budget" as const,
    modelId: row.model_option_id, model: request.model, voice: request.voice, speed: request.speed,
    source: { bookId: row.book_id, editionId: row.edition_id, chapterId: row.chapter_id,
      documentVersionId: row.document_version_id, segmentIndex: request.segmentIndex, textStart: request.textStart, textEnd: request.textEnd },
    reservedCredits: quote.reservedCredits, priceVersion: quote.price.version, policyVersion: quote.policy.version,
    expiresAt: quote.expiresAt, expired: Date.now() >= Date.parse(quote.expiresAt) };
}
async function sourceChapter(user: SupabaseClient, workspaceId: string, input: { editionId: string; chapterId: string }) {
  const edition = await user.from("editions").select("id,book_id,type").eq("id", input.editionId).maybeSingle();
  if (edition.error) throw new AppError(503, "Narration edition is unavailable.");
  if (!edition.data || edition.data.id !== input.editionId || edition.data.type !== "audiobook" || !id.safeParse(edition.data.book_id).success) {
    throw new AppError(404, "Audiobook edition not found.");
  }
  const book = await user.from("books").select("id,workspace_id").eq("id", edition.data.book_id).eq("workspace_id", workspaceId).maybeSingle();
  if (book.error) throw new AppError(503, "Narration book is unavailable.");
  if (!book.data || book.data.id !== edition.data.book_id || book.data.workspace_id !== workspaceId) throw new AppError(404, "Narration book not found.");
  const chapter = await user.from("chapters").select("id,book_id,current_document_version_id")
    .eq("id", input.chapterId).eq("book_id", book.data.id).maybeSingle();
  if (chapter.error) throw new AppError(503, "Saved narration chapter is unavailable.");
  if (!chapter.data || chapter.data.id !== input.chapterId || chapter.data.book_id !== book.data.id
    || !id.safeParse(chapter.data.current_document_version_id).success) throw new AppError(404, "Saved narration chapter not found.");
  const versionId = chapter.data.current_document_version_id;
  const document = await user.from("document_versions").select("id,chapter_id,plain_text").eq("id", versionId).eq("chapter_id", input.chapterId).maybeSingle();
  if (document.error) throw new AppError(503, "Saved narration text is unavailable.");
  if (!document.data || document.data.id !== versionId || document.data.chapter_id !== input.chapterId
    || typeof document.data.plain_text !== "string" || document.data.plain_text.length > 1_000_000) throw new AppError(422, "Save a supported chapter before requesting narration.");
  return { bookId: book.data.id as string, documentVersionId: versionId as string, plainText: document.data.plain_text as string };
}

const chapterFields = "id,user_id,workspace_id,book_id,edition_id,chapter_id,document_version_id,source_sha256,idempotency_key,catalog_version,model_option_id,voice,speed,instructions,segment_count,reserved_credits,expires_at";
const chapterSnapshotSchema = z.object({ id, user_id: id, workspace_id: id, book_id: id, edition_id: id, chapter_id: id,
  document_version_id: id, source_sha256: hash, idempotency_key: key, catalog_version: z.string().min(1).max(128),
  model_option_id: bodySchema.shape.modelId, voice: bodySchema.shape.voice, speed: bodySchema.shape.speed,
  instructions: narrationQuoteRequestSchema.innerType().shape.instructions, segment_count: z.number().int().min(1).max(250),
  reserved_credits: z.number().int().positive().max(2_147_483_647), expires_at: snapshotSchema.shape.expires_at,
}).passthrough();
async function savedChapterOffer(service: SupabaseClient, value: unknown, scope: { workspaceId: string; userId: string }) {
  try {
    const row = chapterSnapshotSchema.parse(value);
    if (row.workspace_id !== scope.workspaceId || row.user_id !== scope.userId) throw new Error("chapter scope mismatch");
    const found = await service.from("narration_chapter_quote_segments").select(`segment_index,quote:narration_quote_snapshots(${fields})`)
      .eq("chapter_quote_id", row.id).order("segment_index", { ascending: true });
    if (found.error || !Array.isArray(found.data) || found.data.length !== row.segment_count) throw new Error("chapter segments unavailable");
    const children = found.data.map((entry: unknown, index: number) => {
      const link = z.object({ segment_index: z.number().int(), quote: z.unknown() }).parse(entry);
      const child = savedOffer(link.quote, scope);
      const childKey = narrationChapterSegmentKey(row.idempotency_key, index);
      if (child.row.idempotency_key !== childKey || child.request.jobId !== narrationJobId(row.user_id, childKey)
        || link.segment_index !== index || child.request.segmentIndex !== index || child.row.book_id !== row.book_id
        || child.row.edition_id !== row.edition_id || child.row.chapter_id !== row.chapter_id
        || child.row.document_version_id !== row.document_version_id || child.row.catalog_version !== row.catalog_version
        || child.row.model_option_id !== row.model_option_id || child.request.voice !== row.voice || child.request.speed !== row.speed
        || child.request.instructions !== row.instructions || Date.parse(child.quote.expiresAt) !== Date.parse(row.expires_at)) {
        throw new Error("chapter segment identity mismatch");
      }
      return child;
    });
    const firstChild = children[0]!;
    let previousEnd = 0;
    for (const child of children) {
      if (child.request.textStart < previousEnd || child.request.model !== firstChild.request.model
        || child.request.maxOutputTokens !== firstChild.request.maxOutputTokens
        || !isDeepStrictEqual(child.quote.price, firstChild.quote.price) || !isDeepStrictEqual(child.quote.policy, firstChild.quote.policy)
        || child.quote.createdAt !== firstChild.quote.createdAt) throw new Error("chapter profile mismatch");
      previousEnd = child.request.textEnd;
    }
    if (new Set(children.map(child => child.row.id)).size !== children.length
      || new Set(children.map(child => child.request.jobId)).size !== children.length
      || children.reduce((sum, child) => sum + BigInt(child.quote.reservedCredits), 0n) !== BigInt(row.reserved_credits)) {
      throw new Error("chapter maximum credit budget mismatch");
    }
    return { row, children };
  } catch { throw new AppError(503, "Saved chapter narration offer could not be verified. Keep the original request key."); }
}
type ChapterOffer = Awaited<ReturnType<typeof savedChapterOffer>>;
function matchingPurchaseCatalog(saved: ChapterOffer): ReturnType<typeof readNarrationCatalog> | null {
  if (process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED !== "true" || Date.now() >= Date.parse(saved.row.expires_at)) return null;
  try {
    const catalog = readNarrationCatalog(process.env.NARRATION_PRICING_CATALOG_JSON, new Date().toISOString());
    const entry = catalog.entries.find(item => item.id === saved.row.model_option_id);
    if (catalog.version !== saved.row.catalog_version || !entry || saved.children.some(child =>
      child.request.model !== entry.price.model || child.request.maxOutputTokens !== entry.maxOutputTokens
      || !isDeepStrictEqual(child.quote.price, entry.price) || !isDeepStrictEqual(child.quote.policy, entry.policy)
      || Date.parse(child.quote.createdAt) < Date.parse(catalog.effectiveAt)
      || Date.parse(child.quote.expiresAt) > Date.parse(catalog.expiresAt)
      || Date.parse(child.quote.expiresAt) > Date.parse(child.quote.createdAt) + catalog.quoteLifetimeSeconds * 1_000)) return null;
    return catalog;
  } catch { return null; } // Closed pricing must not prevent original-offer recovery.
}
async function ownedChapterOffer(service: SupabaseClient, quoteId: string, workspaceId: string, userId: string) {
  const found = await service.from("narration_chapter_quote_snapshots").select(chapterFields)
    .eq("id", quoteId).eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (found.error) throw new AppError(503, "Chapter narration recovery is unavailable.");
  if (!found.data) throw new AppError(404, "Chapter narration quote not found.");
  const saved = await savedChapterOffer(service, found.data, { workspaceId, userId });
  if (saved.row.id !== quoteId) throw new AppError(503, "Chapter narration quote identity could not be verified.");
  return saved;
}
const projectFields = "id,workspace_id,book_id,edition_id,chapter_id,document_version_id,created_by,narration_quote_id,billing_mode,voice,speed,status,segment_count,credit_units,created_at";
const projectSchema = z.object({ id, workspace_id: id, book_id: id, edition_id: id, chapter_id: id, document_version_id: id,
  created_by: id, narration_quote_id: id, billing_mode: z.literal("quoted"), voice: bodySchema.shape.voice,
  speed: z.coerce.number().min(0.25).max(1.5), status: z.enum(["queued", "running", "succeeded", "failed"]),
  segment_count: z.number().int().min(1).max(250), credit_units: z.number().int().positive().max(2_147_483_647),
  created_at: snapshotSchema.shape.expires_at,
}).passthrough();
const acceptanceSchema = z.object({ quote_id: id, project_id: id, expected_credits: z.number().int().positive().max(2_147_483_647),
  ai_disclosure_accepted: z.literal(true), accepted_at: snapshotSchema.shape.expires_at }).passthrough();
const acceptanceUnknown = () => new AppError(503, "Chapter acceptance is unconfirmed. Recover this same quote; do not create another purchase.");
function checkedProject(value: unknown, saved: ChapterOffer) {
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success) throw acceptanceUnknown();
  const project = parsed.data, row = saved.row;
  if (project.workspace_id !== row.workspace_id || project.created_by !== row.user_id || project.narration_quote_id !== row.id
    || project.book_id !== row.book_id || project.edition_id !== row.edition_id || project.chapter_id !== row.chapter_id
    || project.document_version_id !== row.document_version_id || project.voice !== row.voice || project.speed !== row.speed
    || project.segment_count !== row.segment_count || project.credit_units !== row.reserved_credits) throw acceptanceUnknown();
  return project;
}
async function acceptedChapterProject(service: SupabaseClient, saved: ChapterOffer) {
  const found = await service.from("narration_chapter_quote_acceptances")
    .select("quote_id,project_id,expected_credits,ai_disclosure_accepted,accepted_at").eq("quote_id", saved.row.id).maybeSingle();
  if (found.error) throw acceptanceUnknown();
  if (!found.data) return null;
  const parsed = acceptanceSchema.safeParse(found.data);
  if (!parsed.success || parsed.data.quote_id !== saved.row.id || parsed.data.expected_credits !== saved.row.reserved_credits) throw acceptanceUnknown();
  const project = await service.from("audiobook_projects").select(projectFields).eq("id", parsed.data.project_id)
    .eq("workspace_id", saved.row.workspace_id).eq("created_by", saved.row.user_id).eq("narration_quote_id", saved.row.id).maybeSingle();
  if (project.error || !project.data) throw acceptanceUnknown();
  const checked = checkedProject(project.data, saved);
  if (checked.id !== parsed.data.project_id) throw acceptanceUnknown();
  return checked;
}
function publicChapterAcceptance(saved: ChapterOffer, project: ReturnType<typeof checkedProject> | null) {
  if (!project) return { quoteId: saved.row.id, accepted: false as const, project: null };
  return { quoteId: saved.row.id, accepted: true as const,
    project: { id: project.id, billingMode: "quoted" as const, status: project.status, reservedCredits: String(project.credit_units) } };
}
function publicChapterOffer(saved: ChapterOffer) {
  const { row, children } = saved;
  const firstChild = children[0]!;
  return { quoteId: row.id, purchaseAvailable: Boolean(matchingPurchaseCatalog(saved)), pricingBasis: "maximum_token_budget" as const,
    modelId: row.model_option_id, model: firstChild.request.model, voice: row.voice, speed: row.speed,
    source: { bookId: row.book_id, editionId: row.edition_id, chapterId: row.chapter_id, documentVersionId: row.document_version_id },
    segmentCount: row.segment_count, reservedCredits: String(row.reserved_credits),
    segments: children.map(child => ({ quoteId: child.row.id, segmentIndex: child.request.segmentIndex,
      textStart: child.request.textStart, textEnd: child.request.textEnd, reservedCredits: child.quote.reservedCredits })),
    priceVersion: firstChild.quote.price.version, policyVersion: firstChild.quote.policy.version,
    expiresAt: firstChild.quote.expiresAt, expired: Date.now() >= Date.parse(row.expires_at) };
}

export function narrationQuoteRoutes(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/narration-models", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    if (!workspace.success) throw new AppError(422, "Valid workspace ID required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspace.data, req.userId);
    reply.header("cache-control", "private, no-store");
    return { ...availableNarrationModels(process.env.NARRATION_PRICING_CATALOG_JSON, new Date().toISOString()),
      purchaseAvailable: process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED === "true" };
  });
  app.get("/workspaces/:workspaceId/narration-chapter-quotes/:quoteId/project", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Valid workspace and chapter quote IDs required.");
    const { workspaceId, quoteId } = params.data;
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const saved = await ownedChapterOffer(service, quoteId, workspaceId, req.userId);
    // Read only: no current catalog/source read, signing or funding RPC.
    return publicChapterAcceptance(saved, await acceptedChapterProject(service, saved));
  });
  app.post("/workspaces/:workspaceId/narration-chapter-quotes/:quoteId/accept", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    const body = acceptanceBodySchema.safeParse(req.body);
    if (!params.success || !body.success) throw new AppError(422, "Confirm the exact maximum credits, AI voice disclosure and narration generation.");
    const { workspaceId, quoteId } = params.data;
    const role = await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspaceId, req.userId);
    if (!["owner", "admin", "editor", "writer"].includes(role)) throw new AppError(403, "Chapter narration purchases require writing access.");
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const saved = await ownedChapterOffer(service, quoteId, workspaceId, req.userId);
    if (Number(body.data.expectedCredits) !== saved.row.reserved_credits) throw new AppError(409, "Confirm the exact original chapter maximum before purchasing.");
    const original = await acceptedChapterProject(service, saved);
    if (original) return publicChapterAcceptance(saved, original);
    const catalog = matchingPurchaseCatalog(saved);
    if (!catalog) throw new AppError(503, "New chapter narration purchases are not enabled for this offer.", undefined, "narration_purchase_unavailable");
    try {
      const accepted = await service.rpc("accept_narration_chapter_quote", { p_quote_id: quoteId, p_user_id: req.userId,
        p_expected_credits: Number(body.data.expectedCredits), p_ai_disclosure_accepted: true, p_catalog: catalog });
      if (accepted.error?.code === "42501") throw new AppError(403, "Chapter narration access changed.");
      if (accepted.error?.code === "P0002") throw new AppError(404, "Chapter narration quote not found.");
      if (["23514", "22023", "23505"].includes(accepted.error?.code ?? "")) {
        throw new AppError(409, "The chapter quote, available credits or source changed. Recover the original offer before trying again.");
      }
      if (accepted.error || !accepted.data || (Array.isArray(accepted.data) && accepted.data.length !== 1)) throw acceptanceUnknown();
      const project = checkedProject(first(accepted.data), saved);
      const confirmed = await acceptedChapterProject(service, saved);
      if (!confirmed || confirmed.id !== project.id) throw acceptanceUnknown();
      return publicChapterAcceptance(saved, confirmed);
    } catch (error) { if (error instanceof AppError) throw error; throw acceptanceUnknown(); }
  });
  app.get("/workspaces/:workspaceId/narration-quotes/:quoteId", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Valid workspace and quote IDs required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), params.data.workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    const found = await app.supabaseFactory().from("narration_quote_snapshots").select(fields)
      .eq("id", params.data.quoteId).eq("workspace_id", params.data.workspaceId).eq("user_id", req.userId).maybeSingle();
    if (found.error) throw new AppError(503, "Narration quote recovery is unavailable.");
    if (!found.data) throw new AppError(404, "Narration quote not found.");
    const saved = savedOffer(found.data, { workspaceId: params.data.workspaceId, userId: req.userId });
    if (saved.row.id !== params.data.quoteId) throw new AppError(503, "Narration quote identity could not be verified.");
    return publicOffer(saved);
  });
  app.post("/workspaces/:workspaceId/narration-quotes/recover", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    const body = z.object({ idempotencyKey: key }).strict().safeParse(req.body);
    if (!workspace.success || !body.success) throw new AppError(422, "Valid workspace and original quote key required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspace.data, req.userId);
    reply.header("cache-control", "private, no-store");
    const found = await app.supabaseFactory().from("narration_quote_snapshots").select(fields)
      .eq("workspace_id", workspace.data).eq("user_id", req.userId).eq("idempotency_key", body.data.idempotencyKey).maybeSingle();
    if (found.error) throw new AppError(503, "Narration recovery is unavailable. Keep the original request key.");
    if (!found.data) throw new AppError(404, "No saved narration quote was found for this key.");
    const saved = savedOffer(found.data, { workspaceId: workspace.data, userId: req.userId });
    if (saved.row.idempotency_key !== body.data.idempotencyKey) throw new AppError(503, "Narration recovery key could not be verified.");
    return publicOffer(saved);
  });
  app.post("/workspaces/:workspaceId/narration-quotes", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    const parsed = bodySchema.safeParse(req.body);
    if (!workspace.success || !parsed.success) throw new AppError(422, "Choose supported narration settings and consent to saving the offer.");
    const input = parsed.data; const workspaceId = workspace.data; const user = app.supabaseFactory(req.userToken);
    const role = await requireWorkspaceMember(user, workspaceId, req.userId);
    if (!["owner", "admin", "editor", "writer"].includes(role)) throw new AppError(403, "Narration quotes require writing access.");
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    // Key-first recovery survives catalog/source changes. Never recalculate an
    // uncertain saved offer or silently change its delivery settings/price.
    const previous = await service.from("narration_quote_snapshots").select(fields).eq("user_id", req.userId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
    if (previous.error) throw new AppError(503, "Narration quote lookup is unavailable. Keep the original request key.");
    if (previous.data) {
      const saved = savedOffer(previous.data, { workspaceId, userId: req.userId });
      if (saved.row.idempotency_key !== input.idempotencyKey || saved.row.edition_id !== input.editionId || saved.row.chapter_id !== input.chapterId
        || saved.row.model_option_id !== input.modelId || saved.request.segmentIndex !== input.segmentIndex || saved.request.voice !== input.voice
        || saved.request.speed !== input.speed || saved.request.instructions !== input.instructions) throw new AppError(409, "This quote key belongs to different narration settings.");
      return publicOffer(saved);
    }
    const rawCatalog = process.env.NARRATION_PRICING_CATALOG_JSON;
    const catalog = readNarrationCatalog(rawCatalog, new Date().toISOString());
    const entry = catalog.entries.find(item => item.id === input.modelId);
    if (!entry) throw new AppError(422, "Choose an available narration option.");
    const source = await sourceChapter(user, workspaceId, input);
    const segment = segmentSpeechText(source.plainText, 4_096, input.instructions)[input.segmentIndex];
    if (!segment) throw new AppError(422, "Choose an existing saved narration segment.");
    const prepared = prepareNarrationQuote(rawCatalog, { modelId: input.modelId, now: new Date().toISOString(), sourceText: segment.text,
      request: { jobId: narrationJobId(req.userId, input.idempotencyKey), userId: req.userId, workspaceId, bookId: source.bookId,
        editionId: input.editionId, chapterId: input.chapterId, documentVersionId: source.documentVersionId,
        segmentIndex: input.segmentIndex, textStart: segment.start, textEnd: segment.end, textSha256: segment.sha256,
        model: entry.price.model, voice: input.voice, speed: input.speed, instructions: input.instructions,
        maxOutputTokens: entry.maxOutputTokens, promptVersion: "bookworm-realtime-narration-v1", promptSha256: narrationPromptHash(input.instructions) } });
    const saved = await service.rpc("save_narration_quote_snapshot", { p_user_id: req.userId, p_workspace_id: workspaceId, p_book_id: source.bookId,
      p_edition_id: input.editionId, p_chapter_id: input.chapterId, p_document_version_id: source.documentVersionId, p_job_id: prepared.request.jobId,
      p_idempotency_key: input.idempotencyKey, p_request_sha256: narrationRequestHash(prepared.request), p_request: prepared.request,
      p_catalog_version: prepared.catalogVersion, p_model_option_id: input.modelId, p_quote: prepared.quote });
    if (saved.error?.code === "42501") throw new AppError(403, "Narration quote access changed.");
    if (["23505", "23514", "22023"].includes(saved.error?.code ?? "")) throw new AppError(409, "Narration source, settings or offer changed. Recover the original key before requesting another offer.");
    if (saved.error || !saved.data) throw new AppError(503, "Narration save is unconfirmed. Recover the original key; no generation or charge was started.");
    const checked = savedOffer(first(saved.data), { workspaceId, userId: req.userId });
    if (checked.row.idempotency_key !== input.idempotencyKey || checked.row.model_option_id !== input.modelId
      || checked.row.catalog_version !== prepared.catalogVersion || !isDeepStrictEqual(checked.request, prepared.request)
      || !isDeepStrictEqual(checked.quote, prepared.quote)) throw new AppError(503, "Narration save identity is unconfirmed. Recover the original key.");
    return publicOffer(checked);
  });
  app.get("/workspaces/:workspaceId/narration-chapter-quotes/:quoteId", async (req, reply) => {
    const params = z.object({ workspaceId: id, quoteId: id }).safeParse(req.params);
    if (!params.success) throw new AppError(422, "Valid workspace and chapter quote IDs required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), params.data.workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const found = await service.from("narration_chapter_quote_snapshots").select(chapterFields).eq("id", params.data.quoteId)
      .eq("workspace_id", params.data.workspaceId).eq("user_id", req.userId).maybeSingle();
    if (found.error) throw new AppError(503, "Chapter narration recovery is unavailable.");
    if (!found.data) throw new AppError(404, "Chapter narration quote not found.");
    const saved = await savedChapterOffer(service, found.data, { workspaceId: params.data.workspaceId, userId: req.userId });
    if (saved.row.id !== params.data.quoteId) throw new AppError(503, "Chapter narration quote identity could not be verified.");
    return publicChapterOffer(saved);
  });
  app.post("/workspaces/:workspaceId/narration-chapter-quotes/recover", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    const body = z.object({ idempotencyKey: key }).strict().safeParse(req.body);
    if (!workspace.success || !body.success) throw new AppError(422, "Valid workspace and original chapter quote key required.");
    await requireWorkspaceMember(app.supabaseFactory(req.userToken), workspace.data, req.userId);
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const found = await service.from("narration_chapter_quote_snapshots").select(chapterFields)
      .eq("workspace_id", workspace.data).eq("user_id", req.userId).eq("idempotency_key", body.data.idempotencyKey).maybeSingle();
    if (found.error) throw new AppError(503, "Chapter narration recovery is unavailable. Keep the original request key.");
    if (!found.data) throw new AppError(404, "No saved chapter narration quote was found for this key.");
    const saved = await savedChapterOffer(service, found.data, { workspaceId: workspace.data, userId: req.userId });
    if (saved.row.idempotency_key !== body.data.idempotencyKey) throw new AppError(503, "Chapter narration recovery key could not be verified.");
    return publicChapterOffer(saved);
  });
  app.post("/workspaces/:workspaceId/narration-chapter-quotes", async (req, reply) => {
    const workspace = id.safeParse((req.params as { workspaceId: string }).workspaceId);
    const parsed = chapterBodySchema.safeParse(req.body);
    if (!workspace.success || !parsed.success) throw new AppError(422, "Choose supported chapter narration settings and consent to saving the offer.");
    const input = parsed.data, workspaceId = workspace.data, user = app.supabaseFactory(req.userToken);
    const role = await requireWorkspaceMember(user, workspaceId, req.userId);
    if (!["owner", "admin", "editor", "writer"].includes(role)) throw new AppError(403, "Chapter narration quotes require writing access.");
    reply.header("cache-control", "private, no-store");
    const service = app.supabaseFactory();
    const previous = await service.from("narration_chapter_quote_snapshots").select(chapterFields)
      .eq("user_id", req.userId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
    if (previous.error) throw new AppError(503, "Chapter narration lookup is unavailable. Keep the original request key.");
    if (previous.data) {
      const saved = await savedChapterOffer(service, previous.data, { workspaceId, userId: req.userId });
      if (saved.row.idempotency_key !== input.idempotencyKey || saved.row.edition_id !== input.editionId || saved.row.chapter_id !== input.chapterId
        || saved.row.model_option_id !== input.modelId || saved.row.voice !== input.voice || saved.row.speed !== input.speed
        || saved.row.instructions !== input.instructions) throw new AppError(409, "This chapter quote key belongs to different narration settings.");
      return publicChapterOffer(saved);
    }
    const source = await sourceChapter(user, workspaceId, input);
    const prepared = prepareNarrationChapterQuote(process.env.NARRATION_PRICING_CATALOG_JSON, { ...input, now: new Date().toISOString(),
      userId: req.userId, workspaceId, bookId: source.bookId, documentVersionId: source.documentVersionId, sourceText: source.plainText });
    const result = await service.rpc("save_narration_chapter_quote_snapshot", { p_user_id: req.userId, p_workspace_id: workspaceId,
      p_book_id: source.bookId, p_edition_id: input.editionId, p_chapter_id: input.chapterId, p_document_version_id: source.documentVersionId,
      p_source_sha256: prepared.sourceSha256, p_idempotency_key: input.idempotencyKey, p_catalog_version: prepared.catalogVersion,
      p_model_option_id: prepared.modelId, p_offers: prepared.offers });
    if (result.error?.code === "42501") throw new AppError(403, "Chapter narration access changed.");
    if (["23505", "23514", "22023"].includes(result.error?.code ?? "")) throw new AppError(409, "Chapter narration source, settings or offer changed. Recover the original key before requesting another offer.");
    if (result.error || !result.data) throw new AppError(503, "Chapter narration save is unconfirmed. Recover the original key; no generation or charge was started.");
    const saved = await savedChapterOffer(service, first(result.data), { workspaceId, userId: req.userId });
    if (saved.row.idempotency_key !== input.idempotencyKey || saved.row.catalog_version !== prepared.catalogVersion
      || saved.row.model_option_id !== prepared.modelId || saved.row.source_sha256 !== prepared.sourceSha256
      || String(saved.row.reserved_credits) !== prepared.reservedCredits
      || !isDeepStrictEqual(saved.children.map(child => ({ request: child.request, quote: child.quote })), prepared.offers)) {
      throw new AppError(503, "Chapter narration save identity is unconfirmed. Recover the original key.");
    }
    return publicChapterOffer(saved);
  });
}
