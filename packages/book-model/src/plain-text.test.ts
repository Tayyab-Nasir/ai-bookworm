import { test } from "node:test";
import assert from "node:assert/strict";
import { bookNodesPlainText, bookNodesWordCount } from "./index.js";
import { BookNodeSchema, type BookNode } from "./schema.js";

test("reading text includes a rows-only table and illustration caption once", () => {
  const nodes = [
    { id: "intro", type: "paragraph", text: "Opening words" },
    { id: "grid", type: "table", rows: [["Name", "Role"], ["Elara", "Writer"]] },
    { id: "image", type: "image", caption: "The hidden garden", altText: "An accessibility description" },
  ].map((node) => BookNodeSchema.parse(node));
  assert.equal(bookNodesPlainText(nodes), "Opening words\n\nName\tRole\nElara\tWriter\n\nThe hidden garden");
  assert.equal(bookNodesWordCount(nodes), 9);
});

test("mirrored table text and caption are not counted twice", () => {
  const nodes: BookNode[] = [
    { id: "grid", type: "table", rows: [["Name", "Role"]], text: "Name\tRole" },
    { id: "image", type: "image", text: "The hidden garden", caption: "The hidden garden" },
  ];
  assert.equal(bookNodesPlainText(nodes), "Name\tRole\n\nThe hidden garden");
  assert.equal(bookNodesWordCount(nodes), 5);
});

test("explicit canonical text wins over stale grids and rich-text runs", () => {
  const nodes: BookNode[] = [
    { id: "grid", type: "table", rows: [["Old grid"]], text: "Current prose" },
    { id: "empty", type: "table", rows: [["Discarded grid"]], text: "" },
    { id: "formatted", type: "paragraph", text: "Revised text", attributes: { richText: [{ type: "text", text: "Stale text" }] } },
  ];
  assert.equal(bookNodesPlainText(nodes), "Current prose\n\nRevised text");
  assert.equal(bookNodesWordCount(nodes), 4);
});

test("flat nested-list items, quotes and footnotes keep canonical order and Unicode", () => {
  const nodes: BookNode[] = [
    { id: "outer", type: "listItem", text: "Café first", attributes: { listDepth: 0 } },
    { id: "inner", type: "listItem", text: "Inner 😀 line\nContinued", attributes: { listDepth: 1 } },
    { id: "quote", type: "quote", text: "A quotation" },
    { id: "footnote", type: "footnote", text: "Footnote evidence" },
  ];
  assert.equal(bookNodesPlainText(nodes), "Café first\n\nInner 😀 line\nContinued\n\nA quotation\n\nFootnote evidence");
  assert.equal(bookNodesWordCount(nodes), 10);
});

test("only supported reading fields contribute text and extraction never changes nodes", () => {
  const nodes: BookNode[] = [
    { id: "empty", type: "paragraph", text: "" },
    { id: "break", type: "pageBreak" },
    { id: "image", type: "image", altText: "Alternative text", attributes: { privateNote: "Planning note" } },
    { id: "list", type: "list", children: [{ text: "Unknown passthrough content" }] },
    { id: "separator", type: "separator" },
  ];
  const original = JSON.stringify(nodes);
  assert.equal(bookNodesPlainText(nodes), "");
  assert.equal(bookNodesWordCount(nodes), 0);
  assert.equal(JSON.stringify(nodes), original);
});

test("whitespace within prose and table cells remains exact while counting uses whitespace boundaries", () => {
  const nodes: BookNode[] = [
    { id: "space", type: "paragraph", text: "  First\tsecond\r\nthird  " },
    { id: "table", type: "table", rows: [["A\nB", "C"], ["", "D"]] },
  ];
  assert.equal(bookNodesPlainText(nodes), "  First\tsecond\r\nthird  \n\nA\nB\tC\n\tD");
  assert.equal(bookNodesWordCount(nodes), 7);
  assert.equal(bookNodesWordCount([{ id: "blank", type: "paragraph", text: " \t\n\u00a0" }]), 0);
});
