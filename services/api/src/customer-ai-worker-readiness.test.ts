import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAiLifecycle, runCustomerAiLoop } from "./lib/customer-ai-loop.js";
import { customerAiWorkerReadinessApp, customerAiWorkerReadinessProbe } from "./lib/customer-ai-worker-readiness.js";
import { customerAiReadiness, isCustomerAiReady } from "./lib/customer-ai-readiness.js";

const scope = { deploymentId: "deploy", projectRef: "project", serviceId: "service", keyId: "key" };
const token = "synthetic-private-worker-token", key = Buffer.alloc(32, 4);
const path = "/v1/internal/customer-worker/progress";
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const maintenance = { slotsScanned: 0, candidatesScanned: 0, events: [], slotsCycleComplete: true, candidatesCycleComplete: true };
const result = { scanned: 0, attempted: 0, uncertain: 0, suppressed: 0, cycleComplete: false };

test("real private Fastify handler and probe attest only recent loop progress", async () => {
  let wall = 1_800_000_000_000, monotonic = 1000;
  const lifecycle = customerAiLifecycle({ scope, ttlMs: 5_000, mode: "test", _testClock: () => ({ wall, monotonic }) });
  const app = customerAiWorkerReadinessApp({ scope, token, signingKey: key, lifecycle });
  const controller = new AbortController(), first = deferred(), firstDone = deferred(), second = deferred(), secondDone = deferred();
  let ticks = 0;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() {
    if (++ticks === 1) { first.release(); await firstDone.promise; }
    else { second.release(); await secondDone.promise; }
    return result;
  }, async close() {} };
  const fetcher: typeof fetch = async (_input, init) => {
    const res = await app.inject({ method: "POST", url: path, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"]) } });
  };
  const probe = customerAiWorkerReadinessProbe({ scope, token, signingKey: key, serviceUrl: "https://worker.example.test",
    mode: "test", _testNow: () => wall, fetcher });
  const signal = new AbortController().signal;
  await assert.rejects(probe.verifyWorker(signal), /progress is unavailable/u);
  const running = runCustomerAiLoop(runtime, { signal: controller.signal, lifecycle });
  await first.promise; await assert.rejects(probe.verifyWorker(signal), /progress is unavailable/u);
  firstDone.release(); await second.promise;
  const evidence = await probe.verifyWorker(signal);
  assert.deepEqual(evidence, { ...scope, kind: "customer_generation", ready: true, observedAt: wall, expiresAt: wall + 5_000 });
  const readiness = customerAiReadiness({ expected: { ...scope, schemaRevision: "revision" }, now: () => wall,
    operatorEnabled: () => true, verifyWorker: probe.verifyWorker,
    verifyIdentity: async () => ({ deploymentId: scope.deploymentId, serviceId: scope.serviceId, keyId: scope.keyId, identityVerified: true, observedAt: wall }),
    verifyDatabase: async () => ({ deploymentId: scope.deploymentId, projectRef: scope.projectRef, schemaRevision: "revision", aclVerified: true, observedAt: wall }) });
  assert.equal(await isCustomerAiReady(readiness), true);
  wall += 5_000; monotonic += 5_000;
  await assert.rejects(probe.verifyWorker(signal), /progress is unavailable/u);
  assert.equal(await isCustomerAiReady(readiness), false);
  controller.abort(); secondDone.release(); await running;
  await assert.rejects(probe.verifyWorker(signal), /progress is unavailable/u);
  probe.dispose(); await app.close();
});

test("private handler rejects forged lifecycle, wrong identity, authentication and malformed challenges", async () => {
  const forged = { verifyWorker: async () => ({ ...scope, kind: "customer_generation" as const, ready: true as const, observedAt: Date.now(), expiresAt: Date.now() + 5_000 }) };
  const app = customerAiWorkerReadinessApp({ scope, token, signingKey: key, lifecycle: forged });
  const nonce = Buffer.alloc(32, 1).toString("base64url"), challenge = { ...scope, nonce, version: 1 };
  const post = (payload: unknown, header = token, url = path) => app.inject({ method: "POST", url,
    headers: { "content-type": "application/json", "x-service-token": header }, payload: JSON.stringify(payload) });
  assert.equal((await post(challenge, "wrong-synthetic-token")).statusCode, 401);
  assert.equal((await post(challenge)).statusCode, 503);
  for (const bad of [{ ...challenge, deploymentId: "other" }, { ...challenge, projectRef: "other" }, { ...challenge, serviceId: "other" },
    { ...challenge, keyId: "other" }, { ...challenge, nonce: "x" }, { ...challenge, version: 2 }, { ...challenge, extra: "secret" }]) {
    const res = await post(bad); assert.equal(res.statusCode, 400); assert.doesNotMatch(res.body, /secret/u);
  }
  assert.equal((await post(challenge, token, `${path}?leak=1`)).statusCode, 400);
  const oversized = await post({ ...challenge, extra: "x".repeat(4000) }); assert.equal(oversized.statusCode, 400);
  await app.close();
});

test("probe rejects wrong key, identity, replay, malformed response and stale or future evidence", async () => {
  let wall = 1_800_000_000_000, monotonic = 1_000;
  const lifecycle = customerAiLifecycle({ scope, ttlMs: 5_000, mode: "test", _testClock: () => ({ wall, monotonic }) });
  const app = customerAiWorkerReadinessApp({ scope, token, signingKey: key, lifecycle });
  const controller = new AbortController(), started = deferred(), done = deferred(); let ticks = 0;
  const running = runCustomerAiLoop({ async scanMaintenance() { return maintenance; }, async tick() {
    if (++ticks > 1) { started.release(); await done.promise; } return result;
  }, async close() {} }, { signal: controller.signal, lifecycle });
  await started.promise;
  let saved: string | undefined;
  for (const mode of ["replay", "wrong-key", "scope", "stale", "future", "extra", "oversize", "content", "redirect"]) {
    const otherScope = mode === "scope" ? { ...scope, projectRef: "wrong" } : scope;
    let current = wall;
    const fetcher: typeof fetch = async (_, init) => {
      if (mode === "redirect") return new Response(null, { status: 302 });
      const res = await app.inject({ method: "POST", url: path, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      if (mode === "replay") { const body = saved ??= res.body; return new Response(body, { headers: { "content-type": "application/json" } }); }
      if (mode === "extra") return Response.json({ ...JSON.parse(res.body), extra: "private-body" });
      if (mode === "oversize") return Response.json({ extra: "x".repeat(5000) });
      if (mode === "content") return new Response(res.body, { headers: { "content-type": "text/plain" } });
      return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
    };
    if (mode === "stale") current += 5_000;
    if (mode === "future") current -= 1;
    const probe = customerAiWorkerReadinessProbe({ scope: otherScope, token, signingKey: mode === "wrong-key" ? Buffer.alloc(32, 5) : key,
      serviceUrl: "https://worker.example.test", mode: "test", _testNow: () => current, fetcher });
    if (mode === "replay") await probe.verifyWorker(new AbortController().signal);
    await assert.rejects(probe.verifyWorker(new AbortController().signal), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, "Customer AI worker progress is unavailable.");
      assert.doesNotMatch(error.stack ?? "", /private-body|synthetic-private/u); return true;
    });
    probe.dispose();
  }
  controller.abort(); done.release(); await running; await app.close();
});

test("probe bounds uncooperative transport and rejects unsafe configuration", async () => {
  let calls = 0, release!: (response: Response) => void;
  const probe = customerAiWorkerReadinessProbe({ scope, token, signingKey: key, serviceUrl: "https://worker.example.test",
    fetcher: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const abort = new AbortController(), pending = probe.verifyWorker(abort.signal); abort.abort();
  await assert.rejects(pending, /progress is unavailable/u); release(new Response(null, { status: 503 }));
  assert.equal(calls, 1); probe.dispose();
  const stalledCancel = customerAiWorkerReadinessProbe({ scope, token, signingKey: key, serviceUrl: "https://worker.example.test",
    fetcher: async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 503 }) });
  await assert.rejects(Promise.race([stalledCancel.verifyWorker(new AbortController().signal),
    new Promise((_, reject) => setTimeout(() => reject(new Error("blocked-cancellation")), 200))]), /progress is unavailable/u);
  stalledCancel.dispose();
  for (const serviceUrl of ["http://worker.example.test", "https://user:password@example.test", "https://worker.test/?x=1"]) {
    assert.throws(() => customerAiWorkerReadinessProbe({ scope, token, signingKey: key, serviceUrl }), /progress is unavailable/u);
  }
  for (const mode of [undefined, "production"] as const) {
    assert.throws(() => customerAiWorkerReadinessProbe({ scope, token, signingKey: key, serviceUrl: "http://127.0.0.1:3000",
      allowLoopbackHttp: true, mode }), /progress is unavailable/u);
  }
  for (const mode of ["test", "development"] as const) {
    const local = customerAiWorkerReadinessProbe({ scope, token, signingKey: key, serviceUrl: "http://127.0.0.1:3000",
      allowLoopbackHttp: true, mode });
    local.dispose();
  }
});
