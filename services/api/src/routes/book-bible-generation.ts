import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadBook, parseNodes } from "../lib/authoring.js";
import { requireEntitlement } from "../lib/entitlements.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { buildBibleReadingPlan, type BibleReadingChapter } from "../lib/bible-reading-plan.js";
import { aiUsageSchema } from "../lib/ai-usage.js";

const uuid = z.string().uuid();
const generationRequest = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  chapterIds: z.array(uuid).min(1).max(3).optional(),
  maxTokens: z.number().int().min(4096).max(16000).default(12000),
  reading: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), pageIndex: z.number().int().min(0).max(4999) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.chapterIds && new Set(value.chapterIds).size !== value.chapterIds.length) {
    ctx.addIssue({ code: "custom", path: ["chapterIds"], message: "Do not repeat chapter IDs." });
  }
});
const sourceRef = z.object({
  chapterId: uuid, documentVersionId: uuid,
  nodeId: z.string().min(1).max(200), textHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const candidate = z.object({
  suggestionKind: z.literal("book_bible_candidate"), status: z.literal("pending"),
  type: z.enum(["character", "place", "organization", "object", "event", "term"]),
  name: z.string().trim().min(1).max(160), description: z.string().trim().max(12000),
  attributes: z.record(z.string().min(1).max(80), z.unknown()).superRefine((value, ctx) => {
    if (Object.keys(value).length > 40 || Buffer.byteLength(JSON.stringify(value)) > 24000
      || ["imageAssetIds", "__proto__", "constructor", "prototype"].some((key) => Object.hasOwn(value, key))) {
      ctx.addIssue({ code: "custom", message: "Invalid Book Bible attributes." });
    }
  }),
  sourceRefs: z.array(sourceRef).min(1).max(30), confidence: z.number().min(0).max(1),
}).strict();
const candidatesSchema = z.array(candidate).max(10);
const diagnostic = z.object({
  severity: z.enum(["error", "warning", "info"]), code: z.string().min(1).max(200),
  message: z.string().min(1).max(2000), location: z.record(z.string(), z.unknown()),
}).strict();
const aiResponse = z.object({
  jobId: uuid, workspaceId: uuid, bookId: uuid, agentType: z.literal("bookbible"),
  status: z.enum(["succeeded", "failed"]), provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200), suggestions: z.array(z.unknown()).max(10),
  diagnostics: z.array(diagnostic).max(500).default([]),
  usage: aiUsageSchema, error: z.string().max(2000).optional(),
}).passthrough();
type Evidence = z.infer<typeof sourceRef>;

async function loadReadingPlan(user: SupabaseClient, bookId: string, chapterIds: string[] | undefined, maxTokens: number) {
  let query = user.from("chapters").select("id,title,order_index,current_document_version_id")
    .eq("book_id", bookId).order("order_index").limit(3);
  if (chapterIds) query = query.in("id", chapterIds);
  const { data: chapters, error } = await query;
  if (error) throw new AppError(500, "Could not load saved manuscript evidence.");
  if (chapterIds && (new Set(chapterIds).size !== chapterIds.length || chapters?.length !== chapterIds.length)) {
    throw new AppError(422, "Every selected chapter must belong to this book and be selected only once.");
  }
  if (!chapters?.length) throw new AppError(422, "Add saved manuscript chapters first.");
  const inputs: BibleReadingChapter[] = [];
  for (const chapter of chapters) {
    if (!chapter.current_document_version_id) throw new AppError(422, "Save every selected chapter before extracting candidates.");
    const { data: version, error: versionError } = await user.from("document_versions").select("*")
      .eq("id", chapter.current_document_version_id).eq("chapter_id", chapter.id).maybeSingle();
    if (versionError) throw new AppError(500, "Could not load the current saved manuscript version.");
    if (!version) throw new AppError(422, "A selected chapter's saved version is unavailable. Reload the manuscript and try again.");
    inputs.push({ id: chapter.id, title: chapter.title, order: chapter.order_index,
      version: version.version_number, documentVersionId: version.id, nodes: parseNodes(version.content_json) });
  }
  return buildBibleReadingPlan(inputs, maxTokens);
}

function candidatesFromJob(job: Record<string, unknown>) {
  const output = job.output_ref as { candidates?: unknown } | null;
  const parsed = candidatesSchema.safeParse(output?.candidates);
  return parsed.success ? parsed.data : null;
}

function requestFingerprint(bookId: string, body: z.infer<typeof generationRequest>) {
  return createHash("sha256").update(JSON.stringify({ bookId, chapterIds: body.chapterIds ?? null, maxTokens: body.maxTokens,
    ...(body.reading ? { reading: body.reading } : {}) })).digest("hex");
}

function validateCandidates(values: unknown[], evidence: Evidence[]) {
  const parsed = candidatesSchema.safeParse(values);
  if (!parsed.success) throw new AppError(503, "The AI result is invalid. The request remains held for review.");
  const trusted = new Set(evidence.map((ref) => JSON.stringify(ref)));
  for (const item of parsed.data) for (const ref of item.sourceRefs) {
    if (!trusted.has(JSON.stringify(ref))) {
      throw new AppError(503, "The AI cited a source outside the saved request. The request remains held for review.");
    }
  }
  return parsed.data;
}

async function loadSavedJob(sb: SupabaseClient, book: Record<string, unknown>, actor: string, jobId: string) {
  const { data, error } = await sb.from("ai_jobs").select("*")
    .eq("id", jobId).eq("book_id", book.id).eq("agent_type", "bookbible")
    .eq("created_by", actor).maybeSingle();
  if (error) throw new AppError(500, "Could not load the Book Bible request.");
  if (!data) throw new AppError(404, "Book Bible request not found.");
  return data as Record<string, unknown>;
}

async function readResult(fetcher: typeof fetch, jobId: string): Promise<unknown> {
  const serviceUrl = process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`;
  const response = await fetcher(`${serviceUrl.replace(/\/$/u, "")}/v1/ai/jobs/${jobId}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) },
  });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text) > 2000000) throw new Error("Saved result unavailable");
  return JSON.parse(text);
}

