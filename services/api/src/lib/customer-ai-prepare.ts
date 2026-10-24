/** Private non-billable preparation, deliberately unregistered. A successful
 * hash is NOT a job/fee/key authorization. Never expose or log this source.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { customerDispatchScope } from "./customer-ai-dispatch.js";
import { loadCustomerAiSource } from "./customer-ai-source.js";
import type { SupabaseFactory } from "./supabase.js";

const policySelection = z.object({ provider: customerDispatchScope.shape.provider,
  policy: customerDispatchScope.shape.policy }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const receipt = z.object({ provider: customerDispatchScope.shape.provider,
  agentType: customerDispatchScope.shape.agentType, model: customerDispatchScope.shape.policy.shape.model,
  maxOutputTokens: z.number().int().min(1).max(128000), sourceSha256: hash, requestSha256: hash,
  contextOmitted: z.number().int().min(0).max(121) }).strict();
const unavailable = () => new AppError(503, "AI preparation could not be verified. No generation was started.");

export function customerAiPreparation(factory: SupabaseFactory, options: {
  serviceUrl: string; serviceToken: string; fetcher?: typeof fetch; allowLoopbackHttp?: boolean;
}) {
  let endpoint: string;
  try {
    const url = new URL(options.serviceUrl);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (options.allowLoopbackHttp === true && loopback && url.protocol === "http:"))
      || !/^[\x21-\x7e]{16,4096}$/u.test(options.serviceToken)) throw new Error();
    endpoint = url.origin + "/v1/internal/customer-text/prepare";
  } catch { throw unavailable(); }
  const { serviceToken } = options, fetcher = options.fetcher ?? fetch;
  return {
    /** selection must come from the server's reviewed policy, never a browser's
     * model/URL override. Future job creation independently rechecks that policy,
     * source versions, payer/entitlement and credential revision transactionally.
     */
    async prepare(actor: { userId: string; accessToken: string }, input: unknown,
      selection: z.infer<typeof policySelection>, abort?: AbortSignal) {
      let reviewed: z.infer<typeof policySelection>;
      try {
        reviewed = policySelection.parse(selection);
        Object.freeze(reviewed.policy.responseModels); Object.freeze(reviewed.policy.responseUpstreams);
        Object.freeze(reviewed.policy); Object.freeze(reviewed);
      } catch { throw unavailable(); }
      const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(abort ? [abort] : [])]);
      const source = await loadCustomerAiSource(factory, actor, input, signal);
      try {
        signal.throwIfAborted();
        const requestJson = JSON.stringify(source.request);
        const sourceSha256 = createHash("sha256").update(requestJson, "utf8").digest("hex");
        const body = JSON.stringify({ scope: { workspaceId: source.workspaceId, bookId: source.bookId,
          agentType: source.agentType, ...reviewed }, requestJson });
        // Leave headroom for the future signed envelope and longest key. A hash
        // must not promise a dispatchable input that the next stage cannot fit.
        if (Buffer.byteLength(body, "utf8") > 480000) throw new AppError(422, "Selected AI context is too large. Choose fewer whole nodes.");
        const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json", "x-service-token": serviceToken }, body });
        if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          await response.body?.cancel().catch(() => {});
          if (response.status === 422) throw new AppError(422, "Selected saved context cannot fit this AI request. Review the source and context limit.");
          throw unavailable();
        }
        const length = response.headers.get("content-length");
        if (!response.body || (length !== null && (!/^\d{1,10}$/u.test(length) || Number(length) > 16384))) {
          await response.body?.cancel().catch(() => {}); throw unavailable();
        }
        let size = 0;
        const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { size += chunk.byteLength; if (size > 16384) throw unavailable(); controller.enqueue(chunk); },
        }), { signal });
        const result = receipt.parse(await new Response(stream).json()); signal.throwIfAborted();
        if (result.sourceSha256 !== sourceSha256 || result.provider !== reviewed.provider || result.agentType !== source.agentType
          || result.model !== reviewed.policy.model || result.maxOutputTokens !== (source.agentType === "bookbible"
            ? Math.min(reviewed.policy.maxOutputTokens, 6000) : reviewed.policy.maxOutputTokens)) throw unavailable();
        return Object.freeze({ source, selection: reviewed, ...result });
      } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
    },
  };
}
