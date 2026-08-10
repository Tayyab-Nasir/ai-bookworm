import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");
const { parseMentionNames } = await import("./routes/collab.js");
const { FOLDER_TEMPLATE } = await import("./routes/folders.js");

// Same fake-builder shape as app.test.ts, extended with .is/.in and a
// storage stub; responses are keyed per table. Awaited non-terminal chains
// coerce rows to arrays (list queries); .single/.maybeSingle pass through.
function fakeSupabase(responses: Record<string, { data?: unknown; error?: unknown }>, writes?: { table: string; op: string; row: unknown }[]) {
  writes ??= [];
  const client = {
    auth: {
      getUser: async (token: string) =>
        token === "good"
          ? { data: { user: { id: "user-1" } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
    storage: { from: () => ({ createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `signed:${path}` }, error: null }) }) },
    from: (table: string) => {
      const r = responses[table] ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update", "delete", "is", "in", "order", "limit"]) b[m] = () => b;
      b.insert = (row: unknown) => { writes.push({ table, op: "insert", row }); return b; };
      b.single = async () => r;
      b.maybeSingle = async () => r;
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data], error: r.error ?? null });
      return b;
    },
    _writes: writes,
  };
  return client as never;
}

async function appWith(responses: Record<string, { data?: unknown; error?: unknown }>) {
  // All clients (user + service role) share one writes log.
  const writes: { table: string; op: string; row: unknown }[] = [];
  const app = await buildApp(() => fakeSupabase(responses, writes));
  return { app, writes };
}

const auth = { authorization: "Bearer good" };
const editor = { workspace_members: { data: { role: "editor" }, error: null } };

// ---- unit: mention parsing + template -------------------------------------
test("parseMentionNames extracts candidate names (prefixes for over-capture)", () => {
  assert.deepEqual(parseMentionNames("hi @Alice and @bob smith, cc @Alice"), ["alice", "alice and", "bob", "bob smith"]);
  assert.deepEqual(parseMentionNames("no mentions"), []);
});

test("folder template covers 00_Admin..08_Archive", () => {
  const names = FOLDER_TEMPLATE.map((e) => (Array.isArray(e) ? e[0] : e));
  assert.equal(names[0], "00_Admin");
  assert.equal(names[8], "08_Archive");
  assert.equal(names.length, 9);
});

