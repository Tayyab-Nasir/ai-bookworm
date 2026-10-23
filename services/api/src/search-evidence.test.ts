import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { bookMemoryRoutes } from "./routes/book-memory.js";

const BOOK = "11111111-1111-4111-8111-111111111111", CHAPTER = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333", USER = "44444444-4444-4444-8444-444444444444";
const WORKSPACE = "55555555-5555-4555-8555-555555555555", OTHER = "66666666-6666-4666-8666-666666666666";
const auth = { authorization: "Bearer good" }, url = `/v1/books/${BOOK}/search/evidence`;
type Store = Record<string, Record<string, any>[]>;
const md5 = (value: string) => createHash("md5").update(value).digest("hex");
function initial(text = "The silver compass points north."): Store {
  return { books: [{ id: BOOK, workspace_id: WORKSPACE }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, status: "active", role: "reader" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "Arrival", current_document_version_id: VERSION }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 7,
      content_json: { nodes: [{ id: "node-a", type: "paragraph", text }] } }] };
}
const citation = (text = "The silver compass points north.", chunkIndex = 0) => ({
  chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "node-a", chunkIndex,
  textHash: md5(Array.from(text).slice(chunkIndex, chunkIndex + 1800).join("")),
});
async function fixture(store = initial(), failTable?: string) {
  const reads: string[] = [];
  const sb = { auth: { getUser: async (token: string) => ({ data: { user: token === "good" ? { id: USER } : null }, error: null }) },
    from(table: string) {
      const filters: [string, unknown][] = [];
      return { select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
        async maybeSingle() { reads.push(table); return table === failTable ? { data: null, error: { message: "Private database diagnostic" } }
          : { data: (store[table] ?? []).find(row => filters.every(([key, value]) => row[key] === value)) ?? null, error: null }; } };
    } };
  const app = Fastify(); await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(() => sb as never));
  await app.register(async routes => bookMemoryRoutes(routes), { prefix: "/v1" });
  return { app, store, reads };
}

test("search passage reloads pinned canonical text with private headers and no writes", async t => {
  const { app, store } = await fixture(); t.after(() => app.close()); const before = JSON.stringify(store);
  const result = await app.inject({ method: "POST", url, headers: auth, payload: citation() });
  assert.equal(result.statusCode, 200); assert.equal(result.headers["cache-control"], "private, no-store");
  assert.deepEqual(result.json(), { bookId: BOOK, citation: citation(), chapterTitle: "Arrival", versionNumber: 7,
    isCurrentVersion: true, text: "The silver compass points north.", startOffset: 0, endOffset: 32,
    totalLength: 32, previousOffset: null, nextOffset: null, matchedStart: 0, matchedEnd: 32 });
  assert.equal(JSON.stringify(store), before);
});

test("search passage reproduces rich indexed fields, including empty table cells", async t => {
  const store = initial(); store.document_versions[0].content_json.nodes[0] = {
    id: "node-a", type: "table", text: "", caption: "Compass", altText: "🧭 bearings", rows: [["North", ""], ["East", "West"]],
  };
  const text = "Compass\n🧭 bearings\nNorth\n\nEast\nWest";
  const { app } = await fixture(store); t.after(() => app.close());
  const result = await app.inject({ method: "POST", url, headers: auth, payload: citation(text) });
  assert.equal(result.statusCode, 200); assert.equal(result.json().text, text);
  assert.equal(result.json().totalLength, Array.from(text).length);
});

