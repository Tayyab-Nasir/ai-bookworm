import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOperation,
  VersionConflictError,
  NodeNotFoundError,
  ValidationError,
} from "./engine.js";
import type { DocumentOperation } from "./operations.js";
import { sampleBook, CH1, CH2, ASSET1 } from "./fixture.js";

const base = {
  operationId: "op",
  target: { chapterId: CH1, nodeId: "n2" },
  source: "human" as const,
  sourceRef: null,
  expectedVersion: 0,
};
const op = (type: string, payload: object, target = base.target): DocumentOperation =>
  ({ ...base, type, target, payload }) as DocumentOperation;

test("stale expectedVersion throws VersionConflictError and input is unchanged", () => {
  const book = sampleBook();
  const before = JSON.parse(JSON.stringify(book));
  assert.throws(
    () => applyOperation(book, op("delete_node", { nodeId: "n2" }), 5),
    (e) => e instanceof VersionConflictError && e.expected === 0 && e.actual === 5,
  );
  assert.deepEqual(book, before);
});

test("insert_node inserts at index and bumps version", () => {
  const { book, version } = applyOperation(
    sampleBook(),
    op("insert_node", {
      parentId: CH1,
      index: 1,
      node: { id: "n9", type: "separator" },
    }),
    0,
  );
  assert.equal(version, 1);
  assert.deepEqual(
    book.chapters[0].nodes.map((n) => n.id),
    ["n1", "n9", "n2", "n3"],
  );
});

test("insert_node rejects duplicate node id and out-of-bounds index", () => {
  assert.throws(
    () =>
      applyOperation(
        sampleBook(),
        op("insert_node", { parentId: CH1, index: 0, node: { id: "n1", type: "separator" } }),
        0,
      ),
    ValidationError,
  );
  assert.throws(
    () =>
      applyOperation(
        sampleBook(),
        op("insert_node", { parentId: CH1, index: 99, node: { id: "n9", type: "separator" } }),
        0,
      ),
    ValidationError,
  );
});

test("delete_node removes the node", () => {
  const { book } = applyOperation(sampleBook(), op("delete_node", { nodeId: "n2" }), 0);
  assert.deepEqual(
    book.chapters[0].nodes.map((n) => n.id),
    ["n1", "n3"],
  );
});

test("delete_node with bad id throws NodeNotFoundError", () => {
  assert.throws(
    () => applyOperation(sampleBook(), op("delete_node", { nodeId: "nope" }), 0),
    NodeNotFoundError,
  );
});

test("move_node reorders within a chapter (forward, index adjusts)", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("move_node", { nodeId: "n1", parentId: CH1, index: 3 }),
    0,
  );
  assert.deepEqual(
    book.chapters[0].nodes.map((n) => n.id),
    ["n2", "n3", "n1"],
  );
});

test("move_node across chapters", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("move_node", { nodeId: "n4", parentId: CH1, index: 0 }),
    0,
  );
  assert.deepEqual(
    book.chapters[0].nodes.map((n) => n.id),
    ["n4", "n1", "n2", "n3"],
  );
  assert.deepEqual(
    book.chapters[1].nodes.map((n) => n.id),
    ["n5"],
  );
});

test("replace_text honors from/to offsets", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("replace_text", { nodeId: "n2", from: 6, to: 11, text: "there" }),
    0,
  );
  assert.equal(book.chapters[0].nodes[1].text, "Hello there");
});

test("replace_text rejects bad range and text-less nodes", () => {
  assert.throws(
    () =>
      applyOperation(
        sampleBook(),
        op("replace_text", { nodeId: "n2", from: 0, to: 99, text: "x" }),
        0,
      ),
    ValidationError,
  );
  assert.throws(
    () =>
      applyOperation(
        sampleBook(),
        op("replace_text", { nodeId: "n5", from: 0, to: 1, text: "x" }, { chapterId: CH2, nodeId: "n5" }),
        0,
      ),
    ValidationError,
  );
});

test("set_attribute merges attributes and validates level", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("set_attribute", { nodeId: "n2", key: "align", value: "center" }),
    0,
  );
  assert.equal(book.chapters[0].nodes[1].attributes?.align, "center");
  assert.throws(
    () =>
      applyOperation(sampleBook(), op("set_attribute", { nodeId: "n1", key: "level", value: 9 }), 0),
    ValidationError,
  );
});

test("attach_asset sets assetId and updates asset role", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("attach_asset", { nodeId: "n2", assetId: ASSET1, role: "hero" }),
    0,
  );
  assert.equal(book.chapters[0].nodes[1].assetId, ASSET1);
  assert.equal(book.assets[0].role, "hero");
  assert.throws(
    () =>
      applyOperation(
        sampleBook(),
        op("attach_asset", { nodeId: "n2", assetId: "99999999-9999-4999-8999-999999999999", role: "x" }),
        0,
      ),
    NodeNotFoundError,
  );
});

test("detach_asset clears assetId", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("detach_asset", { nodeId: "n5", assetId: ASSET1 }, { chapterId: CH2, nodeId: "n5" }),
    0,
  );
  assert.equal(book.chapters[1].nodes[1].assetId, null);
  assert.throws(
    () =>
      applyOperation(
        sampleBook(),
        op("detach_asset", { nodeId: "n2", assetId: ASSET1 }),
        0,
      ),
    ValidationError,
  );
});

test("split_node splits text at offset", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("split_node", { nodeId: "n2", offset: 5 }),
    0,
  );
  const nodes = book.chapters[0].nodes;
  assert.equal(nodes.length, 4);
  assert.equal(nodes[1].text, "Hello");
  assert.equal(nodes[2].text, " world");
  assert.equal(nodes[2].type, "paragraph");
  assert.notEqual(nodes[2].id, nodes[1].id);
});

test("split_node rejects offset beyond text length", () => {
  assert.throws(
    () => applyOperation(sampleBook(), op("split_node", { nodeId: "n2", offset: 99 }), 0),
    ValidationError,
  );
});

test("merge_nodes concatenates adjacent text and drops right node", () => {
  const { book } = applyOperation(
    sampleBook(),
    op("merge_nodes", { leftNodeId: "n2", rightNodeId: "n3" }),
    0,
  );
  const nodes = book.chapters[0].nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].text, "Hello worldSecond para");
});

test("merge_nodes rejects non-adjacent nodes", () => {
  assert.throws(
    () => applyOperation(sampleBook(), op("merge_nodes", { leftNodeId: "n1", rightNodeId: "n3" }), 0),
    ValidationError,
  );
});

test("operations do not mutate the input book", () => {
  const book = sampleBook();
  const snapshot = JSON.parse(JSON.stringify(book));
  applyOperation(book, op("replace_text", { nodeId: "n2", from: 0, to: 5, text: "Bye" }), 0);
  applyOperation(book, op("move_node", { nodeId: "n3", parentId: CH1, index: 0 }), 0);
  assert.deepEqual(book, snapshot);
});
