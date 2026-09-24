import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { bookMemoryRoutes } from "./routes/book-memory.js";
import { metadataGenerationRoutes } from "./routes/metadata-generation.js";

const BOOK = "11111111-1111-4111-8111-111111111111";
const OTHER_BOOK = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CHAPTER = "44444444-4444-4444-8444-444444444444";
const IMAGE = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const USER = "77777777-7777-4777-8777-777777777777";
const TIME = "2026-08-31T08:00:00.000Z";
const SOURCE_TEXT = "Elara carries a silver compass.";
const SOURCE_HASH = createHash("sha256").update(SOURCE_TEXT).digest("hex");
const auth = { authorization: "Bearer good" };
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

// Stateful query fake checks route filters and mutations, but intentionally
// does not simulate RLS. Database policy tests are a separate acceptance gate.
function fakeSupabase(store: Store, failTable?: string) {
  return {
    auth: { getUser: async (token: string) => ({ data: { user: token === "good" ? { id: USER } : null }, error: null }) },
    from(table: string) {
      const rows = store[table] ??= [];
      const filters: ((row: Row) => boolean)[] = [];
      let operation = "read";
      let payload: Row = {};
      let ascending = true;
      let orderColumn: string | null = null;
      let rowLimit = Infinity;
      let result: { data: Row[] | null; error: unknown } | undefined;
      const run = () => {
        if (result) return result;
        if (table === failTable) return result = { data: null, error: { message: "deliberate database failure" } };
        let found = rows.filter((row) => filters.every((filter) => filter(row)));
        if (operation === "insert") {
          if (table === "book_metadata" && rows.some((row) => row.book_id === payload.book_id)) return result = { data: null, error: { code: "23505" } };
          const row = { id: randomUUID(), created_at: TIME, updated_at: TIME, ...payload };
          rows.push(row); found = [row];
        }
        if (operation === "update") found.forEach((row) => Object.assign(row, payload));
        if (operation === "delete") found.forEach((row) => rows.splice(rows.indexOf(row), 1));
        if (orderColumn) found.sort((a, b) => String(a[orderColumn!]).localeCompare(String(b[orderColumn!])) * (ascending ? 1 : -1));
        return result = { data: found.slice(0, rowLimit).map((row) => ({ ...row })), error: null };
      };
      const builder = {
        select() { return this; },
        limit(value: number) { rowLimit = value; return this; },
        eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return this; },
        is(column: string, value: unknown) { filters.push((row) => row[column] === value); return this; },
        in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return this; },
        order(column: string, options?: { ascending: boolean }) { orderColumn = column; ascending = options?.ascending ?? true; return this; },
        insert(value: Row) { operation = "insert"; payload = value; return this; },
        update(value: Row) { operation = "update"; payload = value; return this; },
        delete() { operation = "delete"; return this; },
        async maybeSingle() { const value = run(); return { ...value, data: value.data?.[0] ?? null }; },
        async single() { return this.maybeSingle(); },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
      };
      return builder;
    },
  } as never;
}

function initialStore(role = "editor"): Store {
  return {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "The Long Way Home", author_name: "Ada", updated_at: TIME }],
    workspace_members: [{ user_id: USER, workspace_id: WORKSPACE, role, status: "active" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "Arrival", current_document_version_id: VERSION }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, content_json: { nodes: [{ id: "n1", type: "paragraph", text: SOURCE_TEXT }] } }],
    assets: [{ id: IMAGE, workspace_id: WORKSPACE, name: "Elara.png", mime_type: "image/png", checksum: "a".repeat(64), storage_path: "private/image.png", size_bytes: 100, deleted_at: null }],
    asset_versions: [{ asset_id: IMAGE, mime_type: "image/png", checksum: "a".repeat(64), storage_path: "private/image.png", size_bytes: 100, scan_status: "clean" }],
  };
}

async function appWith(store: Store, failTable?: string) {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(() => fakeSupabase(store, failTable)));
  await app.register(async (v1) => bookMemoryRoutes(v1), { prefix: "/v1" });
  await app.register(async (v1) => metadataGenerationRoutes(v1, { fetcher: async () => { throw new Error("History must never call an AI provider"); } }), { prefix: "/v1" });
  return app;
}

const entry = { type: "character", name: "Elara", description: "A mapmaker", attributes: { appearance: "Silver hair" }, imageAssetIds: [IMAGE], sourceRefs: [{ chapterId: CHAPTER, documentVersionId: VERSION, note: "Opening scene" }] };

