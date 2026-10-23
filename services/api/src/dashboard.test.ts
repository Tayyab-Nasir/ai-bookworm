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
const { jobSummary } = await import("./lib/job-summary.js");

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>, rpcHandler?: (name: string, args: Record<string, unknown>) => { data: unknown; error: null | { code?: string } }, tableErrors?: Record<string, { code?: string }>, options: { missingCount?: string; denyJobs?: boolean; reads?: { table: string; columns?: string }[] } = {}) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (rpcHandler) return rpcHandler(name, args);
      if (name === "retailer_sales_analytics") return { data: null, error: { code: "PGRST202" } };
      assert.equal(name, "retailer_sales_summary");
      return { data: { status: "not_connected", imports: 0, latestImportedAt: null, units: null, reportedProceedsCents: null, royaltyCents: null, currency: null, currencies: [] }, error: null };
    },
    auth: { getUser: async (token: string) => token === "good"
      ? { data: { user: { id: "11111111-1111-1111-1111-111111111111" } }, error: null }
      : { data: { user: null }, error: { message: "bad" } } },
    from(table: string) {
      if (options.denyJobs) assert(!table.endsWith("_jobs"), "Service role must not read execution jobs");
      let filters: ((row: Row) => boolean)[] = [];
      let head = false; let exactCount = false; let limit = Number.POSITIVE_INFINITY;
      let columns = ""; const orders: { column: string; ascending: boolean }[] = [];
      const apply = () => {
        let rows = [...(tables[table] ?? [])].filter((row) => filters.every((filter) => filter(row)));
        rows.sort((a, b) => { for (const order of orders) { const value = String(a[order.column]).localeCompare(String(b[order.column])) * (order.ascending ? 1 : -1); if (value) return value; } return 0; });
        return rows.slice(0, limit);
      };
      const result = () => { const rows = apply().map(row => ({ ...row, ...(columns.includes("action:request_json->>action") ? { action: (row.request_json as Row)?.action ?? null } : {}) })); const error = tableErrors?.[table] ?? null; return { data: error ? null : head ? null : rows, error, count: error || options.missingCount === table ? null : exactCount ? rows.length : null }; };
      const builder: Record<string, unknown> = {};
      builder.select = (selected?: string, config?: { head?: boolean; count?: string }) => { columns = selected ?? ""; options.reads?.push({ table, columns }); head = config?.head === true; exactCount = config?.count === "exact"; return builder; };
      builder.eq = (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; };
      builder.in = (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return builder; };
      builder.is = (column: string, value: unknown) => { filters.push((row) => row[column] === value || (value === null && row[column] === undefined)); return builder; };
      builder.contains = (column: string, value: Row) => { filters.push((row) => { const actual = row[column] as Row | undefined; return actual ? Object.entries(value).every(([key, item]) => actual[key] === item) : false; }); return builder; };
      builder.gte = () => builder;
      builder.order = (column: string, options?: { ascending?: boolean }) => { orders.push({ column, ascending: options?.ascending ?? true }); return builder; };
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
const jobId = (n: number) => `${String(n).padStart(8, "0")}-6666-4666-8666-666666666666`;

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
      { id: jobId(1), workspace_id: workspaceId, book_id: bookOne, agent_type: "translator", status: "queued", created_at: now, completed_at: null, input_ref: { secret: "never-return" } },
      { id: jobId(2), workspace_id: workspaceId, book_id: bookOne, agent_type: "writer", status: "succeeded", created_at: now, completed_at: now },
      { id: jobId(3), workspace_id: workspaceId, book_id: bookOne, agent_type: "copyeditor", status: "failed", created_at: now, completed_at: now },
    ],
    publishing_jobs: [
      { id: jobId(4), book_id: bookTwo, channel: "kdp", status: "succeeded", request_json: { action: "export_package", private: "never-return" }, created_at: now, completed_at: now },
      { id: jobId(5), book_id: bookOne, channel: "export", status: "running", request_json: { action: "render" }, created_at: now, completed_at: null },
      { id: jobId(6), book_id: bookOne, channel: "kdp", status: "failed", request_json: { action: "preflight" }, created_at: now, completed_at: now },
      { id: jobId(7), book_id: bookOne, channel: "kdp", status: "succeeded", request_json: { action: "validate", private: "never-return" }, created_at: now, completed_at: now },
    ],
    manuscript_import_jobs: [
      { id: jobId(8), book_id: bookOne, status: "running", created_at: now, completed_at: null, source_checksum: "never-return" },
      { id: jobId(9), book_id: bookTwo, status: "failed", created_at: now, completed_at: now, error_code: "never-return" },
    ],
    audiobook_google_play_export_jobs: [
      { id: jobId(10), workspace_id: workspaceId, book_id: bookOne, status: "queued", created_at: now, completed_at: null, snapshot_json: "never-return" },
      { id: jobId(11), workspace_id: workspaceId, book_id: bookTwo, status: "failed", created_at: now, completed_at: now, output_storage_path: "never-return" },
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
  assert.deepEqual(body.summary, { activeBooks: 2, inProductionBooks: 1, publishedBooks: 1, assets: 3, visualAssets: 2, pendingJobs: 4, failedJobs: 4, readyPackages: 1 });
  assert.deepEqual(body.pipeline.map((queue: Row) => [queue.kind, queue.pending, queue.failed]), [["import", 1, 1], ["ai", 1, 1], ["publishing", 1, 1], ["audiobook_export", 1, 1]]);
  assert.equal(body.recentJobs.find((job: Row) => job.id === jobId(7)).label, "Channel preflight");
  assert.equal(body.recentJobs.find((job: Row) => job.id === jobId(6)).label, "Channel preflight");
  assert.equal(body.recentJobs.find((job: Row) => job.id === jobId(5)).label, "Edition render");
  assert.equal(body.recentJobs.find((job: Row) => job.id === jobId(10)).destination, "publish");
  assert.equal(body.usage.usage.ai_credits, 7);
  assert.equal(body.usage.usage.translation_credits, 3);
  assert.equal(body.usage.creditBalance, 42);
  assert.equal(body.sales.status, "not_connected");
  assert.equal(body.sales.units, null);
  assert.equal(body.sales.reportedProceedsCents, null);
  assert.equal(body.recentJobs.some((job: Row) => job.label === "Translation"), true);
  assert.doesNotMatch(response.body, /never-return|input_ref|request_json|snapshot_json|storage_path|source_checksum|error_code/);
  await app.close();
});

