import { test } from "node:test";
import assert from "node:assert/strict";
import { editorToNodes, nodesToEditor, manuscriptTableHeaderRows, manuscriptTableRows, withTableRows } from "../components/book-editor-model";
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

test("table header designation survives cell edits and rejects stale or invalid metadata", () => {
  const table: BookNode = { id: "table", type: "table", rows: [["Name", "Role"], ["Mira", "Navigator"]],
    text: "Name\tRole\nMira\tNavigator", attributes: { tableHeaderRows: 1 } };
  assert.equal(manuscriptTableHeaderRows(table), 1);
  assert.equal(manuscriptTableHeaderRows(withTableRows(table, [["Name", "Role"], ["Mira", "Captain"]])), 1);
  assert.equal(manuscriptTableHeaderRows({ ...table, text: "Replaced text" }), 0);
  assert.equal(manuscriptTableHeaderRows({ ...table, attributes: { tableHeaderRows: 3 } }), 0);
  assert.equal(manuscriptTableHeaderRows({ ...table, attributes: { tableHeaderRows: true } }), 0);
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

test("ordered starts, styles, nesting and explicit restarts survive edits and repeated saves", () => {
  const item = (id: string, start: number, depth = 0): BookNode => ({ id, type: "listItem", text: id,
    attributes: { listStyle: "ordered", listDepth: depth, listStart: start, listNumberStyle: "lower-roman" } });
  const nodes = [item("first", 7), item("child", 3, 1), item("next", 8), item("restart", 2)];
  const doc = nodesToEditor(nodes);
  assert.equal(doc.content?.length, 2);
  assert.equal(doc.content?.[0].attrs?.start, 7);
  assert.equal(doc.content?.[1].attrs?.start, 2);
  assert.equal(doc.content?.[0].attrs?.type, "i");
  let saved = nodes;
  for (let i = 0; i < 3; i++) saved = editorToNodes(nodesToEditor(saved), () => "unused");
  assert.deepEqual(saved.map(n => [n.id, n.attributes?.listStart, n.attributes?.listNumberStyle, n.attributes?.listDepth]),
    nodes.map(n => [n.id, n.attributes?.listStart, n.attributes?.listNumberStyle, n.attributes?.listDepth]));
  doc.content![0].attrs = { start: 12, type: "A" };
  const changed = editorToNodes(doc, () => "unused");
  assert.equal(changed[0].attributes?.listStart, 12);
  assert.equal(changed[2].attributes?.listStart, 13);
  assert.equal(changed[2].attributes?.listNumberStyle, "upper-alpha");
  doc.content![0].type = "bulletList";
  const bullets = editorToNodes(doc, () => "unused");
  assert.equal(bullets[0].attributes?.listStart, undefined);
  assert.equal(bullets[0].attributes?.listNumberStyle, undefined);
});

test("unsafe numbering metadata is normalized and an overflowing edited list is not silently truncated", () => {
  const node: BookNode = { id: "safe", type: "listItem", text: "Safe", attributes: {
    listStyle: "ordered", listStart: "javascript:alert(1)", listNumberStyle: "__proto__" } };
  const doc = nodesToEditor([node]);
  assert.deepEqual(doc.content?.[0].attrs, { start: 1, type: "1" });
  doc.content![0].attrs!.start = 1_000_000;
  doc.content![0].content!.push({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Overflow" }] }] });
  assert.throws(() => editorToNodes(doc, () => "new"), /numbering exceeds/);
  doc.content![0].type = "bulletList";
  const saved = editorToNodes(doc, () => "new");
  assert.equal(saved[0].attributes?.listStart, undefined);
  assert.equal(saved[0].attributes?.listNumberStyle, undefined);
});

test("reversed list direction survives a save and invalid countdown cannot erase source content", () => {
  const nodes: BookNode[] = [3, 2, 1].map((listStart, index) => ({ id: String(index), type: "listItem", text: "Countdown",
    attributes: { listStyle: "ordered", listStart, listNumberStyle: "upper-alpha", listReversed: true } }));
  const doc = nodesToEditor(nodes);
  assert.equal(doc.content?.length, 1); assert.equal(doc.content?.[0].attrs?.reversed, true);
  const saved = editorToNodes(doc, () => "unused");
  assert.deepEqual(saved.map(n => [n.attributes?.listStart, n.attributes?.listReversed]), [[3, true], [2, true], [1, true]]);
  doc.content![0].attrs!.start = 2;
  assert.throws(() => editorToNodes(doc, () => "unused"), /numbering exceeds/);
});
