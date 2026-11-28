import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRevisionText, compareRevisionBlocks, readRevisionSnapshot } from "../lib/version-comparison";
import type { BookNode } from "@bookworm/book-model";
import type { DocumentVersionSnapshot } from "@bookworm/api-client";
const revision = (version_number: number, plain_text?: string) => ({ id: String(version_number), version_number, plain_text });
test("comparison is chronological and reconstructs exact unicode and whitespace", () => {
  const old = "Hello  world.\n\nمرحبا!", next = "Hello new world.\nمرحبا!";
  const result = compareRevisionText(revision(9, next), revision(2, old))!;
  assert.equal(result.before.version_number, 2);
  assert.equal(result.changes.filter((c) => c.kind !== "add").map((c) => c.text).join(""), old);
  assert.equal(result.changes.filter((c) => c.kind !== "del").map((c) => c.text).join(""), next);
});
test("missing history is not an empty chapter", () => {
  assert.equal(compareRevisionText(revision(1), revision(2, "text")), null);
  assert.equal(compareRevisionText(revision(1, ""), revision(2, ""))?.identical, true);
  assert.equal(compareRevisionText(revision(1, ""), revision(2, "text"))?.changes[0].kind, "add");
});
test("whitespace changes are preserved and large comparisons are bounded", () => {
  assert.equal(compareRevisionText(revision(1, "a b"), revision(2, "a\nb"))?.identical, false);
  const result = compareRevisionText(revision(1, "old ".repeat(10000)), revision(2, "new ".repeat(10000)))!;
  assert.equal(result.mode, "full"); assert.equal(result.changes.length, 2);
});

test("canonical comparison catches image, table, list and extension changes despite identical text", () => {
  const before: BookNode[] = [
    { id: "img", type: "image", assetId: "11111111-1111-4111-8111-111111111111", assetVersionNumber: 1, caption: "Day", altText: "Sunrise" },
    { id: "list", type: "listItem", text: "Same", attributes: { listStart: 3, listNumberStyle: "decimal" } },
    { id: "table", type: "table", text: "Same", rows: [["one", "two"]] },
    { id: "h", type: "heading", level: 1, text: "Same", extension: { a: 1 } },
  ];
  const after = structuredClone(before);
  Object.assign(after[0], { assetVersionNumber: 2, caption: "Night", altText: "Moon" });
  after[1].attributes!.listStart = 7; after[2].rows = [["two", "one"]]; after[3].level = 2; after[3].extension = { a: 2 };
  const result = compareRevisionBlocks(before, after);
  assert.deepEqual([result.added, result.removed, result.changed, result.moved], [0, 0, 4, 0]);
  assert.deepEqual(result.changes.map(change => change.fields), [["altText", "assetVersionNumber", "caption"], ["attributes"], ["rows"], ["extension", "level"]]);
  assert.equal(before[0].assetVersionNumber, 1);
});
test("block insertion/removal is not misreported as reordering, real retained order changes are", () => {
  const a: BookNode = { id: "a", type: "paragraph", text: "A" }, b: BookNode = { id: "b", type: "pageBreak" };
  assert.equal(compareRevisionBlocks([a, b], [{ id: "new", type: "separator" }, a, b]).moved, 0);
  assert.equal(compareRevisionBlocks([a, b], [b]).moved, 0);
  assert.deepEqual(compareRevisionBlocks([a, b], [b, a]).changes.map(change => [change.id, change.kind]), [["a", "moved"], ["b", "moved"]]);
  assert.equal(compareRevisionBlocks([], []).identical, true);
  assert.throws(() => compareRevisionBlocks([a, a], [a]), /duplicate/);
});
test("object key order is not a change; array order and missing fields remain meaningful", () => {
  const first: BookNode = { id: "n", type: "paragraph", attributes: { a: 1, b: { z: 3, y: 2 } }, caption: "" };
  const second: BookNode = { id: "n", type: "paragraph", attributes: { b: { y: 2, z: 3 }, a: 1 }, caption: "" };
  assert.equal(compareRevisionBlocks([first], [second]).identical, true);
  delete second.caption;
  assert.deepEqual(compareRevisionBlocks([first], [second]).changes[0].fields, ["caption"]);
});
test("saved snapshot validates chapter, version identity and canonical shape", () => {
  const version = { id: "v", chapter_id: "ch", version_number: 2 };
  const snapshot = { version, document: { chapterId: "ch", version: 2, nodes: [{ id: "n", type: "paragraph", text: "Private <script>" }] } } as DocumentVersionSnapshot;
  assert.deepEqual(readRevisionSnapshot(snapshot, "ch", version), snapshot.document.nodes);
  for (const candidate of [null, { ...snapshot, version: { ...version, id: "other" } },
    { ...snapshot, document: { ...snapshot.document, chapterId: "other" } },
    { ...snapshot, document: { ...snapshot.document, version: 5 } },
    { ...snapshot, document: { ...snapshot.document, nodes: [{ id: "n", type: "bad" }] } },
    { ...snapshot, document: { ...snapshot.document, nodes: [...snapshot.document.nodes, ...snapshot.document.nodes] } }]) {
    assert.throws(() => readRevisionSnapshot(candidate as DocumentVersionSnapshot, "ch", version));
  }
});