async function settleResult(sb: SupabaseClient, job: Record<string, unknown>, raw: unknown) {
  const result = aiResponse.safeParse(raw);
  if (!result.success || result.data.jobId !== job.id || result.data.bookId !== job.book_id
    || result.data.workspaceId !== job.workspace_id) {
    throw new AppError(503, "The existing AI result cannot be verified. The request remains held for review.");
  }
  if (result.data.status === "failed") {
    const { data: failedJob, error } = await sb.from("ai_jobs").update({ status: "failed", error_code: "ai_provider_failed",
      error_message: "The AI service could not produce Book Bible candidates.", completed_at: new Date().toISOString() })
      .eq("id", job.id).in("status", ["queued", "running"]).select("id").maybeSingle();
    if (error || !failedJob) throw new AppError(503, "Could not record the failed result. Recover this request before generating again.");
    throw new AppError(503, "The AI service could not produce Book Bible candidates. No Book Bible entry was saved or charged.",
      { jobId: job.id, status: "failed" });
  }
  const refs = z.array(sourceRef).min(1).safeParse((job.input_ref as { contextSources?: unknown } | null)?.contextSources);
  if (!refs.success) throw new AppError(503, "Trusted manuscript evidence is unavailable. The request remains held for review.");
  const values = validateCandidates(result.data.suggestions, refs.data);
  const { data: completed, error } = await sb.rpc("complete_book_bible_ai_job", {
    p_job_id: job.id, p_provider: result.data.provider, p_model: result.data.model,
    p_usage: result.data.usage, p_diagnostics: result.data.diagnostics,
    p_candidates: values, p_credit_quantity: result.data.provider === "mock" ? 0 : 1,
  });
  if (error || !completed) {
    const fresh = await sb.from("ai_jobs").select("*").eq("id", job.id).maybeSingle();
    if (fresh.data?.status === "succeeded" && candidatesFromJob(fresh.data)) return candidatesFromJob(fresh.data)!;
    if (error?.code === "PGRST202" || error?.code === "42883") {
      throw new AppError(503, "The Book Bible AI database workflow is not installed. The request remains held.");
    }
    throw new AppError(503, "Could not settle the saved Book Bible result. Retry recovery; do not generate again.");
  }
  return values;
}

