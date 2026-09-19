import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyOperation, DocumentOperationSchema, type BookModel, type BookNode } from "@bookworm/book-model";
import { AppError } from "../errors.js";
import { requireEntitlement } from "../lib/entitlements.js";
import { checkAssetReferences, latestVersion, loadBook, loadChapter, nodesSchema, parseNodes, rpcError } from "../lib/authoring.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { retrievalQuery, searchBookContext } from "../lib/retrieval.js";

const createJobSchema = z.object({
  bookId: z.string().uuid(),
  chapterIds: z.array(z.string().uuid()).min(1).max(5),
  agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency"]),
  userInstruction: z.string().trim().min(1).max(4_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  contextPolicy: z.object({
    includeBookBible: z.boolean().default(true),
    includeStyleGuide: z.boolean().default(true),
    includeRelatedContext: z.boolean().default(true),
    semanticTopK: z.number().int().min(1).max(20).default(5),
    maxTokens: z.number().int().min(256).max(16_000).default(4_096),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  if (value.agentType === "writer" && !value.userInstruction) {
    ctx.addIssue({ code: "custom", path: ["userInstruction"], message: "Tell the writing assistant what to draft or rewrite." });
  }
  if (new Set(value.chapterIds).size !== value.chapterIds.length) {
    ctx.addIssue({ code: "custom", path: ["chapterIds"], message: "Do not repeat chapter IDs." });
  }
});

const serviceUsage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().default(0),
}).strict();

const serviceResult = z.object({
  status: z.enum(["succeeded", "failed"]),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  suggestions: z.array(z.unknown()).max(200).default([]),
  diagnostics: z.array(z.unknown()).max(500).default([]),
  usage: serviceUsage,
  error: z.string().max(2_000).optional(),
}).passthrough();

const editSuggestion = z.object({
  chapterId: z.string().uuid(),
  nodeId: z.string().min(1).max(200),
  operation: z.unknown(),
  rationale: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1).nullable().optional(),
}).passthrough();

type ChapterSnapshot = { title: string; order: number; version: number; nodes: BookNode[] };

function wordCount(nodes: BookNode[]) {
  const text = nodes.map((node) => node.text ?? "").filter(Boolean).join("\n\n");
  return { text, count: text.trim() ? text.trim().split(/\s+/u).length : 0 };
}

function chapterIdsForJob(job: Record<string, unknown>) {
  const input = job.input_ref;
  if (!input || typeof input !== "object") return [];
  const chapterVersions = (input as { chapterVersions?: unknown }).chapterVersions;
  if (!Array.isArray(chapterVersions)) return [];
  return [...new Set(chapterVersions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const chapterId = z.string().uuid().safeParse((value as { chapterId?: unknown }).chapterId);
    return chapterId.success ? [chapterId.data] : [];
  }))];
}

function safeAiJob(job: Record<string, unknown>) {
  const input = job.input_ref;
  const contextSources = input && typeof input === "object" && Array.isArray((input as { contextSources?: unknown }).contextSources)
    ? (input as { contextSources: unknown[] }).contextSources.length : 0;
  return {
    id: String(job.id),
    book_id: typeof job.book_id === "string" ? job.book_id : null,
    agent_type: typeof job.agent_type === "string" ? job.agent_type : "unknown",
    status: typeof job.status === "string" ? job.status : "failed",
    model: typeof job.model === "string" ? job.model : null,
    usage_json: job.usage_json ?? {},
    error_code: typeof job.error_code === "string" ? job.error_code : null,
    error_message: typeof job.error_message === "string" ? job.error_message : null,
    created_at: typeof job.created_at === "string" ? job.created_at : "",
    started_at: typeof job.started_at === "string" ? job.started_at : null,
    completed_at: typeof job.completed_at === "string" ? job.completed_at : null,
    chapter_ids: chapterIdsForJob(job),
    context_source_count: contextSources,
  };
}

async function jobWithSuggestions(sb: SupabaseClient, job: Record<string, unknown>) {
  const { data, error } = await sb.from("ai_suggestions").select("*").eq("ai_job_id", job.id).order("created_at");
  if (error) throw new AppError(500, "Could not load AI suggestions.");
  return { ...safeAiJob(job), suggestions: data ?? [] };
}

