import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";
import { clearChapterSave, chapterSaveDigest, chapterSaveKey, parseChapterSave, persistChapterSave, validateChapterSaveResult, validateSavedChapter, validateCurrentChapter } from "../lib/manual-chapter-save";

const scope = { userId: "11111111-1111-4111-8111-111111111111", bookId: "22222222-2222-4222-8222-222222222222", chapterId: "33333333-3333-4333-8333-333333333333" };
const nodes = [{ id: "n", type: "paragraph" as const, text: "PRIVATE MANUSCRIPT", attributes: { richText: [{ type: "text", text: "PRIVATE MANUSCRIPT" }] } }];
const pointer = { schema: 1 as const, ...scope, operationId: "44444444-4444-4444-8444-444444444444", expectedVersion: 2, digest: "a".repeat(64) };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("manual save recovery persists only exact account/book/chapter identity and intent digest", () => {
  const store = storage(); persistChapterSave(store, { ...pointer, nodes } as typeof pointer);
  const raw = store.getItem(chapterSaveKey(scope))!;
  assert.equal(raw.includes("PRIVATE"), false); assert.equal(raw.includes("nodes"), false);
  assert.deepEqual(parseChapterSave(raw, scope), pointer);
  for (const key of ["userId", "bookId", "chapterId"] as const) assert.throws(() => parseChapterSave(raw, { ...scope, [key]: "another" }), /invalid/);
  for (const raw of ["{}", "not-json", JSON.stringify({ ...pointer, expectedVersion: -1 }), JSON.stringify({ ...pointer, nodes })]) assert.throws(() => parseChapterSave(raw, scope), /invalid/);
  assert.equal(parseChapterSave(null, scope), null);
});

test("storage failure and another pending request cannot be silently replaced or cleared", () => {
  const store = storage(); persistChapterSave(store, pointer);
  const other = { ...pointer, operationId: "55555555-5555-4555-8555-555555555555" };
  assert.throws(() => persistChapterSave(store, other), /pending/);
  assert.throws(() => clearChapterSave(store, other), /different/);
  assert.throws(() => persistChapterSave({ ...store, setItem: () => { throw Error("blocked"); } }, pointer), /storage/);
  clearChapterSave(store, pointer); assert.equal(store.getItem(chapterSaveKey(scope)), null);
});

test("manuscript digest preserves semantic order but ignores object key ordering", async () => {
  const digest = await chapterSaveDigest(nodes);
  assert.equal(digest, await chapterSaveDigest([{ attributes: nodes[0].attributes, text: nodes[0].text, type: "paragraph", id: "n" }]));
  assert.notEqual(digest, await chapterSaveDigest([{ ...nodes[0], text: "Changed" }]));
});

test("a supported large chapter remains recoverable within the API's canonical limit", async () => {
  const large = Array.from({ length: 10001 }, (_, index) => ({ id: `n${index}`, type: "paragraph" as const, text: "Line" }));
  await validateSavedChapter({ chapterId: scope.chapterId, version: 3, nodes: large }, { ...pointer, digest: await chapterSaveDigest(large) });
});

test("current document adoption rejects malformed versions, unsupported content and duplicate identities", () => {
  const valid = { chapterId: scope.chapterId, version: 3, nodes };
  validateCurrentChapter(valid, scope.chapterId, 3);
  for (const patch of [{ chapterId: "other" }, { version: "3" }, { version: NaN }, { version: 2 }, { nodes: null }, { nodes: [{ id: "n", type: "unknown" }] }, { nodes: [...nodes, ...nodes] }])
    assert.throws(() => validateCurrentChapter({ ...valid, ...patch }, scope.chapterId, 3), /could not be verified/);
});

test("manual save transports bind the actor and never generate a new closure request key", async () => {
  const original = globalThis.fetch, calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return Response.json({}); };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    await api.saveChapterDocument(scope.chapterId, { nodes, expectedVersion: 2, operationId: pointer.operationId }, scope.userId);
    await api.getManualChapterSaveStatus(scope.chapterId, pointer.operationId, 2, scope.userId);
    await api.closeManualChapterSave(scope.chapterId, pointer.operationId, 2, scope.userId);
    assert.deepEqual(calls.map(c => c.init?.method), ["PUT", "GET", "POST"]);
    assert.ok(calls.every(c => new Headers(c.init?.headers).get("x-bookworm-actor") === scope.userId && !new Headers(c.init?.headers).has("idempotency-key") && c.init?.credentials === "same-origin"));
    assert.equal(calls[1].init?.body, undefined);
    assert.match(calls[1].url, /\?expectedVersion=2$/);
    assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { expectedVersion: 2 });
  } finally { globalThis.fetch = original; }
});

test("recovery confirms immutable saved content and rejects foreign or inconsistent receipts", async () => {
  const checked = { ...pointer, digest: await chapterSaveDigest(nodes) };
  const result = { status: "saved", operationId: pointer.operationId, bookId: scope.bookId, chapterId: scope.chapterId, expectedVersion: 2, currentVersion: 7,
    receipt: { versionId: "v3", document: { chapterId: scope.chapterId, version: 3, nodes } } };
  assert.equal((await validateChapterSaveResult(result, checked)).status, "saved");
  for (const patch of [{ operationId: "other" }, { bookId: "other" }, { currentVersion: 2 }, { receipt: { ...result.receipt, document: { ...result.receipt.document, version: 4 } } }])
    await assert.rejects(validateChapterSaveResult({ ...result, ...patch }, checked), /confirm|match/);
  await assert.rejects(validateChapterSaveResult(result, pointer), /match/);
  for (const status of ["not_found", "superseded", "closed"]) {
    const response = { ...result, status, currentVersion: status === "not_found" ? 2 : 3, receipt: status === "closed" ? result.receipt : null };
    assert.equal((await validateChapterSaveResult(response, checked)).status, status);
  }
  await assert.rejects(validateChapterSaveResult({ ...result, status: "superseded", currentVersion: 2, receipt: null }, checked), /confirm/);
});