test("saved metadata drafts recover across fresh app instances without leaking job inputs", async (t) => {
  const store = initialStore();
  const candidate = { suggestionKind: "metadata_candidate", description: "A mapmaker discovers a hidden world beyond the familiar shore.",
    keywords: ["fantasy"], categories: ["Fiction"], audience: "Adults", rationale: "Based on the opening scene", confidence: 0.8,
    sourceRefs: [{ chapterId: CHAPTER, nodeId: "p1" }], status: "pending" };
  const job = { id: randomUUID(), book_id: BOOK, agent_type: "metadata", status: "succeeded", created_at: TIME,
    input_ref: { secret: "private instructions" }, idempotency_key: "private-key", output_ref: { candidate, diagnostics: "private diagnostics" } };
  store.ai_jobs = [job, { ...job, id: randomUUID(), book_id: OTHER_BOOK }, { ...job, id: randomUUID(), agent_type: "writer" },
    { ...job, id: randomUUID(), status: "running" }, { ...job, id: randomUUID(), output_ref: { candidate: {} } }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await appWith(store); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/metadata/drafts`, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(response.json(), { pending: [], drafts: [{ id: job.id, createdAt: TIME, candidate }] });
    assert.equal(response.body.includes("private"), false);
  }
  assert.equal(store.ai_jobs.length, 5);
});

test("metadata history requires authentication and membership and reports database failure", async (t) => {
  const store = initialStore(); store.workspace_members[0].status = "suspended";
  const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/metadata/drafts`;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url, headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${OTHER_BOOK}/metadata/drafts`, headers: auth })).statusCode, 404);
  const failing = await appWith(initialStore(), "ai_jobs"); t.after(() => failing.close());
  assert.equal((await failing.inject({ method: "GET", url, headers: auth })).statusCode, 500);
});

test("pending metadata status is scoped to this author and book without exposing inputs", async (t) => {
  const store = initialStore();
  const job = { id: randomUUID(), book_id: BOOK, agent_type: "metadata", status: "running", created_by: USER,
    created_at: TIME, input_ref: { secret: "private" }, idempotency_key: "private-key" };
  store.ai_jobs = [job, { ...job, id: randomUUID(), created_by: randomUUID() },
    { ...job, id: randomUUID(), book_id: OTHER_BOOK }, { ...job, id: randomUUID(), agent_type: "writer" },
    { ...job, id: randomUUID(), status: "failed" }];
  const app = await appWith(store); t.after(() => app.close());
  const read = () => app.inject({ method: "GET", url: `/v1/books/${BOOK}/metadata/drafts`, headers: auth });
  const response = await read();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { drafts: [], pending: [{ id: job.id, createdAt: TIME, status: "running" }] });
  assert.equal(response.body.includes("private"), false);
  job.status = "failed";
  assert.deepEqual((await read()).json().pending, []);
});

test("book memory requires authentication and active workspace membership", async (t) => {
  const store = initialStore(); store.workspace_members[0].status = "suspended";
  const app = await appWith(store); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${OTHER_BOOK}/memory`, headers: auth })).statusCode, 404);
});

test("created memory persists across requests and a fresh app instance", async (t) => {
  const store = initialStore();
  const app = await appWith(store); t.after(() => app.close());
  const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  assert.equal(created.statusCode, 201, created.body);
  const item = created.json().item;
  assert.equal(item.book_id, BOOK);
  assert.deepEqual(item.attributes_json, { appearance: "Silver hair", imageAssetIds: [IMAGE] });
  assert.deepEqual(item.source_refs_json, entry.sourceRefs);
  const reopened = await appWith(store); t.after(() => reopened.close());
  const loaded = await reopened.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
  assert.equal(loaded.statusCode, 200, loaded.body);
  assert.equal(loaded.json().items[0].id, item.id);
  assert.equal(loaded.json().canEdit, true);
});

test("existing AI candidate types, nested attributes and node references round-trip", async (t) => {
  const app = await appWith(initialStore()); t.after(() => app.close());
  const payload = { ...entry, type: "place", attributes: { palette: ["blue", "silver"], climate: { season: "winter" } }, sourceRefs: [{ chapterId: CHAPTER, nodeId: "n1", textHash: SOURCE_HASH }] };
  const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().item.source_refs_json, [{ ...payload.sourceRefs[0], documentVersionId: VERSION }]);
  assert.deepEqual(created.json().item.attributes_json.palette, ["blue", "silver"]);
});

