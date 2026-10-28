/** Explicit internal factory, deliberately not mounted in a queue/HTTP route.
 * One resolver attempt, one provider-service POST, then receipt-only recovery.
 * Never logs transport errors/source/key, refunds an uncertain outcome, changes
 * payer, or retries provider generation. Callers must use a service-role client.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import type { CredentialVault } from "./ai-connection-vault.js";
import { customerDispatchScope, customerDispatchSigner, prepareCustomerDispatch } from "./customer-ai-dispatch.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.object({ id, workspace_id: id, book_id: id, created_by: id,
  agent_type: customerDispatchScope.shape.agentType, model: customerDispatchScope.shape.policy.shape.model,
  billing_mode: z.literal("customer_key"), input_ref: z.object({ customerGrantId: id, requestSha256: hash }).strict() });
const claimedJob = identity.extend({ status: z.literal("running"), lease_token: id }).passthrough();
type ClaimedJob = z.infer<typeof claimedJob>;
const completedJob = identity.extend({ status: z.literal("succeeded"), lease_token: z.null(),
  output_ref: z.object({ costPayer: z.literal("customer"), providerCostStatus: z.literal("unknown"),
    reviewRequired: z.literal(true), customerDispatchSha256: hash }).passthrough() }).passthrough();
const context = z.object({ scope: customerDispatchScope, request: z.unknown() }).strict();
const resolved = context.extend({ credential: z.object({ keyId: z.string().min(1).max(40),
  nonce: z.string().max(32), ciphertext: z.string().max(5500), tag: z.string().max(32) }).strict() }).strict();
const first = (data: unknown) => Array.isArray(data) ? data.length === 1 ? data[0] : undefined : data;
export type CustomerAiOutcome = { jobId: string; status: "unavailable" | "preparation_failed" | "succeeded" | "requires_review" | "completion_unknown" };

/** Stop waiting at the deadline even if a transport ignores AbortSignal. The
 * operation may still commit later: racing it is not cancellation evidence. */
async function waitFor<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(operation);
  if (signal.aborted) { void pending.catch(() => {}); signal.throwIfAborted(); }
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Customer AI operation deadline exceeded."));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const result = await Promise.race([pending, stopped]);
    signal.throwIfAborted();
    return result;
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

type PendingRpc = { count: number };
async function rpc(sb: SupabaseClient, name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 60_000, tracker?: PendingRpc) {
  // PostgREST writes are single-attempt. Even read retries must not extend a lease.
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let operation = Promise.resolve(sb.rpc(name, args).abortSignal(deadline));
  if (tracker) {
    tracker.count++;
    operation = operation.finally(() => { tracker.count--; });
  }
  const result = await waitFor(operation, deadline);
  if (result.error) throw new Error("Customer AI database operation unavailable.");
  return result.data as unknown;
}

/** Recovery needs neither a vault nor a provider connection. A public caller
 * must separately authenticate the actor and check current book access.
 */
export async function recoverCustomerAiJob(sb: SupabaseClient, jobId: string, ownerId: string, fingerprint: string,
  expected?: ClaimedJob, timeoutMs = 60_000, tracker?: PendingRpc): Promise<CustomerAiOutcome> {
  if (!id.safeParse(jobId).success || !id.safeParse(ownerId).success || !hash.safeParse(fingerprint).success) {
    return { status: "completion_unknown", jobId };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return { status: "completion_unknown", jobId };
  // Exact receipt replay is transactional/idempotent, unlike generation.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = completedJob.parse(first(await rpc(sb, "complete_customer_ai_job", {
        p_job_id: jobId, p_owner_id: ownerId, p_receipt_fingerprint: fingerprint,
      }, undefined, timeoutMs, tracker)));
      if (result.id !== jobId || result.created_by !== ownerId || result.output_ref.customerDispatchSha256 !== fingerprint
        || (expected && !isDeepStrictEqual(identity.parse(result), identity.parse(expected)))) continue;
      return { status: "succeeded", jobId };
    } catch { /* Static unknown outcome. Never expose database/provider details. */ }
  }
  return { status: "completion_unknown", jobId };
}

