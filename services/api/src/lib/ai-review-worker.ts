import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applyOperation, DocumentOperationSchema, type BookModel, type BookNode } from "@bookworm/book-model";
import { AppError } from "../errors.js";
import { parseNodes } from "./authoring.js";
import { retrievalQuery, searchBookContext } from "./retrieval.js";
import type { SupabaseClient } from "./supabase.js";

const agentTypes = ["writer", "proofreader", "copyeditor", "consistency"] as const;
const inputSchema = z.object({
  chapterVersions: z.array(z.object({ chapterId: z.string().uuid(), version: z.number().int().min(0) })).min(1).max(5),
  userInstruction: z.string().max(4_000).nullable(),
  contextPolicy: z.object({ includeBookBible: z.boolean(), includeStyleGuide: z.boolean(), includeRelatedContext: z.boolean(), semanticTopK: z.number().int().min(1).max(20), maxTokens: z.number().int().min(256).max(16_000) }).strict(),
}).strict();
const claimedSchema = z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), book_id: z.string().uuid(), created_by: z.string().uuid(), agent_type: z.enum(agentTypes), lease_token: z.string().uuid(), input_ref: inputSchema }).passthrough();
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative().default(0), outputTokens: z.number().int().nonnegative().default(0), estimatedCostUsd: z.number().nonnegative().default(0) }).strict();
const resultSchema = z.object({ status: z.enum(["succeeded","failed"]), provider: z.string().min(1).max(100), model: z.string().min(1).max(200), suggestions: z.array(z.unknown()).max(200).default([]), diagnostics: z.array(z.unknown()).max(500).default([]), usage: usageSchema, error: z.string().max(2_000).optional() }).passthrough();
const editSchema = z.object({ chapterId: z.string().uuid(), nodeId: z.string().min(1).max(200), operation: z.unknown(), rationale: z.string().trim().min(1).max(2_000), confidence: z.number().min(0).max(1).nullable().optional() }).passthrough();
type Snapshot = { title: string; order: number; version: number; nodes: BookNode[] };
const row = (value: unknown): Record<string, unknown> | null => { const candidate = Array.isArray(value) ? value[0] : value; return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null; };
export type AiReviewWorkerOutcome = { status: "idle" | "succeeded" | "queued" | "failed" | "lease_lost" | "completion_unknown"; jobId?: string };
class AiReviewFailure extends Error { constructor(readonly code: string, readonly retryable: boolean, message = code) { super(message); } }

function normalize(result: z.infer<typeof resultSchema>, book: Record<string, unknown>, snapshots: Map<string, Snapshot>) {
  return result.suggestions.map((raw) => {
    const value = editSchema.safeParse(raw); if (!value.success) throw new AiReviewFailure("ai_invalid_output", false, "AI provider returned an invalid suggestion");
    const snapshot = snapshots.get(value.data.chapterId); if (!snapshot) throw new AiReviewFailure("ai_invalid_output", false, "AI provider targeted a chapter outside this request");
    const parsed = DocumentOperationSchema.safeParse(value.data.operation);
    if (!parsed.success || parsed.data.type !== "replace_text" || parsed.data.target.chapterId !== value.data.chapterId || parsed.data.target.nodeId !== value.data.nodeId || parsed.data.payload.nodeId !== value.data.nodeId) throw new AiReviewFailure("ai_invalid_output", false, "AI provider returned an unsupported edit");
    const id = randomUUID(); const operation = DocumentOperationSchema.parse({ ...parsed.data, operationId: `ai:${id}`, target: { chapterId: value.data.chapterId, nodeId: value.data.nodeId }, payload: { ...parsed.data.payload, nodeId: value.data.nodeId }, expectedVersion: snapshot.version, source: "ai", sourceRef: id });
    const model: BookModel = { schemaVersion: "1.0", bookId: String(book.id), metadata: { title: String(book.title), author: String(book.author_name), language: String(book.language) }, styleGuide: {}, bookBible: { entities: [] }, assets: [], chapters: [{ id: value.data.chapterId, order: snapshot.order, title: snapshot.title, nodes: snapshot.nodes }] };
    try { applyOperation(model, operation, snapshot.version); } catch { throw new AiReviewFailure("ai_invalid_output", false, "AI provider returned an edit that does not fit the saved manuscript"); }
    return { id, entityType: "chapter", entityId: value.data.chapterId, operation, rationale: value.data.rationale, confidence: value.data.confidence ?? null };
  });
}

