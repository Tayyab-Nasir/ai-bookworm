import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { credentialVault, type CredentialVault } from "./lib/ai-connection-vault.js";
import { customerDispatchSigner, prepareCustomerDispatch, type CustomerDispatchScope } from "./lib/customer-ai-dispatch.js";
import { customerAiWorker, recoverCustomerAiJob } from "./lib/customer-ai-worker.js";
import type { SupabaseClient } from "./lib/supabase.js";

const syntheticKey = "synthetic-worker-provider-key-0001";
function fixture() {
  const scope: CustomerDispatchScope = { grantId: randomUUID(), jobId: randomUUID(), workspaceId: randomUUID(), bookId: randomUUID(),
    ownerId: randomUUID(), connectionId: randomUUID(), credentialRevision: 2, leaseToken: randomUUID(), provider: "openai", agentType: "writer",
    expectedRequestSha256: "a".repeat(64), policy: { model: "synthetic-model", responseModels: ["synthetic-model"], maxOutputTokens: 1024, upstream: null, responseUpstreams: [] } };
  const request = { input: { book: { title: "Synthetic 雨" } } }, prepared = prepareCustomerDispatch(scope, request);
  const job = { id: scope.jobId, workspace_id: scope.workspaceId, book_id: scope.bookId, created_by: scope.ownerId, agent_type: scope.agentType,
    billing_mode: "customer_key", model: scope.policy.model, input_ref: { customerGrantId: scope.grantId, requestSha256: scope.expectedRequestSha256 },
    status: "running", lease_token: scope.leaseToken };
  const completed = { ...job, status: "succeeded", lease_token: null, output_ref: { customerDispatchSha256: prepared.fingerprint,
    costPayer: "customer", providerCostStatus: "unknown", reviewRequired: true } };
  const held = { ...job, status: "failed", lease_token: null, error_code: "customer_provider_outcome_unknown" };
  const binding = { ownerId: scope.ownerId, provider: scope.provider, connectionId: scope.connectionId, revision: scope.credentialRevision };
  const realVault = credentialVault({ AI_CONNECTION_VAULT_KEYRING_JSON: JSON.stringify({ active: "test", keys: { test: randomBytes(32).toString("base64") } }) })!;
  const sealed = realVault.seal(syntheticKey, binding), buffers: Buffer[] = [], events: string[] = [];
  const state = { receipt: false, postCount: 0, resolutionCount: 0, completionCount: 0, held: false };
  const signer = customerDispatchSigner("test", randomBytes(32));
  const hooks: { rpc?: (name: string, args: Record<string, unknown>) => unknown; fetch?: () => Promise<Response>; open?: () => void } = {};
  const sb = { rpc(name: string, args: Record<string, unknown>) { return { abortSignal(signal: AbortSignal) { return Promise.resolve().then(() => {
    assert.ok(signal instanceof AbortSignal); events.push(name);
    const override = hooks.rpc?.(name, args); if (override !== undefined) return { data: override, error: null };
    assert.equal(args.p_job_id, job.id);
    if (name === "claim_customer_ai_job") { assert.equal(args.p_lease_seconds, 300); return { data: job, error: null }; }
    if (name === "prepare_customer_ai_dispatch") { assert.equal(args.p_lease_token, job.lease_token); return { data: { scope, request }, error: null }; }
    if (name === "resolve_customer_ai_dispatch") {
      assert.equal(args.p_lease_token, job.lease_token); assert.equal(args.p_fingerprint, prepared.fingerprint);
      state.resolutionCount++; return { data: { scope, request, credential: sealed }, error: null };
    }
    if (name === "complete_customer_ai_job") {
      state.completionCount++; assert.deepEqual(args, { p_job_id: job.id, p_owner_id: scope.ownerId, p_receipt_fingerprint: prepared.fingerprint });
      return state.receipt ? { data: completed, error: null } : { error: { code: "P0002" } };
    }
    if (name === "hold_customer_ai_job") { assert.equal(args.p_lease_token, job.lease_token); state.held = true; return { data: held, error: null }; }
    throw new Error("Unexpected RPC");
  }); } }; } } as unknown as SupabaseClient;
  const vault: CredentialVault = { seal: realVault.seal, open(envelope, actual) {
    events.push("decrypt"); hooks.open?.(); assert.deepEqual(actual, binding);
    const result = realVault.open(envelope, actual); buffers.push(result); return result;
  } };
  const fetcher: typeof fetch = async (url, init) => {
    events.push("post"); state.postCount++;
    assert.equal(String(url), "https://ai.internal.test/v1/internal/customer-text/dispatch");
    assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST"); assert.ok(init?.signal instanceof AbortSignal);
    const wire = init?.body as Buffer; assert.ok(Buffer.isBuffer(wire)); buffers.push(wire);
    const payload = JSON.parse(Buffer.from(JSON.parse(wire.toString()).payload, "base64url").toString());
    assert.equal(payload.apiKey, syntheticKey); assert.deepEqual(payload.scope, scope);
    assert.equal(buffers[0]!.every(byte => byte === 0), true, "plaintext must be cleared before network");
    if (hooks.fetch) return hooks.fetch();
    state.receipt = true;
    return new Response("untrusted HTTP body is intentionally never parsed", { status: 201 });
  };
  const options = { serviceUrl: "https://ai.internal.test", serviceToken: "synthetic-service-token-001", signer, vault, fetcher };
  const worker = () => customerAiWorker(sb, options);
  const cleared = () => { for (const b of buffers) assert(b.every(byte => byte === 0)); signer.dispose(); };
  return { scope, request, prepared, job, completed, held, state, hooks, sb, worker, options, events, cleared };
}

