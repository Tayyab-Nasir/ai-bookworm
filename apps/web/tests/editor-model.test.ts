import { test } from "node:test";
import assert from "node:assert/strict";
import { editorToNodes, nodesToEditor, manuscriptTableRows, withTableRows } from "../components/book-editor-model";
import type { BookNode } from "@bookworm/book-model";

test("table editing keeps canonical text, safe cells and stable roundtrip without stale formatting", () => {
  const original: BookNode = { id: "table", type: "table", text: "old", attributes: { richText: [{ type: "text", text: "old" }], source: "docx" } };
  const rows = [["A & B", "<script>literal</script>"], ["Multi\nline", ""]];
  const changed = withTableRows(original, rows);
  assert.equal(changed.text, "A & B\t<script>literal</script>\nMulti\nline\t");
  assert.equal(changed.attributes?.richText, undefined);
  assert.equal(changed.attributes?.source, "docx");
  assert.deepEqual(manuscriptTableRows(changed), rows);
  assert.deepEqual(editorToNodes(nodesToEditor([changed]), () => "unused"), [changed]);
  assert.equal(manuscriptTableRows({ ...changed, text: "Accepted AI correction" }), null);
  assert.equal(original.text, "old");
});

test("chapter roundtrip retains artwork, formatting, stable IDs and structural breaks", () => {
  const nodes: BookNode[] = [
    { id: "p", type: "paragraph", text: "Bold\nthen plain", attributes: { richText: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }, { type: "hardBreak" }, { type: "text", text: "then plain" }] } },
    { id: "art", type: "image", assetId: "image-id", altText: "A bridge", caption: "Arrival", attributes: { widthPercent: 75, printPlacement: "fullBleed", printFocalX: 0, printFocalY: 100 } },
    { id: "break", type: "pageBreak" },
  ];
  const saved = editorToNodes(nodesToEditor(nodes), () => "new-id");
  assert.deepEqual(saved.map((n) => n.id), nodes.map((n) => n.id));
  assert.deepEqual(saved[1], nodes[1]);
  assert.deepEqual(saved[2], nodes[2]);
  assert.equal(saved[0].text, nodes[0].text);
  assert.deepEqual((saved[0].attributes?.richText as any[])[0].marks, [{ type: "bold" }]);
});

test("nested mixed lists retain every item, order and depth after repeated saves", () => {
  const nodes: BookNode[] = [
    { id: "a", type: "listItem", text: "Parent", attributes: { listStyle: "ordered", listDepth: 0 } },
    { id: "b", type: "listItem", text: "Child", attributes: { listStyle: "bullet", listDepth: 1 } },
    { id: "c", type: "listItem", text: "Grandchild", attributes: { listStyle: "ordered", listDepth: 2 } },
    { id: "d", type: "listItem", text: "Second", attributes: { listStyle: "ordered", listDepth: 0 } },
  ];
  let saved = nodes;
  for (let i = 0; i < 3; i++) saved = editorToNodes(nodesToEditor(saved), () => "unused");
  assert.deepEqual(saved.map((n) => [n.id, n.text, n.attributes?.listStyle, n.attributes?.listDepth]), nodes.map((n) => [n.id, n.text, n.attributes?.listStyle, n.attributes?.listDepth]));
});

test("stale formatting cannot overwrite accepted AI text when the chapter is opened and saved", () => {
  const nodes: BookNode[] = [{ id: "p", type: "paragraph", text: "Accepted change\nNew line", attributes: { richText: [null, { type: "text", text: "Old draft" }] } }];
  assert.equal(editorToNodes(nodesToEditor(nodes), () => "unused")[0].text, nodes[0].text);
});
