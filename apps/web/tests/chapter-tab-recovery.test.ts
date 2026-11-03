import test from "node:test";
import assert from "node:assert/strict";
import { chapterTabRecoveryKey, readChapterTabRecovery, openChapterTabRecovery, writeChapterTabRecovery, discardChapterTabRecovery } from "../lib/chapter-tab-recovery";
import type { BookNode } from "@bookworm/book-model";

function store(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, getItem: k => m.get(k) ?? null, setItem: (k,v) => { m.set(k,v); }, removeItem: k => { m.delete(k); } };
}
const scope = { userId: "actor-a", bookId: "book", chapterId: "chapter", baseVersion: 3 };
const nodes: BookNode[] = [{ id: "p", type: "paragraph", text: "private draft" }];

test("tab snapshot is scoped and only explicit write stores text", () => {
  const s = store(); assert.equal(readChapterTabRecovery(s, scope), null); assert.equal(s.length, 0);
  const raw = writeChapterTabRecovery(s, scope, nodes, null);
  assert.deepEqual(openChapterTabRecovery(raw, scope), nodes);
  assert.equal(readChapterTabRecovery(s, { ...scope, userId: "actor-b" }), null);
  assert.equal(readChapterTabRecovery(s, { ...scope, bookId: "other" }), null);
  assert.equal(readChapterTabRecovery(s, { ...scope, chapterId: "other" }), null);
  assert.throws(() => openChapterTabRecovery(raw, { ...scope, userId: "actor-b" }), /different account/);
  assert.throws(() => openChapterTabRecovery(raw, { ...scope, baseVersion: 4 }), /has changed/);
  assert.throws(() => chapterTabRecoveryKey({ ...scope, userId: "" }), /could not be verified/);
});

test("compare and replace retains a different or malformed snapshot", () => {
  const s = store(), raw = writeChapterTabRecovery(s, scope, nodes, null);
  assert.throws(() => writeChapterTabRecovery(s, scope, nodes, null), /different local draft/);
  assert.throws(() => discardChapterTabRecovery(s, scope, "wrong"), /changed/);
  assert.equal(readChapterTabRecovery(s, scope), raw);
  s.setItem(chapterTabRecoveryKey(scope), "{broken");
  assert.throws(() => openChapterTabRecovery("{broken", scope), /valid JSON/);
  assert.throws(() => discardChapterTabRecovery(s, scope, raw), /changed/);
  discardChapterTabRecovery(s, scope, "{broken"); assert.equal(s.length, 0);
});

test("quota and invalid manuscript fail without replacing prior snapshot", () => {
  const s = store(), raw = writeChapterTabRecovery(s, scope, nodes, null);
  assert.throws(() => writeChapterTabRecovery(s, scope, [{ id: "p", type: "paragraph", text: "x".repeat(5 * 1024 * 1024) }], raw), /too large/);
  assert.throws(() => writeChapterTabRecovery(s, scope, [...nodes, ...nodes], raw), /invalid manuscript blocks/);
  const denied = { ...s, setItem: () => { throw new Error("quota"); } };
  assert.throws(() => writeChapterTabRecovery(denied, scope, nodes, raw), /could not store/);
  assert.equal(readChapterTabRecovery(s, scope), raw);
});
