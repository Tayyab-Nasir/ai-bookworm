import test from "node:test";
import assert from "node:assert/strict";
import { chapterDraftBackup } from "../lib/chapter-draft";
import type { BookNode } from "@bookworm/book-model";

const nodes: BookNode[] = [
  { id: "heading", type: "heading", level: 2, text: "Research notes", attributes: { richText: [{ type: "text", text: "Research notes", marks: [{ type: "bold" }] }] } },
  { id: "table", type: "table", rows: [["River", "Three bridges"], ["City", "Two towers"]] },
  { id: "picture", type: "image", assetId: "11111111-1111-4111-8111-111111111111", assetVersionNumber: 7, caption: "A moonlit harbour", altText: "Accessibility text is not manuscript prose" },
  { id: "list", type: "listItem", text: "First observation", attributes: { listStyle: "ordered", listStart: 12, listNumberStyle: "upper-roman" } },
];
const input = { bookId: "book", chapterId: "chapter", baseVersion: 4, capturedAt: "2026-10-13T12:00:00.000Z", nodes };

test("local JSON chapter backup preserves complete rich nodes and exact saved base identity", () => {
  const backup = JSON.parse(JSON.stringify(chapterDraftBackup(input)));
  assert.equal(backup.format, "bookworm-chapter-draft");
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.canonicalState, "current-draft");
  assert.deepEqual(backup.nodes, nodes);
  assert.equal(backup.baseVersion, 4);
  assert.equal(backup.chapterId, "chapter");
  assert.match(backup.plainText, /River\tThree bridges\nCity\tTwo towers/u);
  assert.match(backup.plainText, /A moonlit harbour/u);
  assert.doesNotMatch(backup.plainText, /Accessibility/u);
  assert.equal("editorDocument" in backup, false);
  assert(backup.limitations.some((notice: string) => notice.includes("image bytes are not embedded")));
});

test("invalid numbering backup labels canonical nodes as last-valid and captures actual editor state", () => {
  const editorDocument = { type: "doc", content: [{ type: "orderedList", attrs: { start: 1000000 }, content: [
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Unsaved original" }] }] },
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Unsaved second" }] }] },
  ] }] };
  const backup = JSON.parse(JSON.stringify(chapterDraftBackup({ ...input, validation: {
    message: "List numbering exceeds its 1–1000000 range.", draftText: "Unsaved original\nUnsaved second", editorDocument,
  } })));
  assert.equal(backup.canonicalState, "last-valid-draft");
  assert.equal(backup.plainText, "Unsaved original\nUnsaved second");
  assert.deepEqual(backup.editorDocument, editorDocument);
  assert.deepEqual(backup.nodes, nodes);
  assert.match(backup.validationError, /List numbering/u);
});
