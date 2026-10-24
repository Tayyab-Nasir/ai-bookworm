import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import { customerDispatchSigner, type CustomerDispatchScope } from "./lib/customer-ai-dispatch.js";

const scope = (): CustomerDispatchScope => ({ grantId: randomUUID(), jobId: randomUUID(), workspaceId: randomUUID(), bookId: randomUUID(),
  ownerId: randomUUID(), connectionId: randomUUID(), credentialRevision: 3, leaseToken: randomUUID(), provider: "openai", agentType: "writer",
  expectedRequestSha256: "a".repeat(64), policy: { model: "reviewed-model", responseModels: ["reviewed-snapshot"], maxOutputTokens: 1024,
    upstream: null, responseUpstreams: [] } });
const credentials = (s: CustomerDispatchScope) => ({ binding: { ownerId: s.ownerId, provider: s.provider, connectionId: s.connectionId,
  revision: s.credentialRevision }, secret: Buffer.from("synthetic-customer-credential-0001") });

test("exact-byte HMAC, private single-use body, caller buffers and disposed signer", () => {
  const s = scope(), credential = credentials(s), key = randomBytes(32), signer = customerDispatchSigner("test", key, () => 1900000000);
  const envelope = signer.sign(s, { input: { book: { title: "雨 café" } } }, credential);
  assert.equal(inspect(envelope), "[private-customer-dispatch]");
  assert.equal(JSON.stringify(envelope), '"[private-customer-dispatch]"');
  const body = envelope.takeBody(), wire = JSON.parse(body.toString()), raw = Buffer.from(wire.payload, "base64url");
  assert.equal(wire.signature, createHmac("sha256", key).update("bookworm-customer-dispatch-v1\ntest\n").update(raw).digest("hex"));
  const payload = JSON.parse(raw.toString());
  assert.equal(payload.expiresAt - payload.issuedAt, 60); assert.deepEqual(payload.scope, s);
  assert.throws(() => envelope.takeBody()); body.fill(0); raw.fill(0);
  signer.dispose(); assert.throws(() => signer.sign(s, { input: {} }, credential));
  assert.equal(credential.secret.toString(), "synthetic-customer-credential-0001"); credential.secret.fill(0);
});

test("credential binding and bounded safe JSON are checked with static errors", () => {
  const s = scope(), c = credentials(s), signer = customerDispatchSigner("test", randomBytes(32));
  const invalid = [{ ...c.binding, ownerId: randomUUID() }, { ...c.binding, connectionId: randomUUID() },
    { ...c.binding, revision: 4 }, { ...c.binding, provider: "google" as const }];
  for (const binding of invalid) assert.throws(() => signer.sign(s, { input: {} }, { ...c, binding }), /could not be prepared/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, "input", { enumerable: true, get() { throw new Error("must not run"); } });
  for (const request of [undefined, NaN, Infinity, { input: undefined }, cyclic, getter, { input: "x".repeat(524288) },
    { input: "\uD800" }, { input: c.secret.toString() }, { input: new Date() }, { input: 1n }]) {
    assert.throws(() => signer.sign(s, request, c), error => error instanceof Error && error.message === "Customer dispatch could not be prepared. No request was sent.");
  }
  const envelope = signer.sign(s, { input: {} }, c); envelope.dispose(); assert.throws(() => envelope.takeBody()); signer.dispose();
});

test("TypeScript signature crosses Python verification, real agent and durable replay", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["path", "systemroot", "windir", "temp", "tmp", "bookworm_python"].includes(key.toLowerCase())));
  Object.assign(env, { PYTHONPATH: join(root, "services/ai") + (process.platform === "win32" ? ";" : ":") + join(root, "services/ai/tests"), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" });
  const run = (code: string, input?: Buffer) => {
    const p = spawnSync(process.execPath, [join(root, "scripts/run-python.mjs"), "-c", code], { cwd: root, env, input, timeout: 20000, maxBuffer: 1048576 });
    assert.equal(p.status, 0, "Synthetic cross-language fixture failed: " + p.stderr.toString()); return JSON.parse(p.stdout.toString());
  };
  const [s, request] = run("import json; from test_customer_dispatch import fixture; print(json.dumps(fixture(),ensure_ascii=False))");
  const signer = customerDispatchSigner("synthetic", Buffer.from(Array.from({ length: 32 }, (_, i) => i)), () => 1900000000);
  const body = signer.sign(s, request, credentials(s)).takeBody();
  const result = run(`import json,sys,tempfile
from pathlib import Path
from test_customer_dispatch import verify,SqliteReceipts,NOW,transport
from customer_dispatch import execute_dispatch
body=sys.stdin.buffer.read(); calls=[]
with tempfile.TemporaryDirectory() as directory:
 store=SqliteReceipts(Path(directory)/'receipt.db')
 first=execute_dispatch(verify(body),store,now=lambda:NOW,_test_transport=transport('openai',calls))
 again=execute_dispatch(verify(body),SqliteReceipts(store.path),now=lambda:NOW,_test_transport=transport('openai',calls))
 assert first==again and len(calls)==1
 print(json.dumps({'status':first['status'],'cost':first['usage']['estimatedCostUsd'],'calls':len(calls)}))`, body);
  body.fill(0); signer.dispose();
  assert.deepEqual(result, { status: "succeeded", cost: null, calls: 1 });
});
