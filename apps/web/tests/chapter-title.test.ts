import { test } from "node:test";
import assert from "node:assert/strict";
import { clearTitleChange, parseTitleChange, persistTitleChange, titleChangeKey, titleDigest, validateTitleResult, validChapterTitle, type TitleChangePointer } from "../lib/chapter-title";

const scope = { userId: "author", bookId: "book", chapterId: "chapter" };
const p: TitleChangePointer = { ...scope, schema: 1, operationId: "b5100000-0000-4000-8000-000000000004", expectedRevision: 0, titleDigest: await titleDigest("New title") };
const current = { title: "New title", revision: 1, updatedAt: "2026-10-23T15:00:00Z" };
const saved = { bookId: scope.bookId, chapterId: scope.chapterId, operationId: p.operationId, expectedRevision: 0, titleDigest: p.titleDigest, status: "saved", receipt: { title: "New title", revision: 1 }, current };
function storage() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }; }

test("chapter title recovery stores metadata only, preserves identity, and is account/chapter scoped", () => {
  const s = storage(); persistTitleChange(s, p); persistTitleChange(s, p);
  assert.equal(s.data.size, 1); assert.equal(s.getItem(titleChangeKey(p))!.includes("New title"), false);
  assert.deepEqual(parseTitleChange(s.getItem(titleChangeKey(p)), scope), p);
  assert.throws(() => parseTitleChange(s.getItem(titleChangeKey(p)), { ...scope, userId: "different" }));
  assert.throws(() => persistTitleChange(s, { ...p, expectedRevision: 1 }));
  assert.throws(() => clearTitleChange(s, { ...p, titleDigest: "0".repeat(64) }));
  clearTitleChange(s, p); assert.equal(s.data.size, 0);
});
test("chapter title recovery rejects malformed or content-bearing browser records", () => {
  for (const patch of [{ title: "private text" }, { operationId: "bad" }, { expectedRevision: -1 }, { expectedRevision: "0" }, { titleDigest: "x" }, { schema: 2 }]) {
    assert.throws(() => parseTitleChange(JSON.stringify({ ...p, ...patch }), scope));
  }
  assert.equal(parseTitleChange(null, scope), null);
});
test("chapter title receipt validation distinguishes immutable saved outcome from newer current title", async () => {
  assert.deepEqual(await validateTitleResult(saved, p), saved);
  const later = { ...saved, current: { ...current, title: "Collaborator title", revision: 2 } };
  assert.deepEqual(await validateTitleResult(later, p), later);
  for (const status of ["closed", "conflict", "not_found"]) {
    assert.equal((await validateTitleResult({ ...saved, status, receipt: null }, p)).status, status);
  }
});
test("chapter title receipt cannot settle another request or inconsistent manuscript context", async () => {
  for (const patch of [{ operationId: "wrong" }, { chapterId: "wrong" }, { bookId: "wrong" }, { expectedRevision: 1 }, { titleDigest: "0".repeat(64) }, { receipt: null }, { receipt: { title: "Wrong", revision: 1 } }, { current: { ...current, title: "Different at same revision" } }, { current: { ...current, revision: -1 } }, { current: { ...current, updatedAt: "invalid" } }, { status: "unknown" }]) {
    await assert.rejects(validateTitleResult({ ...saved, ...patch }, p));
  }
});
test("chapter title validation supports multilingual text but rejects blank, control and oversized titles", async () => {
  assert.equal(validChapterTitle("باب اوّل — 🌙"), true);
  for (const title of ["", "  ", " padded ", "One\nTwo", "one\tTwo", "one\u0085Two", "x".repeat(501)]) assert.equal(validChapterTitle(title), false);
  assert.equal((await titleDigest("باب اوّل — 🌙")).length, 64);
});
test("storage failures cannot silently discard a title recovery pointer", () => {
  assert.throws(() => persistTitleChange({ getItem: () => null, setItem: () => {} }, p));
  const s = storage(); persistTitleChange(s, p);
  assert.throws(() => clearTitleChange({ getItem: s.getItem, removeItem: () => {} }, p));
});
