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

type Asset = { id: string; workspace_id: string; deleted_at: string | null; status: string };

async function fixture(initial: Asset, beforeWrite?: (row: Asset) => void, role = "editor") {
  const row = { ...initial };
  const events: string[] = [];
  let updateCount = 0;
  const factory = () => ({
    auth: { getUser: async () => ({ data: { user: { id: "author" } }, error: null }) },
    from(table: string) {
      const predicates: ((asset: Asset) => boolean)[] = [];
      let update: Partial<Asset> | undefined;
      const builder = {
        select: () => builder,
        eq: (key: keyof Asset, value: unknown) => { predicates.push(asset => asset[key] === value); return builder; },
        is: (key: keyof Asset, value: unknown) => { predicates.push(asset => asset[key] === value); return builder; },
        update: (value: Partial<Asset>) => { update = value; return builder; },
        insert: async (value: { event_type: string }) => { events.push(value.event_type); return { error: null }; },
        maybeSingle: async () => {
          if (table === "workspace_members") return { data: { role }, error: null };
          if (table !== "assets") return { data: null, error: null };
          if (update) { updateCount++; beforeWrite?.(row); }
          if (!predicates.every(predicate => predicate(row))) return { data: null, error: null };
          if (update) Object.assign(row, update);
          return { data: { ...row }, error: null };
        },
      };
      return builder;
    },
  });
  const app = await buildApp(factory as never);
  return { app, row, events, getUpdates: () => updateCount };
}

const live: Asset = { id: "asset", workspace_id: "workspace", deleted_at: null, status: "draft" };
const auth = { authorization: "Bearer good" };

test("asset removal updates only the observed live row and records one event", async () => {
  const f = await fixture(live);
  try {
    const response = await f.app.inject({ method: "DELETE", url: "/v1/assets/asset", headers: auth });
    assert.equal(response.statusCode, 200);
    assert.equal(f.row.status, "archived");
    assert.ok(f.row.deleted_at);
    assert.deepEqual(f.events, ["asset_deleted"]);
  } finally { await f.app.close(); }
});

test("concurrent removal does not overwrite or log the other removal", async () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const f = await fixture(live, row => { row.deleted_at = timestamp; row.status = "archived"; });
  try {
    const response = await f.app.inject({ method: "DELETE", url: "/v1/assets/asset", headers: auth });
    assert.equal(response.statusCode, 409);
    assert.equal(f.row.deleted_at, timestamp);
    assert.deepEqual(f.events, []);
  } finally { await f.app.close(); }
});

test("a concurrent approval is not silently overwritten by removal", async () => {
  const f = await fixture(live, row => { row.status = "approved"; });
  try {
    const response = await f.app.inject({ method: "DELETE", url: "/v1/assets/asset", headers: auth });
    assert.equal(response.statusCode, 409);
    assert.equal(f.row.status, "approved");
    assert.equal(f.row.deleted_at, null);
    assert.deepEqual(f.events, []);
  } finally { await f.app.close(); }
});

test("restore does not overwrite a later removal or an asset moved across workspaces", async () => {
  for (const mutate of [
    (row: Asset) => { row.deleted_at = "2026-01-02T00:00:00.000Z"; },
    (row: Asset) => { row.workspace_id = "other"; },
  ]) {
    const f = await fixture({ ...live, status: "archived", deleted_at: "2026-01-01T00:00:00.000Z" }, mutate);
    try {
      const response = await f.app.inject({ method: "POST", url: "/v1/assets/asset/restore", headers: auth });
      assert.equal(response.statusCode, 409);
      assert.equal(f.row.status, "archived");
      assert.deepEqual(f.events, []);
    } finally { await f.app.close(); }
  }
});

test("viewer cannot issue a privileged asset removal", async () => {
  const f = await fixture(live, undefined, "viewer");
  try {
    const response = await f.app.inject({ method: "DELETE", url: "/v1/assets/asset", headers: auth });
    assert.equal(response.statusCode, 403);
    assert.equal(f.getUpdates(), 0);
    assert.deepEqual(f.events, []);
  } finally { await f.app.close(); }
});