// ---- folders ---------------------------------------------------------------
test("viewer cannot create folder (403)", async () => {
  const { app } = await appWith({ workspace_members: { data: { role: "viewer" }, error: null } });
  const res = await app.inject({ method: "POST", url: "/v1/workspaces/w1/folders", headers: auth, payload: { name: "X" } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("non-member cannot list folders (403)", async () => {
  const { app } = await appWith({ workspace_members: { data: null, error: null } });
  const res = await app.inject({ method: "GET", url: "/v1/workspaces/w1/folders", headers: auth });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// ---- tasks -----------------------------------------------------------------
test("editor creates task, activity logged", async () => {
  const { app } = await appWith({
    workspace_members: { data: { role: "editor" }, error: null },
    tasks: { data: { id: "t1", title: "Fix cover" }, error: null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: auth,
    payload: { workspaceId: "11111111-1111-1111-1111-111111111111", title: "Fix cover", priority: "high" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().id, "t1");
  await app.close();
});

test("reviewer cannot transition task status (403)", async () => {
  const { app } = await appWith({
    tasks: { data: { id: "t1", workspace_id: "w1", status: "todo" }, error: null },
    workspace_members: { data: { role: "reviewer" }, error: null },
  });
  const res = await app.inject({ method: "PATCH", url: "/v1/tasks/t1", headers: auth, payload: { status: "done" } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("task PATCH 422 on empty update", async () => {
  const { app } = await appWith(editor);
  const res = await app.inject({ method: "PATCH", url: "/v1/tasks/t1", headers: auth, payload: {} });
  assert.equal(res.statusCode, 422);
  await app.close();
});

// ---- approvals -------------------------------------------------------------
test("approval state machine: pending->approved, second resolve 409", async () => {
  const { app } = await appWith({
    approvals: { data: { id: "a1", workspace_id: "w1", status: "approved", reviewer_id: null }, error: null },
    workspace_members: { data: { role: "reviewer" }, error: null },
  });
  // Row already resolved -> both approve and reject conflict.
  const again = await app.inject({ method: "POST", url: "/v1/approvals/a1/approve", headers: auth });
  assert.equal(again.statusCode, 409);
  const flip = await app.inject({ method: "POST", url: "/v1/approvals/a1/reject", headers: auth });
  assert.equal(flip.statusCode, 409);
  await app.close();
});

test("viewer cannot approve (403)", async () => {
  const { app } = await appWith({
    approvals: { data: { id: "a1", workspace_id: "w1", status: "pending", reviewer_id: null }, error: null },
    workspace_members: { data: { role: "viewer" }, error: null },
  });
  const res = await app.inject({ method: "POST", url: "/v1/approvals/a1/approve", headers: auth });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("assigned reviewer mismatch gets 403", async () => {
  const { app } = await appWith({
    approvals: { data: { id: "a1", workspace_id: "w1", status: "pending", reviewer_id: "someone-else" }, error: null },
    workspace_members: { data: { role: "reviewer" }, error: null },
  });
  const res = await app.inject({ method: "POST", url: "/v1/approvals/a1/approve", headers: auth });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// ---- comments --------------------------------------------------------------
test("comment create parses mentions into comment_mentions inserts", async () => {
  const { app, writes } = await appWith({
    workspace_members: { data: { role: "editor" }, error: null },
    comments: { data: { id: "c1", body: "hi" }, error: null },
    profiles: { data: [{ id: "u2", display_name: "Alice" }], error: null },
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/comments",
    headers: auth,
    payload: {
      workspaceId: "11111111-1111-1111-1111-111111111111",
      entityType: "chapter",
      entityId: "22222222-2222-2222-2222-222222222222",
      body: "hey @Alice look",
    },
  });
  assert.equal(res.statusCode, 201);
  // mention rows resolved via candidates -> comment_mentions insert + name in response
  assert.ok(writes.some((w) => w.table === "comment_mentions"), "expected a comment_mentions insert");
  assert.deepEqual(res.json().mentioned, ["u2"]);
  await app.close();
});

// ---- assets: soft delete + restore ----------------------------------------
const deletedAsset = { assets: { data: { id: "as1", workspace_id: "w1", deleted_at: "2026-01-01T00:00:00Z" }, error: null } };
const liveAsset = { assets: { data: { id: "as1", workspace_id: "w1", deleted_at: null }, error: null } };

test("soft delete then delete again -> 409; restore deleted -> ok", async () => {
  const { app } = await appWith({ ...editor, ...deletedAsset });
  const res = await app.inject({ method: "DELETE", url: "/v1/assets/as1", headers: auth });
  assert.equal(res.statusCode, 409); // already deleted
  const restore = await app.inject({ method: "POST", url: "/v1/assets/as1/restore", headers: auth });
  assert.equal(restore.statusCode, 200);
  assert.equal(restore.json().restored, true);
  await app.close();
});

test("restore of live asset -> 409; viewer cannot delete -> 403", async () => {
  const { app } = await appWith({ ...editor, ...liveAsset });
  const restore = await app.inject({ method: "POST", url: "/v1/assets/as1/restore", headers: auth });
  assert.equal(restore.statusCode, 409);
  await app.close();

  const { app: app2 } = await appWith({
    workspace_members: { data: { role: "viewer" }, error: null },
    ...liveAsset,
  });
  const del = await app2.inject({ method: "DELETE", url: "/v1/assets/as1", headers: auth });
  assert.equal(del.statusCode, 403);
  await app2.close();
});

test("new version on deleted asset -> 409", async () => {
  const { app } = await appWith({ ...editor, ...deletedAsset });
  const res = await app.inject({
    method: "POST",
    url: "/v1/assets/as1/versions",
    headers: auth,
    payload: { filename: "v2.png", mimeType: "image/png", sizeBytes: 10 },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

// ---- team ------------------------------------------------------------------
test("non-admin cannot invite (403); invalid email 422", async () => {
  const { app } = await appWith({ workspace_members: { data: { role: "editor" }, error: null } });
  const res = await app.inject({
    method: "POST",
    url: "/v1/workspaces/w1/invitations",
    headers: auth,
    payload: { email: "a@b.co", role: "writer" },
  });
  assert.equal(res.statusCode, 403);
  await app.close();

  const { app: app2 } = await appWith({ workspace_members: { data: { role: "owner" }, error: null } });
  const bad = await app2.inject({
    method: "POST",
    url: "/v1/workspaces/w1/invitations",
    headers: auth,
    payload: { email: "nope", role: "writer" },
  });
  assert.equal(bad.statusCode, 422);
  await app2.close();
});

test("role change requires admin (403 for editor)", async () => {
  const { app } = await appWith({ workspace_members: { data: { role: "editor" }, error: null } });
  const res = await app.inject({
    method: "PATCH",
    url: "/v1/workspaces/w1/members/u2",
    headers: auth,
    payload: { role: "reviewer" },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});
