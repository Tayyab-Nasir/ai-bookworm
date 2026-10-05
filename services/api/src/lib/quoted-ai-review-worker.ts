/** Funded AI-review execution. A durable quote and one-way marker precede any
 * OpenAI dispatch; ambiguous results remain held until a saved receipt exists. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { buildAiReviewContext, validateAiReviewResult, type AiReviewContextJob } from "./ai-review-worker.js";
import { parseNodes } from "./authoring.js";
import { claimPricedDispatch, loadFundedUsage } from "./funded-usage.js";
import { reconcileUsage, type TokenQuantities, type UsageQuote } from "./usage-pricing.js";

const id = z.string().uuid();
const jobSchema = z.object({ id, workspace_id: id, book_id: id, created_by: id,
  agent_type: z.enum(["writer", "proofreader", "copyeditor", "consistency"]),
  billing_mode: z.literal("quoted"), lease_token: id,
  model: z.string().min(1).max(128),
  input_ref: z.object({ aiReviewQuoteRequestId: id, generationRequestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    chapterVersions: z.array(z.object({ chapterId: id, version: z.number().int().positive(), documentVersionId: id }).strict()).min(1).max(5),
    userInstruction: z.string().nullable(), contextPolicy: z.record(z.string(), z.unknown()), maxOutputTokens: z.number().int().positive() }).strict(),
}).passthrough();
const quoteRowSchema = z.object({ id, user_id: id, workspace_id: id, book_id: id,
  generation_job_id: id, generation_request_json: z.unknown(), catalog_json: z.unknown(), source_versions_json: z.unknown(),
  status: z.enum(["counting", "ready", "failed"]), request_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  counted_input_tokens: z.number().int().positive().nullable(), usage_quote_json: z.unknown().nullable(),
  accepted_job_id: id.nullable() }).passthrough();
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative(), latencyMs: z.number().int().nonnegative().optional(),
  measuredTokens: z.array(z.object({ dimension: z.enum(["text_input", "text_cached_input", "text_output"]),
    tokens: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict()).length(3) }).strict();
const resultSchema = z.object({ jobId: id, workspaceId: id, bookId: id,
  agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency"]), status: z.literal("succeeded"),
  provider: z.literal("openai"), model: z.string().min(1).max(128), requestId: z.string().trim().min(1).max(256),
  suggestions: z.array(z.unknown()).max(200), diagnostics: z.array(z.unknown()).max(500), usage: usageSchema }).passthrough();
const hashReply = z.object({ inputSha256: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().min(1).max(128),
  maxOutputTokens: z.number().int().positive(), agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency"]) }).strict();
export type QuotedAiReviewOutcome = { status: "idle" | "succeeded" | "completion_unknown" | "requires_review"; jobId?: string };
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const serviceUrl = () => (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/u, "");
const serviceHeaders = () => ({ "content-type": "application/json", ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) });

async function loadQuote(sb: SupabaseClient, job: z.output<typeof jobSchema>) {
  const { data, error } = await sb.from("ai_review_token_quote_requests").select("*")
    .eq("id", job.input_ref.aiReviewQuoteRequestId).maybeSingle();
  if (error || !data) throw new Error("AI review quote unavailable");
  const saved = quoteRowSchema.parse(data);
  if (saved.status !== "ready" || saved.accepted_job_id !== job.id || saved.generation_job_id !== job.id
    || saved.user_id !== job.created_by || saved.workspace_id !== job.workspace_id || saved.book_id !== job.book_id
    || saved.request_sha256 !== job.input_ref.generationRequestSha256) throw new Error("AI review quote/job identity mismatch");
  const request = z.object({ jobId: id, workspaceId: id, bookId: id,
    agentType: z.enum(["writer", "proofreader", "copyeditor", "consistency"]), model: z.string(), maxOutputTokens: z.number().int().positive(),
    contextPolicy: z.record(z.string(), z.unknown()), input: z.object({ chapterIds: z.array(id).min(1).max(5),
      chapters: z.record(id, z.object({ id, title: z.string().max(500), version: z.number().int().positive(),
        nodes: z.array(z.unknown()).max(20_000) }).passthrough()),
      userInstruction: z.string().nullable() }).passthrough() }).passthrough().parse(saved.generation_request_json);
  const versions = z.array(z.object({ chapterId: id, version: z.number().int().positive(), documentVersionId: id }).strict()).parse(saved.source_versions_json);
  if (request.jobId !== job.id || request.workspaceId !== job.workspace_id || request.bookId !== job.book_id
    || request.agentType !== job.agent_type || request.model !== job.model || request.maxOutputTokens !== job.input_ref.maxOutputTokens
    || !isDeepStrictEqual(versions, job.input_ref.chapterVersions)
    || request.input.userInstruction !== job.input_ref.userInstruction
    || !isDeepStrictEqual(request.contextPolicy, job.input_ref.contextPolicy)) throw new Error("AI review request snapshot mismatch");
  if (new Set(request.input.chapterIds).size !== versions.length || request.input.chapterIds.length !== versions.length
    || Object.keys(request.input.chapters).length !== versions.length
    || versions.some((source) => !request.input.chapterIds.includes(source.chapterId)
      || request.input.chapters[source.chapterId]?.id !== source.chapterId
      || request.input.chapters[source.chapterId]?.version !== source.version)) throw new Error("AI review source snapshot mismatch");
  const quote = z.custom<UsageQuote>().parse(saved.usage_quote_json);
  return { saved, request, quote };
}

async function readReceipt(fetcher: typeof fetch, jobId: string) {
  const response = await fetcher(`${serviceUrl()}/v1/ai/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000), headers: serviceHeaders(),
  });
  const body = await response.text();
  if (!response.ok || Buffer.byteLength(body) > 5_000_000) throw new Error("saved AI review result unavailable");
  return JSON.parse(body) as unknown;
}

async function markReview(sb: SupabaseClient, job: z.output<typeof jobSchema>, reason: "provider_outcome_unknown" | "invalid_result" | "usage_unreconciled", requestId: string) {
  const held = await sb.rpc("hold_quoted_ai_review_for_review", { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason, p_request_id: requestId });
  if (held.error || held.data !== true) throw new Error("could not durably hold AI review for billing review");
  return { status: "requires_review" as const, jobId: job.id };
}

export async function runOneQuotedAiReviewJob(sb: SupabaseClient, options: {
  leaseSeconds?: number; fetcher?: typeof fetch; clock?: () => string;
} = {}): Promise<QuotedAiReviewOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const claimed = await sb.rpc("claim_quoted_ai_review_job", { p_lease_seconds: leaseSeconds });
  if (claimed.error) throw new Error("quoted AI review claim unavailable");
  const rawJob = first(claimed.data);
  if (!rawJob) return { status: "idle" };
  const parsed = jobSchema.safeParse(rawJob);
  if (!parsed.success) return { status: "completion_unknown" };
  const job = parsed.data; const fetcher = options.fetcher ?? fetch; const abort = new AbortController();
  let renewal: Promise<void> | undefined; let leaseLost = false; let dispatchAttempted = false; let completionAttempted = false;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = Promise.resolve(sb.rpc("renew_quoted_ai_review_lease", { p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds }))
      .then((result) => { if (result.error || result.data !== true) { leaseLost = true; abort.abort(); } })
      .catch(() => { leaseLost = true; abort.abort(); }).finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3)); heartbeat.unref();
  const waitRenewal = async () => { if (renewal) await renewal; };
  const holdForReview = async (reason: Parameters<typeof markReview>[2], requestId: string) => {
    await waitRenewal();
    if (leaseLost) return { status: "completion_unknown" as const, jobId: job.id };
    return markReview(sb, job, reason, requestId);
  };
  const savedCompletion = async () => {
    const recovered = await sb.from("ai_jobs").select("id,status").eq("id", job.id).eq("workspace_id", job.workspace_id)
      .eq("book_id", job.book_id).eq("created_by", job.created_by).eq("billing_mode", "quoted").maybeSingle();
    return !recovered.error && recovered.data?.id === job.id && recovered.data.status === "succeeded";
  };
  try {
    const { quote, request } = await loadQuote(sb, job);
    const funded = await loadFundedUsage(sb, job.id);
    if (!funded || funded.status !== "held" || funded.user_id !== job.created_by || funded.workspace_id !== job.workspace_id
      || !isDeepStrictEqual(funded.quote_json, quote) || quote.scope.inputSha256 !== job.input_ref.generationRequestSha256
      || quote.price.model !== job.model) throw new Error("AI review funded quote mismatch");
    const contextPolicy = z.object({ includeBookBible: z.boolean(), includeStyleGuide: z.boolean(),
      includeRelatedContext: z.boolean(), semanticTopK: z.number().int().min(1).max(20),
      maxTokens: z.number().int().min(256).max(16_000) }).strict().parse(job.input_ref.contextPolicy);
    const contextJob: AiReviewContextJob = { id: job.id, workspace_id: job.workspace_id, book_id: job.book_id,
      created_by: job.created_by, agent_type: job.agent_type, lease_token: job.lease_token,
      input_ref: { chapterVersions: job.input_ref.chapterVersions.map(({ chapterId, version }) => ({ chapterId, version })),
        userInstruction: job.input_ref.userInstruction, contextPolicy } };
    // Dispatch and receipt validation use exactly the consented saved context.
    // Reloading style/Bible/retrieval can change the already counted request.
    const { data: book, error: bookError } = await sb.from("books").select("id,workspace_id,title,author_name,language")
      .eq("id", job.book_id).maybeSingle();
    if (bookError || !book || book.workspace_id !== job.workspace_id) throw new Error("AI review book scope unavailable");
    const context = { book, body: request, snapshots: new Map(request.input.chapterIds.map((chapterId, order) => {
      const chapter = request.input.chapters[chapterId]!;
      return [chapterId, { title: chapter.title, order, version: chapter.version, nodes: parseNodes({ nodes: chapter.nodes }) }];
    })) } as unknown as Awaited<ReturnType<typeof buildAiReviewContext>>;
    abort.signal.throwIfAborted();
    const generation = { ...request, model: quote.price.model,
      maxOutputTokens: Number(quote.maximumTokens.find((item) => item.dimension === "text_output")?.tokens),
      expectedInputSha256: quote.scope.inputSha256 };
    if (!Number.isSafeInteger(generation.maxOutputTokens) || generation.maxOutputTokens < 1) throw new Error("invalid AI review output bound");
    const prior = await sb.from("funded_usage_quotes").select("dispatched_at").eq("job_id", job.id).maybeSingle();
    if (prior.error) throw new Error("AI review dispatch state unavailable");
    let rawResult: unknown;
    if (prior.data?.dispatched_at) {
      try { rawResult = await readReceipt(fetcher, job.id); }
      catch { return await holdForReview("provider_outcome_unknown", `ai-review-dispatch-unknown:${job.id}`); }
    } else {
      const checkedResponse = await fetcher(`${serviceUrl()}/v1/ai/text/request-hash`, { method: "POST", redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]), headers: serviceHeaders(), body: JSON.stringify(generation) });
      const checkedText = await checkedResponse.text();
      if (!checkedResponse.ok || Buffer.byteLength(checkedText) > 65_536) throw new Error("AI review request hash unavailable");
      const checked = hashReply.parse(JSON.parse(checkedText));
      if (checked.inputSha256 !== quote.scope.inputSha256 || checked.model !== quote.price.model
        || checked.maxOutputTokens !== generation.maxOutputTokens || checked.agentType !== job.agent_type) {
        await waitRenewal(); abort.signal.throwIfAborted();
        const released = await sb.rpc("release_quoted_ai_review_before_dispatch", { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: "request_mismatch" });
        if (released.error || released.data !== true) throw new Error("AI review request mismatch release uncertain");
        return { status: "requires_review", jobId: job.id };
      }
      abort.signal.throwIfAborted(); await waitRenewal();
      if (leaseLost) throw new Error("AI review lease lost before dispatch");
      await claimPricedDispatch(sb, { jobId: job.id, leaseToken: job.lease_token,
        inputSha256: quote.scope.inputSha256, model: quote.price.model });
      dispatchAttempted = true;
      await waitRenewal(); abort.signal.throwIfAborted();
      try {
        const response = await fetcher(`${serviceUrl()}/v1/ai/jobs`, { method: "POST", redirect: "error",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(150_000)]), headers: serviceHeaders(),
          body: JSON.stringify({ ...generation, idempotencyKey: `quoted-ai-review:${job.id}` }) });
        const text = await response.text();
        if (!response.ok || Buffer.byteLength(text) > 5_000_000) throw new Error("AI review provider result unavailable");
        rawResult = JSON.parse(text);
      } catch {
        try { rawResult = await readReceipt(fetcher, job.id); }
        catch { return await holdForReview("provider_outcome_unknown", `ai-review-dispatch-unknown:${job.id}`); }
      }
    }
    let completed;
    try { completed = resultSchema.parse(rawResult); }
    catch { return await holdForReview("invalid_result", `ai-review-invalid-result:${job.id}`); }
    let normalized;
    try { normalized = validateAiReviewResult(completed, contextJob, context); }
    catch { return await holdForReview("invalid_result", `ai-review-invalid-result:${job.id}`); }
    if (completed.jobId !== job.id || completed.workspaceId !== job.workspace_id || completed.bookId !== job.book_id
      || completed.agentType !== job.agent_type || completed.model !== quote.price.model || completed.suggestions.length !== normalized.suggestions.length) {
      return await holdForReview("invalid_result", `ai-review-invalid-identity:${job.id}`);
    }
    const measured = { scope: quote.scope, provider: "openai" as const, model: completed.model, requestId: completed.requestId,
      measurement: "measured" as const, tokens: completed.usage.measuredTokens as TokenQuantities };
    let settlement: ReturnType<typeof reconcileUsage>;
    try { settlement = reconcileUsage(quote, measured); }
    catch { return await holdForReview("usage_unreconciled", completed.requestId); }
    if (settlement.status === "requires_review") return await holdForReview("usage_unreconciled", completed.requestId);
    const counts = new Map(completed.usage.measuredTokens.map((item) => [item.dimension, BigInt(item.tokens)]));
    if (counts.size !== 3 || counts.get("text_input")! + counts.get("text_cached_input")! !== BigInt(completed.usage.inputTokens)
      || counts.get("text_output") !== BigInt(completed.usage.outputTokens)) {
      return await holdForReview("usage_unreconciled", completed.requestId);
    }
    abort.signal.throwIfAborted(); await waitRenewal();
    if (leaseLost) return { status: "completion_unknown", jobId: job.id };
    completionAttempted = true;
    const stored = await sb.rpc("complete_quoted_ai_review_job", { p_job_id: job.id, p_lease_token: job.lease_token,
      p_provider: completed.provider, p_model: completed.model, p_usage: completed.usage,
      p_diagnostics: completed.diagnostics, p_suggestions: normalized.suggestions, p_settlement: settlement });
    const result = first(stored.data) as RowLike | null;
    if (stored.error || !result || result.id !== job.id || result.status !== "succeeded") {
      return { status: await savedCompletion() ? "succeeded" : "completion_unknown", jobId: job.id };
    }
    return { status: "succeeded", jobId: job.id };
  } catch {
    if (completionAttempted) {
      try { if (await savedCompletion()) return { status: "succeeded", jobId: job.id }; } catch { /* Keep the ambiguous completion for status recovery. */ }
      return { status: "completion_unknown", jobId: job.id };
    }
    if (leaseLost) return { status: "completion_unknown", jobId: job.id };
    if (dispatchAttempted) {
      try { await readReceipt(fetcher, job.id); }
      catch { return await holdForReview("provider_outcome_unknown", `ai-review-dispatch-unknown:${job.id}`); }
    }
    return { status: "completion_unknown", jobId: job.id };
  } finally { clearInterval(heartbeat); await waitRenewal(); }
}

type RowLike = { id: string; status: string };
