import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineText, nodeInline, replaceNodeText, safeInline } from "./rich-text.js";
import { applyOperation } from "./engine.js";
import { sampleBook, CH1 } from "./fixture.js";

test("untrusted runs cannot hide canonical text or carry arbitrary markup", () => {
  assert.deepEqual(safeInline([null, 1, { type: "image" }, { type: "text", text: "<script>", marks: [null, { type: "bold" }, { type: "bold" }, { type: "link", attrs: { href: "javascript:x" } }] }]), [{ type: "text", text: "<script>", marks: [{ type: "bold" }] }]);
  assert.equal(inlineText(nodeInline({ text: "New\ntext", attributes: { richText: [{ type: "text", text: "Old" }] } })), "New\ntext");
  assert.deepEqual(safeInline({ text: "invalid" }), []);
});

test("replace_text keeps unaffected formatting and synchronizes runs through accepted AI operations", () => {
  const book = sampleBook();
  const target = book.chapters[0].nodes.find((n) => n.id === "n2")!;
  target.text = "Hello world!";
  target.attributes = { custom: "keep", richText: [{ type: "text", text: "Hello ", marks: [{ type: "bold" }] }, { type: "text", text: "world!", marks: [{ type: "italic" }] }] };
  const result = applyOperation(book, { operationId: "rich-edit", type: "replace_text", source: "ai", sourceRef: null, expectedVersion: 0, target: { chapterId: CH1, nodeId: "n2" }, payload: { nodeId: "n2", from: 6, to: 11, text: "reader\nfriend" } }, 0);
  const edited = result.book.chapters[0].nodes.find((n) => n.id === "n2")!;
  assert.equal(edited.text, "Hello reader\nfriend!");
  assert.equal(inlineText(nodeInline(edited)), edited.text);
  assert.deepEqual(nodeInline(edited)[0], { type: "text", text: "Hello ", marks: [{ type: "bold" }] });
  assert.deepEqual(nodeInline(edited).at(-1), { type: "text", text: "!", marks: [{ type: "italic" }] });
  assert.equal(edited.attributes?.custom, "keep");
  assert.equal(target.text, "Hello world!");
});

test("replacement slices and insertions never resurrect deleted or stale text", () => {
  for (const text of ["", "abc", "a\nb", "a😀b"]) {
    for (let from = 0; from <= text.length; from++) for (let to = from; to <= text.length; to++) {
      const node = { id: "n", type: "paragraph" as const, text, attributes: { richText: [{ type: "text", text: "stale" }] } };
      for (const replacement of ["", "X", "\nY"]) {
        const result = replaceNodeText(node, from, to, replacement);
        assert.equal(result.text, text.slice(0, from) + replacement + text.slice(to));
        assert.equal(inlineText(nodeInline(result)), result.text);
      }
    }
  }
});

test("split and merge preserve formatting on each side of the boundary", () => {
  const book = sampleBook();
  const target = book.chapters[0].nodes.find((n) => n.id === "n2")!;
  target.text = "BoldItalic";
  target.attributes = { richText: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }, { type: "text", text: "Italic", marks: [{ type: "italic" }] }] };
  const envelope = { operationId: "split-rich", source: "human" as const, sourceRef: null, expectedVersion: 0, target: { chapterId: CH1, nodeId: "n2" } };
  const split = applyOperation(book, { ...envelope, type: "split_node", payload: { nodeId: "n2", offset: 4 } }, 0);
  const [left, right] = split.book.chapters[0].nodes.slice(1, 3);
  assert.deepEqual(nodeInline(left), [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }]);
  assert.deepEqual(nodeInline(right), [{ type: "text", text: "Italic", marks: [{ type: "italic" }] }]);
  const merged = applyOperation(split.book, { ...envelope, expectedVersion: 1, type: "merge_nodes", payload: { leftNodeId: left.id, rightNodeId: right.id } }, 1);
  assert.deepEqual(nodeInline(merged.book.chapters[0].nodes[1]), nodeInline(target));
});
