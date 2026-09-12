import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    auth: { getUser: async (token: string) => token === "good"
      ? { data: { user: { id: "11111111-1111-1111-1111-111111111111" } }, error: null }
      : { data: { user: null }, error: { message: "bad" } } },
    from(table: string) {
      let filters: ((row: Row) => boolean)[] = [];
      let head = false; let exactCount = false; let limit = Number.POSITIVE_INFINITY;
      let orderColumn: string | null = null; let ascending = true;
      const apply = () => {
        let rows = [...(tables[table] ?? [])].filter((row) => filters.every((filter) => filter(row)));
        if (orderColumn) rows.sort((a, b) => String(a[orderColumn!]).localeCompare(String(b[orderColumn!])) * (ascending ? 1 : -1));
        return rows.slice(0, limit);
      };
      const result = () => { const rows = apply(); return { data: head ? null : rows, error: null, count: exactCount ? rows.length : null }; };
      const builder: Record<string, unknown> = {};
      builder.select = (_columns?: string, options?: { head?: boolean; count?: string }) => { head = options?.head === true; exactCount = options?.count === "exact"; return builder; };
      builder.eq = (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; };
      builder.in = (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return builder; };
      builder.is = (column: string, value: unknown) => { filters.push((row) => row[column] === value || (value === null && row[column] === undefined)); return builder; };
      builder.contains = (column: string, value: Row) => { filters.push((row) => { const actual = row[column] as Row | undefined; return actual ? Object.entries(value).every(([key, item]) => actual[key] === item) : false; }); return builder; };
      builder.gte = () => builder;
      builder.order = (column: string, options?: { ascending?: boolean }) => { if (!orderColumn) { orderColumn = column; ascending = options?.ascending ?? true; } return builder; };
      builder.limit = (value: number) => { limit = value; return builder; };
      builder.maybeSingle = async () => { const rows = apply(); return { data: rows[0] ?? null, error: null }; };
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result());
      return builder;
    },
  } as never;
}

const workspaceId = "22222222-2222-2222-2222-222222222222";
const organizationId = "33333333-3333-3333-3333-333333333333";
const bookOne = "44444444-4444-4444-4444-444444444444";
const bookTwo = "55555555-5555-5555-5555-555555555555";
const now = new Date().toISOString();

function dashboardTables(member = true): Record<string, Row[]> {
  return {
    workspace_members: member ? [{ workspace_id: workspaceId, user_id: "11111111-1111-1111-1111-111111111111", status: "active", role: "owner" }] : [],
    workspaces: [{ id: workspaceId, name: "Studio", organization_id: organizationId }],
    books: [
      { id: bookOne, workspace_id: workspaceId, title: "Draft book", author_name: "Author", language: "en", genre: null, subtitle: null, status: "draft", current_version_id: null, created_by: "user", created_at: now, updated_at: now },
      { id: bookTwo, workspace_id: workspaceId, title: "Live book", author_name: "Author", language: "en", genre: null, subtitle: null, status: "published", current_version_id: null, created_by: "user", created_at: now, updated_at: now },
    ],
    assets: [
      { id: "asset-1", workspace_id: workspaceId, type: "illustration", deleted_at: null },
      { id: "asset-2", workspace_id: workspaceId, type: "front_cover", deleted_at: null },
      { id: "asset-3", workspace_id: workspaceId, type: "manuscript", deleted_at: null },
      { id: "asset-deleted", workspace_id: workspaceId, type: "illustration", deleted_at: now },
    ],
    ai_jobs: [
      { id: "ai-1", workspace_id: workspaceId, book_id: bookOne, agent_type: "translator", status: "queued", created_at: now, completed_at: null, input_ref: { secret: "never-return" } },
      { id: "ai-2", workspace_id: workspaceId, book_id: bookOne, agent_type: "writer", status: "succeeded", created_at: now, completed_at: now },
      { id: "ai-3", workspace_id: workspaceId, book_id: bookOne, agent_type: "copyeditor", status: "failed", created_at: now, completed_at: now },
    ],
    publishing_jobs: [
      { id: "pub-1", book_id: bookTwo, channel: "kdp", status: "succeeded", request_json: { action: "export_package", private: "never-return" }, created_at: now, completed_at: now },
      { id: "pub-2", book_id: bookOne, channel: "export", status: "running", request_json: { action: "render" }, created_at: now, completed_at: null },
      { id: "pub-3", book_id: bookOne, channel: "kdp", status: "failed", request_json: { action: "preflight" }, created_at: now, completed_at: now },
    ],
    activity_events: [{ id: 1, workspace_id: workspaceId, actor_id: null, event_type: "publishing_package_created", entity_type: "edition", entity_id: null, payload_json: {}, created_at: now }],
    usage_events: [
      { organization_id: organizationId, meter: "ai_credits", quantity: 7, created_at: now },
      { organization_id: organizationId, meter: "translation_credits", quantity: 3, created_at: now },
    ],
    subscriptions: [],
    credit_ledger: [{ user_id: "11111111-1111-1111-1111-111111111111", balance_after: 42, created_at: now, id: 1 }],
  };
}

test("dashboard returns tenant-scoped operational truth without private job inputs or invented sales", async () => {
  const tables = dashboardTables();
  const app = await buildApp(() => fakeSupabase(tables));
  const response = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["cache-control"]), /private/);
  const body = response.json();
  assert.equal(body.workspace.role, "owner");
  assert.equal(body.books.length, 2);
  assert.deepEqual(body.summary, { activeBooks: 2, inProductionBooks: 1, publishedBooks: 1, assets: 3, visualAssets: 2, pendingJobs: 2, failedJobs: 2, readyPackages: 1 });
  assert.equal(body.usage.usage.ai_credits, 7);
  assert.equal(body.usage.usage.translation_credits, 3);
  assert.equal(body.usage.creditBalance, 42);
  assert.equal(body.sales.status, "not_connected");
  assert.equal(body.sales.units, null);
  assert.equal(body.sales.grossRevenueCents, null);
  assert.equal(body.recentJobs.some((job: Row) => job.label === "Translation"), true);
  assert.doesNotMatch(response.body, /never-return|input_ref|request_json/);
  await app.close();
});

test("dashboard denies a valid user outside the workspace before aggregation", async () => {
  const app = await buildApp(() => fakeSupabase(dashboardTables(false)));
  const response = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
  assert.equal(response.statusCode, 403);
  await app.close();
});
