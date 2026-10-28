import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { credentialVault } from "./lib/ai-connection-vault.js";
import { customerDispatchSigner, prepareCustomerDispatch, type CustomerDispatchScope } from "./lib/customer-ai-dispatch.js";
import { customerAiComposition } from "./lib/customer-ai-composition.js";
import { customerAiLifecycle, runCustomerAiLoop } from "./lib/customer-ai-loop.js";

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
  const maintenanceAttempt = randomUUID();
  const hooks: { fail?: string; service?: () => Promise<Response>; rows?: unknown[]; maintenanceRows?: unknown[];
    stallName?: string; stall?: () => Promise<Response>;
    recover?: () => Promise<Response>; reconcile?: () => Promise<Response>; execute?: () => Promise<Response> } = {};
  const databaseFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const name = url.pathname.split("/").at(-1)!; calls.push(name);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-service-role-key");
    if (name === hooks.stallName && hooks.stall) return hooks.stall();
    if (name === hooks.fail) return json({ error: "synthetic" }, 503, { "retry-after": "1" });
    const args = JSON.parse(String(init?.body ?? "{}"));
    if (name === "discover_customer_ai_ready_jobs") return json(hooks.rows ?? [{ job_id: job.id, created_at: "2026-10-28T13:00:00.123456+00:00", ready: true }]);
    if (name === "list_customer_ai_maintenance_slots") return json([]);
    if (name === "discover_customer_ai_reconciliation_candidates") return json(hooks.maintenanceRows ?? []);
    if (name === "read_customer_ai_maintenance") return json({ attemptId: maintenanceAttempt, jobId: job.id, action: "reconcile", state: "pending", result: null });
    if (name === "execute_customer_ai_maintenance") return hooks.execute ? hooks.execute() : json({ attemptId: maintenanceAttempt, jobId: job.id, action: "reconcile", state: "completed", result: "released" });
    assert.equal(args.p_job_id, job.id);
    if (name === "open_customer_ai_maintenance_slot") return json({ status: "open", version: 1, attempt: { attemptId: maintenanceAttempt, jobId: job.id, action: "reconcile", state: "pending", result: null } });
    if (name === "ack_customer_ai_maintenance_slot") return json({ status: "observed", attemptId: maintenanceAttempt, version: 1, result: "released" });
    if (name === "claim_customer_ai_job") return json(job);
    if (name === "prepare_customer_ai_dispatch") return json({ scope, request });
    if (name === "resolve_customer_ai_dispatch") { resolveCount++; return json({ scope, request, credential }); }
    if (name === "complete_customer_ai_job") return receipt ? json(completed) : json({ message: "absent" }, 404);
    if (name === "hold_customer_ai_job") return json({ ...job, status: "failed", lease_token: null, error_code: "customer_provider_outcome_unknown" });
    if (name === "reconcile_customer_ai_job") return hooks.reconcile ? hooks.reconcile() : json("unchanged");
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
  return { scope, calls, hooks, config, maintenanceAttempt, dispatched: () => dispatched, resolved: () => resolveCount, saveReceipt: () => { receipt = true; } };
}

test("synthetic composed discovery, single dispatch and receipt completion", async () => {
  const f = fixture(), runtime = customerAiComposition(f.config);
  assert.deepEqual(await runtime.tick(), { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: false });
  assert.deepEqual(f.calls, ["discover_customer_ai_ready_jobs", "claim_customer_ai_job", "prepare_customer_ai_dispatch", "resolve_customer_ai_dispatch", "complete_customer_ai_job"]);
  assert.equal(f.dispatched(), 1); assert.equal(f.resolved(), 1);
  await runtime.close(); f.config.signer.dispose();
});

test("close interrupts a non-cooperative discovery and ignores late rows", { timeout: 2000 }, async () => {
  const f = fixture(); let release!: (value: Response) => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const late = new Promise<Response>(resolve => { release = resolve; });
  f.hooks.stallName = "discover_customer_ai_ready_jobs";
  f.hooks.stall = () => { started(); return late; };
  const runtime = customerAiComposition(f.config), tick = runtime.tick();
  await began;
  await runtime.close();
  assert.equal((await tick).attempted, 0);
  release(json([{ job_id: f.scope.jobId, created_at: "2026-10-28T13:00:00.123456+00:00", ready: true }]));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert(!f.calls.includes("claim_customer_ai_job")); assert.equal(f.dispatched(), 0);
  f.config.signer.dispose();
});