export function customerAiWorker(sb: SupabaseClient, options: {
  serviceUrl: string; serviceToken: string; vault: CredentialVault;
  signer: ReturnType<typeof customerDispatchSigner>; fetcher?: typeof fetch;
  allowLoopbackHttp?: boolean;
  rpcTimeoutMs?: number; dispatchTimeoutMs?: number;
}) {
  let endpoint: string;
  try {
    const url = new URL(options.serviceUrl);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (options.allowLoopbackHttp === true && loopback && url.protocol === "http:"))
      || !/^[\x21-\x7e]{16,4096}$/u.test(options.serviceToken) || !options.vault || !options.signer
      || !Number.isInteger(options.rpcTimeoutMs ?? 60_000) || (options.rpcTimeoutMs ?? 60_000) < 1 || (options.rpcTimeoutMs ?? 60_000) > 60_000
      || !Number.isInteger(options.dispatchTimeoutMs ?? 90_000) || (options.dispatchTimeoutMs ?? 90_000) < 1 || (options.dispatchTimeoutMs ?? 90_000) > 90_000) throw new Error();
    endpoint = url.origin + "/v1/internal/customer-text/dispatch";
  } catch { throw new Error("Customer AI worker configuration unavailable."); }
  // Snapshot explicit operator dependencies. No process-wide provider/key mutation.
  const { vault, signer, serviceToken } = options, fetcher = options.fetcher ?? fetch;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 60_000, dispatchTimeoutMs = options.dispatchTimeoutMs ?? 90_000;
  // An abandoned transport still owns its Request, including its internal body
  // copy. Do not send another job until it settles or its process is terminated.
  const pendingRpc: PendingRpc = { count: 0 };
  let running = false, postInFlight = false;
  return {
    assertTransportHealthy() {
      if (postInFlight || pendingRpc.count) throw new Error("Customer AI transport has an unresolved operation.");
    },
    async run(jobId: string, signal?: AbortSignal): Promise<CustomerAiOutcome> {
      if (!id.safeParse(jobId).success || signal?.aborted || running || postInFlight || pendingRpc.count) return { status: "unavailable", jobId };
      running = true;
      try {
      let job: ClaimedJob;
      try {
        job = claimedJob.parse(first(await rpc(sb, "claim_customer_ai_job", { p_job_id: jobId, p_lease_seconds: 300 }, signal, rpcTimeoutMs, pendingRpc)));
        if (job.id !== jobId) return { status: "unavailable", jobId };
      } catch { return { status: "unavailable", jobId }; }
      let resolutionAttempted = false, fingerprint: string | undefined;
      let secret: Buffer | undefined, wire: Buffer | undefined;
      try {
        const raw = context.parse(await rpc(sb, "prepare_customer_ai_dispatch", { p_job_id: job.id, p_lease_token: job.lease_token }, signal, rpcTimeoutMs, pendingRpc));
        const prepared = prepareCustomerDispatch(raw.scope, raw.request), s = prepared.scope;
        if (s.jobId !== job.id || s.ownerId !== job.created_by || s.workspaceId !== job.workspace_id || s.bookId !== job.book_id
          || s.leaseToken !== job.lease_token || s.agentType !== job.agent_type || s.policy.model !== job.model
          || s.grantId !== job.input_ref.customerGrantId || s.expectedRequestSha256 !== job.input_ref.requestSha256) throw new Error();
        fingerprint = prepared.fingerprint;
        signal?.throwIfAborted();
        // Set BEFORE calling: the resolver can commit and lose its response.
        resolutionAttempted = true;
        const dispatch = resolved.parse(await rpc(sb, "resolve_customer_ai_dispatch", {
          p_job_id: job.id, p_lease_token: job.lease_token, p_fingerprint: fingerprint,
        }, signal, rpcTimeoutMs, pendingRpc));
        const returned = prepareCustomerDispatch(dispatch.scope, dispatch.request);
        if (returned.fingerprint !== fingerprint || !isDeepStrictEqual(returned, prepared)) throw new Error();
        signal?.throwIfAborted();
        const binding = { ownerId: s.ownerId, provider: s.provider, connectionId: s.connectionId, revision: s.credentialRevision };
        secret = vault.open(dispatch.credential, binding);
        wire = signer.sign(prepared.scope, prepared.request, { binding, secret }).takeBody();
        secret.fill(0); secret = undefined;
        const deadline = AbortSignal.any([AbortSignal.timeout(dispatchTimeoutMs), ...(signal ? [signal] : [])]);
        // Request construction copies the Buffer. The original is no longer
        // owned by the transport and can be cleared before fetch is invoked.
        const request = new Request(endpoint, { method: "POST", redirect: "error",
          headers: { "content-type": "application/json", "x-service-token": serviceToken },
          signal: deadline,
          body: wire as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"] });
        wire.fill(0); wire = undefined;
        postInFlight = true;
        const post = Promise.resolve().then(() => { deadline.throwIfAborted(); return fetcher(request, { redirect: "error" }); });
        const observed = post.then(response => {
          // Clearing health on settled cleanup assumes trusted native fetch;
          // it does not prove Request-copy erasure or remote cancellation.
          if (!response.body) { postInFlight = false; return; }
          // Receipt recovery need not wait for cancellation. New dispatches
          // remain blocked until the stream confirms cleanup; a failed or
          // permanently stalled cancellation requires process supervision.
          try { void response.body.cancel().then(() => { postInFlight = false; }, () => {}); }
          catch { /* Unconfirmed cleanup stays unhealthy. */ }
        }, () => { /* A rejected transport does not prove its peer stopped. */ });
        // Observes late failure/response without trusting its body. Abort is
        // never evidence that the provider cancelled its paid request.
        await waitFor(observed, deadline);
      } catch { /* No raw exceptions, secret-bearing bodies or retries. */ }
      finally { secret?.fill(0); wire?.fill(0); }
      if (!resolutionAttempted || !fingerprint) return { status: "preparation_failed", jobId };
      const completed = await recoverCustomerAiJob(sb, job.id, job.created_by, fingerprint, job, rpcTimeoutMs, pendingRpc);
      if (completed.status === "succeeded") return completed;
      try {
        const held = identity.extend({ status: z.literal("failed"), error_code: z.literal("customer_provider_outcome_unknown"),
          lease_token: z.null() }).passthrough().parse(first(await rpc(sb, "hold_customer_ai_job", { p_job_id: job.id, p_lease_token: job.lease_token }, undefined, rpcTimeoutMs, pendingRpc)));
        if (isDeepStrictEqual(identity.parse(held), identity.parse(job))) return { status: "requires_review", jobId };
      } catch { /* Completion may have won the race with this hold. */ }
      return recoverCustomerAiJob(sb, job.id, job.created_by, fingerprint, job, rpcTimeoutMs, pendingRpc);
      } finally { running = false; }
    },
  };
}
