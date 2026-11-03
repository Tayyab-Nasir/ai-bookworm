import { test } from "node:test";
import assert from "node:assert/strict";
import type { Edition } from "@bookworm/types";
import { DEFAULT_FORM } from "../lib/publishing-edition-form";
import { editionBase, editionTabKey, parseEditionTab, readEditionTab, writeEditionTab, discardEditionTab } from "../lib/edition-tab-recovery";

const scope = { actor: "11111111-1111-4111-8111-111111111111", bookId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const edition = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", book_id: scope.bookId, type: "ebook", language: "en", updated_at: "2026-11-03T00:00:00.123456Z", edition_metadata_json: { kind: "ebook", unknown: { keep: true } } } as unknown as Edition;
const memory = () => { const values = new Map<string,string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key) } as unknown as Storage; };

test("edition copies require account, book, exact edition and saved metadata", () => {
  const storage = memory(), form = { ...DEFAULT_FORM, publisher: "PRIVATE IMPRINT" };
  assert.equal(readEditionTab(storage,scope),null);
  const raw = writeEditionTab(storage,scope,edition,form,null), parsed = parseEditionTab(raw,scope);
  assert.equal(parsed.editionId,edition.id); assert.equal(parsed.base,editionBase(edition,scope.bookId)); assert.equal(parsed.form.publisher,form.publisher);
  assert.notEqual(editionBase({ ...edition, edition_metadata_json: { kind: "ebook", unknown: { keep: false } } },scope.bookId),parsed.base);
  assert.throws(() => parseEditionTab(raw,{ ...scope, actor: "22222222-2222-4222-8222-222222222222" }));
  assert.throws(() => editionTabKey({ ...scope,bookId:"invalid" }));
});
test("compare-and-replace and discard preserve a changed copy", () => {
  const storage = memory(), raw = writeEditionTab(storage,scope,edition,DEFAULT_FORM,null);
  assert.throws(() => writeEditionTab(storage,scope,edition,DEFAULT_FORM,null),/changed/);
  storage.setItem(editionTabKey(scope),"OTHER");
  assert.throws(() => discardEditionTab(storage,scope,raw),/changed/); assert.equal(readEditionTab(storage,scope),"OTHER");
});
test("invalid, missing-field, oversized and non-finite copies fail closed", () => {
  const storage = memory(), raw = writeEditionTab(storage,scope,edition,DEFAULT_FORM,null), parsed = JSON.parse(raw);
  assert.throws(() => parseEditionTab("bad",scope));
  parsed.form.kind = "unrecognized"; assert.throws(() => parseEditionTab(JSON.stringify(parsed),scope),/invalid format/); parsed.form.kind = "ebook";
  delete parsed.form.publisher; assert.throws(() => parseEditionTab(JSON.stringify(parsed),scope));
  assert.throws(() => parseEditionTab("x".repeat(512*1024+1),scope),/too large/);
  assert.throws(() => writeEditionTab(memory(),scope,edition,{...DEFAULT_FORM,bodySize:NaN},null),/invalid/);
});
test("storage quota errors do not replace the previous copy", () => {
  const storage = memory(), raw = writeEditionTab(storage,scope,edition,DEFAULT_FORM,null);
  storage.setItem = () => { throw new Error("quota"); };
  assert.throws(() => writeEditionTab(storage,scope,edition,{...DEFAULT_FORM,publisher:"updated"},raw),/could not save/);
  assert.equal(readEditionTab(storage,scope),raw);
});