test("customer worker orders lease/context/one-way resolution/decryption/send/receipt completion", async () => {
  const f = fixture();
  assert.deepEqual(await f.worker().run(f.job.id), { status: "succeeded", jobId: f.job.id });
  assert.deepEqual(f.events, ["claim_customer_ai_job", "prepare_customer_ai_dispatch", "resolve_customer_ai_dispatch", "decrypt", "post", "complete_customer_ai_job"]);
  assert.equal(f.state.postCount, 1); assert.equal(f.state.resolutionCount, 1); assert.equal(f.state.held, false); f.cleared();
});

test("lost HTTP reply and failed HTTP status recover the receipt without trusting body or regenerating", async () => {
  for (const lost of [true, false]) {
    const f = fixture(); f.hooks.fetch = async () => { f.state.receipt = true; if (lost) throw new Error(syntheticKey); return new Response("bad", { status: 503 }); };
    assert.equal((await f.worker().run(f.job.id)).status, "succeeded");
    assert.equal(f.state.postCount, 1); assert.equal(f.state.resolutionCount, 1); f.cleared();
  }
});

test("absent receipt keeps a hold, never retries POST or releases the platform reservation", async () => {
  const f = fixture(); f.hooks.fetch = async () => { throw new Error(syntheticKey); };
  const result = await f.worker().run(f.job.id);
  assert.deepEqual(result, { status: "requires_review", jobId: f.job.id });
  assert.equal(f.state.postCount, 1); assert.equal(f.state.completionCount, 2); assert.equal(f.state.held, true);
  assert(!JSON.stringify(result).includes(syntheticKey)); assert(!f.events.some(name => /cancel|release|deduct/u.test(name))); f.cleared();
});

test("lost resolver confirmation never resolves or sends again, even if a hold cannot be confirmed", async () => {
  for (const holdFails of [false, true]) {
    const f = fixture(); f.hooks.rpc = name => { if (name === "resolve_customer_ai_dispatch" || (holdFails && name === "hold_customer_ai_job")) throw new Error(syntheticKey); };
    const result = await f.worker().run(f.job.id);
    assert.equal(result.status, holdFails ? "completion_unknown" : "requires_review");
    assert.equal(f.events.filter(name => name === "resolve_customer_ai_dispatch").length, 1);
    assert.equal(f.state.postCount, 0); assert(!f.events.includes("decrypt")); f.cleared();
  }
});

test("all canonical scope bindings must match before resolving any key", async () => {
  const mutations: Array<(s: CustomerDispatchScope) => void> = [s => { s.ownerId = randomUUID(); }, s => { s.jobId = randomUUID(); },
    s => { s.workspaceId = randomUUID(); }, s => { s.bookId = randomUUID(); }, s => { s.leaseToken = randomUUID(); },
    s => { s.grantId = randomUUID(); }, s => { s.policy.model = "another"; }, s => { s.agentType = "metadata"; }, s => { s.expectedRequestSha256 = "b".repeat(64); }];
  for (const mutate of mutations) {
    const f = fixture(), scope = structuredClone(f.scope); mutate(scope);
    f.hooks.rpc = name => name === "prepare_customer_ai_dispatch" ? { scope, request: f.request } : undefined;
    assert.equal((await f.worker().run(f.job.id)).status, "preparation_failed");
    assert.equal(f.state.resolutionCount, 0); assert.equal(f.state.postCount, 0); assert(!f.state.held); f.cleared();
  }
});

