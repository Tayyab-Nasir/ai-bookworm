import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assembleBookModel, bookModelFingerprint } from "./lib/authoring.js";
import { buildPublishingOutput, runOnePublishingJob } from "./lib/publishing-worker.js";
import { loadRenderImages, renderImagesFingerprint } from "./lib/render-images.js";

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
const IMAGE = "ca900000-0000-4000-8000-000000000001";

function dataClient(tables: Record<string, Row[]>, uploads: { path: string; bytes: Buffer }[], objects = new Map<string, Buffer>(), removed: string[] = []) {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let limit: number | null = null;
      const selected = () => (tables[table] ?? []).filter((entry) => filters.every(([key, expected]) =>
        Array.isArray(expected) ? expected.includes(entry[key]) : entry[key] === expected)).slice(0, limit ?? undefined);
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.is = builder.eq;
      builder.in = (key: string, value: unknown[]) => { filters.push([key, value]); return builder; };
      builder.gte = () => builder;
      builder.order = () => builder;
      builder.limit = (value: number) => { limit = value; return builder; };
      builder.maybeSingle = async () => ({ data: selected()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: selected(), error: null });
      return builder;
    },
    storage: { from: () => ({ download: async (path: string) => ({ data: objects.has(path) ? new Blob([new Uint8Array(objects.get(path)!)]) : null, error: null }), upload: async (path: string, bytes: Buffer) => {
      uploads.push({ path, bytes }); return { data: { path }, error: null };
    }, remove: async (paths: string[]) => { removed.push(...paths); return { data: paths, error: null }; } }) },
  } as never;
}

test("publishing worker reconstructs a pinned book and stores verified renderer bytes", async () => {
  const config = { kind: "ebook" };
  const imageBytes = Buffer.from("current image bytes");
  const imagePath = `workspaces/${WORKSPACE}/assets/${IMAGE}/v4/image.png`;
  const imageMetadata = { storage_path: imagePath, checksum: createHash("sha256").update(imageBytes).digest("hex"), mime_type: "image/png", size_bytes: imageBytes.length };
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Worker Book", subtitle: null, author_name: "Author", language: "en", created_by: USER }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "editor", status: "active" }],
    workspaces: [{ id: WORKSPACE, organization_id: ORG }],
    editions: [{ id: EDITION, book_id: BOOK, type: "ebook", edition_metadata_json: config, updated_at: UPDATED }],
    subscriptions: [], chapters: [{ id: CHAPTER, book_id: BOOK, title: "One", order_index: 0 }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 1, content_json: { schemaVersion: "1.0", nodes: [{ id: "n1", type: "paragraph", text: "Saved manuscript." }, { id: "i1", type: "image", assetId: IMAGE, assetVersionNumber: 4 }] } }],
    assets: [{ id: IMAGE, workspace_id: WORKSPACE, ...imageMetadata, status: "approved", deleted_at: null }],
    asset_versions: [{ asset_id: IMAGE, version_number: 4, ...imageMetadata, scan_status: "clean" }],
    book_metadata: [], style_guides: [], book_bible_items: [],
  };
  const uploads: { path: string; bytes: Buffer }[] = [];
  const sb = dataClient(tables, uploads, new Map([[imagePath, imageBytes]]));
  const model = await assembleBookModel(sb, tables.books[0]);
  const loadedImages = await loadRenderImages(sb, WORKSPACE, [IMAGE], null, model.chapters.flatMap(chapter => chapter.nodes));
  const savedImages = { imageSha256: renderImagesFingerprint(loadedImages), artworkSnapshot: loadedImages.artworkSnapshot };
  const artifact = Buffer.from("PK\u0003\u0004fixture-epub");
  const sha = createHash("sha256").update(artifact).digest("hex");
  let request: Row = {};
  const output = await buildPublishingOutput(sb, {
    id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: "render", lease_token: LEASE,
    request_json: { action: "render", editionUpdatedAt: UPDATED, bookModelSha256: bookModelFingerprint(model), ...savedImages },
  }, async (url, init) => {
    assert.equal(String(url).endsWith("/render"), true);
    request = JSON.parse(String(init?.body));
    return Response.json({ format: "epub", artifactBase64: artifact.toString("base64"), sha256: sha, rendererVersion: "fixture-1" });
  }, new AbortController().signal, []);
  assert.equal((request.bookModel as Row).bookId, BOOK);
  assert.equal((request.assetImagesBase64 as Row)[IMAGE], imageBytes.toString("base64"));
  assert.equal((output.artifacts as Row[])[0].checksum, sha);
  assert.equal(uploads.length, 1);
  assert.equal(request.artworkSnapshot, undefined, "private completion metadata must not be sent to renderer");
  assert.deepEqual(uploads[0].bytes, artifact);
  assert.match(uploads[0].path, new RegExp(`^workspaces/${WORKSPACE}/assets/[0-9a-f-]+/v1/book\\.epub$`));
  await assert.rejects(buildPublishingOutput(sb, {
    id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: "render", lease_token: LEASE,
    request_json: { action: "render", editionUpdatedAt: UPDATED, bookModelSha256: bookModelFingerprint(model), ...savedImages },
  }, async () => {
    tables.asset_versions[0].scan_status = "infected";
    return Response.json({ format: "epub", artifactBase64: artifact.toString("base64"), sha256: sha, rendererVersion: "fixture-1" });
  }, new AbortController().signal, []), /clean.*confirmed current version/u);
  assert.equal(uploads.length, 1, "quarantine during rendering must prevent artifact upload");
  tables.asset_versions[0].scan_status = "clean";
  tables.asset_versions[0].version_number = 5;
  for (const action of ["render", "validate"] as const) {
    await assert.rejects(buildPublishingOutput(sb, {
      id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: action === "render" ? "render" : "export", lease_token: LEASE,
      request_json: { action, editionUpdatedAt: UPDATED, bookModelSha256: bookModelFingerprint(model), ...savedImages },
    }, async () => { assert.fail("stale image must not reach renderer"); }, new AbortController().signal, []), /placed illustration version has changed/u);
  }
  assert.equal(uploads.length, 1, "stale image must not create another artifact");
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

