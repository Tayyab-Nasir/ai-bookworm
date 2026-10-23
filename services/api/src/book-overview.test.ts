import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test"; process.env.LOG_LEVEL = "error";
const { buildApp } = await import("./app.js");
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const USER = id(1), BOOK = id(2), WORKSPACE = id(3), OTHER = id(4), CHAPTER = id(5), SECOND = id(6), VERSION = id(7), SECOND_VERSION = id(8);
const now = "2026-10-24T00:00:00.000Z";
type Row = Record<string, unknown>;
function tables(): Record<string, Row[]> {
  return {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "The Harbor Notebook", subtitle: null, author_name: "Synthetic Author", language: "en", genre: "Adventure", status: "draft", updated_at: now, private: "private-payload" }],
    workspace_members: [{ user_id: USER, workspace_id: WORKSPACE, role: "owner", status: "active" }],
    workspaces: [{ id: WORKSPACE, name: "Harbor Studio", private: "private-payload" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "The harbor", order_index: 0, current_document_version_id: VERSION },
      { id: SECOND, book_id: BOOK, title: "The departure", order_index: 1, current_document_version_id: SECOND_VERSION }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 2, word_count: 23, created_at: now, content_json: { private: "private-payload" } },
      { id: SECOND_VERSION, chapter_id: SECOND, version_number: 1, word_count: 11, created_at: now },
      { id: id(9), chapter_id: CHAPTER, version_number: 1, word_count: 99999, created_at: now }],
    book_bible_items: [{ id: id(10), book_id: BOOK, description: "private-payload" }, { id: id(11), book_id: OTHER }],
    book_metadata: [{ book_id: BOOK, description: "private-payload", keywords: ["harbor"], categories: ["Adventure"], isbn13: null }],
    editions: [{ id: id(12), book_id: BOOK, type: "print", status: "draft", updated_at: now,
      edition_metadata_json: { cover: { asset_id: id(13) }, private: "private-payload" } }],
    manuscript_import_jobs: [{ id: id(14), book_id: BOOK, status: "succeeded", created_at: now, completed_at: now, error_code: "private-payload" }],
    ai_jobs: [{ id: id(15), book_id: BOOK, workspace_id: WORKSPACE, agent_type: "writer", status: "failed", created_at: now, completed_at: now, input_ref: "private-payload" },
      { id: id(16), book_id: OTHER, workspace_id: WORKSPACE, agent_type: "writer", status: "queued", created_at: now, completed_at: null },
      { id: id(17), book_id: BOOK, workspace_id: OTHER, agent_type: "writer", status: "queued", created_at: now, completed_at: null }],
    publishing_jobs: [{ id: id(18), book_id: BOOK, channel: "render", status: "succeeded", created_at: now, completed_at: now, request_json: { action: "render", private: "private-payload" } },
      { id: id(19), book_id: BOOK, channel: "kdp", status: "succeeded", created_at: now, completed_at: now, request_json: { action: "export_package" } },
      { id: id(20), book_id: BOOK, channel: "render", status: "failed", created_at: now, completed_at: now, request_json: { action: "render" } },
      { id: id(21), book_id: OTHER, channel: "kdp", status: "succeeded", created_at: now, completed_at: now, request_json: { action: "export_package" } }],
  };
}
function fake(data: Record<string, Row[]>, options: { error?: string; missingCount?: string } = {}, reads: { table: string; columns?: string }[] = []) {
  return {
    auth: { getUser: async (token: string) => ({ data: { user: token === "good" ? { id: USER } : null }, error: token === "good" ? null : {} }) },
    from(table: string) {
      const read = { table, columns: "" }; reads.push(read);
      const filters: ((r: Row) => boolean)[] = []; let take = Infinity, head = false, counted = false, order = "", ascending = true;
      const result = () => {
        let rows = (data[table] ?? []).filter(r => filters.every(f => f(r)));
        const total = rows.length;
        if (order) rows = [...rows].sort((a, b) => (a[order]! < b[order]! ? -1 : a[order]! > b[order]! ? 1 : 0) * (ascending ? 1 : -1));
        return { data: options.error === table ? null : head ? null : rows.slice(0, take).map(r => ({ ...r, ...(table === "publishing_jobs" ? { action: (r.request_json as Row)?.action } : {}) })),
          error: options.error === table ? { message: "private-payload" } : null,
          count: counted && options.missingCount !== table ? total : null };
      };
      const query = {
        select(columns: string, opts?: { count?: string; head?: boolean }) { read.columns = columns; counted = opts?.count === "exact"; head = opts?.head === true; return query; },
        eq(k: string, value: unknown) { filters.push(r => r[k] === value); return query; },
        in(k: string, values: unknown[]) { filters.push(r => values.includes(r[k])); return query; },
        contains(k: string, value: Row) { filters.push(r => Object.entries(value).every(([key, item]) => (r[k] as Row)?.[key] === item)); return query; },
        order(k: string, options?: { ascending?: boolean }) { order = k; ascending = options?.ascending ?? true; return query; },
        limit(n: number) { take = n; return query; },
        maybeSingle: async () => { const value = result(); return { ...value, data: value.data?.[0] ?? null }; },
        then(resolve: (v: unknown) => unknown) { return resolve(result()); },
      };
      return query;
    },
  } as never;
}
async function request(data = tables(), options: { error?: string; missingCount?: string } = {}, token = "good", book = BOOK) {
  const reads: { table: string; columns?: string }[] = [], tokens: (string | undefined)[] = [];
  const app = await buildApp(t => { tokens.push(t); return fake(data, options, reads); });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/books/${book}/overview`, headers: { authorization: `Bearer ${token}` } });
    return { response, reads, tokens };
  } finally { await app.close(); }
}

test("book overview returns current saved pointers, scoped history and safe read-only summaries", async () => {
  const { response, reads, tokens } = await request();
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "private, no-store");
  const value = response.json();
  assert.equal(value.viewerId, USER); assert.equal(value.workspace.id, WORKSPACE);
  assert.deepEqual(value.manuscript, { chapterCount: 2, wordCount: 34, chaptersWithoutSavedVersion: 0 });
  assert.equal(value.bibleItems, 1); assert.deepEqual(value.history, { renders: 1, packages: 1 });
  assert.deepEqual(value.listing, { description: true, keywords: 1, categories: 1, isbn: false });
  assert.equal(value.editions[0].coverArtworkChosen, true); assert.equal(value.jobs.length, 5);
  assert.doesNotMatch(response.body, /private-payload|request_json|input_ref|content_json|error_code|storage_path|signedUrl|service_role/);
  assert(tokens.length > 0 && tokens.every(t => t === "good"), "Only caller-scoped clients may be created");
  assert(reads.filter(r => r.table === "document_versions").every(r => r.columns === "id,chapter_id,version_number,word_count,created_at"));
});
test("book desk includes only this book's audiobook exports and routes actual Bible and planning agents correctly", async () => {
  const rows = tables();
  rows.audiobook_google_play_export_jobs = [
    { id: id(90), workspace_id: WORKSPACE, book_id: BOOK, status: "queued", created_at: now, completed_at: null, snapshot_json: "private-payload" },
    { id: id(91), workspace_id: OTHER, book_id: OTHER, status: "running", created_at: now, completed_at: null },
  ];
  rows.ai_jobs = ["bookbible", "story_blueprint", "illustrator"].map((agent_type, i) => ({ id: id(92 + i), workspace_id: WORKSPACE, book_id: BOOK, agent_type, status: "queued", created_at: now, completed_at: null }));
  const { response } = await request(rows); assert.equal(response.statusCode, 200);
  const jobs = response.json().jobs;
  assert.equal(jobs.find((job: Row) => job.id === id(90)).kind, "audiobook_export");
  assert.equal(jobs.find((job: Row) => job.id === id(92)).destination, "memory");
  assert.equal(jobs.find((job: Row) => job.id === id(93)).destination, "plan");
  assert.equal(jobs.find((job: Row) => job.id === id(94)).destination, "assets");
  assert(!jobs.some((job: Row) => job.id === id(91))); assert.doesNotMatch(response.body, /private-payload|snapshot_json/);
});

test("empty books show actual zeroes without pretending an unsaved chapter is a version", async () => {
  const rows = tables(); rows.chapters = []; rows.document_versions = []; rows.book_metadata = []; rows.editions = [];
  const { response, reads } = await request(rows);
  assert.equal(response.statusCode, 200);
  const value = response.json();
  assert.deepEqual(value.manuscript, { chapterCount: 0, wordCount: 0, chaptersWithoutSavedVersion: 0 });
  assert.equal(value.listing.description, false); assert.equal(value.editionsTotal, 0);
  assert(!reads.some(r => r.table === "document_versions"));
});
test("a chapter without a saved pointer remains visibly unsaved", async () => {
  const rows = tables(); rows.chapters[0].current_document_version_id = null;
  const { response } = await request(rows); assert.equal(response.statusCode, 200);
  const value = response.json();
  assert.equal(value.manuscript.chaptersWithoutSavedVersion, 1); assert.equal(value.manuscript.wordCount, 11);
  assert.equal(value.chapters[0].versionNumber, null);
});
test("viewers may read the book desk without obtaining edit privileges", async () => {
  const rows = tables(); rows.workspace_members[0].role = "viewer";
  const { response } = await request(rows); assert.equal(response.statusCode, 200);
  assert.equal(response.json().workspace.role, "viewer");
});
test("nonmembers and revoked members are refused before any aggregation", async () => {
  for (const status of ["missing", "revoked"]) {
    const rows = tables(); if (status === "missing") rows.workspace_members = []; else rows.workspace_members[0].status = "revoked";
    const { response, reads } = await request(rows); assert.equal(response.statusCode, 403);
    assert(reads.every(r => ["books", "workspace_members"].includes(r.table)));
  }
});
test("invalid identity or book ID cannot start book aggregation", async () => {
  const auth = await request(tables(), {}, "bad"); assert.equal(auth.response.statusCode, 401); assert.equal(auth.reads.length, 0);
  const invalid = await request(tables(), {}, "good", "not-a-uuid"); assert.equal(invalid.response.statusCode, 422); assert.equal(invalid.reads.length, 0);
  const absent = await request(tables(), {}, "good", OTHER); assert.equal(absent.response.statusCode, 404);
});
test("database and exact-count failures are unavailable, never misleading zeroes", async () => {
  for (const table of ["workspaces", "chapters", "book_metadata", "book_bible_items", "editions", "manuscript_import_jobs", "ai_jobs", "publishing_jobs", "audiobook_google_play_export_jobs", "document_versions"]) {
    const { response } = await request(tables(), { error: table }); assert.equal(response.statusCode, 503, table);
    assert.doesNotMatch(response.body, /private-payload/);
  }
  for (const table of ["book_bible_items", "editions", "publishing_jobs"]) {
    const { response } = await request(tables(), { missingCount: table }); assert.equal(response.statusCode, 503, table);
  }
});
test("missing, foreign or malformed current-version metadata is refused", async () => {
  for (const problem of ["missing", "foreign", "negative", "duplicate"]) {
    const rows = tables();
    if (problem === "missing") rows.document_versions = [];
    if (problem === "foreign") rows.document_versions[0].chapter_id = OTHER;
    if (problem === "negative") rows.document_versions[0].word_count = -1;
    if (problem === "duplicate") rows.chapters[1].current_document_version_id = VERSION;
    const { response } = await request(rows); assert.equal(response.statusCode, 503, problem);
  }
});
test("all supported chapters are bounded without silently dropping an oversized book", async () => {
  const rows = tables(); rows.chapters = Array.from({ length: 501 }, (_, n) => ({ id: id(100 + n), book_id: BOOK, title: `Chapter ${n}`, order_index: n, current_document_version_id: null }));
  const { response } = await request(rows); assert.equal(response.statusCode, 503);
});
test("edition lists retain the exact total when their visible sample is bounded", async () => {
  const rows = tables(); rows.editions = Array.from({ length: 15 }, (_, n) => ({ ...rows.editions[0], id: id(100 + n) }));
  const { response } = await request(rows); assert.equal(response.statusCode, 200);
  const value = response.json(); assert.equal(value.editions.length, 12); assert.equal(value.editionsTotal, 15);
});
