import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearManualBiblePointer, manualBibleIntentDigest, manualBibleRecoveryKey, manualBibleRetryAllowed, parseManualBiblePointer,
  persistManualBiblePointer, validateManualBibleResult, type ManualBiblePointer,
} from "../lib/manual-bible-recovery";

const USER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const time = "2026-10-13T00:00:00Z";
const pointer: ManualBiblePointer = { schema: 2, userId: USER, bookId: BOOK, requestId: REQUEST, action: "create", targetId: null, expectedUpdatedAt: null, expectedIncarnationId: null, intentDigest: "a".repeat(64) };
const item = { id: ITEM, book_id: BOOK, mutation_incarnation_id: USER, type: "character", name: "Current canon", description: "Current private text", attributes_json: { traits: ["careful", "bold"] }, source_refs_json: [], updated_at: time };
const result = { receipt: { requestId: REQUEST, bookId: BOOK, action: "create", itemId: ITEM, intentHash: "b".repeat(64), resultHash: "c".repeat(64), resultUpdatedAt: time, committedAt: time }, disposition: "unchanged", item, replayed: true, closed: false };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}

test("manual pointers bind the real account and book and contain no entry body", () => {
  const saved = storage();
  persistManualBiblePointer(saved, { ...pointer, description: "PRIVATE-CANON", attributes: { secret: "PRIVATE-TRAITS" } } as ManualBiblePointer);
  const raw = saved.getItem(manualBibleRecoveryKey(USER, BOOK))!;
  assert(!raw.includes("PRIVATE-"));
  assert.deepEqual(parseManualBiblePointer(raw, USER, BOOK), pointer);
  assert.throws(() => parseManualBiblePointer(raw, ITEM, BOOK));
  assert.throws(() => parseManualBiblePointer(raw, USER, ITEM));
  assert.throws(() => manualBibleRecoveryKey("universal-user", BOOK));
});

test("malformed or extended checkpoints cannot be silently replaced", () => {
  for (const value of [{ ...pointer, requestId: "bad" }, { ...pointer, schema: 3 }, { ...pointer, intentDigest: "bad" }, { ...pointer, targetId: ITEM }, { ...pointer, action: "update" }, { ...pointer, expectedIncarnationId: ITEM }, { ...pointer, privateText: "PRIVATE-CANON" }]) {
    assert.throws(() => parseManualBiblePointer(JSON.stringify(value), USER, BOOK));
  }
  assert.throws(() => parseManualBiblePointer("not-json", USER, BOOK));
  assert.equal(parseManualBiblePointer(null, USER, BOOK), null);
});

test("legacy pointers stay recoverable and closable but cannot dispatch inferred entry incarnations", () => {
  const { expectedIncarnationId: _incarnation, ...base } = pointer;
  const legacy = { ...base, schema: 1 as const, action: "update" as const, targetId: ITEM, expectedUpdatedAt: time };
  const saved = storage(); persistManualBiblePointer(saved, legacy);
  const raw = saved.getItem(manualBibleRecoveryKey(USER, BOOK))!;
  assert.deepEqual(parseManualBiblePointer(raw, USER, BOOK), legacy);
  assert.equal(manualBibleRetryAllowed(legacy), false); assert.equal(manualBibleRetryAllowed(pointer), true);
  assert.throws(() => parseManualBiblePointer(JSON.stringify({ ...legacy, expectedIncarnationId: USER }), USER, BOOK));
  const modern = { ...legacy, schema: 2 as const, expectedIncarnationId: USER };
  assert.equal(manualBibleRetryAllowed(modern), true);
  persistManualBiblePointer(saved, modern); assert.deepEqual(parseManualBiblePointer(saved.getItem(manualBibleRecoveryKey(USER, BOOK)), USER, BOOK), modern);
  for (const token of [null, undefined, "guessed-incarnation"]) assert.throws(() => parseManualBiblePointer(JSON.stringify({ ...modern, expectedIncarnationId: token }), USER, BOOK));
});

test("durable preparation verifies storage before a caller can dispatch", () => {
  assert.throws(() => persistManualBiblePointer({ getItem: () => null, setItem: () => {} }, pointer), /No manual Book Bible write was sent/);
  assert.throws(() => persistManualBiblePointer({ getItem: () => null, setItem() { throw new Error("quota"); } }, pointer), /No manual Book Bible write was sent/);
});

test("clearing a confirmed pointer cannot remove a newer request", () => {
  const saved = storage(); persistManualBiblePointer(saved, pointer);
  clearManualBiblePointer(saved, pointer); assert.equal(saved.values.size, 0);
  persistManualBiblePointer(saved, { ...pointer, requestId: ITEM });
  assert.throws(() => clearManualBiblePointer(saved, pointer), /newer saved request/);
  assert.equal(saved.values.size, 1);
});

