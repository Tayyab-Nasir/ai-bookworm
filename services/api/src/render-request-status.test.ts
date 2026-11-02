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

const actor = "a0000000-0000-4000-8000-000000000001";
const other = "a0000000-0000-4000-8000-000000000002";
const book = "b0000000-0000-4000-8000-000000000001";
const workspace = "c0000000-0000-4000-8000-000000000001";
const edition = "d0000000-0000-4000-8000-000000000001";
const request = "e0000000-0000-4000-8000-000000000001";
const jobId = "f0000000-0000-4000-8000-000000000001";
type Row = Record<string, unknown>;
async function setup(job: Row | null, role = "viewer") {
  const tables: Record<string, Row[]> = {
    books: [{ id: book, workspace_id: workspace }],
    editions: [{ id: edition, book_id: book }],
    workspace_members: role ? [{ workspace_id: workspace, user_id: actor, role, status: "active" }] : [],
    publishing_jobs: job ? [job] : [],
  };
  let writes = 0;
  const factory = () => ({
    auth: { getUser: async () => ({ data: { user: { id: actor } }, error: null }) },
    from(table: string) {
      const filters: [string, unknown][] = [];
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        maybeSingle: async () => ({ data: tables[table]?.find(row => filters.every(([key, value]) => row[key] === value)) ?? null, error: null }),
        update: () => { writes++; throw new Error("read-only route wrote"); },
        insert: () => { writes++; throw new Error("read-only route wrote"); },
      };
      return builder;
    },
  });
  const app = await buildApp(factory as never);
  return { app, writes: () => writes };
}
const row = (): Row => ({ id: jobId, book_id: book, edition_id: edition, created_by: actor, channel: "render",
  status: "succeeded", idempotency_key: request, request_json: { action: "render", privateContent: "never expose" }, response_json: { secret: true } });
const url = `/v1/editions/${edition}/render-requests/${request}?bookId=${book}`;

test("render request status is read-only, account scoped and omits private request content", async () => {
  const f = await setup(row());
  try {
    const response = await f.app.inject({ method: "GET", url, headers: { authorization: "Bearer good" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { bookId: book, editionId: edition, requestId: request, job: { id: jobId, status: "succeeded" } });
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(f.writes(), 0);
  } finally { await f.app.close(); }
});

test("missing and foreign actor requests remain unknown; no member is denied", async () => {
  for (const value of [null, { ...row(), created_by: other }]) {
    const f = await setup(value);
    try {
      const response = await f.app.inject({ method: "GET", url, headers: { authorization: "Bearer good" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().job, null);
      assert.equal(f.writes(), 0);
    } finally { await f.app.close(); }
  }
  const f = await setup(row(), "");
  try { assert.equal((await f.app.inject({ method: "GET", url, headers: { authorization: "Bearer good" } })).statusCode, 403); }
  finally { await f.app.close(); }
});

test("malformed identity or non-render job fails closed", async () => {
  const f = await setup({ ...row(), channel: "kdp" });
  try {
    assert.equal((await f.app.inject({ method: "GET", url, headers: { authorization: "Bearer good" } })).statusCode, 503);
    assert.equal((await f.app.inject({ method: "GET", url: `/v1/editions/${edition}/render-requests/nope?bookId=${book}`, headers: { authorization: "Bearer good" } })).statusCode, 422);
    assert.equal(f.writes(), 0);
  } finally { await f.app.close(); }
});

test("render POST rejects a changed actor before accessing the database", async () => {
  const f = await setup(null);
  try {
    const response = await f.app.inject({ method: "POST", url: `/v1/editions/${edition}/render`,
      headers: { authorization: "Bearer good", "x-bookworm-actor": other }, payload: { idempotencyKey: request } });
    assert.equal(response.statusCode, 409);
    assert.equal(f.writes(), 0);
  } finally { await f.app.close(); }
});