test("node-level Bible evidence is pinned to a saved version and rejects invented or stale citations", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/bible`;
  const valid = { ...entry, sourceRefs: [{ chapterId: CHAPTER, nodeId: "n1" }] };
  const saved = await app.inject({ method: "POST", url, headers: auth, payload: valid });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.deepEqual(saved.json().item.source_refs_json, [{ chapterId: CHAPTER, nodeId: "n1", documentVersionId: VERSION, textHash: SOURCE_HASH }]);
  for (const sourceRefs of [
    [{ chapterId: CHAPTER, nodeId: "invented" }],
    [{ chapterId: CHAPTER, nodeId: "n1", textHash: "0".repeat(64) }],
    [{ chapterId: CHAPTER, textHash: SOURCE_HASH }],
    [{ chapterId: CHAPTER, documentVersionId: randomUUID(), nodeId: "n1" }],
  ]) {
    const rejected = await app.inject({ method: "POST", url, headers: auth, payload: { ...entry, sourceRefs } });
    assert.equal(rejected.statusCode, 422, rejected.body);
  }
  assert.equal(store.book_bible_items.length, 1);
  store.chapters[0].current_document_version_id = null;
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: valid })).statusCode, 422);
});

test("pinned Bible evidence remains editable after the current chapter version changes", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/bible`;
  const created = await app.inject({ method: "POST", url, headers: auth,
    payload: { ...entry, sourceRefs: [{ chapterId: CHAPTER, nodeId: "n1" }] } });
  assert.equal(created.statusCode, 201, created.body);
  const saved = created.json().item;
  store.chapters[0].current_document_version_id = randomUUID();
  const updated = await app.inject({ method: "PUT", url: `${url}/${saved.id}`, headers: auth,
    payload: { ...entry, name: "Elara the mapmaker", sourceRefs: saved.source_refs_json, expectedUpdatedAt: saved.updated_at } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().item.source_refs_json, saved.source_refs_json);
  const stale = await app.inject({ method: "PUT", url: `${url}/${saved.id}`, headers: auth,
    payload: { ...entry, sourceRefs: [{ ...saved.source_refs_json[0], textHash: "0".repeat(64) }], expectedUpdatedAt: updated.json().item.updated_at } });
  assert.equal(stale.statusCode, 422, stale.body);
  assert.equal(store.book_bible_items[0].name, "Elara the mapmaker");
});

test("viewer can read saved memory but cannot create, replace, delete or edit metadata", async (t) => {
  const store = initialStore("viewer"); const app = await appWith(store); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).json().canEdit, false);
  const calls = [
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, payload: entry },
    { method: "PUT" as const, url: `/v1/books/${BOOK}/bible/${IMAGE}`, payload: { ...entry, expectedUpdatedAt: TIME } },
    { method: "DELETE" as const, url: `/v1/books/${BOOK}/bible/${IMAGE}`, payload: { expectedUpdatedAt: TIME } },
    { method: "PUT" as const, url: `/v1/books/${BOOK}/metadata`, payload: { expectedUpdatedAt: null, description: "New description" } },
  ];
  for (const call of calls) assert.equal((await app.inject({ ...call, headers: auth })).statusCode, 403);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
  assert.equal(store.book_metadata?.length ?? 0, 0);
});

test("Bible rejects cross-workspace, incomplete and non-image references", async (t) => {
  for (const patch of [{ workspace_id: "foreign" }, { checksum: "pending" }, { mime_type: "application/pdf" }, { deleted_at: TIME }]) {
    const store = initialStore(); Object.assign(store.assets[0], patch);
    const app = await appWith(store); t.after(() => app.close());
    const res = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(store.book_bible_items?.length ?? 0, 0);
  }
});

test("Bible rejects foreign chapter and mismatched document-version citations", async (t) => {
  for (const table of ["chapters", "document_versions"]) {
    const store = initialStore();
    Object.assign(store[table][0], table === "chapters" ? { book_id: OTHER_BOOK } : { chapter_id: OTHER_BOOK });
    const app = await appWith(store); t.after(() => app.close());
    const res = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
    assert.equal(res.statusCode, 422, res.body);
  }
});

test("memory picker and writes reject quarantined or mismatched current image versions", async (t) => {
  for (const patch of [{ scan_status: "pending" }, { scan_status: "infected" }, { scan_status: "error" },
    { scan_status: null }, { checksum: "b".repeat(64) }, { storage_path: "private/old.png" },
    { size_bytes: 101 }, { mime_type: "image/jpeg" }, { asset_id: OTHER_BOOK }]) {
    const store = initialStore(); Object.assign(store.asset_versions[0], patch);
    const app = await appWith(store); t.after(() => app.close());
    const loaded = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
    assert.equal(loaded.statusCode, 200, loaded.body);
    assert.deepEqual(loaded.json().imageAssets, [], JSON.stringify(patch));
    const save = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
    assert.equal(save.statusCode, 422, save.body);
    assert.equal(store.book_bible_items?.length ?? 0, 0);
  }
});