test("resolve response scope/source/credential tampering cannot decrypt or send a different request", async () => {
  for (const which of ["revision", "source", "encryption", "extra"]) {
    const f = fixture();
    f.hooks.rpc = name => {
      if (name !== "resolve_customer_ai_dispatch") return;
      return { scope: { ...f.scope, ...(which === "revision" ? { credentialRevision: 3 } : {}) },
        request: which === "source" ? { input: { book: { title: "different" } } } : f.request,
        credential: { keyId: "wrong", nonce: "a", ciphertext: "b", tag: "c" }, ...(which === "extra" ? { leaked: true } : {}) };
    };
    assert.equal((await f.worker().run(f.job.id)).status, "requires_review"); assert.equal(f.state.postCount, 0);
    assert.equal(f.events.includes("decrypt"), which === "encryption"); f.cleared();
  }
});

test("lost completion response replays only completion; late competing completion wins a hold race", async () => {
  for (const late of [false, true]) {
    const f = fixture(); let completions = 0;
    f.hooks.fetch = async () => { f.state.receipt = !late; return new Response(null, { status: 204 }); };
    f.hooks.rpc = name => {
      if (!late && name === "complete_customer_ai_job" && ++completions === 1) throw new Error("Lost reply");
      if (late && name === "hold_customer_ai_job") { f.state.receipt = true; throw new Error("Completion won"); }
    };
    assert.equal((await f.worker().run(f.job.id)).status, "succeeded");
    assert.equal(f.state.postCount, 1); assert.equal(f.state.resolutionCount, 1); f.cleared();
  }
});

test("receipt recovery does not need a key, network sender or still-enabled policy", async () => {
  const f = fixture(); f.state.receipt = true; f.options.signer.dispose();
  assert.equal((await recoverCustomerAiJob(f.sb, f.job.id, f.scope.ownerId, f.prepared.fingerprint)).status, "succeeded");
  assert.deepEqual(f.events, ["complete_customer_ai_job"]); assert.equal(f.state.postCount, 0); f.cleared();
});

test("forged completion identity, fingerprint or payer never reports success", async () => {
  for (const bad of ["owner", "fingerprint", "payer", "model"]) {
    const f = fixture(), data = structuredClone(f.completed);
    if (bad === "owner") data.created_by = randomUUID();
    if (bad === "fingerprint") data.output_ref.customerDispatchSha256 = "c".repeat(64);
    if (bad === "payer") data.output_ref.costPayer = "platform";
    if (bad === "model") data.model = "changed";
    f.hooks.rpc = name => name === "complete_customer_ai_job" ? data : undefined;
    assert.equal((await f.worker().run(f.job.id)).status, "requires_review"); f.cleared();
  }
});

test("preparation/claim/shutdown failure sends nothing; shutdown after resolver remains held", async () => {
  for (const stage of ["claim_customer_ai_job", "prepare_customer_ai_dispatch", "resolve_customer_ai_dispatch"]) {
    const f = fixture(), abort = new AbortController();
    f.hooks.rpc = name => { if (name === stage) { abort.abort(); throw new Error(syntheticKey); } };
    assert.equal((await f.worker().run(f.job.id, abort.signal)).status,
      stage === "claim_customer_ai_job" ? "unavailable" : stage === "prepare_customer_ai_dispatch" ? "preparation_failed" : "requires_review");
    assert.equal(f.state.postCount, 0); f.cleared();
  }
  const f = fixture(); assert.equal((await f.worker().run(f.job.id, AbortSignal.abort())).status, "unavailable");
  assert.deepEqual(f.events, []); f.cleared();
});

test("transport configuration fails closed before any database/key activity", () => {
  const f = fixture();
  for (const serviceUrl of ["http://remote.test", "https://user:secret@example.test", "https://example.test?token=bad", "https://example.test/#bad", "https://example.test/unreviewed", "file:///tmp/service"]) {
    assert.throws(() => customerAiWorker(f.sb, { ...f.options, serviceUrl, allowLoopbackHttp: true }), /configuration unavailable/u);
  }
  assert.throws(() => customerAiWorker(f.sb, { ...f.options, serviceUrl: "http://127.0.0.1:8000" }));
  assert.doesNotThrow(() => customerAiWorker(f.sb, { ...f.options, serviceUrl: "http://127.0.0.1:8000", allowLoopbackHttp: true }));
  assert.throws(() => customerAiWorker(f.sb, { ...f.options, serviceToken: "short" }));
  assert.throws(() => customerAiWorker(f.sb, { ...f.options, serviceToken: "bad\n".repeat(10) }));
  assert.deepEqual(f.events, []); f.cleared();
});