export function bookBibleGenerationRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;

  app.post("/books/:bookId/bible/reading-plan", async (req, reply) => {
    const bookId = uuid.safeParse((req.params as { bookId: string }).bookId);
    const body = z.object({ chapterIds: z.array(uuid).min(1).max(3),
      maxTokens: z.number().int().min(4096).max(16000).default(12000) }).strict().safeParse(req.body);
    if (!bookId.success || !body.success) throw new AppError(422, "Select up to three saved chapters and a valid reading budget.");
    const user = app.supabaseFactory(req.userToken);
    await loadBook(user, bookId.data, req.userId, true);
    const plan = await loadReadingPlan(user, bookId.data, body.data.chapterIds, body.data.maxTokens);
    const { data: jobs, error } = await user.from("ai_jobs").select("id,input_ref")
      .eq("book_id", bookId.data).eq("created_by", req.userId).eq("agent_type", "bookbible")
      .eq("status", "succeeded").order("created_at", { ascending: false }).limit(5000);
    if (error) throw new AppError(500, "Could not verify saved reading progress.");
    reply.header("cache-control", "private, no-store");
    return { fingerprint: plan.fingerprint, totalBytes: plan.totalBytes, creditsPerPage: 1,
      pages: plan.pages.map((page, pageIndex) => ({ pageIndex, ranges: page.ranges, bytes: page.bytes,
        completedJobId: jobs?.find((job) => job.input_ref?.reading?.fingerprint === plan.fingerprint
          && job.input_ref?.reading?.pageIndex === pageIndex)?.id ?? null })) };
  });

  app.get("/books/:bookId/bible/drafts", async (req, reply) => {
    const parsed = uuid.safeParse((req.params as { bookId: string }).bookId);
    if (!parsed.success) throw new AppError(422, "Invalid book ID.");
    const user = app.supabaseFactory(req.userToken);
    await loadBook(user, parsed.data, req.userId);
    const { data: saved, error } = await user.from("ai_jobs")
      .select("id,created_at,output_ref").eq("book_id", parsed.data)
      .eq("agent_type", "bookbible").eq("status", "succeeded")
      .order("created_at", { ascending: false }).limit(20);
    const { data: pending, error: pendingError } = await user.from("ai_jobs")
      .select("id,created_at,status").eq("book_id", parsed.data)
      .eq("agent_type", "bookbible").eq("created_by", req.userId)
      .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(20);
    if (error || pendingError) throw new AppError(500, "Could not load Book Bible drafts.");
    reply.header("cache-control", "private, no-store");
    return {
      pending: (pending ?? []).map((job) => ({ id: job.id, createdAt: job.created_at, status: job.status })),
      drafts: (saved ?? []).flatMap((job) => {
        const values = candidatesFromJob(job);
        return values ? [{ id: job.id, createdAt: job.created_at, candidates: values }] : [];
      }),
    };
  });

  app.post("/books/:bookId/bible/jobs/:jobId/recover", async (req, reply) => {
    const parsed = z.object({ bookId: uuid, jobId: uuid }).safeParse(req.params);
    if (!parsed.success) throw new AppError(422, "Invalid Book Bible recovery request.");
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, parsed.data.bookId, req.userId, true);
    const service = app.supabaseFactory();
    const job = await loadSavedJob(service, book, req.userId, parsed.data.jobId);
    const saved = candidatesFromJob(job);
    if (job.status === "succeeded" && saved) return { candidates: saved };
    if (!["queued", "running"].includes(String(job.status))) throw new AppError(409, "This request cannot be recovered.");
    let raw: unknown;
    try { raw = await readResult(fetcher, parsed.data.jobId); }
    catch { throw new AppError(503, "The existing result is unavailable. No new generation was started; the request remains pending."); }
    const values = await settleResult(service, job, raw);
    reply.header("cache-control", "private, no-store");
    return { candidates: values };
  });

  app.post("/books/:bookId/bible/generate", async (req, reply) => {
    const parsed = generationRequest.safeParse(req.body);
    const parsedBookId = uuid.safeParse((req.params as { bookId: string }).bookId);
    if (!parsed.success || !parsedBookId.success) {
      throw new AppError(422, "Check the Book Bible generation request.",
        { issues: parsed.success ? [{ path: ["bookId"], message: "Invalid book ID." }] : parsed.error.issues });
    }
    const body = parsed.data;
    const bookId = parsedBookId.data;
    const fingerprint = requestFingerprint(bookId, body);
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, bookId, req.userId, true);
    const service = app.supabaseFactory();
    const { data: replay, error: replayError } = await service.from("ai_jobs").select("*")
      .eq("idempotency_key", body.idempotencyKey).eq("workspace_id", book.workspace_id)
      .eq("created_by", req.userId).maybeSingle();
    if (replayError) throw new AppError(500, "Could not verify the Book Bible request key.");
    if (replay) {
      if (replay.book_id !== bookId || replay.agent_type !== "bookbible"
        || (replay.input_ref as { requestFingerprint?: string } | null)?.requestFingerprint !== fingerprint) {
        throw new AppError(409, "That AI request key is already bound to a different request.");
      }
      const saved = candidatesFromJob(replay);
      if (replay.status === "succeeded" && saved) return reply.status(200).send({ job: replay, candidates: saved });
      throw new AppError(409, "The original Book Bible request is unresolved. Recover it without generating again.",
        { jobId: replay.id, status: replay.status, errorCode: replay.error_code ?? null });
    }
    const { data: workspace, error: workspaceError } = await service.from("workspaces")
      .select("organization_id").eq("id", book.workspace_id).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(500, "Could not resolve Book Bible credits.");

    const plan = await loadReadingPlan(user, bookId, body.chapterIds, body.maxTokens);
    if (body.reading && body.reading.fingerprint !== plan.fingerprint) {
      throw new AppError(409, "The saved manuscript or reading budget changed. Refresh the reading plan before purchasing another batch.", { status: "not_started" });
    }
    if (!body.reading && plan.pages.length > 1) {
      throw new AppError(422, "This selection needs multiple reading batches. Prepare a reading plan and choose a batch before generating. No extraction was started.");
    }
    const pageIndex = body.reading?.pageIndex ?? 0;
    const page = plan.pages[pageIndex];
    if (!page) throw new AppError(422, "This reading batch is outside the saved plan.");
    const { data: completedPages, error: progressError } = await service.from("ai_jobs").select("*")
      .eq("book_id", bookId).eq("created_by", req.userId).eq("agent_type", "bookbible")
      .eq("status", "succeeded").order("created_at", { ascending: false }).limit(5000);
    if (progressError) throw new AppError(503, "Could not verify saved reading progress. No extraction was started.");
    const completedPage = completedPages?.find((saved) => saved.input_ref?.reading?.fingerprint === plan.fingerprint
      && saved.input_ref?.reading?.pageIndex === pageIndex);
    if (completedPage) {
      const candidates = candidatesFromJob(completedPage);
      if (!candidates) throw new AppError(503, "The completed reading batch needs review; no new extraction was started.");
      reply.header("cache-control", "private, no-store");
      return { job: completedPage, candidates };
    }
    const chapterInput = page.chapters;
    const evidence: Evidence[] = page.ranges.map(({ startOffset: _start, endOffset: _end, ...ref }) => ref);
    await requireEntitlement(service, workspace.organization_id, "ai_credits", 1);
    const jobId = randomUUID();
    const { data: job, error: insertError } = await service.from("ai_jobs").insert({
      id: jobId, workspace_id: book.workspace_id, book_id: bookId, agent_type: "bookbible",
      status: "running", input_ref: {
        requestFingerprint: fingerprint,
        chapterVersions: Object.values(chapterInput).map((chapter) => {
          const value = chapter as { id: string; documentVersionId: string };
          return { chapterId: value.id, documentVersionId: value.documentVersionId };
        }),
        contextSources: evidence,
        reading: { fingerprint: plan.fingerprint, pageIndex, pageCount: plan.pages.length, ranges: page.ranges },
        maxTokens: body.maxTokens,
      },
      idempotency_key: body.idempotencyKey, created_by: req.userId,
      started_at: new Date().toISOString(),
    }).select("*").single();
    if (insertError?.code === "23514") throw new AppError(422, "Book Bible credit capacity is exhausted.", undefined, "quota_exceeded");
    if (insertError?.code === "42501") throw new AppError(403, "Book Bible generation requires editing access.");
    if (insertError?.code === "23505") throw new AppError(409, "A Book Bible request is already active. Refresh drafts to recover it.");
    if (insertError || !job) throw new AppError(500, "Could not reserve the Book Bible AI job.");

    const serviceUrl = process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`;
    let raw: unknown;
    try {
      const response = await fetcher(`${serviceUrl.replace(/\/$/u, "")}/v1/ai/jobs`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
        headers: { "content-type": "application/json",
          ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) },
        body: JSON.stringify({
          jobId, workspaceId: book.workspace_id, bookId, agentType: "bookbible",
          idempotencyKey: `api:${jobId}`, maxOutputTokens: 6000,
          contextPolicy: { includeBookBible: false, includeStyleGuide: false,
            includeRelatedContext: false, semanticTopK: 5, maxTokens: body.maxTokens },
          input: { chapterIds: Object.keys(chapterInput), chapters: chapterInput,
            book: { title: book.title, author: book.author_name, language: book.language },
            bookBible: [], relatedContext: [], styleGuide: {},
            userInstruction: "Extract only reviewable entities grounded in the supplied saved manuscript excerpts. A passage may be only part of a node; do not infer facts from omitted text. Citation hashes identify the full saved node, not only this excerpt." },
        }),
      });
      const text = await response.text();
      if (!response.ok || Buffer.byteLength(text) > 2000000) throw new Error("AI service result unavailable");
      raw = JSON.parse(text);
    } catch {
      throw new AppError(503, "The AI response is unavailable. Recover the existing request; do not generate again.",
        { jobId, status: "running" });
    }
    const values = await settleResult(service, job, raw);
    const { data: completed } = await service.from("ai_jobs").select("*").eq("id", jobId).maybeSingle();
    reply.header("cache-control", "private, no-store");
    return reply.status(201).send({ job: completed, candidates: values });
  });
}
