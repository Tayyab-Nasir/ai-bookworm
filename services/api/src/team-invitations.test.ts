import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.APP_URL = "https://bookworm.test";

const { buildApp } = await import("./app.js");

type Row = Record<string, unknown>;
interface Store {
  tables: Record<string, Row[]>;
  rpcResults: Record<string, { data: unknown; error: unknown }>;
  rpcCalls: { name: string; args: Row }[];
  beforeInvitationUpdate?: (row: Row) => void;
}

const OWNER = "a8000000-0000-4000-8000-000000000001";
const WORKSPACE = "b8000000-0000-4000-8000-000000000001";

function fakeSupabase(store: Store) {
  const client = {
    auth: {
      getUser: async (token: string) => token === "owner"
        ? { data: { user: { id: OWNER } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let patch: Row | null = null;
      let inserted: Row | null = null;
      const matches = () => rows.filter((row) => filters.every(([column, value]) => row[column] === value));
      const resolveRows = () => {
        if (inserted) return [inserted];
        if (patch && table === "workspace_invitations" && store.beforeInvitationUpdate) {
          const callback = store.beforeInvitationUpdate;
          delete store.beforeInvitationUpdate;
          const row = rows.find((item) => item.id === filters.find(([column]) => column === "id")?.[1]);
          if (row) callback(row);
        }
        const found = matches();
        if (patch) for (const row of found) Object.assign(row, patch);
        return found;
      };
      const result = (single: boolean) => ({ data: single ? resolveRows()[0] ?? null : resolveRows(), error: null });
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: unknown) => { filters.push([column, value]); return builder; };
      builder.order = () => builder;
      builder.insert = (value: Row) => {
        inserted = { id: value.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...value };
        if (table === "workspace_invitations") inserted.status ??= "pending";
        rows.push(inserted);
        return builder;
      };
      builder.update = (value: Row) => { patch = value; return builder; };
      builder.single = async () => result(true);
      builder.maybeSingle = async () => result(true);
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result(false));
      return builder;
    },
    rpc: (name: string, args: Row) => {
      store.rpcCalls.push({ name, args });
      const response = store.rpcResults[name] ?? { data: null, error: null };
      return {
        single: async () => response,
        then: (resolve: (value: unknown) => unknown) => resolve(response),
      };
    },
  };
  return client as never;
}

function baseStore(): Store {
  return {
    tables: {
      workspace_members: [{ workspace_id: WORKSPACE, user_id: OWNER, role: "owner", status: "active" }],
      workspace_invitations: [],
      activity_events: [],
    },
    rpcResults: {},
    rpcCalls: [],
  };
}

async function appWith(store: Store) {
  return buildApp((() => fakeSupabase(store)) as never);
}

const auth = { authorization: "Bearer owner" };

