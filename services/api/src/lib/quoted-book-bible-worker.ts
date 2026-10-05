/** Funded, one-way Book Bible dispatch. Unknown provider outcomes stay held. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { claimPricedDispatch, loadFundedUsage } from "./funded-usage.js";
import { aiUsageSchema } from "./ai-usage.js";
import { reconcileUsage, type UsageQuote } from "./usage-pricing.js";

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const version = z.object({ chapterId: id, documentVersionId: id, version: z.number().int().positive() }).strict();
const evidence = z.object({ chapterId: id, documentVersionId: id, nodeId: z.string().min(1).max(200), textHash: hash }).strict();
const jobSchema = z.object({ id, workspace_id: id, book_id: id, created_by: id, agent_type: z.literal("bookbible"),
  billing_mode: z.literal("quoted"), lease_token: id, model: z.string().min(1).max(128),
  input_ref: z.object({ bookBibleQuoteRequestId: id, sourceSha256: hash, generationRequestSha256: hash,
    chapterVersions: z.array(version).min(1).max(3), contextSources: z.array(evidence).min(1).max(100),
    reading: z.object({ fingerprint: hash, pageIndex: z.number().int().nonnegative() }).strict(),
    generationRequest: z.unknown() }).strict(),
}).passthrough();
const quoteRow = z.object({ id, user_id: id, workspace_id: id, book_id: id, generation_job_id: id,
  generation_request_json: z.unknown(), source_versions_json: z.unknown(), source_sha256: hash,
  generation_request_sha256: hash.nullable(),
  usage_quote_json: z.unknown().nullable(), status: z.enum(["counting", "ready", "failed"]), accepted_job_id: id.nullable() }).passthrough();
const candidate = z.object({ suggestionKind: z.literal("book_bible_candidate"), status: z.literal("pending"),
  type: z.enum(["character", "place", "organization", "object", "event", "term"]),
  name: z.string().trim().min(1).max(160), description: z.string().trim().max(12000),
  attributes: z.record(z.string().min(1).max(80), z.unknown()), sourceRefs: z.array(evidence).min(1).max(30),
  confidence: z.number().min(0).max(1), }).strict();
const candidates = z.array(candidate).max(10);
const diagnostic = z.object({ severity: z.enum(["error", "warning", "info"]), code: z.string().min(1).max(200),
  message: z.string().min(1).max(2000), location: z.record(z.string(), z.unknown()) }).strict();
const resultSchema = z.object({ jobId: id, workspaceId: id, bookId: id, agentType: z.literal("bookbible"),
  status: z.enum(["succeeded", "failed"]), provider: z.literal("openai"), model: z.string().min(1).max(200),
  requestId: z.string().trim().min(1).max(256), suggestions: z.array(z.unknown()).max(10),
  diagnostics: z.array(diagnostic).max(500), usage: aiUsageSchema }).passthrough();
const hashReply = z.object({ inputSha256: hash, model: z.string().min(1).max(128),
  maxOutputTokens: z.number().int().positive().max(6000), agentType: z.literal("bookbible") }).strict();
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const serviceUrl = () => (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/u, "");
const serviceHeaders = () => ({ "content-type": "application/json", ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) });
export type QuotedBookBibleOutcome = { status: "idle" | "succeeded" | "completion_unknown" | "requires_review"; jobId?: string };
type RowLike = { id: string; status: string };

async function readReceipt(fetcher: typeof fetch, jobId: string) {
  const response = await fetcher(`${serviceUrl()}/v1/ai/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000), headers: serviceHeaders(),
  });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text) > 2_000_000) throw new Error("saved Book Bible result unavailable");
  return JSON.parse(text) as unknown;
}

async function holdForReview(sb: SupabaseClient, job: z.output<typeof jobSchema>, reason: "provider_outcome_unknown" | "invalid_result" | "usage_unreconciled", requestId: string): Promise<QuotedBookBibleOutcome> {
  const result = await sb.rpc("hold_quoted_book_bible_for_review", { p_job_id: job.id, p_lease_token: job.lease_token,
    p_reason: reason, p_request_id: requestId });
  if (result.error || result.data !== true) throw new Error("could not durably hold Book Bible request for review");
  return { status: "requires_review", jobId: job.id };
}

export async function runOneQuotedBookBibleJob(sb: SupabaseClient, options: {
  leaseSeconds?: number; fetcher?: typeof fetch;
} = {}): Promise<QuotedBookBibleOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const claimed = await sb.rpc("claim_quoted_book_bible_job", { p_lease_seconds: leaseSeconds });
  if (claimed.error) throw new Error("quoted Book Bible claim unavailable");
  const parsed = jobSchema.safeParse(first(claimed.data));
  if (first(claimed.data) === null || first(claimed.data) === undefined) return { status: "idle" };
  if (!parsed.success) return { status: "completion_unknown" };
  const job = parsed.data; const fetcher = options.fetcher ?? fetch; const abort = new AbortController();
  let renewal: Promise<void> | undefined; let leaseLost = false; let dispatchAttempted = false; let completionAttempted = false;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = Promise.resolve(sb.rpc("renew_quoted_book_bible_lease", { p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds }))
      .then((result) => { if (result.error || result.data !== true) { leaseLost = true; abort.abort(); } })
      .catch(() => { leaseLost = true; abort.abort(); }).finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3)); heartbeat.unref();
  const waitRenewal = async () => { if (renewal) await renewal; };
  const holdForCurrentLease = async (reason: Parameters<typeof holdForReview>[2], requestId: string) => {
    await waitRenewal();
    if (leaseLost) return { status: "completion_unknown" as const, jobId: job.id };
    return holdForReview(sb, job, reason, requestId);
  };
  const savedCompletion = async () => {
    const saved = await sb.from("ai_jobs").select("id,status,model").eq("id", job.id).eq("workspace_id", job.workspace_id)
      .eq("book_id", job.book_id).eq("created_by", job.created_by).eq("agent_type", "bookbible")
      .eq("billing_mode", "quoted").eq("model", job.model).maybeSingle();
    if (saved.error || saved.data?.id !== job.id || saved.data.status !== "succeeded" || saved.data.model !== job.model) return false;
    const funded = await loadFundedUsage(sb, job.id);
    return funded?.status === "settled" && funded.user_id === job.created_by && funded.workspace_id === job.workspace_id
      && funded.quote_json.price.provider === "openai" && funded.quote_json.price.model === job.model
      && funded.quote_json.scope.inputSha256 === job.input_ref.generationRequestSha256;
  };
  try {
    const requestResult = await sb.from("book_bible_token_quote_requests").select("*")
      .eq("id", job.input_ref.bookBibleQuoteRequestId).maybeSingle();
    if (requestResult.error || !requestResult.data) throw new Error("Book Bible quote snapshot unavailable");
    const requestRow = quoteRow.parse(requestResult.data);
    const sourceSnapshot = z.object({ versions: z.array(version).min(1).max(3), reading: z.object({ fingerprint: hash, pageIndex: z.number().int().nonnegative() }).strict() }).strict().parse(requestRow.source_versions_json);
    const generation = z.object({ jobId: id, workspaceId: id, bookId: id, agentType: z.literal("bookbible"), model: z.string().min(1),
      maxOutputTokens: z.number().int().positive().max(6000), contextPolicy: z.record(z.string(), z.unknown()), input: z.record(z.string(), z.unknown()) }).strict().parse(requestRow.generation_request_json);
    const contextChapterIds = z.array(id).min(1).max(3).parse(generation.input.chapterIds);
    const chapterKeys = Object.keys(z.record(z.string(), z.unknown()).parse(generation.input.chapters));
    const sortedChapterIds = [...contextChapterIds].sort();
    if (requestRow.status !== "ready" || requestRow.accepted_job_id !== job.id || requestRow.generation_job_id !== job.id
      || requestRow.user_id !== job.created_by || requestRow.workspace_id !== job.workspace_id || requestRow.book_id !== job.book_id
      || requestRow.source_sha256 !== job.input_ref.sourceSha256
      || requestRow.generation_request_sha256 !== job.input_ref.generationRequestSha256
      || generation.jobId !== job.id || generation.workspaceId !== job.workspace_id || generation.bookId !== job.book_id
      || generation.model !== job.model || !isDeepStrictEqual(sourceSnapshot.versions, job.input_ref.chapterVersions)
      || !isDeepStrictEqual(sourceSnapshot.reading, job.input_ref.reading)
      || !isDeepStrictEqual(generation, job.input_ref.generationRequest)
      || new Set(contextChapterIds).size !== contextChapterIds.length
      || !isDeepStrictEqual(sortedChapterIds, chapterKeys.sort())
      || !isDeepStrictEqual(sortedChapterIds, sourceSnapshot.versions.map((item) => item.chapterId).sort())) {
      throw new Error("Book Bible quote/job snapshot mismatch");
    }
    const quote = z.custom<UsageQuote>().parse(requestRow.usage_quote_json);
    const funded = await loadFundedUsage(sb, job.id);
    if (!funded || funded.status !== "held" || funded.user_id !== job.created_by || funded.workspace_id !== job.workspace_id
      || !isDeepStrictEqual(funded.quote_json, quote) || quote.scope.inputSha256 !== job.input_ref.generationRequestSha256
      || quote.price.model !== job.model) throw new Error("Book Bible funded quote mismatch");
    const prior = await sb.from("funded_usage_quotes").select("dispatched_at").eq("job_id", job.id).maybeSingle();
    if (prior.error) throw new Error("Book Bible dispatch state unavailable");
    let rawResult: unknown;
    if (prior.data?.dispatched_at) {
      try { rawResult = await readReceipt(fetcher, job.id); }
      catch { return await holdForCurrentLease("provider_outcome_unknown", `book-bible-dispatch-unknown:${job.id}`); }
    } else {
      const providerRequest = { ...generation, expectedInputSha256: quote.scope.inputSha256 };
      const checkedResponse = await fetcher(`${serviceUrl()}/v1/ai/text/request-hash`, { method: "POST", redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]), headers: serviceHeaders(), body: JSON.stringify(providerRequest) });
      const checkedText = await checkedResponse.text();
      if (!checkedResponse.ok || Buffer.byteLength(checkedText) > 65_536) throw new Error("Book Bible request hash unavailable");
      const checked = hashReply.parse(JSON.parse(checkedText));
      if (checked.inputSha256 !== quote.scope.inputSha256 || checked.model !== quote.price.model
        || checked.maxOutputTokens !== generation.maxOutputTokens) {
        await waitRenewal(); abort.signal.throwIfAborted();
        const released = await sb.rpc("release_quoted_book_bible_before_dispatch", { p_job_id: job.id,
          p_lease_token: job.lease_token, p_reason: "request_mismatch" });
        if (released.error || released.data !== true) throw new Error("Book Bible request mismatch release uncertain");
        return { status: "completion_unknown", jobId: job.id };
      }
      abort.signal.throwIfAborted(); await waitRenewal();
      if (leaseLost) throw new Error("Book Bible lease lost before dispatch");
      await claimPricedDispatch(sb, { jobId: job.id, leaseToken: job.lease_token,
        inputSha256: quote.scope.inputSha256, model: quote.price.model });
      dispatchAttempted = true;
      await waitRenewal(); abort.signal.throwIfAborted();
      try {
        const response = await fetcher(`${serviceUrl()}/v1/ai/jobs`, { method: "POST", redirect: "error",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(150_000)]), headers: serviceHeaders(),
          body: JSON.stringify({ ...providerRequest, idempotencyKey: `quoted-book-bible:${job.id}` }) });
        const text = await response.text();
        if (!response.ok || Buffer.byteLength(text) > 2_000_000) throw new Error("Book Bible provider result unavailable");
        rawResult = JSON.parse(text);
      } catch {
        try { rawResult = await readReceipt(fetcher, job.id); }
        catch { return await holdForCurrentLease("provider_outcome_unknown", `book-bible-dispatch-unknown:${job.id}`); }
      }
    }
    const completed = resultSchema.safeParse(rawResult);
    if (!completed.success) return await holdForCurrentLease("invalid_result", `book-bible-invalid-result:${job.id}`);
    const result = completed.data;
    if (result.jobId !== job.id || result.workspaceId !== job.workspace_id || result.bookId !== job.book_id
      || result.agentType !== "bookbible" || result.model !== quote.price.model || result.status !== "succeeded") {
      return await holdForCurrentLease("invalid_result", result.requestId);
    }
    const parsedCandidates = candidates.safeParse(result.suggestions);
    const trusted = new Set(job.input_ref.contextSources.map((ref) => JSON.stringify(ref)));
    if (!parsedCandidates.success || !isDeepStrictEqual(parsedCandidates.data, result.suggestions)
      || parsedCandidates.data.some((item) => item.sourceRefs.some((ref) => !trusted.has(JSON.stringify(ref))))) {
      return await holdForCurrentLease("invalid_result", result.requestId);
    }
    // aiUsageSchema permits absent provider measurements for non-retail AI jobs.
    // A funded quote must never substitute estimated/aggregate counts for actual tokens.
    if (!result.usage.measuredTokens) return await holdForCurrentLease("usage_unreconciled", result.requestId);
    let settlement;
    try { settlement = reconcileUsage(quote, { scope: quote.scope, provider: "openai", model: result.model,
      requestId: result.requestId, measurement: "measured", tokens: result.usage.measuredTokens }); }
    catch { return await holdForCurrentLease("usage_unreconciled", result.requestId); }
    if (settlement.status === "requires_review") return await holdForCurrentLease("usage_unreconciled", result.requestId);
    abort.signal.throwIfAborted(); await waitRenewal();
    if (leaseLost) return { status: "completion_unknown", jobId: job.id };
    completionAttempted = true;
    const stored = await sb.rpc("complete_quoted_book_bible_job", { p_job_id: job.id, p_lease_token: job.lease_token,
      p_provider: result.provider, p_model: result.model, p_request_id: result.requestId,
      p_usage: result.usage, p_diagnostics: result.diagnostics, p_candidates: parsedCandidates.data, p_settlement: settlement });
    const row = first(stored.data) as RowLike | null;
    if (stored.error || !row || row.id !== job.id || row.status !== "succeeded") {
      return { status: await savedCompletion() ? "succeeded" : "completion_unknown", jobId: job.id };
    }
    return { status: "succeeded", jobId: job.id };
  } catch {
    if (completionAttempted) {
      try { if (await savedCompletion()) return { status: "succeeded", jobId: job.id }; } catch { /* Preserve ambiguous completion for status recovery. */ }
      return { status: "completion_unknown", jobId: job.id };
    }
    if (leaseLost) return { status: "completion_unknown", jobId: job.id };
    if (dispatchAttempted) {
      try { await readReceipt(fetcher, job.id); }
      catch { return await holdForCurrentLease("provider_outcome_unknown", `book-bible-dispatch-unknown:${job.id}`); }
    }
    return { status: "completion_unknown", jobId: job.id };
  } finally { clearInterval(heartbeat); await waitRenewal(); }
}