test("reference clearance is rechecked on save without deleting historical memory links", async (t) => {
  const store = initialStore(); store.asset_versions[0].scan_status = "trusted_generated";
  const app = await appWith(store); t.after(() => app.close());
  const read = () => app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
  const initial = await read();
  assert.equal(initial.json().imageAssets.length, 1);
  assert.equal(initial.body.includes("private/image.png"), false);
  const saved = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  assert.equal(saved.statusCode, 201, saved.body);
  const item = saved.json().item;
  store.asset_versions[0].scan_status = "infected";
  const changed = await read();
  assert.deepEqual(changed.json().imageAssets, []);
  assert.deepEqual(changed.json().items[0].attributes_json.imageAssetIds, [IMAGE]);
  const url = `/v1/books/${BOOK}/bible/${item.id}`;
  const payload = { ...entry, expectedUpdatedAt: item.updated_at };
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload: { ...payload, imageAssetIds: [] } })).statusCode, 200);
  assert.equal(store.assets.length, 1);
});

test("missing versions hide images and clearance lookup errors fail closed", async (t) => {
  const store = initialStore(); store.asset_versions = [];
  const app = await appWith(store); t.after(() => app.close());
  assert.deepEqual((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).json().imageAssets, []);
  assert.equal((await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry })).statusCode, 422);
  const failedStore = initialStore();
  const failed = await appWith(failedStore, "asset_versions"); t.after(() => failed.close());
  for (const call of [{ method: "GET" as const, url: `/v1/books/${BOOK}/memory` },
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, payload: entry }]) {
    const result = await failed.inject({ ...call, headers: auth });
    assert.equal(result.statusCode, 500, result.body);
    assert.equal(result.body.includes("deliberate database failure"), false);
  }
  assert.equal(failedStore.book_bible_items?.length ?? 0, 0);
});

test("Bible update and delete scope by book and prevent stale overwrites", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const create = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  const item = create.json().item;
  const url = `/v1/books/${BOOK}/bible/${item.id}`;
  const update = await app.inject({ method: "PUT", url, headers: auth, payload: { ...entry, name: "Elara Vale", expectedUpdatedAt: item.updated_at } });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().item.name, "Elara Vale");
  assert.notEqual(update.json().item.updated_at, item.updated_at);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload: { ...entry, name: "Stale", expectedUpdatedAt: item.updated_at } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: { expectedUpdatedAt: item.updated_at } })).statusCode, 409);
  store.books.push({ id: OTHER_BOOK, workspace_id: WORKSPACE });
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/books/${OTHER_BOOK}/bible/${item.id}`, headers: auth, payload: { expectedUpdatedAt: update.json().item.updated_at } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: { expectedUpdatedAt: update.json().item.updated_at } })).statusCode, 200);
  assert.equal(store.book_bible_items.length, 0);
  assert.equal(store.assets.length, 1);
  assert.equal(store.chapters.length, 1);
});

test("metadata insert and update preserve contributors and reject stale writes", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/metadata`;
  const payload = { expectedUpdatedAt: null, description: "A journey home.", keywords: ["fiction", "fiction"], categories: ["Fiction / Fantasy"], isbn13: "9780306406157", edition: "First", publicationDate: "2026-09-01" };
  const saved = await app.inject({ method: "PUT", url, headers: auth, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().metadata.keywords, ["fiction"]);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload })).statusCode, 409);
  store.book_metadata[0].contributors = [{ name: "Beth", role: "illustrator" }];
  const updated = await app.inject({ method: "PUT", url, headers: auth, payload: { ...payload, expectedUpdatedAt: saved.json().metadata.updated_at, description: "New description." } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().metadata.contributors, [{ name: "Beth", role: "illustrator" }]);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload: { ...payload, expectedUpdatedAt: saved.json().metadata.updated_at } })).statusCode, 409);
  const loaded = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
  assert.equal(loaded.json().metadata.description, "New description.");
});

test("invalid input and unknown fields never mutate records", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const invalidEntries = [{ ...entry, name: "   " }, { ...entry, book_id: OTHER_BOOK }, { ...entry, attributes: { imageAssetIds: [OTHER_BOOK] } }, { ...entry, sourceRefs: [{ chapterId: "invalid" }] }];
  for (const payload of invalidEntries) assert.equal((await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload })).statusCode, 422);
  for (const payload of [{ expectedUpdatedAt: null, publicationDate: "2026-02-30" }, { expectedUpdatedAt: null, isbn13: "9780306406158" }, { description: "No concurrency token" }, { expectedUpdatedAt: null, title: "wrong table" }]) {
    assert.equal((await app.inject({ method: "PUT", url: `/v1/books/${BOOK}/metadata`, headers: auth, payload })).statusCode, 422);
  }
  assert.equal(store.book_metadata?.length ?? 0, 0);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("database failures return errors without claiming saved data", async (t) => {
  const store = initialStore(); const app = await appWith(store, "book_bible_items"); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).statusCode, 500);
  const res = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.includes("deliberate database failure"), false);
});
