import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { credentialVault } from "./lib/ai-connection-vault.js";
import { customerDispatchSigner, prepareCustomerDispatch, type CustomerDispatchScope } from "./lib/customer-ai-dispatch.js";
import { customerAiComposition } from "./lib/customer-ai-composition.js";

const token = "synthetic-internal-service-token";
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value),
  { status, headers: { "content-type": "application/json", ...headers } });

function fixture() {
  const scope: CustomerDispatchScope = { grantId: randomUUID(), jobId: randomUUID(), workspaceId: randomUUID(), bookId: randomUUID(),
    ownerId: randomUUID(), connectionId: randomUUID(), credentialRevision: 2, leaseToken: randomUUID(), provider: "openai", agentType: "writer",
    expectedRequestSha256: "a".repeat(64), policy: { model: "synthetic-model", responseModels: ["synthetic-model"], maxOutputTokens: 1024, upstream: null, responseUpstreams: [] } };
  const request = { input: { book: { title: "Synthetic" } } }, prepared = prepareCustomerDispatch(scope, request);
  const job = { id: scope.jobId, workspace_id: scope.workspaceId, book_id: scope.bookId, created_by: scope.ownerId, agent_type: scope.agentType,
    billing_mode: "customer_key", model: scope.policy.model, input_ref: { customerGrantId: scope.grantId, requestSha256: scope.expectedRequestSha256 },
    status: "running", lease_token: scope.leaseToken };
  const completed = { ...job, status: "succeeded", lease_token: null, output_ref: { customerDispatchSha256: prepared.fingerprint,
    costPayer: "customer", providerCostStatus: "unknown", reviewRequired: true } };
  const vault = credentialVault({ AI_CONNECTION_VAULT_KEYRING_JSON: JSON.stringify({ active: "test", keys: { test: randomBytes(32).toString("base64") } }) })!;
  const credential = vault.seal("synthetic-customer-provider-key", { ownerId: scope.ownerId, provider: scope.provider,
    connectionId: scope.connectionId, revision: scope.credentialRevision });
  const signer = customerDispatchSigner("test", randomBytes(32));
  const calls: string[] = []; let receipt = false, dispatched = 0, resolveCount = 0;
  const hooks: { fail?: string; service?: () => Promise<Response>; rows?: unknown[]; recover?: () => Promise<Response> } = {};
  const databaseFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const name = url.pathname.split("/").at(-1)!; calls.push(name);
    assert.equal(init?.redirect, "error");
    if (name === hooks.fail) return json({ error: "synthetic" }, 503, { "retry-after": "1" });
    const args = JSON.parse(String(init?.body ?? "{}"));
    if (name === "discover_customer_ai_ready_jobs") return json(hooks.rows ?? [{ job_id: job.id, created_at: "2026-10-28T13:00:00.123456+00:00", ready: true }]);
    assert.equal(args.p_job_id, job.id);
    if (name === "claim_customer_ai_job") return json(job);
    if (name === "prepare_customer_ai_dispatch") return json({ scope, request });
    if (name === "resolve_customer_ai_dispatch") { resolveCount++; return json({ scope, request, credential }); }
    if (name === "complete_customer_ai_job") return receipt ? json(completed) : json({ message: "absent" }, 404);
    if (name === "hold_customer_ai_job") return json({ ...job, status: "failed", lease_token: null, error_code: "customer_provider_outcome_unknown" });
    if (name === "reconcile_customer_ai_job") return json("unchanged");
    if (name === "recover_customer_ai_receipt") return hooks.recover ? hooks.recover() : json("settled");
    throw new Error("Unexpected synthetic operation");
  };
  const serviceFetch: typeof fetch = async (_input, init) => {
    dispatched++; assert.equal(init?.redirect, "error");
    if (hooks.service) return hooks.service();
    receipt = true; return json({ ignored: true });
  };
  const config = { databaseUrl: "https://db.example.test", serviceRoleKey: "synthetic-service-role-key", serviceUrl: "https://ai.example.test",
    serviceToken: token, vault, signer, databaseFetch, serviceFetch, mode: "test" as const };
  return { scope, calls, hooks, config, dispatched: () => dispatched, resolved: () => resolveCount, saveReceipt: () => { receipt = true; } };
}

test("synthetic composed discovery, single dispatch and receipt completion", async () => {
  const f = fixture(), runtime = customerAiComposition(f.config);
  assert.deepEqual(await runtime.tick(), { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: true });
  assert.deepEqual(f.calls, ["discover_customer_ai_ready_jobs", "claim_customer_ai_job", "prepare_customer_ai_dispatch", "resolve_customer_ai_dispatch", "complete_customer_ai_job"]);
  assert.equal(f.dispatched(), 1); assert.equal(f.resolved(), 1);
  await runtime.close(); f.config.signer.dispose();
});