test("dashboard denies a valid user outside the workspace before aggregation", async () => {
  const app = await buildApp(() => fakeSupabase(dashboardTables(false)));
  const response = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
  assert.equal(response.statusCode, 403);
  await app.close();
});

test("dashboard reads every execution queue only through the caller and projects only safe columns", async () => {
  const reads: { table: string; columns?: string }[] = [];
  const app = await buildApp(token => {
    return fakeSupabase(dashboardTables(), undefined, undefined, { reads: token ? reads : undefined, denyJobs: !token });
  });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
    assert.equal(response.statusCode, 200, response.body);
    for (const table of ["manuscript_import_jobs", "ai_jobs", "publishing_jobs", "audiobook_google_play_export_jobs"]) {
      const queue = reads.filter(read => read.table === table); assert(queue.length >= 3);
      assert(queue.every(read => !/\*|input_ref|output_ref|snapshot_json|error_|storage_path/.test(read.columns ?? "")));
    }
    assert(reads.some(read => read.table === "publishing_jobs" && read.columns?.includes("action:request_json->>action")));
  } finally { await app.close(); }
});

test("dashboard excludes jobs from another workspace or book even when the caller can read both", async () => {
  const rows = dashboardTables(), foreignBook = "77777777-7777-4777-8777-777777777777";
  for (const table of ["manuscript_import_jobs", "publishing_jobs", "ai_jobs", "audiobook_google_play_export_jobs"]) {
    rows[table].push({ ...rows[table][0], id: jobId(99), book_id: foreignBook, workspace_id: foreignBook });
  }
  const app = await buildApp(() => fakeSupabase(rows));
  try {
    const result = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
    assert.equal(result.statusCode, 200, result.body); const body = result.json();
    assert.equal(body.summary.pendingJobs, 4); assert.equal(body.summary.failedJobs, 4);
    assert(!body.recentJobs.some((job: Row) => job.id === jobId(99)));
  } finally { await app.close(); }
});

