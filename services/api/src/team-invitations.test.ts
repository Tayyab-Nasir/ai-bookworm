import { test } from "node:test";
import assert from "node:assert/strict";

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
