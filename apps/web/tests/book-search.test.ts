import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type SearchPassageCitation } from "@bookworm/api-client";
import { parseSearchResults, parseSearchPassage, searchCitation } from "../lib/book-search";

const book = "11111111-1111-4111-8111-111111111111";
const chapter = "22222222-2222-4222-8222-222222222222";
const version = "33333333-3333-4333-8333-333333333333";
const id = "44444444-4444-4444-8444-444444444444";
const citation: SearchPassageCitation = { chapterId: chapter, documentVersionId: version, nodeId: "p1", chunkIndex: 0, textHash: "a".repeat(32) };
const row = { id, source_type: "manuscript", chapter_id: chapter, document_version_id: version,
  bible_item_id: null, node_id: "p1", chunk_index: 0, text_hash: citation.textHash,
  title: "The compass", excerpt: "The silver compass.", score: 0.25 };
const response = (results: unknown[] = [row]) => ({ query: "compass", strategy: "postgres_full_text", results });
const passage = () => ({ bookId: book, citation, chapterTitle: "The compass", versionNumber: 1,
  isCurrentVersion: true, text: "🌙abc", startOffset: 0, endOffset: 4, totalLength: 4,
  previousOffset: null, nextOffset: null, matchedStart: 0, matchedEnd: 4 });

test("search results accept bounded manuscript and Bible evidence, stripping extra fields", () => {
  const bible = { ...row, id: book, source_type: "bible", bible_item_id: id, chapter_id: null, document_version_id: null, node_id: null };
  const rows = parseSearchResults(response([{ ...row, extra: "discard" }, bible]), "compass");
  assert.deepEqual(rows[0], row); assert.deepEqual(searchCitation(rows[0]!), citation);
  assert.equal(searchCitation(rows[1]!), null); assert.deepEqual(parseSearchResults(response([]), "compass"), []);
  assert.equal(parseSearchResults(response([{ ...row, excerpt: "🌙".repeat(1800) }]), "compass")[0]?.excerpt.length, 3600);
});

for (const [name, patch] of Object.entries({ id: { id: "bad" }, mixed: { bible_item_id: id }, foreignKind: { source_type: "image" },
  missingVersion: { document_version_id: null }, missingNode: { node_id: "" }, hash: { text_hash: "a".repeat(64) },
  coordinate: { chunk_index: 1 }, negative: { chunk_index: -1600 }, score: { score: "0.5" }, nonfinite: { score: Infinity },
  oversized: { excerpt: "🌙".repeat(1801) }, empty: { excerpt: "" } })) {
  test(`search results reject ${name}`, () => assert.throws(() => parseSearchResults(response([{ ...row, ...patch }]), "compass"), /could not be verified/));
}
test("search envelope rejects wrong query, strategy, excessive and duplicate results", () => {
  for (const value of [null, [], { ...response(), query: "other" }, { ...response(), strategy: "semantic" },
    response([row, row]), response(Array(9).fill(row))]) assert.throws(() => parseSearchResults(value, "compass"));
});

test("source reader accepts exact citation and Unicode code-point ranges, not UTF-16 offsets", () => {
  assert.deepEqual(parseSearchPassage({ ...passage(), extra: "drop" }, book, citation), passage());
  assert.throws(() => parseSearchPassage({ ...passage(), endOffset: 5, totalLength: 5 }, book, citation));
  assert.equal(parseSearchPassage({ ...passage(), isCurrentVersion: false }, book, citation).isCurrentVersion, false);
});
test("source reader validates near-match window and both pagination directions", () => {
  const laterCitation = { ...citation, chunkIndex: 6400 };
  const window = { ...passage(), citation: laterCitation, text: "🌙".repeat(6000), startOffset: 6100, endOffset: 12100,
    totalLength: 13000, previousOffset: 100, nextOffset: 12100, matchedStart: 6400, matchedEnd: 8200 };
  assert.equal(parseSearchPassage(window, book, laterCitation).text.length, 12000);
  const tail = { ...window, text: "x".repeat(900), startOffset: 12100, endOffset: 13000, previousOffset: 6100, nextOffset: null };
  assert.equal(parseSearchPassage(tail, book, laterCitation, 12100).nextOffset, null);
  assert.throws(() => parseSearchPassage(tail, book, laterCitation, 100));
});
for (const [name, patch] of Object.entries({ book: { bookId: chapter }, citation: { citation: { ...citation, documentVersionId: book } },
  version: { versionNumber: 0 }, status: { isCurrentVersion: "true" }, text: { text: "" },
  total: { totalLength: -1 }, start: { startOffset: 1 }, previous: { previousOffset: 0 }, next: { nextOffset: 4 },
  match: { matchedStart: 1 }, matchEnd: { matchedEnd: 1800 } })) {
  test(`source reader rejects mismatched ${name}`, () => assert.throws(() => parseSearchPassage({ ...passage(), ...patch }, book, citation)));
}
test("typed source reader sends only the pinned citation and optional offset to the correct book", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return Response.json(passage()); };
    const client = createClient({ baseUrl: "http://bookworm.test", token: "fixture-token" });
    assert.deepEqual(await client.readSearchPassage(book, { ...citation, offset: 0 }), passage());
    assert.equal(calls.length, 1); assert.equal(calls[0]?.url, `http://bookworm.test/v1/books/${book}/search/evidence`);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { ...citation, offset: 0 });
  } finally { globalThis.fetch = originalFetch; }
});