test("empty workspace still exposes workspace-only AI jobs without querying an empty book scope", async () => {
  const rows = dashboardTables(); rows.books = []; rows.ai_jobs = [{ ...rows.ai_jobs[0], book_id: null, agent_type: "illustrator" }];
  const reads: { table: string; columns?: string }[] = [];
  const app = await buildApp(() => fakeSupabase(rows, undefined, undefined, { reads }));
  try {
    const result = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
    assert.equal(result.statusCode, 200, result.body); const body = result.json();
    assert.equal(body.summary.pendingJobs, 1); assert.equal(body.recentJobs[0].destination, "assets");
    assert.equal(body.recentJobs[0].bookId, null); assert.equal(body.summary.readyPackages, 0);
    assert(!reads.some(read => ["manuscript_import_jobs", "publishing_jobs", "audiobook_google_play_export_jobs"].includes(read.table)));
  } finally { await app.close(); }
});

test("queue totals are exact across history while recent execution jobs stay bounded and deterministically ordered", async () => {
  const rows = dashboardTables(); rows.ai_jobs = Array.from({ length: 30 }, (_, i) => ({ ...rows.ai_jobs[0], id: jobId(100 + i) }));
  const app = await buildApp(() => fakeSupabase(rows));
  try {
    const result = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
    assert.equal(result.statusCode, 200, result.body); const body = result.json();
    assert.equal(body.summary.pendingJobs, 33); assert.equal(body.pipeline.find((queue: Row) => queue.kind === "ai").pending, 30);
    assert.equal(body.recentJobs.length, 12); assert.equal(body.recentJobs[0].id, jobId(129));
    assert.equal(body.recentJobs[11].id, jobId(118));
  } finally { await app.close(); }
});

test("missing or failed queue/count reads never become a false zero dashboard", async () => {
  for (const table of ["books", "assets", "ai_jobs", "publishing_jobs", "manuscript_import_jobs", "audiobook_google_play_export_jobs"]) {
    for (const missing of [false, true]) {
      const app = await buildApp(() => fakeSupabase(dashboardTables(), undefined, missing ? undefined : { [table]: { code: "PGRST205" } }, missing ? { missingCount: table } : {}));
      try {
        const response = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
        assert.equal(response.statusCode, 503, `${table}: ${response.body}`);
        assert.equal(response.headers["cache-control"], "private, no-store"); assert(!("summary" in response.json()));
      } finally { await app.close(); }
    }
  }
});

