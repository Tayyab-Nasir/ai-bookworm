/** Explicit private-service identity probe. A valid proof says nothing about
 * database ACLs, queue/worker readiness, provider access or paid entitlements.
 * No launcher, timer, environment configuration or automatic retry lives here.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const domain = "bookworm-customer-service-identity-v2";
const binding = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const proof = z.object({ version: z.literal(2), deploymentId: binding, serviceId: binding,
  keyId: z.string(), nonce: z.string(), proof: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export function customerAiIdentityProbe(config: {
  serviceUrl: string; serviceToken: string; deploymentId: string; serviceId: string; keyId: string; signingKey: Buffer;
  allowLoopbackHttp?: boolean; fetcher?: typeof fetch;
}) {
  const unavailable = () => new Error("Customer AI service identity is unavailable.");
  let endpoint: string;
  try {
    if (!config || typeof config.serviceUrl !== "string" || config.serviceUrl !== config.serviceUrl.trim()
      || typeof config.serviceToken !== "string" || !/^[\x21-\x7e]{16,4096}$/u.test(config.serviceToken)
      || !binding.safeParse(config.deploymentId).success || !binding.safeParse(config.serviceId).success
      || typeof config.keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(config.keyId)
      || !Buffer.isBuffer(config.signingKey) || config.signingKey.length !== 32
      || (config.allowLoopbackHttp !== undefined && typeof config.allowLoopbackHttp !== "boolean")) throw unavailable();
    const url = new URL(config.serviceUrl), loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (config.allowLoopbackHttp === true && loopback && url.protocol === "http:"))) throw unavailable();
    endpoint = url.origin + "/v1/internal/customer-text/identity";
  } catch { throw unavailable(); }
  const key = Buffer.from(config.signingKey), { serviceToken, deploymentId, serviceId, keyId } = config, fetcher = config.fetcher ?? fetch;
  let disposed = false;
  return {
    dispose() { disposed = true; key.fill(0); },
    async check(signal?: AbortSignal): Promise<{ identityVerified: true; deploymentId: string; serviceId: string; keyId: string }> {
      if (disposed || (signal !== undefined && !(signal instanceof AbortSignal)) || signal?.aborted) throw unavailable();
      const deadline = AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
      const nonce = randomBytes(32).toString("base64url");
      let abort: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          abort = () => reject(new Error()); deadline.addEventListener("abort", abort, { once: true });
          if (deadline.aborted) abort();
        });
        const request = fetcher(endpoint, { method: "POST", redirect: "error", signal: deadline,
          headers: { "content-type": "application/json", "x-service-token": serviceToken }, body: JSON.stringify({ version: 2, deploymentId, serviceId, keyId, nonce }) });
        // If a non-cooperative test transport finishes after timeout, discard it.
        void request.then(response => { if (deadline.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
        const response = await Promise.race([request, interrupted]);
        if (deadline.aborted || disposed || response.status !== 200
          || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          void response.body?.cancel().catch(() => {}); throw unavailable();
        }
        const length = response.headers.get("content-length");
        if (!response.body || (length !== null && (!/^\d{1,6}$/u.test(length) || Number(length) > 4096))) {
          void response.body?.cancel().catch(() => {}); throw unavailable();
        }
        let size = 0;
        const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { size += chunk.byteLength; if (size > 4096) throw unavailable(); controller.enqueue(chunk); },
        }), { signal: deadline });
        const value = proof.parse(await Promise.race([new Response(stream).json(), interrupted]));
        if (deadline.aborted || disposed || value.deploymentId !== deploymentId || value.serviceId !== serviceId || value.keyId !== keyId || value.nonce !== nonce) throw unavailable();
        const expected = createHmac("sha256", key).update(`${domain}\n${deploymentId}\n${serviceId}\n${keyId}\n${nonce}`, "ascii").digest();
        const actual = Buffer.from(value.proof, "hex");
        if (!timingSafeEqual(expected, actual)) throw unavailable();
        return { identityVerified: true, deploymentId, serviceId, keyId };
      } catch { throw unavailable(); }
      finally { if (abort) deadline.removeEventListener("abort", abort); }
    },
  };
}
