import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assembleBookModel, bookModelFingerprint } from "./lib/authoring.js";
import { buildPublishingOutput, runOnePublishingJob } from "./lib/publishing-worker.js";
import { loadRenderImages, renderImagesFingerprint } from "./lib/render-images.js";
import { editionConfigSchema, withEditionLanguage } from "./routes/editions.js";

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

function dataClient(tables: Record<string, Row[]>, uploads: { path: string; bytes: Buffer }[], objects = new Map<string, Buffer>(), removed: string[] = [], reads: string[] = []) {
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
    storage: { from: () => ({ download: async (path: string) => { reads.push(path); return { data: objects.has(path) ? new Blob([new Uint8Array(objects.get(path)!)]) : null, error: null }; }, upload: async (path: string, bytes: Buffer) => {
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

async function savedCoverWorkerFixture(selectedCover = false, language = "en") {
  const config = editionConfigSchema.parse({ kind: "ebook", cover: { asset_id: selectedCover ? IMAGE : null },
    metadata_overrides: selectedCover ? { title: "" } : {} });
  const epub = Buffer.from("PK\u0003\u0004saved-worker-epub");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 11]);
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const imagePath = `workspaces/${WORKSPACE}/assets/${IMAGE}/v1/art.png`;
  const imageMetadata = { storage_path: imagePath, checksum: digest(png), mime_type: "image/png", size_bytes: png.length };
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Worker Book", author_name: "Author", language: "en", created_by: USER }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "editor", status: "active" }],
    workspaces: [{ id: WORKSPACE, organization_id: ORG }],
    editions: [{ id: EDITION, book_id: BOOK, type: "ebook", language, edition_metadata_json: config, updated_at: UPDATED }],
    subscriptions: [{ id: ORG, organization_id: ORG, plan_id: ORG, status: "active" }],
    plans: [{ id: ORG, name: "fixture", entitlements_json: { publishing_channels: ["kdp"] } }],
    chapters: [], document_versions: [], book_metadata: [], style_guides: [], book_bible_items: [],
    assets: selectedCover ? [{ id: IMAGE, workspace_id: WORKSPACE, ...imageMetadata, status: "approved", deleted_at: null }] : [],
    asset_versions: selectedCover ? [{ asset_id: IMAGE, version_number: 1, ...imageMetadata, scan_status: "clean" }] : [],
  };
  const uploads: { path: string; bytes: Buffer }[] = [], reads: string[] = [];
  const objects = new Map(selectedCover ? [[imagePath, png]] : []);
  const sb = dataClient(tables, uploads, objects, [], reads);
  const model = withEditionLanguage(await assembleBookModel(sb, tables.books[0]), language);
  const images = await loadRenderImages(sb, WORKSPACE, [], selectedCover ? IMAGE : null);
  const request = { editionUpdatedAt: UPDATED, bookModelSha256: bookModelFingerprint(model),
    imageSha256: renderImagesFingerprint(images), artworkSnapshot: images.artworkSnapshot };
  const artifacts = [{ bytes: epub, role: "rendered_ebook", type: "rendered_book", mimeType: "application/epub+zip", filename: "book.epub" },
    ...(selectedCover ? [{ bytes: png, role: "rendered_cover", type: "rendered_cover", mimeType: "image/png", filename: "cover.png" }] : [])]
    .map(({ bytes: value, ...artifact }) => {
      const assetId = crypto.randomUUID();
      const storagePath = `workspaces/${WORKSPACE}/assets/${assetId}/v1/${artifact.filename}`;
      objects.set(storagePath, value);
      tables.assets.push({ id: assetId, workspace_id: WORKSPACE, storage_path: storagePath, mime_type: artifact.mimeType,
        size_bytes: value.length, checksum: digest(value), deleted_at: null });
      return { ...artifact, assetId, storagePath, name: artifact.filename, sizeBytes: value.length, checksum: digest(value) };
    });
  const sourceRenderJobId = crypto.randomUUID(), sourcePreflightJobId = crypto.randomUUID();
  const renderJob = { id: sourceRenderJobId, book_id: BOOK, edition_id: EDITION, channel: "render", status: "succeeded",
    request_json: { ...request, action: "render" }, response_json: { artifacts, rendererVersion: "fixture", usage: {} as Row } };
  tables.publishing_jobs = [renderJob, { id: sourcePreflightJobId, book_id: BOOK, edition_id: EDITION, channel: "kdp", status: "succeeded",
    request_json: { ...request, action: "validate" }, response_json: { ruleVersion: "fixture", channel: "kdp", requestedChannel: "kdp", errors: 0, warnings: 0, findings: [] } }];
  const job = { id: JOB, book_id: BOOK, edition_id: EDITION, created_by: USER, channel: "render", lease_token: LEASE,
    request_json: { ...request, action: "render" as const, sourceRenderJobId, sourcePreflightJobId } };
  reads.length = 0;
  return { sb, tables, uploads, reads, objects, renderJob, job, epub, png, digest };
}

test("publishing worker fingerprints and dispatches the saved edition language for every action", async () => {
  for (const action of ["render", "validate", "export_package"] as const) {
    const fixture = await savedCoverWorkerFixture(false, "fr");
    const job = { ...fixture.job, channel: action === "render" ? "render" : "kdp", request_json: { ...fixture.job.request_json, action } };
    let dispatches = 0;
    await buildPublishingOutput(fixture.sb, job, async (_url, init) => {
      dispatches++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.bookModel.metadata.language, "fr");
      if (action === "validate") return Response.json({ ruleVersion: "fixture", channel: "kdp", errors: 0, warnings: 0, findings: [] });
      if (action === "export_package") return Response.json({ channel: "kdp", ruleVersion: "fixture", errors: 0,
        packages: [{ path: "kdp-export.zip", sha256: fixture.digest(fixture.epub), dataBase64: fixture.epub.toString("base64") }] });
      return Response.json({ format: "epub", artifactBase64: fixture.epub.toString("base64"), sha256: fixture.digest(fixture.epub), rendererVersion: "fixture" });
    }, new AbortController().signal, []);
    assert.equal(dispatches, 1);
    assert.equal(fixture.tables.books[0].language, "en", "edition language must not mutate the source book");
  }
});

test("publishing worker rejects unsupported saved cover policy before private reads or package dispatch", async () => {
  for (const usage of [{}, { coverRendererVersion: "cover-1.3.0", coverMetadataPolicy: "effective-ebook-metadata-v1" },
    { coverRendererVersion: "cover-1.4.0", coverMetadataPolicy: "old-policy" }]) {
    const fixture = await savedCoverWorkerFixture(true);
    fixture.renderJob.response_json.usage = usage;
    const saved = structuredClone(fixture.tables.publishing_jobs);
    const job = { ...fixture.job, channel: "kdp", request_json: { ...fixture.job.request_json, action: "export_package" as const } };
    let dispatches = 0;
    await assert.rejects(buildPublishingOutput(fixture.sb, job, async () => { dispatches++; assert.fail("old cover must not be packaged"); },
      new AbortController().signal, []), /cover metadata.*render again/iu);
    assert.equal(dispatches, 0);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(fixture.uploads, []);
    assert.deepEqual(fixture.tables.publishing_jobs, saved);
  }
});

test("leased render completion persists verified cover version and policy", async () => {
  const fixture = await savedCoverWorkerFixture(true, "fr");
  let completed: Row | undefined;
  const sb = Object.assign(fixture.sb, { rpc: async (name: string, args: Row) => {
    if (name === "claim_publishing_job") return { data: [fixture.job], error: null };
    if (name === "complete_leased_publishing_job") { completed = args.p_result as Row; return { data: { status: "succeeded" }, error: null }; }
    if (name === "fail_leased_publishing_job") return { data: { status: "failed" }, error: null };
    throw new Error(`Unexpected fixture RPC ${name}`);
  } }) as never;
  const result = await runOnePublishingJob(sb, { fetcher: async () => Response.json({ format: "epub",
    artifactBase64: fixture.epub.toString("base64"), sha256: fixture.digest(fixture.epub), rendererVersion: "fixture",
    coverArtifactBase64: fixture.png.toString("base64"), coverSha256: fixture.digest(fixture.png), coverFormat: "png", coverRendererVersion: "cover-1.4.0" }) });
  assert.deepEqual(result, { status: "succeeded", jobId: JOB });
  assert.equal((completed?.usage as Row).coverRendererVersion, "cover-1.4.0");
  assert.equal((completed?.usage as Row).coverMetadataPolicy, "effective-ebook-metadata-v1");
  assert.deepEqual(fixture.uploads.map(upload => upload.bytes), [fixture.epub, fixture.png]);
});

test("publishing worker terminally rejects incompatible cover versions without redispatch", async () => {
  for (const coverRendererVersion of [null, "cover-1.3.0", "cover-1.5.0"]) {
    const fixture = await savedCoverWorkerFixture(true);
    let terminal = false, dispatches = 0, completions = 0;
    const failures: Row[] = [];
    const sb = Object.assign(fixture.sb, { rpc: async (name: string, args: Row) => {
      if (name === "claim_publishing_job") return { data: terminal ? [] : [fixture.job], error: null };
      if (name === "complete_leased_publishing_job") { completions++; return { data: { status: "succeeded" }, error: null }; }
      if (name === "fail_leased_publishing_job") {
        failures.push(args);
        terminal = args.p_retryable === false;
        return { data: { status: terminal ? "failed" : "queued" }, error: null };
      }
      throw new Error(`Unexpected fixture RPC ${name}`);
    } }) as never;
    const fetcher = async (url: string | URL | Request) => {
      assert.ok(String(url).endsWith("/render"), "an incompatible render must never dispatch package creation");
      dispatches++;
      return Response.json({ format: "epub", artifactBase64: fixture.epub.toString("base64"), sha256: fixture.digest(fixture.epub), rendererVersion: "fixture",
        coverArtifactBase64: fixture.png.toString("base64"), coverSha256: fixture.digest(fixture.png), coverFormat: "png", coverRendererVersion });
    };
    assert.deepEqual(await runOnePublishingJob(sb, { fetcher }), { status: "failed", jobId: JOB });
    assert.equal(failures[0].p_retryable, false);
    assert.equal(failures[0].p_error_code, "worker_cover_policy_unsupported");
    assert.deepEqual(fixture.uploads, []);
    assert.equal(completions, 0);
    assert.deepEqual(await runOnePublishingJob(sb, { fetcher }), { status: "idle" });
    assert.equal(dispatches, 1, "terminal failure must not queue an automatic replacement render");
  }
});

test("publishing worker packages reviewed affected cover bytes without regeneration", async () => {
  const fixture = await savedCoverWorkerFixture(true, "fr");
  fixture.renderJob.response_json.usage = { coverRendererVersion: "cover-1.4.0", coverMetadataPolicy: "effective-ebook-metadata-v1" };
  const saved = structuredClone(fixture.tables.publishing_jobs);
  const job = { ...fixture.job, channel: "kdp", request_json: { ...fixture.job.request_json, action: "export_package" as const } };
  let dispatches = 0;
  await buildPublishingOutput(fixture.sb, job, async (url, init) => {
    dispatches++;
    assert.ok(String(url).endsWith("/v1/publishing/package"));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.artifactsBase64["book.epub"], fixture.epub.toString("base64"));
    assert.equal(body.artifactsBase64["cover.png"], fixture.png.toString("base64"));
    return Response.json({ channel: "kdp", ruleVersion: "fixture", errors: 0,
      packages: [{ path: "kdp-export.zip", sha256: fixture.digest(fixture.epub), dataBase64: fixture.epub.toString("base64") }] });
  }, new AbortController().signal, []);
  assert.equal(dispatches, 1);
  assert.deepEqual(fixture.tables.publishing_jobs, saved);
  assert.equal(fixture.uploads.length, 1);
  assert.ok(fixture.uploads[0].path.endsWith("/kdp-export.zip"));
});