async function contextForJob(sb: SupabaseClient, job: z.infer<typeof claimedSchema>) {
  const { data: book, error: bookError } = await sb.from("books").select("id,workspace_id,title,author_name,language").eq("id", job.book_id).maybeSingle();
  if (bookError || !book || book.workspace_id !== job.workspace_id) throw new AiReviewFailure("ai_source_unavailable", false, "Book source is unavailable");
  const snapshots = new Map<string, Snapshot>();
  for (const pointer of job.input_ref.chapterVersions) {
    const { data: chapter, error: chapterError } = await sb.from("chapters").select("id,title,order_index,book_id").eq("id", pointer.chapterId).maybeSingle();
    const { data: version, error: versionError } = await sb.from("document_versions").select("version_number,content_json").eq("chapter_id", pointer.chapterId).eq("version_number", pointer.version).maybeSingle();
    if (chapterError || versionError || !chapter || !version || chapter.book_id !== job.book_id) throw new AiReviewFailure("ai_source_changed", false, "The saved chapter version is no longer available");
    snapshots.set(pointer.chapterId, { title: String(chapter.title), order: Number(chapter.order_index), version: Number(version.version_number), nodes: parseNodes(version.content_json) });
  }
  const [{ data: style, error: styleError }, { data: bible, error: bibleError }] = await Promise.all([
    sb.from("style_guides").select("rules_json,tone,spelling_variant").eq("book_id", job.book_id).maybeSingle(),
    sb.from("book_bible_items").select("id,type,name,description,attributes_json,source_refs_json").eq("book_id", job.book_id).order("created_at").limit(100),
  ]);
  if (styleError || bibleError) throw new AiReviewFailure("ai_source_unavailable", true, "Could not assemble approved AI context");
  const query = retrievalQuery(job.input_ref.userInstruction ?? [...snapshots.values()].map((chapter) => `${chapter.title} ${chapter.nodes.map((node) => node.text ?? "").join(" ")}`).join(" "));
  const related = job.input_ref.contextPolicy.includeRelatedContext && ["writer","consistency"].includes(job.agent_type) && query ? await searchBookContext(sb, job.book_id, { query, limit: job.input_ref.contextPolicy.semanticTopK, includeBible: job.input_ref.contextPolicy.includeBookBible }) : [];
  return { book: book as Record<string, unknown>, snapshots, body: { jobId: job.id, workspaceId: job.workspace_id, bookId: job.book_id, agentType: job.agent_type, idempotencyKey: `worker:${job.id}`, contextPolicy: job.input_ref.contextPolicy, input: { chapterIds: [...snapshots.keys()], chapters: Object.fromEntries([...snapshots].map(([id, value]) => [id, { id, title: value.title, version: value.version, nodes: value.nodes }])), styleGuide: job.input_ref.contextPolicy.includeStyleGuide && style ? { rules: style.rules_json, tone: style.tone, spellingVariant: style.spelling_variant } : {}, bookBible: job.input_ref.contextPolicy.includeBookBible ? bible ?? [] : [], relatedContext: related, userInstruction: job.input_ref.userInstruction } } };
}