async function markFailed(sb: SupabaseClient, jobId: string, code: string, message: string) {
  await sb.from("ai_jobs").update({
    status: "failed", error_code: code, error_message: message.slice(0, 2_000), completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}

function normalizeSuggestions(result: z.infer<typeof serviceResult>, book: Record<string, unknown>, snapshots: Map<string, ChapterSnapshot>) {
  return result.suggestions.map((raw) => {
    const suggestion = editSuggestion.safeParse(raw);
    if (!suggestion.success) throw new AppError(503, "The AI provider returned an invalid suggestion. Nothing was saved or charged.");
    const snapshot = snapshots.get(suggestion.data.chapterId);
    if (!snapshot) throw new AppError(503, "The AI provider targeted a chapter outside this request. Nothing was saved or charged.");
    const parsed = DocumentOperationSchema.safeParse(suggestion.data.operation);
    if (!parsed.success || parsed.data.type !== "replace_text") {
      throw new AppError(503, "The AI provider returned an unsupported edit. Nothing was saved or charged.");
    }
    const suggestionId = randomUUID();
    const operation = DocumentOperationSchema.parse({
      ...parsed.data,
      operationId: `ai:${suggestionId}`,
      target: { chapterId: suggestion.data.chapterId, nodeId: suggestion.data.nodeId },
      payload: { ...parsed.data.payload, nodeId: suggestion.data.nodeId },
      expectedVersion: snapshot.version,
      source: "ai",
      sourceRef: suggestionId,
    });
    if (parsed.data.target.chapterId !== suggestion.data.chapterId || parsed.data.target.nodeId !== suggestion.data.nodeId || parsed.data.payload.nodeId !== suggestion.data.nodeId) {
      throw new AppError(503, "The AI provider returned mismatched edit targets. Nothing was saved or charged.");
    }
    const model: BookModel = {
      schemaVersion: "1.0",
      bookId: String(book.id),
      metadata: { title: String(book.title), author: String(book.author_name), language: String(book.language) },
      styleGuide: {}, bookBible: { entities: [] }, assets: [],
      chapters: [{ id: suggestion.data.chapterId, order: snapshot.order, title: snapshot.title, nodes: snapshot.nodes }],
    };
    try { applyOperation(model, operation, snapshot.version); }
    catch { throw new AppError(503, "The AI provider returned an edit that does not fit the saved manuscript. Nothing was saved or charged."); }
    return {
      id: suggestionId,
      entityType: "chapter",
      entityId: suggestion.data.chapterId,
      operation,
      rationale: suggestion.data.rationale,
      confidence: suggestion.data.confidence ?? null,
    };
  });
}

export function aiRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;

  app.get("/ai/jobs", async (req, reply) => {
    const parsed = z.object({
      bookId: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    }).strict().safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Check the AI review history request.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, parsed.data.bookId, req.userId);
    const { data, error } = await sb.from("ai_jobs").select("*")
      .eq("book_id", parsed.data.bookId)
      .in("agent_type", ["writer", "proofreader", "copyeditor", "consistency"])
      .order("created_at", { ascending: false }).limit(parsed.data.limit);
    if (error) throw new AppError(500, "Could not load AI review history.");
    reply.header("cache-control", "private, no-store");
    return { jobs: (data ?? []).map((job) => safeAiJob(job as Record<string, unknown>)) };
  });

  app.post("/ai/jobs", async (req, reply) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the AI request.", { issues: parsed.error.issues });
    const body = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, body.bookId, req.userId, true);
    const service = app.supabaseFactory();
    const { data: replay, error: replayError } = await service.from("ai_jobs").select("*")
      .eq("idempotency_key", body.idempotencyKey).eq("workspace_id", book.workspace_id).eq("created_by", req.userId).maybeSingle();
    if (replayError) throw new AppError(500, "Could not verify the AI request key.");
    if (replay) {
      if (replay.book_id !== body.bookId || replay.agent_type !== body.agentType) throw new AppError(409, "That AI request key is already in use.");
      return reply.status(200).send(await jobWithSuggestions(service, replay));
    }
    const { data: workspace, error: workspaceError } = await service.from("workspaces").select("organization_id").eq("id", book.workspace_id).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(500, "Could not resolve AI usage for this workspace.");
    await requireEntitlement(service, workspace.organization_id, "ai_credits", 1);

    const { data: chapters, error: chaptersError } = await user.from("chapters").select("id,title,order_index").eq("book_id", body.bookId).in("id", body.chapterIds);
    if (chaptersError) throw new AppError(500, "Could not load the requested chapters.");
    if (!chapters || chapters.length !== body.chapterIds.length) throw new AppError(422, "Every requested chapter must belong to this book.");
    const snapshots = new Map<string, ChapterSnapshot>();
    for (const chapter of chapters) {
      const current = await latestVersion(user, chapter.id);
      snapshots.set(chapter.id, {
        title: chapter.title, order: chapter.order_index, version: current?.version_number ?? 0,
        nodes: parseNodes(current?.content_json),
      });
    }
    const jobId = randomUUID();
    const { data: job, error: insertError } = await service.from("ai_jobs").insert({
      id: jobId, workspace_id: book.workspace_id, book_id: body.bookId, agent_type: body.agentType,
      status: "queued", input_ref: {
        chapterVersions: body.chapterIds.map((chapterId) => ({ chapterId, version: snapshots.get(chapterId)?.version ?? 0 })),
        userInstruction: body.userInstruction ?? null, contextPolicy: body.contextPolicy,
      }, idempotency_key: body.idempotencyKey, created_by: req.userId,
    }).select("*").single();
    if (insertError?.code === "23505") {
      const { data: existing } = await service.from("ai_jobs").select("*")
        .eq("idempotency_key", body.idempotencyKey).eq("workspace_id", book.workspace_id).eq("created_by", req.userId).maybeSingle();
      if (!existing || existing.book_id !== body.bookId || existing.agent_type !== body.agentType) throw new AppError(409, "That AI request key is already in use.");
      return reply.status(200).send(await jobWithSuggestions(service, existing));
    }
    if (insertError?.code === "23514") throw new AppError(422, "Text credit capacity is exhausted. Wait for pending requests or add funded capacity.", undefined, "quota_exceeded");
    if (insertError?.code === "42501") throw new AppError(403, "AI generation requires editing access.");
    if (insertError || !job) throw new AppError(500, "Could not create the AI job.");

    // The request finishes here. A service-role worker rehydrates the exact
    // saved chapter versions under a renewable fence; no manuscript is queued.
    return reply.status(202).send(await jobWithSuggestions(service, job));
  });

  app.get("/ai/jobs/:jobId", async (req) => {
    const result = z.string().uuid().safeParse((req.params as { jobId: string }).jobId);
    if (!result.success) throw new AppError(404, "AI job not found.");
    const sb = app.supabaseFactory(req.userToken);
    const { data: job, error } = await sb.from("ai_jobs").select("*").eq("id", result.data).maybeSingle();
    if (error) throw new AppError(500, "Could not load the AI job.");
    if (!job) throw new AppError(404, "AI job not found.");
    return jobWithSuggestions(sb, job);
  });

  app.post("/ai/suggestions/:suggestionId/apply", async (req) => {
    const id = z.string().uuid().safeParse((req.params as { suggestionId: string }).suggestionId);
    if (!id.success) throw new AppError(404, "AI suggestion not found.");
    const sb = app.supabaseFactory(req.userToken);
    const { data: suggestion, error } = await sb.from("ai_suggestions").select("*").eq("id", id.data).maybeSingle();
    if (error) throw new AppError(500, "Could not load the AI suggestion.");
    if (!suggestion) throw new AppError(404, "AI suggestion not found.");
    if (suggestion.status !== "pending") throw new AppError(409, `This suggestion is already ${suggestion.status}.`);
    const operation = DocumentOperationSchema.safeParse(suggestion.operation_json);
    if (!operation.success || operation.data.type !== "replace_text" || operation.data.target.chapterId !== suggestion.entity_id) {
      throw new AppError(422, "This AI suggestion cannot be applied to a manuscript.");
    }
    const { chapter, book } = await loadChapter(sb, operation.data.target.chapterId, req.userId, true);
    const current = await latestVersion(sb, chapter.id);
    const currentVersion = current?.version_number ?? 0;
    const nodes = parseNodes(current?.content_json);
    const model: BookModel = {
      schemaVersion: "1.0", bookId: book.id,
      metadata: { title: book.title, author: book.author_name, language: book.language },
      styleGuide: {}, bookBible: { entities: [] }, assets: [],
      chapters: [{ id: chapter.id, order: chapter.order_index, title: chapter.title, nodes }],
    };
    let next: BookNode[];
    try { next = nodesSchema.parse(applyOperation(model, operation.data, currentVersion).book.chapters[0].nodes); }
    catch { throw new AppError(409, "The manuscript changed after this suggestion was created. Run the AI assistant again."); }
    await checkAssetReferences(sb, next, book.workspace_id);
    const words = wordCount(next);
    const { data, error: applyError } = await sb.rpc("accept_ai_suggestion", {
      p_suggestion_id: id.data, p_content_json: { schemaVersion: "1.0", nodes: next },
      p_plain_text: words.text, p_word_count: words.count,
    });
    if (applyError) rpcError(applyError);
    const version = Array.isArray(data) ? data[0] : data;
    if (!version) throw new AppError(500, "The suggestion write returned no manuscript version.");
    return { suggestionId: id.data, status: "accepted", version: version.version_number, versionId: version.id };
  });

  app.post("/ai/suggestions/:suggestionId/reject", async (req) => {
    const id = z.string().uuid().safeParse((req.params as { suggestionId: string }).suggestionId);
    if (!id.success) throw new AppError(404, "AI suggestion not found.");
    const sb = app.supabaseFactory(req.userToken);
    const { data, error } = await sb.rpc("reject_ai_suggestion", { p_suggestion_id: id.data });
    if (error?.code === "P0002") throw new AppError(404, "AI suggestion not found.");
    if (error?.code === "42501") throw new AppError(403, "Your role cannot review this suggestion.");
    if (error?.code === "40001") throw new AppError(409, "This suggestion was already reviewed.");
    if (error) throw new AppError(500, "Could not reject the AI suggestion.");
    return { suggestion: Array.isArray(data) ? data[0] : data };
  });
}
