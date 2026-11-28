import assert from "node:assert/strict";
import { test } from "node:test";
import { clearChapterCreation, readChapterCreation, saveChapterCreation } from "../lib/chapter-creation-recovery";

const actorId = "11111111-1111-4111-8111-111111111111";
const bookId = "22222222-2222-4222-8222-222222222222";
const requestKey = "33333333-3333-4333-8333-333333333333";
const pointer = { schema: 1 as const, actorId, bookId, requestKey };

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
}

test("chapter recovery keeps only scoped request identity and refuses replacement", () => {
  const store = storage();
  saveChapterCreation(store, pointer);
  assert.deepEqual(readChapterCreation(store, actorId, bookId), pointer);
  assert.equal(readChapterCreation(store, "44444444-4444-4444-8444-444444444444", bookId), null);
  assert.equal(readChapterCreation(store, actorId, "55555555-5555-4555-8555-555555555555"), null);
  assert.doesNotMatch([...store.data.values()][0], /title|brief/i);
  assert.throws(() => saveChapterCreation(store, pointer), /earlier chapter request/);
  assert.throws(() => clearChapterCreation(store, { ...pointer, requestKey: "66666666-6666-4666-8666-666666666666" }), /different chapter/);
  clearChapterCreation(store, pointer);
  assert.equal(readChapterCreation(store, actorId, bookId), null);
});

test("invalid or unavailable recovery storage blocks a new request", () => {
  const store = storage();
  saveChapterCreation(store, pointer);
  const storageKey = [...store.data.keys()][0];
  store.data.set(storageKey, JSON.stringify({ ...pointer, actorId: "other" }));
  assert.throws(() => readChapterCreation(store, actorId, bookId), /unreadable/);
  assert.throws(() => saveChapterCreation(store, pointer), /unreadable/);
  assert.throws(() => saveChapterCreation({ getItem: () => null, setItem: () => { throw new Error(); } }, pointer), /No new chapter was sent/);
});