test("workspace invitations store only a hash, rotate, list safely, and revoke", async () => {
  const store = baseStore();
  const app = await appWith(store);
  const first = await app.inject({
    method: "POST", url: `/v1/workspaces/${WORKSPACE}/invitations`, headers: auth,
    payload: { email: " Writer@Example.com ", role: "writer" },
  });
  assert.equal(first.statusCode, 201);
  assert.match(first.json().acceptanceUrl, /^https:\/\/bookworm\.test\/team\/accept#token=/);
  assert.equal(first.json().invitation.email, "writer@example.com");
  assert.equal("token_hash" in first.json().invitation, false);
  assert.match(String(store.tables.workspace_invitations[0].token_hash), /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(store.tables.workspace_invitations[0]).includes(first.json().acceptanceUrl.split("token=")[1]), false);

  const originalHash = store.tables.workspace_invitations[0].token_hash;
  const rotated = await app.inject({
    method: "POST", url: `/v1/workspaces/${WORKSPACE}/invitations`, headers: auth,
    payload: { email: "writer@example.com", role: "reviewer" },
  });
  assert.equal(rotated.statusCode, 200);
  assert.equal(store.tables.workspace_invitations.length, 1);
  assert.notEqual(store.tables.workspace_invitations[0].token_hash, originalHash);
  assert.equal(store.tables.workspace_invitations[0].role, "reviewer");

  const listed = await app.inject({ method: "GET", url: `/v1/workspaces/${WORKSPACE}/invitations`, headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().invitations.length, 1);
  assert.equal("token_hash" in listed.json().invitations[0], false);

  const invitationId = store.tables.workspace_invitations[0].id as string;
  const revoked = await app.inject({ method: "DELETE", url: `/v1/workspaces/${WORKSPACE}/invitations/${invitationId}`, headers: auth });
  assert.equal(revoked.statusCode, 200);
  assert.equal(store.tables.workspace_invitations[0].status, "revoked");
  await app.close();
});

test("invitation acceptance hashes the raw token and role changes use the atomic RPC", async () => {
  const store = baseStore();
  store.rpcResults.accept_workspace_invitation = { data: { workspaceId: WORKSPACE, organizationId: "org-1", role: "writer", status: "active" }, error: null };
  store.rpcResults.change_workspace_member_role = { data: { workspace_id: WORKSPACE, user_id: "member-1", role: "reviewer", status: "active" }, error: null };
  const app = await appWith(store);
  const token = "a".repeat(43);
  const accepted = await app.inject({ method: "POST", url: "/v1/workspaces/invitations/accept", headers: auth, payload: { token } });
  assert.equal(accepted.statusCode, 200);
  const acceptCall = store.rpcCalls.find((call) => call.name === "accept_workspace_invitation");
  assert.ok(acceptCall);
  assert.match(String(acceptCall.args.p_token_hash), /^[0-9a-f]{64}$/);
  assert.notEqual(acceptCall.args.p_token_hash, token);

  const changed = await app.inject({
    method: "PATCH", url: `/v1/workspaces/${WORKSPACE}/members/member-1`, headers: auth,
    payload: { role: "reviewer" },
  });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(store.rpcCalls.at(-1), {
    name: "change_workspace_member_role",
    args: { p_workspace_id: WORKSPACE, p_user_id: "member-1", p_role: "reviewer" },
  });
  await app.close();
});

test("invitation and owner-role database errors map to stable API boundaries", async () => {
  const store = baseStore();
  store.rpcResults.accept_workspace_invitation = { data: null, error: { code: "42501", message: "secret details" } };
  store.rpcResults.change_workspace_member_role = { data: null, error: { code: "23505", message: "secret details" } };
  const app = await appWith(store);
  const denied = await app.inject({ method: "POST", url: "/v1/workspaces/invitations/accept", headers: auth, payload: { token: "b".repeat(43) } });
  assert.equal(denied.statusCode, 403);
  assert.equal(JSON.stringify(denied.json()).includes("secret details"), false);
  const conflict = await app.inject({ method: "PATCH", url: `/v1/workspaces/${WORKSPACE}/members/${OWNER}`, headers: auth, payload: { role: "admin" } });
  assert.equal(conflict.statusCode, 409);
  await app.close();
});

test("invitation status is actor-bound, private and never returns the token", async () => {
  const store = baseStore();
  const token = "secret-synthetic-token-".repeat(3);
  store.rpcResults.workspace_invitation_acceptance_status = {
    data: { viewerId: OWNER, state: "accepted", workspaceId: WORKSPACE, role: "reviewer" }, error: null,
  };
  const app = await appWith(store);
  const result = await app.inject({ method: "POST", url: "/v1/workspaces/invitations/status", headers: auth, payload: { token } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.deepEqual(result.json(), { viewerId: OWNER, state: "accepted", workspaceId: WORKSPACE, role: "reviewer" });
  assert.deepEqual(store.rpcCalls.at(-1), {
    name: "workspace_invitation_acceptance_status",
    args: { p_token_hash: createHash("sha256").update(token).digest("hex") },
  });
  assert.equal(result.body.includes(token), false);
  for (const state of ["not_confirmed", "accepted_unavailable"] as const) {
    store.rpcResults.workspace_invitation_acceptance_status = { data: { viewerId: OWNER, state }, error: null };
    const response = await app.inject({ method: "POST", url: "/v1/workspaces/invitations/status", headers: auth, payload: { token } });
    assert.deepEqual(response.json(), { viewerId: OWNER, state });
  }
  await app.close();
});

test("invitation status fails closed for another actor, malformed data and database errors", async () => {
  const store = baseStore();
  const app = await appWith(store);
  const token = "x".repeat(43);
  for (const response of [
    { data: { viewerId: WORKSPACE, state: "accepted", workspaceId: WORKSPACE, role: "writer" }, error: null },
    { data: { viewerId: OWNER, state: "not_confirmed", workspaceId: WORKSPACE }, error: null },
    { data: { viewerId: OWNER, state: "accepted", workspaceId: "bad", role: "writer" }, error: null },
    { data: null, error: { message: "private database details" } },
  ]) {
    store.rpcResults.workspace_invitation_acceptance_status = response;
    const result = await app.inject({ method: "POST", url: "/v1/workspaces/invitations/status", headers: auth, payload: { token } });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.includes("private database details"), false);
    assert.equal(result.body.includes(WORKSPACE), false);
  }
  const invalid = await app.inject({ method: "POST", url: "/v1/workspaces/invitations/status", headers: auth, payload: { token: "short" } });
  assert.equal(invalid.statusCode, 422);
  await app.close();
});

test("stale invitation rotations do not overwrite acceptance or a newer link", async () => {
  for (const change of ["accepted", "revoked", "rotated"] as const) {
    const store = baseStore();
    const app = await appWith(store);
    const payload = { email: "writer@example.com", role: "writer" };
    const first = await app.inject({ method: "POST", url: `/v1/workspaces/${WORKSPACE}/invitations`, headers: auth, payload });
    assert.equal(first.statusCode, 201);
    let snapshot: Row = {};
    store.beforeInvitationUpdate = (row) => {
      if (change === "rotated") {
        row.updated_at = new Date(Date.parse(String(row.updated_at)) + 1).toISOString();
        row.token_hash = "newer-hash";
      } else row.status = change;
      snapshot = { ...row };
    };
    const stale = await app.inject({ method: "POST", url: `/v1/workspaces/${WORKSPACE}/invitations`, headers: auth, payload });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(store.tables.workspace_invitations[0], snapshot);
    assert.equal("acceptanceUrl" in stale.json(), false);
    await app.close();
  }
});