test("exact-body digests ignore object insertion order and request UUID but retain every canon field and operation", async () => {
  const body = { name: "Elara", description: "PRIVATE-CANON", attributes: { traits: ["bold", "quiet"], nested: { b: 2, a: true } }, imageAssetIds: [ITEM], sourceRefs: [] };
  const first = await manualBibleIntentDigest("create", null, body);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, await manualBibleIntentDigest("create", null, { requestId: REQUEST, sourceRefs: [], imageAssetIds: [ITEM], attributes: { nested: { a: true, b: 2 }, traits: ["bold", "quiet"] }, description: "PRIVATE-CANON", name: "Elara" }));
  for (const change of [{ name: "Other" }, { description: "Changed" }, { attributes: {} }, { sourceRefs: [{ chapterId: ITEM }] }, { imageAssetIds: [] }]) assert.notEqual(first, await manualBibleIntentDigest("create", null, { ...body, ...change }));
  assert.notEqual(first, await manualBibleIntentDigest("update", ITEM, body));
  const update = { ...body, expectedUpdatedAt: time, expectedIncarnationId: USER };
  assert.notEqual(await manualBibleIntentDigest("update", ITEM, update), await manualBibleIntentDigest("update", ITEM, { ...update, expectedIncarnationId: ITEM }));
});

test("receipt verification accepts matching instants and current changed canon", () => {
  assert.equal(validateManualBibleResult({ ...result, item: { ...item, updated_at: "2026-10-13T00:00:00+00:00" } }, pointer).item?.name, "Current canon");
  assert.equal(validateManualBibleResult({ ...result, disposition: "changed", item: { ...item, name: "Newer canon", updated_at: "2026-10-13T01:00:00Z" } }, pointer).item?.name, "Newer canon");
});

test("receipt verification fences foreign book, request, action, target and malformed current item", () => {
  for (const patch of [{ requestId: ITEM }, { bookId: ITEM }, { action: "delete" }, { itemId: "bad" }, { resultHash: "bad" }, { resultUpdatedAt: null }]) assert.throws(() => validateManualBibleResult({ ...result, receipt: { ...result.receipt, ...patch } }, pointer));
  for (const patch of [{ id: USER }, { book_id: USER }, { updated_at: "2026-10-13T01:00:00Z" }, { mutation_incarnation_id: undefined }, { mutation_incarnation_id: "bad" }, { attributes_json: null }, { source_refs_json: "bad" }]) assert.throws(() => validateManualBibleResult({ ...result, item: { ...item, ...patch } }, pointer));
  const update = { ...pointer, action: "update" as const, targetId: USER, expectedUpdatedAt: time, expectedIncarnationId: USER };
  assert.throws(() => validateManualBibleResult({ ...result, receipt: { ...result.receipt, action: "update" } }, update));
});

test("confirmed deletion follows current disposition rather than reviving or deleting current canon", () => {
  const deletion = { ...pointer, action: "delete" as const, targetId: ITEM, expectedUpdatedAt: time, expectedIncarnationId: USER };
  const receipt = { ...result.receipt, action: "delete" };
  assert.equal(validateManualBibleResult({ ...result, receipt, disposition: "deleted", item: null }, deletion).item, null);
  assert.equal(validateManualBibleResult({ ...result, receipt, disposition: "changed" }, deletion).item?.name, "Current canon");
  assert.throws(() => validateManualBibleResult({ ...result, receipt }, deletion));
  assert.throws(() => validateManualBibleResult({ ...result, receipt, disposition: "deleted" }, deletion));
});

test("only the exact missing receipt response represents an unconfirmed absent result", () => {
  assert.deepEqual(validateManualBibleResult({ receipt: null, disposition: null, item: null, replayed: false, closed: false }, pointer), { receipt: null, disposition: null, item: null, replayed: false, closed: false, closure: null });
  for (const value of [{ receipt: null, disposition: null, item, replayed: false, closed: false }, { receipt: null, disposition: "deleted", item: null, replayed: false, closed: false }, { receipt: null, disposition: null, item: null, replayed: true, closed: false }, { receipt: null, disposition: null, item: null, replayed: false }, { item }]) assert.throws(() => validateManualBibleResult(value, pointer));
});

test("only an empty identity-bound proven closure envelope can close an unresolved pointer", () => {
  const closed = { receipt: null, disposition: null, item: null, replayed: false, closed: true, closure: { requestId: REQUEST, bookId: BOOK, closedAt: time } };
  assert.equal(validateManualBibleResult(closed, pointer).closed, true);
  for (const closure of [undefined, null, { ...closed.closure, requestId: ITEM }, { ...closed.closure, bookId: ITEM }, { ...closed.closure, closedAt: "not-a-timestamp" }, { ...closed.closure, closedAt: "10/13/2026" }, { ...closed.closure, closedAt: "2026-10-13T00:00" }]) assert.throws(() => validateManualBibleResult({ ...closed, closure }, pointer));
  assert.throws(() => validateManualBibleResult({ ...result, closure: closed.closure }, pointer));
  assert.throws(() => validateManualBibleResult({ ...closed, closed: false }, pointer));
  for (const value of [{ ...result, closed: true }, { receipt: null, disposition: null, item, replayed: false, closed: true }, { receipt: null, disposition: "deleted", item: null, replayed: false, closed: true }, { receipt: null, disposition: null, item: null, replayed: true, closed: true }, { receipt: null, disposition: null, item: null, replayed: false, closed: "true" }]) assert.throws(() => validateManualBibleResult(value, pointer));
});