test("SDK transport does not retry discovery or reconciliation despite Retry-After", async () => {
  for (const name of ["discover_customer_ai_ready_jobs", "reconcile_customer_ai_job", "recover_customer_ai_receipt"]) {
    const f = fixture(); f.hooks.fail = name; const runtime = customerAiComposition(f.config);
    await assert.rejects(name.startsWith("discover") ? runtime.tick() : name.startsWith("reconcile")
      ? runtime.reconcile(f.scope.jobId) : runtime.recoverReceipt(f.scope.jobId));
    assert.equal(f.calls.filter(value => value === name).length, 1);
    assert.equal(f.dispatched(), 0); await runtime.close(); f.config.signer.dispose();
  }
});

test("receipt recovery is explicit, makes no provider request and drains before close", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  f.hooks.recover = async () => { started(); await new Promise<void>(done => { release = done; }); return json("settled"); };
  const runtime = customerAiComposition(f.config), running = runtime.recoverReceipt(f.scope.jobId); await began;
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await assert.rejects(runtime.recoverReceipt(f.scope.jobId), /closed/u); assert.equal(closed, false);
  release(); assert.deepEqual(await running, { state: "settled", suppressionCleared: false }); await closing;
  assert.deepEqual(f.calls, ["recover_customer_ai_receipt"]); assert.equal(f.dispatched(), 0); f.config.signer.dispose();
});

test("lost dispatch reply recovers durable receipt without a second provider send", async () => {
  const f = fixture(); f.hooks.service = async () => { f.saveReceipt(); throw new Error("synthetic-secret-must-not-leak"); };
  const runtime = customerAiComposition(f.config);
  assert.equal((await runtime.tick()).uncertain, 0);
  assert.equal(f.resolved(), 1); assert.equal(f.dispatched(), 1);
  assert.equal(f.calls.filter(name => name === "complete_customer_ai_job").length, 1);
  await runtime.close(); f.config.signer.dispose();
});

test("claim and resolver failures make one RPC attempt and never dispatch", async () => {
  for (const name of ["claim_customer_ai_job", "resolve_customer_ai_dispatch"]) {
    const f = fixture(); f.hooks.fail = name; const runtime = customerAiComposition(f.config);
    await runtime.tick();
    assert.equal(f.calls.filter(value => value === name).length, 1);
    assert.equal(f.dispatched(), 0);
    assert.ok(!f.calls.some(value => /cancel|release/u.test(value)));
    await runtime.close(); f.config.signer.dispose();
  }
});

test("caller abort prevents new claims and does not prevent receipt recovery after dispatch", async () => {
  const f = fixture(), controller = new AbortController(), runtime = customerAiComposition(f.config);
  const already = new AbortController(); already.abort();
  assert.equal((await runtime.tick(already.signal)).attempted, 0); assert.equal(f.calls.length, 0);
  f.hooks.service = async () => { f.saveReceipt(); controller.abort(); throw new Error("synthetic disconnected response"); };
  assert.equal((await runtime.tick(controller.signal)).uncertain, 0);
  assert.equal(f.dispatched(), 1); assert.equal(f.calls.at(-1), "complete_customer_ai_job");
  await runtime.close(); f.config.signer.dispose();
});

test("shutdown stops intake but drains the current dispatch and receipt", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  f.hooks.service = async () => { started(); await new Promise<void>(done => { release = done; }); f.saveReceipt(); return json({}); };
  const runtime = customerAiComposition(f.config), running = runtime.tick(); await began;
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await assert.rejects(runtime.tick(), /closed/u); assert.equal(closed, false);
  release(); assert.equal((await running).uncertain, 0); await closing;
  assert.equal(f.calls.at(-1), "complete_customer_ai_job"); assert.equal(f.dispatched(), 1); f.config.signer.dispose();
});

test("shutdown during a multi-job page drains only the active job", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  f.hooks.rows = [
    { job_id: f.scope.jobId, created_at: "2026-10-28T13:00:00.123456+00:00", ready: true },
    { job_id: randomUUID(), created_at: "2026-10-28T13:00:01.123456+00:00", ready: true },
  ];
  f.hooks.service = async () => { started(); await new Promise<void>(done => { release = done; }); f.saveReceipt(); return json({}); };
  const runtime = customerAiComposition(f.config), running = runtime.tick(); await began;
  const closing = runtime.close(); release();
  assert.deepEqual(await running, { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: false });
  await closing;
  assert.equal(f.calls.filter(name => name === "claim_customer_ai_job").length, 1);
  assert.equal(f.calls.at(-1), "complete_customer_ai_job"); assert.equal(f.dispatched(), 1);
  f.config.signer.dispose();
});

test("invalid configuration fails closed without including secrets", () => {
  const f = fixture();
  for (const config of [{ ...f.config, databaseUrl: "http://remote.invalid" },
    { ...f.config, databaseUrl: "https://user:password@db.example.test" },
    { ...f.config, mode: "production" as const, allowLoopbackHttp: true }, { ...f.config, serviceToken: "short" }]) {
    assert.throws(() => customerAiComposition(config), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, "Customer AI composition configuration is invalid.");
      assert.doesNotMatch(error.stack ?? "", /password|synthetic-service-role-key/u); return true;
    });
  }
  f.config.signer.dispose();
});
