import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { customerAiIdentityProbe } from "./lib/customer-ai-identity.js";

const key = Buffer.alloc(32, 7), token = "synthetic-private-service-token";
const signed = (request: { keyId: string; nonce: string }, secret = key) => ({ ...request,
  proof: createHmac("sha256", secret).update(`bookworm-customer-service-identity-v1\n${request.keyId}\n${request.nonce}`, "ascii").digest("hex") });
const base = { serviceUrl: "https://service.example.test", serviceToken: token, keyId: "current", signingKey: key };

test("TypeScript challenge verifies the actual Python private ASGI app", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["path", "systemroot", "windir", "temp", "tmp", "bookworm_python"].includes(name.toLowerCase())));
  Object.assign(env, { PYTHONPATH: join(root, "services/ai"), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" });
  const client = customerAiIdentityProbe({ ...base, fetcher: async (_url, init) => {
    const code = `import sys,json\nfrom fastapi.testclient import TestClient\nfrom customer_private_app import create_customer_private_app\napp=create_customer_private_app(database_url='https://database.invalid',service_role_key='synthetic-private-database-token',service_token='synthetic-private-service-token',signing_keys={'current':bytes([7])*32},mode='test')\nwith TestClient(app) as client:\n response=client.post('/v1/internal/customer-text/identity',content=sys.stdin.buffer.read(),headers={'content-type':'application/json','x-service-token':'synthetic-private-service-token'})\n print(json.dumps({'status':response.status_code,'body':response.json()}))`;
    const child = spawnSync(process.execPath, [join(root, "scripts/run-python.mjs"), "-c", code],
      { cwd: root, env, input: String(init?.body), timeout: 20_000, maxBuffer: 8192 });
    assert.equal(child.status, 0, "Synthetic identity bridge failed.");
    const result = JSON.parse(child.stdout.toString()); return Response.json(result.body, { status: result.status });
  } });
  assert.deepEqual(await client.check(), { identityVerified: true }); client.dispose();
});

test("identity check sends one fresh nonce and accepts matching configured key", async () => {
  const nonces: string[] = [];
  const client = customerAiIdentityProbe({ ...base, fetcher: async (url, init) => {
    assert.equal(url, "https://service.example.test/v1/internal/customer-text/identity");
    assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST");
    const request = JSON.parse(String(init?.body)); nonces.push(request.nonce);
    return Response.json(signed(request));
  } });
  assert.deepEqual(await client.check(), { identityVerified: true });
  assert.deepEqual(await client.check(), { identityVerified: true }); assert.notEqual(nonces[0], nonces[1]);
  client.dispose(); await assert.rejects(client.check(), /identity is unavailable/u);
});

test("rotated key ID and secret must both match; stale proof and malformed responses fail closed", async () => {
  let stale: unknown;
  for (const mode of ["token", "key", "keyid", "nonce", "replay", "redirect", "extra", "content", "oversize"]) {
    let count = 0;
    const client = customerAiIdentityProbe({ ...base, keyId: "rotated", signingKey: Buffer.alloc(32, 9), fetcher: async (_, init) => {
      count++; const request = JSON.parse(String(init?.body));
      const current = signed(request, Buffer.alloc(32, 9));
      if (mode === "token") return new Response("private-body", { status: 401 });
      if (mode === "redirect") return new Response(null, { status: 302 });
      if (mode === "key") return Response.json(signed(request, key));
      if (mode === "keyid") return Response.json({ ...current, keyId: "old" });
      if (mode === "nonce") return Response.json({ ...current, nonce: "A".repeat(43) });
      if (mode === "extra") return Response.json({ ...current, extra: "private-body" });
      if (mode === "content") return new Response(JSON.stringify(current), { headers: { "content-type": "text/plain" } });
      if (mode === "oversize") return new Response("x".repeat(4097), { headers: { "content-type": "application/json" } });
      if (mode === "replay") return Response.json(stale ??= current);
      throw new Error();
    } });
    if (mode === "replay") assert.deepEqual(await client.check(), { identityVerified: true });
    await assert.rejects(client.check(), error => { assert.ok(error instanceof Error); assert.equal(error.message, "Customer AI service identity is unavailable.");
      assert.doesNotMatch(error.stack ?? "", /private-body|synthetic-private/u); return true; });
    assert.equal(count, mode === "replay" ? 2 : 1); client.dispose();
  }
});

test("abort of uncooperative transport is bounded and never retries", async () => {
  const controller = new AbortController(); let calls = 0, release!: (value: Response) => void;
  const client = customerAiIdentityProbe({ ...base, fetcher: () => { calls++; return new Promise(done => { release = done; }); } });
  const pending = client.check(controller.signal); controller.abort();
  await assert.rejects(pending, /identity is unavailable/u);
  release(new Response(null, { status: 503 })); await Promise.resolve(); assert.equal(calls, 1); client.dispose();
});

test("identity timeout stops waiting on an uncooperative transport without retry", { timeout: 12_000 }, async () => {
  let calls = 0, release!: (value: Response) => void;
  const client = customerAiIdentityProbe({ ...base, fetcher: () => { calls++; return new Promise(done => { release = done; }); } });
  const started = Date.now(), keepAlive = setTimeout(() => {}, 8_000);
  try {
    await assert.rejects(client.check(), /identity is unavailable/u);
    assert.ok(Date.now() - started >= 4_000); assert.equal(calls, 1);
    release(new Response(null, { status: 503 })); await Promise.resolve();
  } finally { clearTimeout(keepAlive); client.dispose(); }
});

test("configuration rejects unsafe destinations and does not leak input", () => {
  for (const config of [{ ...base, serviceUrl: "http://service.example" }, { ...base, serviceUrl: "https://user:password@example.com" },
    { ...base, signingKey: Buffer.alloc(31) }, { ...base, keyId: "bad key" }, { ...base, serviceToken: "short" }]) {
    assert.throws(() => customerAiIdentityProbe(config), error => { assert.ok(error instanceof Error);
      assert.equal(error.message, "Customer AI service identity is unavailable."); assert.doesNotMatch(error.stack ?? "", /password|synthetic-private/u); return true; });
  }
});