for (const kind of ["post", "rpc"] as const) {
  test(`unsettled worker ${kind} stops the loop instead of refreshing progress`, { timeout: 2000 }, async () => {
    const f = fixture(); let release!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { release = resolve; });
    f.hooks.rows = [];
    if (kind === "post") f.hooks.service = () => delayed;
    else { f.hooks.stallName = "resolve_customer_ai_dispatch"; f.hooks.stall = () => delayed; }
    const runtime = customerAiComposition({ ...f.config, dispatchTimeoutMs: 15, rpcTimeoutMs: 15 });
    const lifecycle = customerAiLifecycle({ scope: { deploymentId: "d", projectRef: "p", serviceId: "s", keyId: "k" }, ttlMs: 5_000 });
    let scans = 0, before: Promise<unknown> | undefined;
    const running = runCustomerAiLoop(runtime, { signal: new AbortController().signal, idleDelayMs: 100, lifecycle,
      onMaintenance: () => {
        if (++scans === 2) {
          before = lifecycle.verifyWorker(new AbortController().signal);
          f.hooks.rows = [{ job_id: f.scope.jobId, created_at: "2026-10-28T13:00:00.123456+00:00", ready: true }];
        }
      } });
    await assert.rejects(running, /loop stopped unexpectedly/u);
    assert(before); await before;
    await assert.rejects(lifecycle.verifyWorker(new AbortController().signal), /progress is unavailable/u);
    assert.equal(f.dispatched(), kind === "post" ? 1 : 0);
    assert.equal(f.calls.filter(x => x === "resolve_customer_ai_dispatch").length, 1);
    assert(!f.calls.some(x => /release|cancel|deduct/u.test(x)));
    release(json({ ignored: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
    f.config.signer.dispose();
  });
}

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

test("maintenance scan uses the shared service client and only journaled actions", async () => {
  const f = fixture();
  f.hooks.maintenanceRows = [{ job_id: f.scope.jobId, created_at: "2026-10-28T13:00:00.123456+00:00", action: "reconcile" }];
  const runtime = customerAiComposition(f.config);
  assert.deepEqual(await runtime.scanMaintenance(), { slotsScanned: 0, candidatesScanned: 1,
    events: [{ jobId: f.scope.jobId, attemptId: f.maintenanceAttempt, status: "released" }],
    slotsCycleComplete: true, candidatesCycleComplete: false });
  assert.deepEqual(f.calls, ["list_customer_ai_maintenance_slots", "discover_customer_ai_reconciliation_candidates",
    "open_customer_ai_maintenance_slot", "read_customer_ai_maintenance", "execute_customer_ai_maintenance", "ack_customer_ai_maintenance_slot"]);
  assert.equal(f.dispatched(), 0); await runtime.close(); f.config.signer.dispose();
});

test("maintenance discovery is one attempt and static errors omit upstream data", async () => {
  const f = fixture(); f.hooks.fail = "discover_customer_ai_reconciliation_candidates";
  const runtime = customerAiComposition(f.config);
  await assert.rejects(runtime.scanMaintenance(), error => { assert.ok(error instanceof Error);
    assert.equal(error.message, "Customer AI maintenance controller is unavailable."); assert.doesNotMatch(error.stack ?? "", /synthetic-service-role-key/u); return true; });
  assert.deepEqual(f.calls, ["list_customer_ai_maintenance_slots", "discover_customer_ai_reconciliation_candidates"]);
  assert.equal(f.dispatched(), 0); await runtime.close(); f.config.signer.dispose();
});

test("journaled slot survives lost open, execute and ack across new compositions without provider calls", async () => {
  const f = fixture(), attemptId = randomUUID(); let opened = false, acknowledged = false;
  let state: "pending" | "completed" = "pending", loseOpen = true, loseExecute = true, loseAck = true;
  const names: string[] = [], receipt = () => ({ attemptId, jobId: f.scope.jobId, action: "recover_receipt", state,
    result: state === "pending" ? null : "settled" });
  const databaseFetch: typeof fetch = async (input, init) => {
    const name = new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1)!; names.push(name);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-service-role-key");
    const args = JSON.parse(String(init?.body));
    if (name === "list_customer_ai_maintenance_slots") return json(opened && !acknowledged ? [{
      job_id: f.scope.jobId, action: "recover_receipt", version: 1, attempt_id: attemptId, state, result: state === "pending" ? null : "settled" }] : []);
    if (name === "discover_customer_ai_reconciliation_candidates") return json(acknowledged ? [] : [{
      job_id: f.scope.jobId, created_at: "2026-10-28T13:00:00.123456+00:00", action: "receipt_available" }]);
    if (name === "open_customer_ai_maintenance_slot") { opened = true; if (loseOpen) { loseOpen = false; return json({}, 503); }
      return json({ status: "open", version: 1, attempt: receipt() }); }
    if (name === "read_customer_ai_maintenance") { assert.equal(args.p_attempt_id, attemptId); return json(receipt()); }
    if (name === "execute_customer_ai_maintenance") { assert.equal(args.p_attempt_id, attemptId); state = "completed";
      if (loseExecute) { loseExecute = false; return json({}, 503); } return json(receipt()); }
    if (name === "ack_customer_ai_maintenance_slot") { assert.equal(args.p_attempt_id, attemptId); assert.equal(args.p_version, 1); acknowledged = true;
      if (loseAck) { loseAck = false; return json({}, 503); } return json({ status: "observed", attemptId, version: 1, result: "settled" }); }
    throw new Error("Unexpected synthetic database operation");
  };
  for (let i = 0; i < 4; i++) {
    const runtime = customerAiComposition({ ...f.config, databaseFetch });
    const output = await runtime.scanMaintenance();
    if (i < 3) assert(output.events.some(event => event.status === "unconfirmed"));
    await runtime.close();
  }
  assert.equal(acknowledged, true); assert.equal(f.dispatched(), 0);
  assert.equal(names.filter(name => name === "execute_customer_ai_maintenance").length, 1);
  assert.equal(names.filter(name => name === "ack_customer_ai_maintenance_slot").length, 1);
  assert(!names.some(name => /resolve_customer|cancel_customer|reconcile_customer_ai_job|recover_customer_ai_receipt/u.test(name)));
  f.config.signer.dispose();
});

test("composition shutdown drains maintenance action and stops subsequent page work", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  f.hooks.maintenanceRows = [
    { job_id: f.scope.jobId, created_at: "2026-10-28T13:00:00.123456+00:00", action: "reconcile" },
    { job_id: randomUUID(), created_at: "2026-10-28T13:00:01.123456+00:00", action: "receipt_available" },
  ];
  f.hooks.execute = async () => { started(); await new Promise<void>(done => { release = done; });
    return json({ attemptId: f.maintenanceAttempt, jobId: f.scope.jobId, action: "reconcile", state: "completed", result: "released" }); };
  const runtime = customerAiComposition({ ...f.config, pageSize: 2 }), pending = runtime.scanMaintenance(); await began;
  await assert.rejects(runtime.tick(), /already running/u);
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  assert.equal(closed, false); release();
  assert.deepEqual(await pending, { slotsScanned: 0, candidatesScanned: 1, events: [],
    slotsCycleComplete: true, candidatesCycleComplete: false });
  await closing; assert.equal(f.calls.filter(name => name === "recover_customer_ai_receipt").length, 0);
  assert.equal(f.dispatched(), 0); await assert.rejects(runtime.scanMaintenance(), /closed/u); f.config.signer.dispose();
});

test("lost dispatch reply recovers durable receipt, then stops unhealthy transport", async () => {
  const f = fixture(); f.hooks.service = async () => { f.saveReceipt(); throw new Error("synthetic-secret-must-not-leak"); };
  const runtime = customerAiComposition(f.config);
  await assert.rejects(runtime.tick(), /unresolved operation/u);
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
  await assert.rejects(runtime.tick(controller.signal), /unresolved operation/u);
  assert.equal(f.dispatched(), 1); assert.equal(f.calls.at(-1), "complete_customer_ai_job");
  await runtime.close(); f.config.signer.dispose();
});

test("shutdown stops intake but drains the current dispatch and receipt", async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  f.hooks.service = async () => { started(); await new Promise<void>(done => { release = done; }); f.saveReceipt(); return json({}); };
  const runtime = customerAiComposition({ ...f.config, pageSize: 2 }), running = runtime.tick(); await began;
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
  const runtime = customerAiComposition({ ...f.config, pageSize: 2 }), running = runtime.tick(); await began;
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
