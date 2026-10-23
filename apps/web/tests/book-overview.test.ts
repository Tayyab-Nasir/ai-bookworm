import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, parseBookOverview, type BookOverview } from "../../../packages/api-client/src/index.js";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const BOOK = id(1), USER = id(2), SPACE = id(3), now = "2026-10-24T00:00:00.000Z";
function fixture(): BookOverview {
  return { viewerId: USER, observedAt: now,
    book: { id: BOOK, workspaceId: SPACE, title: "The Harbor Notebook", subtitle: null, authorName: "A. Author", language: "en", genre: null, status: "draft", updatedAt: now },
    workspace: { id: SPACE, name: "Author studio", role: "owner" },
    manuscript: { chapterCount: 1, wordCount: 35, chaptersWithoutSavedVersion: 0 },
    chapters: [{ id: id(4), title: "Harbor", orderIndex: 0, versionNumber: 2, wordCount: 35, updatedAt: now }], bibleItems: 1,
    listing: { description: false, keywords: 0, categories: 0, isbn: false }, editionsTotal: 0, editions: [], history: { renders: 0, packages: 0 },
    jobs: [{ id: id(5), kind: "import", label: "Manuscript import", status: "succeeded", createdAt: now, completedAt: now, destination: "editor" }] };
}
test("book desk client accepts only exact book/workspace scope and consistent saved totals", () => {
  const value = fixture(); assert.deepEqual(parseBookOverview(value, BOOK), value);
  for (const change of [
    (v: BookOverview) => { v.book.id = id(99); },
    (v: BookOverview) => { v.workspace.id = id(99); },
    (v: BookOverview) => { v.manuscript.wordCount++; },
    (v: BookOverview) => { v.manuscript.chapterCount++; },
    (v: BookOverview) => { v.manuscript.chaptersWithoutSavedVersion++; },
    (v: BookOverview) => { v.workspace.role = "superadmin"; },
    (v: BookOverview) => { v.observedAt = "yesterday"; },
    (v: BookOverview) => { v.bibleItems = -1; },
  ]) { const invalid = fixture(); change(invalid); assert.throws(() => parseBookOverview(invalid, BOOK), /could not be verified/); }
});
test("book desk refuses misleading unsaved versions, duplicate chapters and wrong ordering", () => {
  for (const change of [
    (v: BookOverview) => { v.chapters[0].versionNumber = null; },
    (v: BookOverview) => { v.chapters[0].wordCount = NaN; },
    (v: BookOverview) => { v.chapters[0].versionNumber = 0; },
    (v: BookOverview) => { v.chapters.push({ ...v.chapters[0] }); v.manuscript.chapterCount = 2; v.manuscript.wordCount = 70; },
    (v: BookOverview) => { v.chapters.push({ ...v.chapters[0], id: id(99), orderIndex: 0 }); v.manuscript.chapterCount = 2; v.manuscript.wordCount = 70; },
    (v: BookOverview) => { v.chapters.push({ ...v.chapters[0], id: id(99), orderIndex: 1 }); v.chapters.reverse(); v.manuscript.chapterCount = 2; v.manuscript.wordCount = 70; },
  ]) { const value = fixture(); change(value); assert.throws(() => parseBookOverview(value, BOOK)); }
  const unsaved = fixture(); unsaved.chapters[0] = { ...unsaved.chapters[0], versionNumber: null, wordCount: 0, updatedAt: null };
  unsaved.manuscript = { chapterCount: 1, wordCount: 0, chaptersWithoutSavedVersion: 1 }; assert.equal(parseBookOverview(unsaved, BOOK).chapters[0].versionNumber, null);
});
test("overview payloads cannot smuggle private job inputs or malformed operational facts", () => {
  for (const change of [
    (v: any) => { v.secret = "private manuscript"; },
    (v: any) => { v.book.storagePath = "private manuscript"; },
    (v: any) => { v.jobs[0].request_json = { prompt: "private manuscript" }; },
    (v: any) => { v.jobs[0].status = "published"; },
    (v: any) => { v.jobs[0].destination = "https://unowned.example"; },
    (v: any) => { v.jobs.push({ ...v.jobs[0] }); },
    (v: any) => { v.history.packages = Infinity; },
    (v: any) => { v.editions = [{ id: id(9), kind: "ebook", status: "draft", updatedAt: now, coverArtworkChosen: true }]; },
    (v: any) => { v.listing.description = "private manuscript"; },
  ]) { const value = fixture(); change(value); assert.throws(() => parseBookOverview(value, BOOK)); }
});
test("typed overview fetch is a read and validates the returned book before exposing it", async () => {
  const original = globalThis.fetch, calls: { input: string; method?: string }[] = [];
  try {
    globalThis.fetch = async (input, init) => { calls.push({ input: String(input), method: init?.method }); return new Response(JSON.stringify(fixture()), { headers: { "content-type": "application/json" } }); };
    const api = createClient({ baseUrl: "/api/backend" });
    assert.equal((await api.getBookOverview(BOOK)).book.id, BOOK);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET"); assert(calls[0].input.endsWith(`/v1/books/${BOOK}/overview`));
    await assert.rejects(api.getBookOverview(id(99)), /could not be verified/);
  } finally { globalThis.fetch = original; }
});
