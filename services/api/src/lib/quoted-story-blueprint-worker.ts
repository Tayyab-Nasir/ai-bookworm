/**
 * Leased worker for one accepted, paid Story Blueprint proposal.
 *
 * A quote only authorizes the exact pinned request. This worker persists the
 * provider receipt and review candidate before it tries to settle credits, so
 * any uncertain post-dispatch outcome is recoverable without a second model
 * call. It never saves or materializes a blueprint.
 */
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { claimPricedDispatch, loadFundedUsage, settlePricedUsage } from "./funded-usage.js";
import { storyBlueprintCandidateSchema, storyBlueprintGenerationContextPolicy, storyBlueprintSourceSnapshotSchema } from "./story-blueprint-generation-contract.js";
import { reconcileUsage, type TokenQuantities, type UsageQuote } from "./usage-pricing.js";

const id = z.string().uuid();
const measuredTokensSchema = z.array(z.object({
  dimension: z.enum(["text_input", "text_cached_input", "text_output"]),
  tokens: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict()).length(3);
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative(),
  measuredTokens: measuredTokensSchema,
}).strict();
const providerReceiptSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().trim().min(1).max(128),
  requestId: z.string().trim().min(1).max(256),
  usage: usageSchema,
}).strict();
const jobSchema = z.object({
  id, workspace_id: id, book_id: id, created_by: id, billing_mode: z.literal("quoted"), lease_token: id,
  input_ref: z.object({
    proposalId: id, requestId: id, blueprintId: id, sourceRevision: z.number().int().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), generationRequestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).passthrough();
const proposalSchema = z.object({
  id, request_id: id, user_id: id, workspace_id: id, book_id: id, blueprint_id: id,
  source_revision: z.number().int().min(1), source_snapshot_json: storyBlueprintSourceSnapshotSchema,
  book_snapshot_json: z.object({
    title: z.string().max(500).refine((value) => value.trim().length > 0),
    author: z.string().max(500),
    language: z.string().max(40).refine((value) => value.trim().length > 0),
  }).strict(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/), generation_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation_job_id: id, accepted_job_id: id.nullable(),
}).passthrough();
const requestHashSchema = z.object({
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().trim().min(1).max(128),
}).strict();
const serviceResultSchema = z.object({
  status: z.literal("succeeded"), provider: z.literal("openai"), model: z.string().trim().min(1).max(128),
  requestId: z.string().trim().min(1).max(256), suggestions: z.array(storyBlueprintCandidateSchema).length(1),
  usage: usageSchema,
}).passthrough();
const storedResultSchema = z.object({
  provider_receipt_json: providerReceiptSchema,
  candidate_json: storyBlueprintCandidateSchema,
}).passthrough();

type Candidate = z.output<typeof storyBlueprintCandidateSchema>;
type ProviderReceipt = z.output<typeof providerReceiptSchema>;
type Completion = { receipt: ProviderReceipt; candidate: Candidate };
export type QuotedStoryBlueprintOutcome = {
  status: "idle" | "succeeded" | "completion_unknown" | "requires_review";
  jobId?: string;
};

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function exactMeasuredTokens(usage: z.output<typeof usageSchema>): TokenQuantities {
  const tokens = usage.measuredTokens as TokenQuantities;
  const byDimension = new Map(tokens.map((item) => [item.dimension, item.tokens]));
  if (byDimension.size !== 3
    || BigInt(byDimension.get("text_input") ?? "-1") + BigInt(byDimension.get("text_cached_input") ?? "-1") !== BigInt(usage.inputTokens)
    || BigInt(byDimension.get("text_output") ?? "-1") !== BigInt(usage.outputTokens)) {
    throw new Error("inconsistent provider-measured Story Blueprint usage");
  }
  return tokens;
}

function aiServiceUrl() {
  return (process.env.AI_SERVICE_URL ?? `http://127.0.0.1:${process.env.AI_SERVICE_PORT ?? "8000"}`).replace(/\/$/u, "");
}

async function savedProposal(sb: SupabaseClient, job: z.output<typeof jobSchema>) {
  const { data, error } = await sb.from("story_blueprint_quote_proposals")
    .select("id,request_id,user_id,workspace_id,book_id,blueprint_id,source_revision,source_snapshot_json,book_snapshot_json,source_sha256,generation_request_sha256,generation_job_id,accepted_job_id")
    .eq("id", job.input_ref.proposalId).maybeSingle();
  if (error) throw new Error("Story Blueprint proposal unavailable");
  const proposal = proposalSchema.parse(data);
  if (proposal.request_id !== job.input_ref.requestId || proposal.blueprint_id !== job.input_ref.blueprintId
    || proposal.workspace_id !== job.workspace_id || proposal.book_id !== job.book_id || proposal.user_id !== job.created_by
    || proposal.generation_job_id !== job.id || proposal.accepted_job_id !== job.id
    || proposal.source_revision !== job.input_ref.sourceRevision || proposal.source_sha256 !== job.input_ref.sourceSha256
    || proposal.generation_request_sha256 !== job.input_ref.generationRequestSha256) {
    throw new Error("Story Blueprint proposal/job identity mismatch");
  }
  return proposal;
}

async function existingCompletion(sb: SupabaseClient, jobId: string): Promise<Completion | null> {
  const { data, error } = await sb.from("story_blueprint_generation_results")
    .select("provider_receipt_json,candidate_json").eq("ai_job_id", jobId).maybeSingle();
  if (error) throw new Error("Story Blueprint receipt unavailable");
  if (!data) return null;
  const row = storedResultSchema.parse(data);
  return { receipt: row.provider_receipt_json, candidate: row.candidate_json };
}

function storyBlueprintRequest(job: z.output<typeof jobSchema>, proposal: z.output<typeof proposalSchema>, model: string, maxOutputTokens: number) {
  return {
    jobId: job.id, workspaceId: job.workspace_id, bookId: job.book_id, model, maxOutputTokens,
    contextPolicy: storyBlueprintGenerationContextPolicy,
    input: {
      storyBlueprint: proposal.source_snapshot_json,
      book: proposal.book_snapshot_json,
    },
  };
}

function serviceHeaders() {
  return { "content-type": "application/json", ...(process.env.AI_SERVICE_TOKEN ? { "x-service-token": process.env.AI_SERVICE_TOKEN } : {}) };
}

async function verifyGenerationRequest(fetcher: typeof fetch, request: ReturnType<typeof storyBlueprintRequest>, expectedInputSha256: string) {
  const response = await fetcher(`${aiServiceUrl()}/v1/ai/story-blueprint/request-hash`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: serviceHeaders(), body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text, "utf8") > 64_000) throw new Error("Story Blueprint request identity unavailable");
  const result = requestHashSchema.parse(JSON.parse(text));
  if (result.inputSha256 !== expectedInputSha256 || result.model !== request.model) {
    throw new Error("Story Blueprint request no longer matches its funded quote");
  }
}

async function generateCompletion(fetcher: typeof fetch, job: z.output<typeof jobSchema>, proposal: z.output<typeof proposalSchema>,
  model: string, maxOutputTokens: number, signal: AbortSignal): Promise<Completion> {
  const request = storyBlueprintRequest(job, proposal, model, maxOutputTokens);
  const response = await fetcher(`${aiServiceUrl()}/v1/ai/jobs`, {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    headers: serviceHeaders(),
    body: JSON.stringify({
      ...request, agentType: "story_blueprint", expectedInputSha256: job.input_ref.generationRequestSha256,
      idempotencyKey: `worker:${job.id}`,
    }),
  });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text, "utf8") > 1_000_000) throw new Error("Story Blueprint AI service unavailable");
  const result = serviceResultSchema.parse(JSON.parse(text));
  const receipt = providerReceiptSchema.parse({
    provider: result.provider, model: result.model, requestId: result.requestId, usage: result.usage,
  });
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 65_536 || Buffer.byteLength(JSON.stringify(result.suggestions[0]), "utf8") > 524_288) {
    throw new Error("Story Blueprint provider result exceeds durable bounds");
  }
  exactMeasuredTokens(receipt.usage);
  return { receipt, candidate: result.suggestions[0] };
}

