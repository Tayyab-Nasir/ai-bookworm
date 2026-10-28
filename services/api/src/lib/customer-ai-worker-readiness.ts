/** Explicit private worker readiness transport. No listener or route is registered
 * in production here. The proof attests recent completed loop progress, not
 * current spare capacity, database ACLs, provider access or job completion.
 * Protect the listener with TLS and a private network; use a dedicated key and
 * token, not database/service credentials. Progress can age out after dispatch.
 */
import Fastify from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { verifyCustomerAiLifecycle, type CustomerAiLifecycle } from "./customer-ai-loop.js";

const domain = "bookworm-customer-worker-progress-v1";
const binding = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const keyId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u);
const scope = z.object({ deploymentId: binding, projectRef: binding, serviceId: binding, keyId }).strict();
type Scope = z.infer<typeof scope>;
const challenge = scope.extend({ version: z.literal(1), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const time = z.number().int().nonnegative().safe();
const response = challenge.extend({ kind: z.literal("customer_generation"), ready: z.literal(true), observedAt: time,
  expiresAt: time, proof: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const tokenPattern = /^[\x21-\x7e]{16,4096}$/u;
const unavailable = () => new Error("Customer AI worker progress is unavailable.");
const path = "/v1/internal/customer-worker/progress";
const mac = (key: Buffer, p: Scope & { nonce: string; observedAt: number; expiresAt: number }) => createHmac("sha256", key)
  .update(`${domain}\n${p.deploymentId}\n${p.projectRef}\n${p.serviceId}\n${p.keyId}\n${p.nonce}\n${p.observedAt}\n${p.expiresAt}`, "ascii").digest();
const validNonce = (nonce: string) => Buffer.from(nonce, "base64url").length === 32 && Buffer.from(nonce, "base64url").toString("base64url") === nonce;
const sameScope = (a: Scope, b: Scope) => a.deploymentId === b.deploymentId && a.projectRef === b.projectRef && a.serviceId === b.serviceId && a.keyId === b.keyId;

/** Operator must explicitly listen on a private TLS-protected transport. */
export function customerAiWorkerReadinessApp(config: { scope: Scope; token: string; signingKey: Buffer; lifecycle: CustomerAiLifecycle }) {
  const parsed = scope.safeParse(config?.scope);
  if (!parsed.success || typeof config?.token !== "string" || !tokenPattern.test(config.token)
    || !Buffer.isBuffer(config.signingKey) || config.signingKey.length !== 32 || !config.lifecycle) throw unavailable();
  const expected = parsed.data, secret = Buffer.from(config.signingKey), tokenHash = createHash("sha256").update(config.token).digest();
  const app = Fastify({ logger: false, bodyLimit: 2048, requestTimeout: 5_000 });
  let disposed = false;
  app.setErrorHandler((_error, _request, reply) => { void reply.code(400).send({ error: "Invalid worker progress challenge." }); });
  app.addHook("onClose", async () => { disposed = true; secret.fill(0); tokenHash.fill(0); });
  app.post(path, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const supplied = request.headers["x-service-token"];
    const validToken = typeof supplied === "string" && tokenPattern.test(supplied);
    const suppliedHash = createHash("sha256").update(validToken ? supplied : "").digest();
    if (!timingSafeEqual(tokenHash, suppliedHash) || !validToken || disposed) return reply.code(401).send({ error: "Worker authentication failed." });
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    const parsedChallenge = challenge.safeParse(request.body);
    if (request.raw.url?.includes("?") || contentType !== "application/json"
      || (request.headers["content-encoding"] ?? "identity") !== "identity" || !parsedChallenge.success
      || !validNonce(parsedChallenge.data.nonce) || !sameScope(parsedChallenge.data, expected)) {
      return reply.code(400).send({ error: "Invalid worker progress challenge." });
    }
    try {
      const evidence = await verifyCustomerAiLifecycle(config.lifecycle, new AbortController().signal);
      if (disposed || !sameScope(evidence, expected)) throw unavailable();
      const payload = { ...parsedChallenge.data, kind: evidence.kind, ready: evidence.ready,
        observedAt: evidence.observedAt, expiresAt: evidence.expiresAt };
      return reply.send({ ...payload, proof: mac(secret, payload).toString("hex") });
    } catch { return reply.code(503).send({ error: "Worker progress unavailable." }); }
  });
  return app;
}

/** API-side one-shot challenge. A successful check is only fresh worker-progress
 * evidence; it does not prove the worker stays alive after this response. */
export function customerAiWorkerReadinessProbe(config: { scope: Scope; serviceUrl: string; token: string; signingKey: Buffer;
  maxAgeMs?: number; allowLoopbackHttp?: boolean; fetcher?: typeof fetch; mode?: "test" | "development" | "production"; _testNow?: () => number }) {
  const parsed = scope.safeParse(config?.scope), maxAge = config?.maxAgeMs ?? 5_000;
  let endpoint: string;
  try {
    if (!parsed.success || typeof config.token !== "string" || !tokenPattern.test(config.token)
      || !Buffer.isBuffer(config.signingKey) || config.signingKey.length !== 32
      || !Number.isInteger(maxAge) || maxAge < 1_000 || maxAge > 30_000
      || (config.allowLoopbackHttp !== undefined && typeof config.allowLoopbackHttp !== "boolean")
      || (config.mode !== undefined && !["test", "development", "production"].includes(config.mode))
      || (config.allowLoopbackHttp === true && !["test", "development"].includes(config.mode ?? ""))
      || (config._testNow !== undefined && (config.mode !== "test" || typeof config._testNow !== "function"))
      || typeof config.serviceUrl !== "string" || config.serviceUrl !== config.serviceUrl.trim()) throw unavailable();
    const url = new URL(config.serviceUrl), loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (config.allowLoopbackHttp === true && loopback && url.protocol === "http:"))) throw unavailable();
    endpoint = url.origin + path;
  } catch { throw unavailable(); }
  const expected = parsed.data, secret = Buffer.from(config.signingKey), fetcher = config.fetcher ?? fetch, now = config._testNow ?? Date.now;
  const token = config.token; let disposed = false;
  return {
    dispose() { disposed = true; secret.fill(0); },
    async verifyWorker(signal: AbortSignal) {
      if (disposed || !(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
      const deadline = AbortSignal.any([AbortSignal.timeout(5_000), signal]);
      const nonce = randomBytes(32).toString("base64url"); let abort: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          abort = () => reject(new Error()); deadline.addEventListener("abort", abort, { once: true }); if (deadline.aborted) abort();
        });
        const request = fetcher(endpoint, { method: "POST", redirect: "error", signal: deadline,
          headers: { "content-type": "application/json", "x-service-token": token }, body: JSON.stringify({ ...expected, version: 1, nonce }) });
        void request.then(res => { if (deadline.aborted) void res.body?.cancel().catch(() => {}); }, () => {});
        const res = await Promise.race([request, interrupted]);
        const length = res.headers.get("content-length");
        if (deadline.aborted || disposed || res.status !== 200 || res.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
          || !res.body || (length !== null && (!/^\d{1,6}$/u.test(length) || Number(length) > 4096))) {
          void res.body?.cancel().catch(() => {}); throw unavailable();
        }
        let size = 0;
        const stream = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          size += chunk.byteLength; if (size > 4096) throw unavailable(); controller.enqueue(chunk);
        } }), { signal: deadline });
        const value = response.parse(await Promise.race([new Response(stream).json(), interrupted]));
        const current = now(), expectedMac = mac(secret, value), actualMac = Buffer.from(value.proof, "hex");
        if (deadline.aborted || disposed || !sameScope(value, expected) || value.nonce !== nonce || !timingSafeEqual(expectedMac, actualMac)
          || !Number.isSafeInteger(current) || current < 0 || value.observedAt > current || value.expiresAt <= current
          || value.observedAt < current - maxAge || value.expiresAt > value.observedAt + maxAge) throw unavailable();
        return { ...expected, kind: value.kind, ready: value.ready, observedAt: value.observedAt, expiresAt: value.expiresAt };
      } catch { throw unavailable(); }
      finally { if (abort) deadline.removeEventListener("abort", abort); }
    },
  };
}
