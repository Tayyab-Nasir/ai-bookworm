import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assembleBookModel, bookModelFingerprint } from "./lib/authoring.js";
import { buildPublishingOutput, runOnePublishingJob } from "./lib/publishing-worker.js";

type Row = Record<string, unknown>;
const USER = "ca000000-0000-4000-8000-000000000001";
const ORG = "ca100000-0000-4000-8000-000000000001";
const WORKSPACE = "ca200000-0000-4000-8000-000000000001";
const BOOK = "ca300000-0000-4000-8000-000000000001";
const EDITION = "ca400000-0000-4000-8000-000000000001";
const CHAPTER = "ca500000-0000-4000-8000-000000000001";
const VERSION = "ca600000-0000-4000-8000-000000000001";
const JOB = "ca700000-0000-4000-8000-000000000001";
const LEASE = "ca800000-0000-4000-8000-000000000001";
const UPDATED = "2026-09-05T12:00:00.000Z";

function dataClient(tables: Record<string, Row[]>, uploads: { path: string; bytes: Buffer }[]) {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let limit: number | null = null;
      const selected = () => (tables[table] ?? []).filter((entry) => filters.every(([key, expected]) =>
        Array.isArray(expected) ? expected.includes(entry[key]) : entry[key] === expected)).slice(0, limit ?? undefined);
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.in = (key: string, value: unknown[]) => { filters.push([key, value]); return builder; };
      builder.gte = () => builder;
      builder.order = () => builder;
      builder.limit = (value: number) => { limit = value; return builder; };
      builder.maybeSingle = async () => ({ data: selected()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: selected(), error: null });
      return builder;
    },
    storage: { from: () => ({ upload: async (path: string, bytes: Buffer) => {
      uploads.push({ path, bytes }); return { data: { path }, error: null };
    } }) },
  } as never;
}

test("publishing worker reconstructs a pinned book and stores verified renderer bytes", async () => {
  const config = { kind: "ebook" };
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Worker Book", subtitle: null, author_name: "Author", language: "en", created_by: USER }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "editor", status: "active" }],
    workspaces: [{ id: WORKSPACE, organization_id: ORG }],
    editions: [{ id: EDITION, book_id: BOOK, type: "ebook", edition_metadata_json: config, updated_at: UPDATED }],
    subscriptions: [], chapters: [{ id: CHAPTER, book_id: BOOK, title: "One", order_index: 0 }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 1, content_json: { schemaVersion: "1.0", nodes: [{ id: "n1", type: "paragraph", text: "Saved manuscript." }] } }],
    book_metadata: [], style_guides: [], book_bible_items: [],
  };
  const uploads: { path: string; bytes: Buffer }[] = [];
  const sb = dataClient(tables, uploads);
  const model = await assembleBookModel(sb, tables.books[0]);
  const artifact = Buffer.from("PK\u0003\u0004fixture-epub");
  const sha = createHash("sha256").update(artifact).digest("hex");
  let request: Row = {};
  const output = await buildPublishingOutput(sb, {
    id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: "render", lease_token: LEASE,
    request_json: { action: "render", editionUpdatedAt: UPDATED, bookModelSha256: bookModelFingerprint(model) },
  }, async (url, init) => {
    assert.equal(String(url).endsWith("/render"), true);
    request = JSON.parse(String(init?.body));
    return Response.json({ format: "epub", artifactBase64: artifact.toString("base64"), sha256: sha, rendererVersion: "fixture-1" });
  }, new AbortController().signal, []);
  assert.equal((request.bookModel as Row).bookId, BOOK);
  assert.equal((output.artifacts as Row[])[0].checksum, sha);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].bytes, artifact);
  assert.match(uploads[0].path, new RegExp(`^workspaces/${WORKSPACE}/assets/[0-9a-f-]+/v1/book\\.epub$`));
});

test("worker poll is idle without a claim and persists invalid claims as terminal failures", async () => {
  let mode: "idle" | "invalid" = "idle";
  const calls: { name: string; args: Row }[] = [];
  const sb = { rpc: async (name: string, args: Row) => {
    calls.push({ name, args });
    if (name === "claim_publishing_job") return mode === "idle" ? { data: [], error: null } : { data: [{
      id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: "render", lease_token: LEASE,
      request_json: { action: "render", editionUpdatedAt: UPDATED, bookModelSha256: "invalid" },
    }], error: null };
    if (name === "fail_leased_publishing_job") return { data: { id: JOB, status: "failed" }, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  } } as never;
  assert.deepEqual(await runOnePublishingJob(sb), { status: "idle" });
  mode = "invalid";
  assert.deepEqual(await runOnePublishingJob(sb), { status: "failed", jobId: JOB });
  const failure = calls.find((call) => call.name === "fail_leased_publishing_job")!;
  assert.equal(failure.args.p_error_code, "worker_invalid_input");
  assert.equal(failure.args.p_retryable, false);
});