async function retainUnknownDispatchForReview(sb: SupabaseClient, input: {
  jobId: string; leaseToken: string; requestId: string; reason: "provider_outcome_unknown" | "receipt_persistence_uncertain";
}) {
  const result = await sb.rpc("mark_story_blueprint_generation_requires_review", {
    p_job_id: input.jobId, p_lease_token: input.leaseToken, p_request_id: input.requestId, p_reason: input.reason,
  });
  return !result.error && result.data === true;
}

async function retainForFinancialReview(sb: SupabaseClient, jobId: string, quote: UsageQuote, requestId: string) {
  const settlement = {
    status: "requires_review",
    // This is an immutable provider receipt identifier, not author content or
    // an internal job ID. Keep the whole maximum reservation until an operator
    // resolves an unverifiable/mismatched receipt.
    requestId,
    reason: "receipt_unreconciled",
    heldCredits: quote.reservedCredits,
    fingerprint: quote.fingerprint,
  };
  const result = await sb.rpc("settle_funded_usage_quote", { p_job_id: jobId, p_settlement: settlement });
  if (result.error || !firstRow(result.data)) throw new Error("Story Blueprint financial-review hold uncertain");
}

export async function runOneQuotedStoryBlueprintJob(
  sb: SupabaseClient,
  options: { leaseSeconds?: number; fetcher?: typeof fetch } = {},
): Promise<QuotedStoryBlueprintOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const claimed = await sb.rpc("claim_quoted_story_blueprint_job", { p_lease_seconds: leaseSeconds });
  if (claimed.error) throw new Error("Story Blueprint claim unavailable");
  const raw = firstRow(claimed.data);
  if (!raw) return { status: "idle" };
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success) return { status: "completion_unknown" };
  const job = parsed.data;
  const abort = new AbortController();
  let renewal: Promise<void> | undefined;
  let dispatchAttempted = false;
  let receiptPersisted = false;
  let completion: Completion | null = null;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = Promise.resolve(sb.rpc("renew_story_blueprint_generation_lease", {
      p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds,
    })).then((response) => { if (response.error || response.data !== true) abort.abort(); })
      .catch(() => abort.abort()).finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3));
  heartbeat.unref();
  try {
    const funded = await loadFundedUsage(sb, job.id);
    if (!funded || funded.user_id !== job.created_by || funded.workspace_id !== job.workspace_id
      || funded.quote_json.scope.inputSha256 !== job.input_ref.generationRequestSha256) {
      throw new Error("Story Blueprint funded quote mismatch");
    }
    const quote = funded.quote_json;
    const outputBound = quote.maximumTokens.find((item) => item.dimension === "text_output")?.tokens;
    if (!outputBound || BigInt(outputBound) < 1n || BigInt(outputBound) > 128_000n) throw new Error("invalid Story Blueprint output bound");
    const proposal = await savedProposal(sb, job);
    const prior = await existingCompletion(sb, job.id);
    completion = prior;
    receiptPersisted = completion !== null;
    if (!completion) {
      const request = storyBlueprintRequest(job, proposal, quote.price.model, Number(outputBound));
      abort.signal.throwIfAborted();
      // Verify the exact frozen prompt before committing the irreversible
      // provider-dispatch marker. This keeps source metadata/prompt drift from
      // trapping a paid hold after it can no longer be safely retried.
      await verifyGenerationRequest(options.fetcher ?? fetch, request, job.input_ref.generationRequestSha256);
      abort.signal.throwIfAborted();
      dispatchAttempted = true;
      await claimPricedDispatch(sb, {
        jobId: job.id, leaseToken: job.lease_token, model: quote.price.model,
        inputSha256: job.input_ref.generationRequestSha256,
      });
      completion = await generateCompletion(options.fetcher ?? fetch, job, proposal, quote.price.model,
        Number(outputBound), abort.signal);
      abort.signal.throwIfAborted();
      const written = await sb.rpc("record_story_blueprint_generation_result", {
        p_job_id: job.id, p_lease_token: job.lease_token,
        p_provider_receipt_json: completion.receipt, p_candidate_json: completion.candidate,
      });
      if (written.error || !firstRow(written.data)) throw new Error("Story Blueprint receipt persistence uncertain");
      receiptPersisted = true;
    }
    const measured = {
      scope: quote.scope, provider: completion.receipt.provider, model: completion.receipt.model,
      requestId: completion.receipt.requestId, measurement: "measured" as const,
      tokens: exactMeasuredTokens(completion.receipt.usage),
    };
    let settlement: ReturnType<typeof reconcileUsage>;
    try {
      settlement = reconcileUsage(quote, measured);
    } catch {
      // A valid immutable receipt that does not reconcile with its approved
      // quote (for example, a provider model mismatch) can never be silently
      // billed or retried. Convert it to the database's explicit held-review
      // state so the UI stops polling it as ordinary queued work.
      await retainForFinancialReview(sb, job.id, quote, completion.receipt.requestId);
      return { status: "requires_review", jobId: job.id };
    }
    abort.signal.throwIfAborted();
    const fundedAfter = await settlePricedUsage(sb, job.id, measured);
    if (settlement.status === "requires_review" || fundedAfter.status === "requires_review") {
      return { status: "requires_review", jobId: job.id };
    }
    const completed = await sb.rpc("complete_quoted_story_blueprint_generation", {
      p_job_id: job.id, p_lease_token: job.lease_token,
    });
    if (completed.error || !firstRow(completed.data)) throw new Error("Story Blueprint completion uncertain");
    return { status: "succeeded", jobId: job.id };
  } catch {
    if (dispatchAttempted && !receiptPersisted) {
      const requestId = completion?.receipt.requestId ?? `bookworm-dispatch-unknown:${job.id}`;
      const reason = completion ? "receipt_persistence_uncertain" : "provider_outcome_unknown";
      try {
        if (await retainUnknownDispatchForReview(sb, { jobId: job.id, leaseToken: job.lease_token, requestId, reason })) {
          return { status: "requires_review", jobId: job.id };
        }
      } catch { /* Keep the job recoverable if financial reconciliation also fails. */ }
    }
    // Never fail, refund, or redispatch a paid request based on an uncertain
    // network/provider outcome. A saved private receipt can only be settled or
    // completed on a later leased recovery run.
    return { status: "completion_unknown", jobId: job.id };
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}
