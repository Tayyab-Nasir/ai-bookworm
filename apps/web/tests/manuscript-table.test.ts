import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BookNode } from "@bookworm/book-model";
import { editorToNodes, nodesToEditor } from "../components/book-editor-model";
import { manuscriptTableSpans, mergeTableCells, splitTableCell, tableGridHash, tableSelection, withTableHeaderRows, withTableRows } from "../lib/manuscript-table";

function table(rows = [["A", "B"], ["C", "D"]]): BookNode {
  return { id: "table", type: "table", rows, text: rows.map((row) => row.join("\t")).join("\n"), attributes: { source: "docx" } };
}

test("imported legacy merges survive a cell edit and editor save with a fresh structural hash", () => {
  const original = table([["Across", ""], ["Mira", "Navigator"]]);
  const spans = [{ row: 0, col: 0, rowspan: 1, colspan: 2 }];
  original.attributes = { ...original.attributes, tableHeaderRows: 1, tableSpans: spans,
    tableSpanSource: createHash("sha256").update(original.text!).digest("hex") };
  assert.deepEqual(manuscriptTableSpans(original), spans);
  const changed = withTableRows(original, [["Across revised", ""], ["Mira", "Captain"]]);
  assert.deepEqual(manuscriptTableSpans(changed), spans);
  assert.equal(changed.attributes?.tableSpanSource, tableGridHash(changed.rows!));
  assert.equal(changed.attributes?.source, "docx");
  assert.deepEqual(editorToNodes(nodesToEditor([changed]), () => "unused"), [changed]);
  assert.equal(original.rows![0][0], "Across");
});

test("merge keeps all cell text in reading order, split keeps text, and the original remains undoable", () => {
  const original = table([["A\tB", "second"], ["Mira 🌙", "D\nE"]]);
  const merged = mergeTableCells(original, { top: 0, left: 0, bottom: 1, right: 1 });
  assert.deepEqual(merged.rows, [["A\tB\nsecond\nMira 🌙\nD\nE", ""], ["", ""]]);
  assert.deepEqual(manuscriptTableSpans(merged), [{ row: 0, col: 0, rowspan: 2, colspan: 2 }]);
  assert.deepEqual(tableSelection(manuscriptTableSpans(merged), { row: 0, col: 0 }, { row: 0, col: 0 }), { top: 0, left: 0, bottom: 1, right: 1 });
  const split = splitTableCell(merged, { row: 0, col: 0 });
  assert.deepEqual(split.rows, merged.rows);
  assert.deepEqual(manuscriptTableSpans(split), []);
  assert.equal(split.attributes?.tableSpanSource, undefined);
  assert.deepEqual(original.rows, [["A\tB", "second"], ["Mira 🌙", "D\nE"]]);
});

test("partial merges, header crossings and oversized combined text are rejected before content changes", () => {
  const merged = mergeTableCells(table(), { top: 0, left: 0, bottom: 1, right: 0 });
  assert.throws(() => mergeTableCells(merged, { top: 0, left: 0, bottom: 0, right: 1 }), /whole merged cells/);
  assert.throws(() => withTableHeaderRows(merged, 1), /spanning the header/);
  assert.throws(() => mergeTableCells(withTableHeaderRows(table(), 1), { top: 0, left: 0, bottom: 1, right: 1 }), /Header and body/);
  assert.throws(() => mergeTableCells(table([["x".repeat(60000), "y".repeat(60000)]]), { top: 0, left: 0, bottom: 0, right: 1 }), /supported size/);
  assert.throws(() => mergeTableCells(table(), { top: 0, left: 0, bottom: 3, right: 1 }), /inside this table/);
});

test("structural signatures distinguish embedded separators and reject stale or malformed spans", () => {
  const rows = [["A\tB", ""], ["Mira 🌙", "D\nE"]];
  assert.equal(tableGridHash(rows), "v2:ac83bba0564a344c30307d809c44502ecf81ed278ed12fe996eea5f254d6f2d9");
  assert.equal(tableGridHash(rows), `v2:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`);
  assert.notEqual(tableGridHash([["A\tB", ""]]), tableGridHash([["A", "B", ""]]));
  const merged = mergeTableCells(table(), { top: 0, left: 0, bottom: 0, right: 1 });
  const editedOutsideGrid = { ...merged, text: "Author replacement" };
  assert.deepEqual(manuscriptTableSpans(editedOutsideGrid), []);
  const repaired = withTableRows(editedOutsideGrid, [["New", "content"]]);
  assert.equal(repaired.text, "New\tcontent");
  assert.equal(repaired.attributes?.tableSpans, undefined);
  assert.deepEqual(manuscriptTableSpans({ ...merged, attributes: { ...merged.attributes, tableSpans: [{ row: 0, col: 0, rowspan: true, colspan: 2 }] } }), []);
});