export async function runOneAiReviewJob(sb: SupabaseClient, options: { leaseSeconds?: number; fetcher?: typeof fetch } = {}): Promise<AiReviewWorkerOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180; const claim = await sb.rpc("claim_ai_review_job", { p_lease_seconds: leaseSeconds });
  if (claim.error) throw new AiReviewFailure("ai_claim_failed", true); const raw = row(claim.data); if (!raw) return { status: "idle" };
  const parsed = claimedSchema.safeParse(raw); const jobId = String(raw.id); const token = String(raw.lease_token); if (!parsed.success) { await sb.rpc("fail_ai_review_job", { p_job_id: jobId, p_lease_token: token, p_error_code: "ai_invalid_input", p_error_message: "Invalid queued AI job", p_retryable: false }); return { status: "failed", jobId }; }
  const abort = new AbortController(); let renewal: Promise<void> | undefined; const heartbeat = setInterval(() => { if (renewal) return; renewal = Promise.resolve(sb.rpc("renew_ai_review_lease", { p_job_id: jobId, p_lease_token: token, p_lease_seconds: leaseSeconds })).then((renewed) => { if (renewed.error || renewed.data !== true) abort.abort(); }).catch(() => abort.abort()).finally(() => { renewal = undefined; }); }, Math.floor(leaseSeconds * 1000 / 3)); heartbeat.unref(); let completionAttempted = false;
  try {
    const context = await contextForJob(sb, parsed.data); abort.signal.throwIfAborted();
    const base = process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`;
    const response = await (options.fetcher ?? fetch)(`${base.replace(/\/$/u, "")}/v1/ai/jobs`, { method: "POST", redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]), headers: { "content-type": "application/json", ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) }, body: JSON.stringify(context.body) });
    const text = await response.text(); if (!response.ok || Buffer.byteLength(text) > 5_000_000) throw new AiReviewFailure("ai_service_unavailable", true, "AI service unavailable");
    const result = resultSchema.safeParse(JSON.parse(text)); if (!result.success || result.data.status === "failed") throw new AiReviewFailure("ai_provider_failed", true, result.success ? result.data.error ?? "AI provider failed" : "Invalid AI service response");
    const suggestions = normalize(result.data, context.book, context.snapshots); abort.signal.throwIfAborted(); completionAttempted = true;
    const complete = await sb.rpc("complete_leased_ai_review_job", { p_job_id: jobId, p_lease_token: token, p_provider: result.data.provider, p_model: result.data.model, p_usage: result.data.usage, p_diagnostics: result.data.diagnostics, p_suggestions: suggestions, p_credit_quantity: result.data.provider === "mock" ? 0 : 1 });
    if (complete.error || !row(complete.data)) throw new AiReviewFailure(complete.error?.code === "40001" ? "ai_lease_lost" : "ai_completion_failed", true); return { status: "succeeded", jobId };
  } catch (error) {
    if (completionAttempted) { try { const recovered = await sb.from("ai_jobs").select("status,lease_token").eq("id", jobId).maybeSingle(); if (recovered.data?.status === "succeeded") return { status: "succeeded", jobId }; } catch { return { status: "completion_unknown", jobId }; } }
    if (abort.signal.aborted) return { status: "lease_lost", jobId };
    const failure = error instanceof AiReviewFailure ? error : error instanceof AppError ? new AiReviewFailure(error.status >= 500 ? "ai_dependency_unavailable" : "ai_source_rejected", error.status >= 500, error.message) : new AiReviewFailure("ai_execution_failed", true, "AI review execution failed");
    const failed = await sb.rpc("fail_ai_review_job", { p_job_id: jobId, p_lease_token: token, p_error_code: failure.code, p_error_message: failure.message.slice(0, 2_000), p_retryable: failure.retryable });
    if (failed.error?.code === "40001") return { status: "lease_lost", jobId }; if (failed.error || !row(failed.data)) throw new AiReviewFailure("ai_failure_persistence_failed", true); return { status: row(failed.data)?.status === "queued" ? "queued" : "failed", jobId };
  } finally { clearInterval(heartbeat); await renewal; }
}