test("search passage pagination uses PostgreSQL character offsets, not UTF-16 units", async t => {
  const text = "🦉".repeat(13_000) + " ending";
  const { app } = await fixture(initial(text)); t.after(() => app.close());
  const ref = citation(text, 6400);
  const first = await app.inject({ method: "POST", url, headers: auth, payload: ref });
  assert.equal(first.statusCode, 200); const page = first.json();
  assert.equal(page.startOffset, 6100); assert.equal(page.endOffset, 12100);
  assert.equal(page.text.length, 12000); assert.equal(page.nextOffset, 12100); assert.equal(page.previousOffset, 100);
  const next = await app.inject({ method: "POST", url, headers: auth, payload: { ...ref, offset: page.nextOffset } });
  assert.equal(next.json().text, Array.from(text).slice(12100).join("")); assert.equal(next.json().nextOffset, null);
  assert.equal(next.json().totalLength, 13007);
  const invalid = await app.inject({ method: "POST", url, headers: auth, payload: { ...ref, offset: 13007 } });
  assert.equal(invalid.statusCode, 422);
});

test("a later chapter revision never substitutes its text for the cited version", async t => {
  const store = initial(); store.chapters[0].current_document_version_id = OTHER;
  store.document_versions.push({ id: OTHER, chapter_id: CHAPTER, version_number: 8, content_json: { nodes: [{ id: "node-a", type: "paragraph", text: "Changed later" }] } });
  const { app } = await fixture(store); t.after(() => app.close());
  const result = await app.inject({ method: "POST", url, headers: auth, payload: citation() });
  assert.equal(result.statusCode, 200); assert.equal(result.json().isCurrentVersion, false);
  assert.equal(result.json().text, "The silver compass points north."); assert.equal(result.json().versionNumber, 7);
});

test("source reading requires current authentication and membership before manuscript access", async t => {
  for (const mode of ["unauthenticated", "nonmember", "foreign-chapter", "foreign-version"]) {
    await t.test(mode, async t => {
      const store = initial(); if (mode === "nonmember") store.workspace_members = [];
      if (mode === "foreign-chapter") store.chapters[0].book_id = OTHER;
      if (mode === "foreign-version") store.document_versions[0].chapter_id = OTHER;
      const { app, reads } = await fixture(store); t.after(() => app.close());
      const result = await app.inject({ method: "POST", url, headers: mode === "unauthenticated" ? {} : auth, payload: citation() });
      assert.equal(result.statusCode, mode === "unauthenticated" ? 401 : mode === "nonmember" ? 403 : 404);
      assert(!result.body.includes("silver compass"));
      if (["unauthenticated", "nonmember", "foreign-chapter"].includes(mode)) assert(!reads.includes("document_versions"));
    });
  }
});

test("search fingerprints and chunk coordinates must match exact saved fields", async t => {
  const { app } = await fixture(); t.after(() => app.close());
  for (const [change, code] of [
    [{ textHash: "f".repeat(32) }, 409], [{ nodeId: "missing" }, 404], [{ chunkIndex: 1600 }, 409],
    [{ chunkIndex: 1 }, 422], [{ chunkIndex: -1 }, 422], [{ chunkIndex: true }, 422],
    [{ offset: -1 }, 422], [{ offset: null }, 422], [{ textHash: "a".repeat(64) }, 422],
    [{ extra: "field" }, 422], [{ chapterId: "invalid" }, 422],
  ] as const) {
    const result = await app.inject({ method: "POST", url, headers: auth, payload: { ...citation(), ...change } });
    assert.equal(result.statusCode, code, JSON.stringify(change));
  }
});

test("source read fails closed on corrupt canonical data and redacts database failures", async t => {
  for (const mode of ["duplicate-node", "invalid-version", "database"]) {
    const store = initial();
    if (mode === "duplicate-node") store.document_versions[0].content_json.nodes.push({ id: "node-a", type: "paragraph", text: "Ambiguous" });
    if (mode === "invalid-version") store.document_versions[0].version_number = 0;
    const { app } = await fixture(store, mode === "database" ? "document_versions" : undefined); t.after(() => app.close());
    const result = await app.inject({ method: "POST", url, headers: auth, payload: citation() });
    assert.equal(result.statusCode, mode === "duplicate-node" ? 422 : 503);
    assert(!result.body.includes("Private database"));
  }
});
