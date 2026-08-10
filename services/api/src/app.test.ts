import { test, before } from "node:test";
import assert from "node:assert/strict";

// Env must be set before @bookworm/config loads (env is cached at first load).
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

// Query-builder fake: .from(t).select(...).eq(...)... terminal methods
// (single/maybeSingle/order/limit/insert/delete) resolve with canned rows.
function fakeSupabase(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: { table: string; op: string }[] = [];
  const client = {
    auth: {
      getUser: async (token: string) =>
        token === "good"
          ? { data: { user: { id: "user-1" } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      const r = responses[table] ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      const chain = ["select", "eq", "insert", "update", "delete"];
      for (const m of chain) b[m] = (...a: unknown[]) => { if (m === "insert") calls.push({ table, op: "insert" }); return b; };
      b.order = () => b;
      b.limit = () => b;
      b.single = async () => r;
      b.maybeSingle = async () => r;
      b.then = (resolve: (v: unknown) => unknown) => resolve(r); // await builder = select-all
      return b;
    },
    _calls: calls,
  };
  return client as never;
}

let close: (() => Promise<void>) | null = null;
before(() => { /* per-test apps */ });

async function appWith(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const app = await buildApp(() => fakeSupabase(responses));
  close = () => app.close();
  return app;
}

const auth = { authorization: "Bearer good" };

test("401 without token, ApiError envelope", async () => {
  const app = await appWith({});
  const res = await app.inject({ method: "GET", url: "/v1/workspaces" });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.equal(typeof body.error.requestId, "string");
  assert.equal(typeof body.error.message, "string");
  await app.close();
});

test("401 with invalid token", async () => {
  const app = await appWith({});
  const res = await app.inject({ method: "GET", url: "/v1/workspaces", headers: { authorization: "Bearer bad" } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("404 unknown route yields ApiError shape", async () => {
  const app = await appWith({});
  const res = await app.inject({ method: "GET", url: "/v1/nope", headers: auth });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.code, "not_found");
  assert.ok(body.error.requestId);
  await app.close();
});

test("404 for unknown chapter on operations", async () => {
  const app = await appWith({ chapters: { data: null, error: null } });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chapters/11111111-1111-1111-1111-111111111111/operations",
    headers: auth,
    payload: { operationId: "op1", type: "replace_text", target: {}, payload: {}, expectedVersion: 0 },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "not_found");
  await app.close();
});

test("409 on stale expectedVersion", async () => {
  const app = await appWith({
    chapters: { data: { book_id: "b1" }, error: null },
    books: { data: { workspace_id: "w1" }, error: null },
    workspace_members: { data: { role: "editor" }, error: null },
    document_versions: { data: { version_number: 3, content_json: {}, plain_text: "", word_count: 0 }, error: null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chapters/c1/operations",
    headers: auth,
    payload: { operationId: "op1", type: "replace_text", target: {}, payload: {}, expectedVersion: 2 },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.code, "conflict");
  assert.equal(body.error.details.currentVersion, 3);
  await app.close();
});

test("200 returns new version when expectedVersion matches", async () => {
  const app = await appWith({
    chapters: { data: { book_id: "b1" }, error: null },
    books: { data: { workspace_id: "w1" }, error: null },
    workspace_members: { data: { role: "editor" }, error: null },
    document_versions: { data: { version_number: 3, content_json: {}, plain_text: "", word_count: 0 }, error: null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chapters/c1/operations",
    headers: auth,
    payload: { operationId: "op1", type: "replace_text", target: {}, payload: {}, expectedVersion: 3 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().version, 4);
  await app.close();
});

test("403 when member role cannot edit", async () => {
  const app = await appWith({
    chapters: { data: { book_id: "b1" }, error: null },
    books: { data: { workspace_id: "w1" }, error: null },
    workspace_members: { data: { role: "viewer" }, error: null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chapters/c1/operations",
    headers: auth,
    payload: { operationId: "op1", type: "replace_text", target: {}, payload: {}, expectedVersion: 0 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "unauthorized");
  await app.close();
});

test("422 on invalid DocumentOperation body", async () => {
  const app = await appWith({});
  const res = await app.inject({
    method: "POST",
    url: "/v1/chapters/c1/operations",
    headers: auth,
    payload: { type: "replace_text" },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "business_validation");
  await app.close();
});

test("409 on duplicate Idempotency-Key", async () => {
  const app = await appWith({
    chapters: { data: { book_id: "b1" }, error: null },
    books: { data: { workspace_id: "w1" }, error: null },
    workspace_members: { data: { role: "editor" }, error: null },
    document_versions: { data: { version_number: 0, content_json: {}, plain_text: "", word_count: 0 }, error: null },
  });
  const req = {
    method: "POST" as const,
    url: "/v1/chapters/c1/operations",
    headers: { ...auth, "idempotency-key": "k-1" },
    payload: { operationId: "op1", type: "replace_text", target: {}, payload: {}, expectedVersion: 0 },
  };
  const first = await app.inject(req);
  assert.equal(first.statusCode, 200);
  const second = await app.inject(req);
  assert.equal(second.statusCode, 409);
  await app.close();
});

test("200 list workspaces with RLS-aware client", async () => {
  const app = await appWith({ workspaces: { data: [{ id: "w1", name: "W" }], error: null } });
  const res = await app.inject({ method: "GET", url: "/v1/workspaces", headers: auth });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().workspaces.length, 1);
  await app.close();
});
