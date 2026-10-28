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

async function rpc(sb: SupabaseClient, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  // PostgREST writes are single-attempt. Even read retries must not extend a lease.
  const result = await sb.rpc(name, args).abortSignal(AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]));
  if (result.error) throw new Error("Customer AI database operation unavailable.");
  return result.data as unknown;
}

/** Recovery needs neither a vault nor a provider connection. A public caller
 * must separately authenticate the actor and check current book access.
 */
export async function recoverCustomerAiJob(sb: SupabaseClient, jobId: string, ownerId: string, fingerprint: string,
  expected?: ClaimedJob): Promise<CustomerAiOutcome> {
  if (!id.safeParse(jobId).success || !id.safeParse(ownerId).success || !hash.safeParse(fingerprint).success) {
    return { status: "completion_unknown", jobId };
  }
  // Exact receipt replay is transactional/idempotent, unlike generation.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = completedJob.parse(first(await rpc(sb, "complete_customer_ai_job", {
        p_job_id: jobId, p_owner_id: ownerId, p_receipt_fingerprint: fingerprint,
      })));
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
}) {
  let endpoint: string;
  try {
    const url = new URL(options.serviceUrl);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (options.allowLoopbackHttp === true && loopback && url.protocol === "http:"))
      || !/^[\x21-\x7e]{16,4096}$/u.test(options.serviceToken) || !options.vault || !options.signer) throw new Error();
    endpoint = url.origin + "/v1/internal/customer-text/dispatch";
  } catch { throw new Error("Customer AI worker configuration unavailable."); }
  // Snapshot explicit operator dependencies. No process-wide provider/key mutation.
  const { vault, signer, serviceToken } = options, fetcher = options.fetcher ?? fetch;
  return {
    async run(jobId: string, signal?: AbortSignal): Promise<CustomerAiOutcome> {
      if (!id.safeParse(jobId).success || signal?.aborted) return { status: "unavailable", jobId };
      let job: ClaimedJob;
      try {
        job = claimedJob.parse(first(await rpc(sb, "claim_customer_ai_job", { p_job_id: jobId, p_lease_seconds: 300 }, signal)));
        if (job.id !== jobId) return { status: "unavailable", jobId };
      } catch { return { status: "unavailable", jobId }; }
      let resolutionAttempted = false, fingerprint: string | undefined;
      let secret: Buffer | undefined, wire: Buffer | undefined;
      try {
        const raw = context.parse(await rpc(sb, "prepare_customer_ai_dispatch", { p_job_id: job.id, p_lease_token: job.lease_token }, signal));
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
        }, signal));
        const returned = prepareCustomerDispatch(dispatch.scope, dispatch.request);
        if (returned.fingerprint !== fingerprint || !isDeepStrictEqual(returned, prepared)) throw new Error();
        signal?.throwIfAborted();
        const binding = { ownerId: s.ownerId, provider: s.provider, connectionId: s.connectionId, revision: s.credentialRevision };
        secret = vault.open(dispatch.credential, binding);
        wire = signer.sign(prepared.scope, prepared.request, { binding, secret }).takeBody();
        secret.fill(0); secret = undefined;
        const response = await fetcher(endpoint, { method: "POST", redirect: "error",
          headers: { "content-type": "application/json", "x-service-token": serviceToken },
          signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
          body: wire as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"] });
        // Never trust the transport body (success OR failure) for settlement.
        // The AI service saves its private receipt before answering HTTP.
        // Cancellation is best effort: a response stream may never settle its
        // cancel promise. Continue with receipt-only recovery in that case.
        void response.body?.cancel().catch(() => {});
      } catch { /* No raw exceptions, secret-bearing bodies or retries. */ }
      finally { secret?.fill(0); wire?.fill(0); }
      if (!resolutionAttempted || !fingerprint) return { status: "preparation_failed", jobId };
      const completed = await recoverCustomerAiJob(sb, job.id, job.created_by, fingerprint, job);
      if (completed.status === "succeeded") return completed;
      try {
        const held = identity.extend({ status: z.literal("failed"), error_code: z.literal("customer_provider_outcome_unknown"),
          lease_token: z.null() }).passthrough().parse(first(await rpc(sb, "hold_customer_ai_job", { p_job_id: job.id, p_lease_token: job.lease_token })));
        if (isDeepStrictEqual(identity.parse(held), identity.parse(job))) return { status: "requires_review", jobId };
      } catch { /* Completion may have won the race with this hold. */ }
      return recoverCustomerAiJob(sb, job.id, job.created_by, fingerprint, job);
    },
  };
}
