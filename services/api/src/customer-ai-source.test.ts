import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "./errors.js";
import { loadCustomerAiSource } from "./lib/customer-ai-source.js";
import { ids, sha, sourceFixture } from "./testing/customer-ai-fixture.js";

const reject = (status: number) => (error: unknown) => error instanceof AppError && error.status === status
  && !JSON.stringify(error).includes("private-database-detail") && !error.message.includes("private-database-detail");

test("authenticated canonical full-node source, exact current pointer, detached frozen result", async () => {
  const f = sourceFixture();
  f.data.document_versions.push({ ...f.data.document_versions[0], id: ids.other, version_number: 999, content_json: { nodes: [] } });
  const result = await loadCustomerAiSource(f.factory, f.actor, f.input);
  assert.deepEqual(result.sourceVersions, [{ chapterId: ids.chapter, documentVersionId: ids.version, version: 3 }]);
  assert.deepEqual(result.request.input.chapters[ids.chapter].nodes, [{ id: "p1", type: "paragraph", text: f.nodes[0].text, textHash: sha(f.nodes[0].text!) }]);
  assert.deepEqual(f.stats(), { authCalls: 2, factories: 1 });
  assert(!f.reads.some(r => r.table === "style_guides" || r.table === "book_bible_items"));
  assert(!JSON.stringify(result).includes("not-for-model")); assert(!JSON.stringify(result).includes(f.actor.accessToken));
  const version = f.reads.find(r => r.table === "document_versions")!;
  assert.deepEqual(version.filters, [["id", ids.version], ["chapter_id", ids.chapter]]);
  f.nodes[0].text = "mutated"; f.input.contextPolicy.maxTokens = 256;
  assert.notEqual(result.request.input.chapters[ids.chapter].nodes[0].text, "mutated");
  assert.equal(result.request.contextPolicy.maxTokens, 4096);
  assert.throws(() => { result.request.input.chapters[ids.chapter].nodes[0].text = "mutated"; });
});

for (const kind of ["metadata", "bookbible"] as const) test(`${kind} uses canonical table/caption text, never alt text or private assets`, async () => {
  const f = sourceFixture(); f.input.agentType = kind;
  f.nodes.push({ id: "table", type: "table", rows: [["one", "two"], ["three", "four"]] },
    { id: "image", type: "image", caption: "Rainy skyline", altText: "private-alt", assetId: ids.other },
    { id: "empty-table", type: "table", text: "", rows: [["stale grid"]] });
  const result = await loadCustomerAiSource(f.factory, f.actor, f.input);
  const nodes = result.request.input.chapters[ids.chapter].nodes;
  assert.equal(nodes[1].text, "one\ttwo\nthree\tfour"); assert.equal(nodes[1].textHash, sha(nodes[1].text));
  assert.equal(nodes[2].text, "Rainy skyline"); assert.equal(nodes.length, 3);
  assert(!JSON.stringify(nodes).includes("private-alt")); assert(!JSON.stringify(nodes).includes(ids.other));
});

test("writer can target a saved empty text node; non-text rich nodes are not silently editable", async () => {
  const f = sourceFixture(); f.nodes[0].text = "";
  f.nodes.push({ id: "image", type: "image", text: "title", caption: "different caption" });
  const result = await loadCustomerAiSource(f.factory, f.actor, f.input);
  assert.deepEqual(result.request.input.chapters[ids.chapter].nodes, [{ id: "p1", type: "paragraph", text: "", textHash: sha("") }]);
  f.input.chapters[0].nodeIds = ["image"];
  await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input), reject(422));
});

test("opted-in context preserves approved facts, removes image IDs and unbound citations", async () => {
  const f = sourceFixture(); Object.assign(f.input.contextPolicy, { includeStyleGuide: true, includeBookBible: true });
  f.data.book_bible_items[0].source_refs_json.push({ chapterId: ids.other, documentVersionId: ids.version, nodeId: "p1", textHash: sha(f.nodes[0].text!) });
  const result = await loadCustomerAiSource(f.factory, f.actor, f.input);
  assert.deepEqual(result.request.input.styleGuide, { rules: { contractions: false }, tone: "calm", spellingVariant: "en-US" });
  assert.deepEqual(result.request.input.bookBible[0].attributes, { weather: "rain" });
  assert.equal((result.request.input.bookBible[0].sourceRefs as unknown[]).length, 1);
  assert.equal(f.reads.find(r => r.table === "book_bible_items")!.limit, 101);
});

