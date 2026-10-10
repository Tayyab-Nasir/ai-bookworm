import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleBookModel, bookModelFingerprint } from "./lib/authoring.js";
import type { SupabaseClient } from "./lib/supabase.js";
import { assertSourceJob } from "./routes/publishing.js";

const BOOK = { id: "10000000-0000-4000-8000-000000000001", workspace_id: "20000000-0000-4000-8000-000000000002",
  title: "Saved metadata fixture", author_name: "Fixture Author", language: "en" };

function fixture(metadata: Record<string, unknown> | null) {
  const tables: Record<string, Record<string, unknown>[]> = {
    chapters: [], book_metadata: metadata ? [metadata] : [], style_guides: [], book_bible_items: [],
  };
  let externalCalls = 0;
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "limit"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: tables[table]?.[0] ?? null, error: null });
      builder.then = (resolve: (result: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
      return builder;
    },
    storage: { from: () => { externalCalls++; throw new Error("No storage call is permitted in this metadata fixture."); } },
    rpc: () => { externalCalls++; throw new Error("No RPC is permitted in this metadata fixture."); },
  } as unknown as SupabaseClient;
  return { client, externalCalls: () => externalCalls };
}

test("saved publication date reaches the model and a date-only edit invalidates source proofs", async () => {
  const row = { publication_date: "2024-02-29", description: "Saved listing text", keywords: ["fiction"], categories: ["Fiction"], isbn13: null, edition: "First" };
  const store = fixture(row);
  const before = await assembleBookModel(store.client, BOOK);
  assert.equal(before.metadata.publicationDate, row.publication_date);
  row.publication_date = "2026-11-01";
  const after = await assembleBookModel(store.client, BOOK);
  assert.equal(after.metadata.publicationDate, row.publication_date);
  assert.notEqual(bookModelFingerprint(before), bookModelFingerprint(after));
  for (const action of ["render", "validate"] as const) {
    const expected = { action, bookId: BOOK.id, editionId: "30000000-0000-4000-8000-000000000003",
      channel: action === "render" ? "render" : "kdp", editionUpdatedAt: "2026-01-01T00:00:00Z",
      bookModelSha256: bookModelFingerprint(before) };
    const proof = { status: "succeeded", book_id: expected.bookId, edition_id: expected.editionId,
      channel: expected.channel, request_json: { action, editionUpdatedAt: expected.editionUpdatedAt,
        bookModelSha256: expected.bookModelSha256 } };
    assert.doesNotThrow(() => assertSourceJob(proof, expected));
    assert.throws(() => assertSourceJob(proof, { ...expected, bookModelSha256: bookModelFingerprint(after) }),
      /Run a fresh successful/);
  }
  assert.deepEqual({ ...before.metadata, publicationDate: after.metadata.publicationDate }, after.metadata);
  assert.equal(store.externalCalls(), 0);
});

test("absent and null saved dates preserve the legacy canonical model and proof hash", async () => {
  const metadata = { description: "Saved listing text", keywords: [], categories: [], isbn13: null, edition: null };
  const absent = await assembleBookModel(fixture(metadata).client, BOOK);
  const nullDate = await assembleBookModel(fixture({ ...metadata, publication_date: null }).client, BOOK);
  assert.equal(Object.hasOwn(absent.metadata, "publicationDate"), false);
  assert.deepEqual(nullDate, absent);
  assert.equal(bookModelFingerprint(nullDate), bookModelFingerprint(absent));
});

test("invalid stored calendar dates cannot become a render or package snapshot", async () => {
  for (const publication_date of ["2026-02-30", "2026-1-01", "0000-01-01", "2026-01-01T00:00:00Z"]) {
    const store = fixture({ publication_date });
    await assert.rejects(assembleBookModel(store.client, BOOK));
    assert.equal(store.externalCalls(), 0);
  }
});
