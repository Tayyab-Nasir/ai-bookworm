import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AppError } from "./errors.js";
import { customerAiPreparation } from "./lib/customer-ai-prepare.js";
import { customerDispatchSigner, type CustomerDispatchScope } from "./lib/customer-ai-dispatch.js";
import { ids, sha, sourceFixture } from "./testing/customer-ai-fixture.js";

const policy = () => ({ provider: "openai" as const, policy: { model: "reviewed-model", responseModels: ["reviewed-snapshot"],
  maxOutputTokens: 1024, upstream: null, responseUpstreams: [] as string[] } });
const options = () => ({ serviceUrl: "https://private-ai.example", serviceToken: "synthetic-service-auth" });
const reject = (status: number) => (error: unknown) => error instanceof AppError && error.status === status && !error.message.includes("private-upstream-body");
const reply = (body: string) => { const { scope, requestJson } = JSON.parse(body); return { provider: scope.provider,
  agentType: scope.agentType, model: scope.policy.model, maxOutputTokens: scope.agentType === "bookbible" ? Math.min(scope.policy.maxOutputTokens, 6000) : scope.policy.maxOutputTokens,
  sourceSha256: sha(requestJson), requestSha256: "a".repeat(64), contextOmitted: 0 }; };
const python = (code: string, input: Buffer | string) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["path", "systemroot", "windir", "temp", "tmp", "bookworm_python"].includes(key.toLowerCase())));
  Object.assign(env, { PYTHONPATH: join(root, "services/ai"), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" });
  const result = spawnSync(process.execPath, [join(root, "scripts/run-python.mjs"), "-c", code], { cwd: root, env, input, timeout: 20000, maxBuffer: 1048576 });
  assert.equal(result.status, 0, "Synthetic preparation failed: " + result.stderr.toString());
  return JSON.parse(result.stdout.toString());
};

test("canonical RLS source crosses actual Python prompt preparation and signed dispatch after JSONB key reordering", async () => {
  const f = sourceFixture(); Object.assign(f.input.contextPolicy, { includeStyleGuide: true, includeBookBible: true });
  f.data.style_guides[0].rules_json = { z: "last", a: { unicode: "雨", small: 1e-7 } };
  let calls = 0;
  const preparer = customerAiPreparation(f.factory, { ...options(), fetcher: async (url, init) => {
    calls++; assert.equal(url, "https://private-ai.example/v1/internal/customer-text/prepare"); assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST"); assert(init?.signal); assert(!String(init?.body).includes(f.actor.accessToken));
    const result = python("import sys,json; from customer_prepare_http import prepare_customer_input; print(json.dumps(prepare_customer_input(sys.stdin.buffer.read())))", String(init?.body));
    return Response.json(result);
  } });
  const result = await preparer.prepare(f.actor, f.input, policy());
  assert.equal(calls, 1); assert.equal(result.sourceSha256, sha(JSON.stringify(result.source.request)));
  assert.equal(result.contextOmitted, 0); assert.match(result.requestSha256, /^[a-f0-9]{64}$/);
  const s: CustomerDispatchScope = { grantId: ids.other, jobId: ids.other, workspaceId: ids.workspace, bookId: ids.book,
    ownerId: ids.owner, connectionId: ids.other, credentialRevision: 1, leaseToken: ids.other,
    ...result.selection, agentType: result.source.agentType, expectedRequestSha256: result.requestSha256 };
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
  const signer = customerDispatchSigner("synthetic", Buffer.alloc(32, 7), () => 1900000000);
  const key = Buffer.from("synthetic-customer-credential-0001");
  const body = signer.sign(s, reorder(result.source.request), { binding: { ownerId: ids.owner, provider: "openai", connectionId: ids.other, revision: 1 }, secret: key }).takeBody();
  const proof = python(`import sys,json
from customer_dispatch import verify_dispatch,build_customer_agent
grant=verify_dispatch(sys.stdin.buffer.read(),{'synthetic':bytes([7])*32},now=1900000000)
agent,request,prepared=build_customer_agent(grant)
assert agent.provider is None
print(json.dumps({'valid':True,'provider':grant.scope.provider}))`, body);
  body.fill(0); key.fill(0); signer.dispose(); assert.deepEqual(proof, { valid: true, provider: "openai" });
});

test("selection and dependency snapshots are immutable; Bible effective output cap is explicit", async () => {
  const f = sourceFixture(); f.input.agentType = "bookbible"; const selected = policy(); selected.policy.maxOutputTokens = 9000;
  const config = { ...options(), fetcher: async (_: unknown, init?: RequestInit) => {
    selected.policy.model = "changed"; selected.policy.responseModels.push("changed"); config.serviceToken = "changed";
    return Response.json(reply(String(init?.body)));
  } };
  const result = await customerAiPreparation(f.factory, config).prepare(f.actor, f.input, selected);
  assert.equal(result.model, "reviewed-model"); assert.equal(result.maxOutputTokens, 6000);
  assert.deepEqual(result.selection.policy.responseModels, ["reviewed-snapshot"]);
  assert.throws(() => { result.selection.policy.responseModels.push("mutated"); });
});
for (const change of ["sourceSha256", "provider", "agentType", "model", "requestSha256", "maxOutputTokens", "contextOmitted", "extra"]) {
  test(`private preparation refuses a mismatched ${change}`, async () => {
    const f = sourceFixture(); let calls = 0;
    const fetcher: typeof fetch = async (_, init) => { calls++; const r: Record<string, unknown> = reply(String(init?.body));
      r[change] = change === "maxOutputTokens" ? 1025 : change === "contextOmitted" ? -1 : "changed"; return Response.json(r); };
    await assert.rejects(customerAiPreparation(f.factory, { ...options(), fetcher }).prepare(f.actor, f.input, policy()), reject(503));
    assert.equal(calls, 1);
  });
}
for (const mode of ["error", "redirect", "non-json", "length", "chunked", "network", "invalid-json", "aborted", "source-too-large", "context-limit"]) {
  test(`bounded single-attempt preparation rejects ${mode} without upstream body disclosure`, async () => {
    const f = sourceFixture(); let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (mode === "network") throw new Error("private-upstream-body");
      if (mode === "context-limit") return Response.json({ detail: "private-upstream-body" }, { status: 422 });
      if (mode === "error" || mode === "redirect") return new Response("private-upstream-body", { status: mode === "error" ? 500 : 302 });
      if (mode === "length") return new Response("{}", { headers: { "content-type": "application/json", "content-length": "16385" } });
      if (mode === "chunked") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(" ".repeat(16385))); c.close(); } }), { headers: { "content-type": "application/json" } });
      return new Response("private-upstream-body", { headers: { "content-type": mode === "non-json" ? "text/plain" : "application/json" } });
    };
    if (mode === "source-too-large") f.nodes[0].text = "\n".repeat(180000);
    const signal = mode === "aborted" ? AbortSignal.abort() : undefined;
    await assert.rejects(customerAiPreparation(f.factory, { ...options(), fetcher }).prepare(f.actor, f.input, policy(), signal), reject(mode === "source-too-large" || mode === "context-limit" ? 422 : 503));
    assert.equal(calls, mode === "aborted" || mode === "source-too-large" ? 0 : 1);
  });
}
test("invalid policy or author never reaches the private service", async () => {
  const f = sourceFixture(); let calls = 0;
  const client = customerAiPreparation(f.factory, { ...options(), fetcher: async () => { calls++; throw new Error(); } });
  await assert.rejects(client.prepare(f.actor, f.input, { ...policy(), policy: { ...policy().policy, model: "https://evil.example?q=secret" } }), reject(503));
  await assert.rejects(client.prepare({ ...f.actor, userId: ids.other }, f.input, policy()), reject(401));
  assert.equal(calls, 0);
});
test("cancellation bounds a stalled response body and does not retry", async () => {
  const f = sourceFixture(), controller = new AbortController(); let cancelled = false, calls = 0;
  const fetcher: typeof fetch = async () => { calls++;
    const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"provider":')); setImmediate(() => controller.abort()); },
      cancel() { cancelled = true; } });
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  await assert.rejects(customerAiPreparation(f.factory, { ...options(), fetcher }).prepare(f.actor, f.input, policy(), controller.signal), reject(503));
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
test("operator-only service URL validation; HTTP allowed solely by explicit loopback opt-in", () => {
  const f = sourceFixture();
  for (const serviceUrl of ["http://private-ai.example", "https://x.example/path", "https://x.example?key=x", "https://x.example/#x", "https://user:password@x.example", "file:///x", "http://localhost:9000"]) {
    assert.throws(() => customerAiPreparation(f.factory, { ...options(), serviceUrl }), reject(503));
  }
  assert.throws(() => customerAiPreparation(f.factory, { ...options(), serviceToken: "space not allowed" }), reject(503));
  assert(customerAiPreparation(f.factory, { ...options(), serviceUrl: "http://127.0.0.1:9000", allowLoopbackHttp: true }));
});