test("invalid job timestamps or statuses fail closed without returning raw private values", async () => {
  for (const field of ["created_at", "status"]) {
    const rows = dashboardTables(); rows.manuscript_import_jobs[0][field] = "never-return";
    const app = await buildApp(() => fakeSupabase(rows));
    try {
      const response = await app.inject({ method: "GET", url: `/v1/dashboard?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
      assert.equal(response.statusCode, 503); assert.doesNotMatch(response.body, /never-return/);
    } finally { await app.close(); }
  }
});

test("shared job labels cover the actual worker agent names without inventing a render for an unknown action", () => {
  assert.deepEqual(jobSummary("ai", { agent_type: "bookbible" }), { label: "Book Bible extraction", destination: "memory" });
  assert.deepEqual(jobSummary("ai", { agent_type: "story_blueprint" }), { label: "Story Blueprint proposal", destination: "plan" });
  assert.deepEqual(jobSummary("ai", { agent_type: "unknown-private-value" }), { label: "AI task", destination: "overview" });
  assert.deepEqual(jobSummary("publishing", { action: "unknown-private-value" }), { label: "Publishing task", destination: "publish" });
  for (const key of ["__proto__", "constructor", "toString"]) {
    assert.deepEqual(jobSummary("ai", { agent_type: key }), { label: "AI task", destination: "overview" });
    assert.deepEqual(jobSummary("publishing", { action: key }), { label: "Publishing task", destination: "publish" });
  }
});

test("retailer import normalizes rows and lets the database derive durable report identity", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const app = await buildApp(() => fakeSupabase(dashboardTables(), (name, args) => {
    calls.push({ name, args });
    if (name === "import_retailer_sales") return { data: [{ import_id: "66666666-6666-6666-6666-666666666666", row_count: 1, duplicate: false }], error: null };
    return { data: { status: "not_connected", imports: 0, latestImportedAt: null, units: null, reportedProceedsCents: null, royaltyCents: null, currency: null, currencies: [] }, error: null };
  }));
  const response = await app.inject({ method: "POST", url: "/v1/sales/imports", headers: { authorization: "Bearer good" }, payload: {
    workspaceId, source: "amazon_kdp", fileName: "september.csv", rows: [{ soldOn: "2026-09-01", title: "Draft book", units: 2, royaltyCents: 697, currency: "usd" }],
  } });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), { importId: "66666666-6666-6666-6666-666666666666", rowCount: 1, duplicate: false });
  assert.equal(calls[0]?.name, "import_retailer_sales");
  assert.equal(calls[0]?.args.p_content_sha256, undefined);
  assert.deepEqual(calls[0]?.args.p_rows, [{ bookId: null, soldOn: "2026-09-01", title: "Draft book", externalId: null, marketplace: null, format: null, units: 2, reportedProceedsCents: null, royaltyCents: 697, currency: "USD" }]);
  await app.close();
});

test("retailer import rejects impossible ISO calendar dates before calling the write RPC", async () => {
  let called = false;
  const app = await buildApp(() => fakeSupabase(dashboardTables(), () => { called = true; return { data: null, error: null }; }));
  const response = await app.inject({ method: "POST", url: "/v1/sales/imports", headers: { authorization: "Bearer good" }, payload: {
    workspaceId, source: "amazon_kdp", fileName: "impossible-date.csv", rows: [{ soldOn: "2026-02-30", title: "Book", units: 1, royaltyCents: 1, currency: "USD" }],
  } });
  assert.equal(response.statusCode, 422);
  assert.equal(called, false);
  await app.close();
});

test("retailer import cannot confirm a receipt for a different row count", async () => {
  const app = await buildApp(() => fakeSupabase(dashboardTables(), () => ({
    data: [{ import_id: "66666666-6666-6666-6666-666666666666", row_count: 99, duplicate: false }], error: null,
  })));
  try {
    const result = await app.inject({ method: "POST", url: "/v1/sales/imports", headers: { authorization: "Bearer good" }, payload: {
      workspaceId, source: "other", fileName: "report.csv", rows: [{ soldOn: "2026-09-01", title: "Book", units: 1, royaltyCents: 1, currency: "USD" }],
    } });
    assert.equal(result.statusCode, 503, result.body);
    assert.match(result.body, /Refresh reports or retry the same file/i);
    assert.equal(result.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});

test("sales history returns an explicit unavailable read model before its migration is installed", async () => {
  const app = await buildApp(() => fakeSupabase(dashboardTables(), undefined, { retailer_sales_imports: { code: "PGRST205" } }));
  const response = await app.inject({ method: "GET", url: `/v1/sales/imports?workspaceId=${workspaceId}`, headers: { authorization: "Bearer good" } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["cache-control"]), /private/);
  assert.deepEqual(response.json().imports, []);
  assert.equal(response.json().summary.available, false);
  assert.match(response.json().summary.message, /not installed/i);
  assert.equal(response.json().analytics.available, false);
  assert.equal(response.json().analytics.windowStart, null);
  await app.close();
});

test("retailer import rejects viewer roles before the write RPC", async () => {
  const tables = dashboardTables();
  tables.workspace_members[0].role = "viewer";
  let called = false;
  const app = await buildApp(() => fakeSupabase(tables, () => { called = true; return { data: null, error: null }; }));
  const response = await app.inject({ method: "POST", url: "/v1/sales/imports", headers: { authorization: "Bearer good" }, payload: {
    workspaceId, source: "other", fileName: "report.csv", rows: [{ soldOn: "2026-09-01", title: "Book", units: 1, royaltyCents: 1, currency: "USD" }],
  } });
  assert.equal(response.statusCode, 403);
  assert.equal(called, false);
  await app.close();
});
