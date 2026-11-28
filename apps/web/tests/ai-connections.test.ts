import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient } from "../../../packages/api-client/src/index.js";
import { parseAiConnections, parseAiConnectionReceipt, type AiConnectionPending } from "../../../packages/api-client/src/ai-connections.js";
import { parsePendingConnection, readPendingConnection, savePendingConnection, clearPendingConnection } from "../lib/ai-connection-recovery.js";
const actor = randomUUID(), other = randomUUID();
const pending: AiConnectionPending = { connectionId: randomUUID(), operationId: randomUUID(), expectedRevision: null, provider: "openai", action: "save" };
const row = { id: pending.connectionId, provider: "openai", status: "saved", revision: 1, keySuffix: "test", lastOperationId: pending.operationId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
test("connection client binds all actions and validates masked, exact-operation responses", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let result: unknown = { viewerId: actor, canSave: true, generationAvailable: false, connections: [row] };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json(result); };
  try {
    const api = createClient({ baseUrl: "http://local.test" });
    assert.equal((await api.listAiConnections(actor)).connections.length, 1);
    result = { viewerId: actor, connection: row };
    const { provider, action: _action, ...body } = pending;
    await api.saveAiConnection(provider, { ...body, apiKey: "synthetic-only-key-test" }, actor);
    result = { viewerId: actor, connection: { ...row, keySuffix: null, status: "revoked" } };
    await api.revokeAiConnection(provider, body, actor);
    result = { viewerId: actor, receipt: { ...pending, status: "closed", revision: null } };
    await api.recoverAiConnection(pending, actor, true);
    for (const call of calls) assert.equal(new Headers(call.init.headers).get("x-bookworm-actor"), actor);
    assert.deepEqual(calls.map(call => call.init.method), ["GET", "PUT", "DELETE", "POST"]);
    assert(calls.every(call => !new Headers(call.init.headers).has("idempotency-key")));
    result = { viewerId: other, canSave: true, generationAvailable: false, connections: [row] };
    await assert.rejects(api.listAiConnections(actor));
  } finally { globalThis.fetch = original; }
});
test("connection parsers reject wrong actors, duplicate providers, raw secrets and mismatched receipts", () => {
  const base = { viewerId: actor, canSave: true, generationAvailable: false, connections: [row] };
  for (const value of [{ ...base, viewerId: other }, { ...base, connections: [row, row] }, { ...base, connections: [{ ...row, keySuffix: "raw-private-key" }] }, { ...base, connections: [{ ...row, status: "validated" }] }]) assert.throws(() => parseAiConnections(value, actor));
  assert(!JSON.stringify(parseAiConnections({ ...base, secret: "ignored", connections: [{ ...row, secret: "ignored" }] }, actor)).includes("ignored"));
  for (const receipt of [{ ...pending, status: "not_found", revision: null }, { ...pending, status: "saved", revision: 2 }, { ...pending, action: "revoke", status: "saved", revision: 1 }]) assert.throws(() => parseAiConnectionReceipt({ viewerId: actor, receipt }, actor, pending, true));
});
test("recovery storage holds only opaque account-scoped intent and rejects secret fields", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), store = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) } });
  try {
    assert.throws(() => parsePendingConnection({ ...pending, apiKey: "never-store-this" }));
    savePendingConnection(actor, pending); assert.deepEqual(readPendingConnection(actor), pending); assert.equal(readPendingConnection(other), null);
    clearPendingConnection(actor, randomUUID()); assert.equal(store.size, 1);
    clearPendingConnection(actor, pending.operationId); assert.equal(store.size, 0);
    assert.throws(() => savePendingConnection("not-user", pending));
  } finally { if (original) Object.defineProperty(globalThis, "sessionStorage", original); else Reflect.deleteProperty(globalThis, "sessionStorage"); }
});
