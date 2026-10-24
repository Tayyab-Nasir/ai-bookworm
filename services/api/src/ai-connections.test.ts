import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { aiConnectionRoutes } from "./routes/ai-connections.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { credentialVault } from "./lib/ai-connection-vault.js";
import { safeRequestLog } from "./lib/redact.js";
import type { SupabaseFactory } from "./lib/supabase.js";
const owner = randomUUID(), foreign = randomUUID(), connectionId = randomUUID(), operationId = randomUUID();
const now = new Date().toISOString();
const key = randomBytes(40).toString("hex");
const input = { connectionId, operationId, expectedRevision: null, apiKey: key };
const row = { id: connectionId, owner_id: owner, provider: "openai", status: "saved", revision: 1, key_suffix: key.slice(-4), last_operation_id: operationId, created_at: now, updated_at: now };
async function fixture(options: { rows?: unknown[]; enabled?: boolean; error?: { code?: string }; fail?: boolean; rpcData?: unknown } = {}) {
  const calls: { token?: string; name: string; args: Record<string, unknown> }[] = [], logs: string[] = [];
  const app = Fastify({ logger: { level: "info", stream: { write: (line: string) => { logs.push(line); } }, serializers: { req: safeRequestLog } } });
  const vault = credentialVault({ AI_CONNECTION_VAULT_KEYRING_JSON: JSON.stringify({ active: "test", keys: { test: randomBytes(32).toString("base64") } }) });
  const factory = ((token?: string) => ({
    auth: { getUser: async () => ({ data: { user: token === "good" ? { id: owner } : null }, error: null }) },
    from: (table: string) => { assert.equal(table, "ai_connections"); assert.equal(token, "good"); return {
      select: (fields: string) => { assert(!/ciphertext|secret/.test(fields)); return { eq: (field: string, id: string) => {
        assert.equal(field, "owner_id"); assert.equal(id, owner); return { order: () => ({ limit: async () => ({ data: options.rows ?? [row], error: options.error ?? null }) }) };
      } }; },
    }; },
    rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ token, name, args }); if (options.fail) throw new Error(key); return { data: options.rpcData ?? row, error: options.error ?? null }; },
  })) as unknown as SupabaseFactory;
  app.addHook("onRequest", async (_req, reply) => { reply.header("cache-control", "private, no-store"); });
  await app.register(async child => { await child.register(errorHandlerPlugin); await child.register(makeAuthPlugin(factory)); aiConnectionRoutes(child, { vault: () => options.enabled === false ? null : vault }); }, { prefix: "/v1" });
  const send = (method = "GET", body?: unknown, actor: string | null = owner, path = "") => app.inject({ method: method as "GET", url: `/v1/account/ai-connections${path}`, headers: { authorization: "Bearer good", ...(actor ? { "x-bookworm-actor": actor } : {}) }, ...(body ? { payload: body } : {}) });
  return { app, calls, logs, send, vault };
}
test("owner-scoped listing returns only masked metadata, funding/validity are never inferred", async () => {
  const f = await fixture(); try { const response = await f.send(); assert.equal(response.statusCode, 200); assert.equal(response.json().viewerId, owner);
    assert.equal(response.json().generationAvailable, false); assert.equal(response.json().canSave, true); assert(!response.body.includes(key));
    assert.deepEqual(Object.keys(response.json().connections[0]).sort(), ["createdAt", "id", "keySuffix", "lastOperationId", "provider", "revision", "status", "updatedAt"]);
  } finally { await f.app.close(); }
  const foreignRows = await fixture({ rows: [{ ...row, owner_id: foreign }] }); try { assert.equal((await foreignRows.send()).statusCode, 503); } finally { await foreignRows.app.close(); }
});
test("save sends an authenticated encrypted envelope and derived owner, never plaintext to SQL", async () => {
  const f = await fixture(); try { const response = await f.send("PUT", input, owner, "/openai"); assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.calls.length, 1); const call = f.calls[0]; assert.equal(call.token, undefined); assert.equal(call.args.p_owner_id, owner);
    assert(!JSON.stringify(call.args).includes(key)); assert(!response.body.includes(key));
    const plaintext = f.vault!.open({ keyId: call.args.p_key_id as string, nonce: call.args.p_nonce as string, ciphertext: call.args.p_ciphertext as string, tag: call.args.p_auth_tag as string }, { ownerId: owner, connectionId, provider: "openai", revision: 1 });
    assert.equal(plaintext.toString(), key); plaintext.fill(0);
  } finally { await f.app.close(); }
});
test("all management actions require actor binding before SQL; client owner/endpoints and empty revokes are rejected", async () => {
  const f = await fixture(); try {
    for (const [method, body, path] of [["GET", undefined, ""], ["PUT", input, "/openai"], ["DELETE", { connectionId, operationId, expectedRevision: 1 }, "/openai"], ["POST", { connectionId, operationId, expectedRevision: 1, action: "save" }, "/openai/close"]] as const) {
      assert.equal((await f.send(method, body, null, path)).statusCode, 422);
      assert.equal((await f.send(method, body, foreign, path)).statusCode, 409);
    }
    for (const body of [{ ...input, ownerId: foreign }, { ...input, endpoint: "http://127.0.0.1" }, { ...input, apiKey: "short" }]) assert.equal((await f.send("PUT", body, owner, "/openai")).statusCode, 422);
    assert.equal((await f.send("PUT", input, owner, "/unapproved")).statusCode, 422);
    assert.equal((await f.send("DELETE", input, owner, "/openai")).statusCode, 422);
    assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
test("missing encryption refuses saves but metadata and removal remain available", async () => {
  const f = await fixture({ enabled: false, rpcData: { ...row, status: "revoked", key_suffix: null, revision: 2 } }); try {
    assert.equal((await f.send()).json().canSave, false);
    assert.equal((await f.send("PUT", input, owner, "/openai")).statusCode, 503); assert.equal(f.calls.length, 0);
    const response = await f.send("DELETE", { connectionId, operationId, expectedRevision: 1 }, owner, "/openai"); assert.equal(response.statusCode, 200, response.body);
    assert(!Object.keys(f.calls[0].args).some(field => /key|cipher|nonce|tag/.test(field)));
  } finally { await f.app.close(); }
});
test("errors and malformed confirmations are neutral, conflicts and rate limits retain their status", async () => {
  for (const [options, status] of [[{ fail: true }, 503], [{ error: { code: "40001" } }, 409], [{ error: { code: "P0429" } }, 429], [{ error: { code: "PGRST202" } }, 503], [{ rpcData: { ...row, owner_id: foreign } }, 503], [{ rpcData: { ...row, revision: 2 } }, 503]] as const) {
    const f = await fixture(options); try { const response = await f.send("PUT", input, owner, "/openai"); assert.equal(response.statusCode, status); assert(!response.body.includes(key)); assert(!f.logs.join("").includes(key)); } finally { await f.app.close(); }
  }
});
test("recovery checks are read-only and close passes only account-bound opaque intent", async () => {
  const receipt = { connectionId, operationId, expectedRevision: null, provider: "openai", action: "save", status: "not_found", revision: null };
  const f = await fixture({ rpcData: receipt }); try { const response = await f.send("POST", { connectionId, operationId, expectedRevision: null, action: "save" }, owner, "/openai/check");
    assert.equal(response.statusCode, 200); assert.equal(f.calls[0].args.p_close, false);
    assert.equal((await f.send("POST", { connectionId, operationId, expectedRevision: null, action: "save" }, owner, "/openai/close")).statusCode, 503);
  } finally { await f.app.close(); }
  const closed = await fixture({ rpcData: { ...receipt, status: "closed" } }); try { assert.equal((await closed.send("POST", { connectionId, operationId, expectedRevision: null, action: "save" }, owner, "/openai/close")).statusCode, 200); assert.equal(closed.calls[0].args.p_close, true); } finally { await closed.app.close(); }
});
test("malformed JSON, URL and request-id key fragments are never reflected in errors or logs", async () => {
  const f = await fixture(); try {
    const response = await f.app.inject({ method: "PUT", url: `/v1/account/ai-connections/openai?secret=${key}`, headers: { authorization: "Bearer good", "x-bookworm-actor": owner, "x-request-id": key, "content-type": "application/json" }, payload: `{"apiKey":"${key}"broken` });
    assert.equal(response.statusCode, 400); assert(!response.body.includes(key)); assert(!f.logs.join("").includes(key));
    assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