for (const table of ["books", "workspace_members", "chapters", "document_versions", "style_guides", "book_bible_items"]) {
  test(`database failure for ${table} is static and fails closed`, async () => {
    const f = sourceFixture(); Object.assign(f.input.contextPolicy, { includeStyleGuide: true, includeBookBible: true }); f.controls.errorTable = table;
    await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input), reject(503));
  });
}
for (const role of ["reader", "designer", "illustrator", "viewer"]) test(`${role} cannot prepare writing source`, async () => {
  const f = sourceFixture(); f.data.workspace_members[0].role = role;
  await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input), reject(403));
});
for (const phase of ["initial", "final"]) test(`${phase} auth must match the explicit owner`, async () => {
  const f = sourceFixture(); f.controls.onAuth = count => { if (count === (phase === "initial" ? 1 : 2)) f.controls.authId = ids.other; };
  await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input), reject(401));
});
for (const change of ["pointer", "title", "order", "book", "membership"]) test(`changes during source loading invalidate ${change}`, async () => {
  const f = sourceFixture(); f.controls.before = (table, count) => {
    if (table === "chapters" && count === 2) {
      if (change === "pointer") f.data.chapters[0].current_document_version_id = ids.other;
      if (change === "title") f.data.chapters[0].title = "New title";
      if (change === "order") f.data.chapters[0].order_index = 1;
    }
    if (table === "books" && count === 2 && change === "book") f.data.books[0].title = "New book";
    if (table === "workspace_members" && count === 2 && change === "membership") f.data.workspace_members[0].status = "revoked";
  };
  await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input), reject(change === "membership" ? 403 : 409));
});
test("actor is snapshotted before the first async read", async () => {
  const f = sourceFixture(); f.controls.before = table => { if (table === "books") Object.assign(f.actor, { userId: ids.other, accessToken: "changed" }); };
  const result = await loadCustomerAiSource(f.factory, f.actor, f.input); assert.equal(result.ownerId, ids.owner);
});
for (const change of ["missing-book", "foreign-chapter", "wrong-version", "missing-node", "duplicate-node", "unicode", "node-count", "bible-count", "size"]) {
  test(`invalid saved source rejects ${change}`, async () => {
    const f = sourceFixture(); let status = 422;
    if (change === "missing-book") { f.data.books = []; status = 404; }
    if (change === "foreign-chapter") { f.data.chapters[0].book_id = ids.other; status = 409; }
    if (change === "wrong-version") { f.input.chapters[0].version = 4; status = 409; }
    if (change === "missing-node") f.input.chapters[0].nodeIds = ["missing"];
    if (change === "duplicate-node") f.nodes.push({ ...f.nodes[0] });
    if (change === "unicode") { f.nodes[0].text = "\ud800"; status = 503; }
    if (change === "node-count") { for (let i = 0; i < 200; i++) f.nodes.push({ id: "p" + (i + 2), type: "paragraph", text: "a" }); }
    if (change === "bible-count") { f.input.contextPolicy.includeBookBible = true; f.data.book_bible_items = Array(101).fill(f.data.book_bible_items[0]); }
    if (change === "size") f.nodes[0].text = "雨".repeat(134000);
    await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input), reject(status));
  });
}
test("invalid selection, unsupported retrieval, bad actor and cancellation do not read source", async () => {
  const f = sourceFixture();
  for (const input of [{ ...f.input, extra: true }, { ...f.input, chapters: [...f.input.chapters, ...f.input.chapters] },
    { ...f.input, userInstruction: null }, { ...f.input, contextPolicy: { ...f.input.contextPolicy, includeRelatedContext: true } },
    { ...f.input, chapters: [{ ...f.input.chapters[0], nodeIds: ["p1", "p1"] }] }]) {
    await assert.rejects(loadCustomerAiSource(f.factory, f.actor, input), reject(422));
  }
  await assert.rejects(loadCustomerAiSource(f.factory, { ...f.actor, accessToken: "" }, f.input), reject(401));
  await assert.rejects(loadCustomerAiSource(f.factory, f.actor, f.input, AbortSignal.abort()), reject(503));
  await assert.rejects(loadCustomerAiSource(() => { throw new Error("private-database-detail"); }, f.actor, f.input), reject(503));
  assert.equal(f.stats().factories, 0);
});
