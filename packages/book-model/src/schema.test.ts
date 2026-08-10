import { test } from "node:test";
import assert from "node:assert/strict";
import { BookModelSchema } from "./schema.js";
import { DocumentOperationSchema } from "./operations.js";
import { validateBookModel } from "./validate.js";
import { sampleBook, CH1, ASSET1 } from "./fixture.js";

test("schema validates a sample 2-chapter book", () => {
  const parsed = BookModelSchema.parse(sampleBook());
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.chapters[0].nodes[0].type, "heading");
});

test("schema rejects unknown node type and bad schemaVersion", () => {
  const bad = sampleBook();
  (bad.chapters[0].nodes[0] as { type: string }).type = "video";
  assert.throws(() => BookModelSchema.parse(bad));
  assert.throws(() => BookModelSchema.parse({ ...sampleBook(), schemaVersion: "2.0" }));
});

test("operation envelope parses with defaults", () => {
  const op = DocumentOperationSchema.parse({
    operationId: "op1",
    type: "replace_text",
    target: { chapterId: CH1, nodeId: "n2" },
    payload: { nodeId: "n2", from: 0, to: 5, text: "x" },
    expectedVersion: 0,
  });
  assert.equal(op.source, "human");
  assert.equal(op.sourceRef, null);
});

test("validateBookModel accepts the fixture", () => {
  const r = validateBookModel(sampleBook());
  assert.equal(r.valid, true);
  assert.deepEqual(r.issues, []);
});

test("validateBookModel reports schema errors on garbage", () => {
  const r = validateBookModel({ nope: 1 });
  assert.equal(r.valid, false);
  assert.ok(r.issues.every((i) => i.code === "schema_error"));
});

test("validateBookModel flags missing title, empty chapter, duplicate node id", () => {
  const book = sampleBook();
  book.metadata.title = "  ";
  book.chapters[1].nodes = [];
  book.chapters[0].nodes[2] = { ...book.chapters[0].nodes[1] };
  const r = validateBookModel(book);
  assert.equal(r.valid, false);
  const codes = r.issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ["duplicate_node_id", "empty_chapter", "missing_title"]);
});