for (const scenario of ["stale", "permission", "invalid", "lease", "unknown", "committed", "success", "retryable"] as const) {
  test(`publishing completion ${scenario} preserves fencing, recovery and artifact cleanup`, async () => {
    const tables: Record<string, Row[]> = {
      books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Worker Book", author_name: "Author", language: "en", created_by: USER }],
      workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "editor", status: "active" }],
      workspaces: [{ id: WORKSPACE, organization_id: ORG }], subscriptions: [],
      editions: [{ id: EDITION, book_id: BOOK, type: "ebook", edition_metadata_json: { kind: "ebook" }, updated_at: UPDATED }],
      chapters: [], document_versions: [], assets: [], book_metadata: [], style_guides: [], book_bible_items: [],
    };
    const uploads: { path: string; bytes: Buffer }[] = [], removed: string[] = [];
    const client = dataClient(tables, uploads, new Map(), removed);
    const model = await assembleBookModel(client, tables.books[0]);
    const images = await loadRenderImages(client, WORKSPACE, [], null);
    const job: Row = { id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: "render", lease_token: LEASE,
      status: "running", request_json: { action: "render", editionUpdatedAt: UPDATED, bookModelSha256: bookModelFingerprint(model),
        imageSha256: renderImagesFingerprint(images), artworkSnapshot: images.artworkSnapshot } };
    tables.publishing_jobs = [job];
    const calls: { name: string; args: Row }[] = [];
    const sb = Object.assign(client, { rpc: async (name: string, args: Row) => {
      calls.push({ name, args });
      if (name === "claim_publishing_job") return { data: [job], error: null };
      if (name === "complete_leased_publishing_job") {
        if (scenario === "committed" || scenario === "success") job.status = "succeeded";
        if (scenario === "unknown") tables.publishing_jobs = [];
        if (scenario === "committed" || scenario === "unknown") throw new Error("lost completion reply");
        if (scenario === "success") return { data: job, error: null };
        return { data: null, error: { code: scenario === "permission" ? "42501" : scenario === "invalid" ? "22023" : scenario === "retryable" ? "08006" : "40001",
          details: scenario === "stale" ? "bookworm_publishing_snapshot_changed" : "", message: "private database diagnostic" } };
      }
      if (name === "fail_leased_publishing_job") return { data: { id: JOB, status: args.p_retryable ? "queued" : "failed" }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    } }) as never;
    const bytes = Buffer.from("PK\u0003\u0004fixture-epub");
    const outcome = await runOnePublishingJob(sb, { fetcher: async () => Response.json({ format: "epub", artifactBase64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"), rendererVersion: "fixture-1" }) });
    const expected = scenario === "lease" ? "lease_lost" : scenario === "unknown" ? "completion_unknown"
      : scenario === "committed" || scenario === "success" ? "succeeded" : scenario === "retryable" ? "queued" : "failed";
    assert.deepEqual(outcome, { status: expected, jobId: JOB });
    assert.equal(uploads.length, 1);
    assert.deepEqual(removed, ["unknown", "committed", "success"].includes(scenario) ? [] : [uploads[0].path]);
    const failure = calls.find(call => call.name === "fail_leased_publishing_job");
    if (expected === "failed" || expected === "queued") {
      assert.equal(failure?.args.p_retryable, scenario === "retryable");
      assert.equal(failure?.args.p_error_code, scenario === "stale" ? "worker_inputs_changed" : scenario === "permission" ? "worker_permission_changed"
        : scenario === "invalid" ? "worker_invalid_input" : "worker_completion_failed");
    } else assert.equal(failure, undefined, "lost leases and uncertain/committed completion must not be failed");
  });
}
