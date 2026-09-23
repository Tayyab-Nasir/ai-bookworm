import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { loadChapterAudio, assembleChapterAudio } from "./lib/audio-download.js";
import { audiobookRoutes } from "./routes/audiobooks.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";

const PROJECT = "b6000000-0000-4000-8000-000000000001";
const WORKSPACE = "b6000000-0000-4000-8000-000000000002";
const USER = "b6000000-0000-4000-8000-000000000003";
const VERSION = "b6000000-0000-4000-8000-000000000006";
const QC_REPORT = "b6000000-0000-4000-8000-000000000007";
const BOOK = "b6000000-0000-4000-8000-000000000008";
const EDITION = "b6000000-0000-4000-8000-000000000009";
const COVER = "b6000000-0000-4000-8000-000000000010";
const ISBN = "9780306406157";
const ids = ["b6000000-0000-4000-8000-000000000004", "b6000000-0000-4000-8000-000000000005"];
const bytes = [Buffer.from("ID3fixture-one"), Buffer.from("ID3fixture-two")];
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const quality = { schemaVersion: 1, profile: "ACX technical preflight; not retailer approval", chapterDurationSeconds: 30,
  sampleRateHz: 44100, channels: 1, bitRateKbps: 192, bitRateMode: "cbr", rmsDbfs: -20, samplePeakDbfs: -4,
  technicalChecks: { rms: { status: "pass", value: -20, unit: "dBFS", limit: "-23 to -18 dB RMS" },
    noiseFloor: { status: "manual_review", value: null, limit: "listening required" } }, reviewRequired: true,
  acxNarrationPolicy: "explicit_authorization_required_for_ai_voice" };
function png(width = 1024, height = 1024) {
  const value = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
  value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20); return value;
}
function fixture() {
  const tables: Record<string, Record<string, any>[]> = {
    audiobook_projects: [{ id: PROJECT, workspace_id: WORKSPACE, book_id: BOOK, edition_id: EDITION, chapter_id: ids[0], document_version_id: VERSION, status: "succeeded", segment_count: 2, created_at: "2026-09-23T00:00:00Z" }],
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Fixture book", author_name: "Test author" }],
    editions: [{ id: EDITION, book_id: BOOK, type: "audiobook" }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, status: "active", role: "reviewer" }],
    chapters: [{ id: ids[0], book_id: BOOK, order_index: 0, title: "Chapter one", current_document_version_id: VERSION }],
    document_versions: [{ id: VERSION, chapter_id: ids[0], plain_text: "A chapter long enough for the export fixture." }],
    audiobook_segments: ids.map((id, index) => ({ project_id: PROJECT, segment_index: index, asset_id: id, completed_at: "2026-09-18" })),
    assets: [...ids.map((id, index) => ({ id, workspace_id: WORKSPACE, storage_path: `workspaces/${WORKSPACE}/audiobooks/${PROJECT}/${index}.mp3`,
      mime_type: "audio/mpeg", type: "audiobook_segment", size_bytes: bytes[index].length, checksum: sha(bytes[index]), deleted_at: null })),
    { id: COVER, workspace_id: WORKSPACE, storage_path: `workspaces/${WORKSPACE}/assets/${COVER}/v1/cover.png`, mime_type: "image/png", size_bytes: png().length, checksum: sha(png()), deleted_at: null }],
    audiobook_qc_reports: [],
    audiobook_qc_signoffs: [],
    audiobook_google_play_export_jobs: [],
  };
  const reads: string[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sb = {
    from: (name: string) => {
      const filters: ((row: Record<string, any>) => boolean)[] = [];
      const rows = () => tables[name].filter((row) => filters.every((filter) => filter(row)));
      let insertError: { code: string } | null = null;
      const builder = { select: () => builder, eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
        order: () => builder, limit: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (name === "audiobook_qc_reports" && tables[name].some((item) => item.project_id === row.project_id && item.audio_sha256 === row.audio_sha256)) insertError = { code: "23505" };
          else if (name === "audiobook_qc_signoffs" && tables[name].some((item) => item.report_id === row.report_id && item.reviewer_id === row.reviewer_id)) insertError = { code: "23505" };
          else tables[name].push({ ...row, ...(name === "audiobook_qc_reports" ? { id: QC_REPORT, created_at: "2026-09-23T00:00:00Z" } : { signed_at: "2026-09-23T00:05:00Z" }) });
          return builder;
        },
        maybeSingle: async () => ({ data: insertError ? null : rows()[0] ?? null, error: insertError }),
        then: (resolve: (data: unknown) => unknown) => resolve({ data: rows(), error: null }) };
      return builder;
    },
    storage: { from: () => ({ download: async (path: string) => {
      reads.push(path);
      if (path.endsWith("cover.png")) return { data: new Blob([png()]), error: null };
      const index = path.endsWith("/0.mp3") ? 0 : 1;
      return { data: new Blob([bytes[index]]), error: null };
    } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "queue_audiobook_google_play_export") {
        if (tables.workspace_members[0]?.role === "viewer") return { data: null, error: { code: "42501" } };
        return { data: { id: "b6000000-0000-4000-8000-000000000011", edition_id: EDITION, status: "queued",
          progress_chapters: 0, progress_total: 1, error_code: null, created_at: "2026-09-23T00:00:00Z", completed_at: null,
          output_size_bytes: null, total_duration_seconds: null }, error: null };
      }
      if (name === "cancel_audiobook_google_play_export") {
        const job = tables.audiobook_google_play_export_jobs.find((item) => item.id === args.p_job_id);
        if (!job) return { data: null, error: { code: "P0002" } };
        if (job.status === "queued") Object.assign(job, { status: "cancelled", completed_at: "2026-09-23T00:03:00Z" });
        else if (job.status === "running") Object.assign(job, { cancellation_requested_at: "2026-09-23T00:03:00Z" });
        return { data: job, error: null };
      }
      return { data: null, error: { code: "42883" } };
    },
  } as never;
  return { sb, tables, reads, rpcCalls };
}

test("chapter assembly reads exact, ordered, RLS-scoped private segments", async () => {
  const data = fixture();
  const loaded = await loadChapterAudio(data.sb, PROJECT);
  assert.deepEqual(loaded.segments, bytes);
  assert.equal(loaded.projectId, PROJECT);
  assert.equal(loaded.workspaceId, WORKSPACE);
  assert.equal(loaded.documentVersionId, VERSION);
  assert.match(loaded.sourceManifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(data.reads, data.tables.assets.slice(0, 2).map((asset) => asset.storage_path));
  await assert.rejects(loadChapterAudio(data.sb, USER), /not found/);
  await assert.rejects(loadChapterAudio(data.sb, "invalid"), /not found/);
});

test("Google Play export progress is member-safe, history refreshes and cancellation is checkpointed", async () => {
  const data = fixture();
  const job: Record<string, any> = { id: "b6000000-0000-4000-8000-000000000011", edition_id: EDITION, status: "running",
    progress_chapters: 2, progress_total: 4, error_code: null, created_at: "2026-09-23T00:00:00Z",
    completed_at: null, identifier: ISBN, snapshot_json: { secretSource: "never returned" },
    output_storage_path: "private/path.zip", output_size_bytes: null, total_duration_seconds: null };
  data.tables.audiobook_google_play_export_jobs.push(job);
  const app = Fastify(); app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async (req) => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin); audiobookRoutes(app);
  const path = `/audiobook-google-play-exports/${job.id}`;
  const progress = await app.inject({ method: "GET", url: path });
  assert.equal(progress.statusCode, 200, progress.body); assert.equal(progress.headers["cache-control"], "private, no-store");
  assert.equal(progress.json().job.progressChapters, 2); assert.equal(JSON.stringify(progress.json()).includes("private/path.zip"), false);
  assert.equal(JSON.stringify(progress.json()).includes("never returned"), false);
  const history = await app.inject({ method: "GET", url: `/editions/${EDITION}/audiobook-google-play-exports` });
  assert.equal(history.statusCode, 200, history.body); assert.equal(history.json().jobs.length, 1);
  const cancelled = await app.inject({ method: "POST", url: `${path}/cancel` });
  assert.equal(cancelled.statusCode, 200, cancelled.body); assert.equal(cancelled.json().job.status, "running");
  assert.ok(job.cancellation_requested_at, "active export should request cancellation at a worker checkpoint");
  assert.deepEqual(data.rpcCalls.at(-1), { name: "cancel_audiobook_google_play_export", args: { p_job_id: job.id } });
  await app.close();
});

test("chapter assembly refuses unfinished, missing, swapped or corrupt audio", async () => {
  for (const change of [
    (data: ReturnType<typeof fixture>) => { data.tables.audiobook_projects[0].status = "running"; },
    (data: ReturnType<typeof fixture>) => { data.tables.audiobook_segments.pop(); },
    (data: ReturnType<typeof fixture>) => { data.tables.audiobook_segments[0].segment_index = 1; },
    (data: ReturnType<typeof fixture>) => { data.tables.assets[0].workspace_id = USER; },
    (data: ReturnType<typeof fixture>) => { data.tables.assets[0].storage_path = "other/project.mp3"; },
    (data: ReturnType<typeof fixture>) => { data.tables.assets[0].deleted_at = "2026-09-18"; },
    (data: ReturnType<typeof fixture>) => { data.tables.assets[0].checksum = "a".repeat(64); },
  ]) {
    const data = fixture(); change(data);
    await assert.rejects(loadChapterAudio(data.sb, PROJECT));
  }
});

test("assembled audio transport bounds and validates the binary response", async () => {
  const output = Buffer.from("ID3assembled-chapter");
  const fetcher: typeof fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { segmentsBase64: bytes.map((part) => part.toString("base64")) });
    return new Response(output, { headers: { "content-type": "audio/mpeg", "x-artifact-sha256": sha(output), "x-bookworm-audio-qc": JSON.stringify(quality) } });
  };
  assert.deepEqual(await assembleChapterAudio(bytes, fetcher), { bytes: output, quality, audioSha256: sha(output) });
  assert.deepEqual(await assembleChapterAudio(bytes, async () => new Response(output, { headers: { "x-artifact-sha256": sha(output) } })), { bytes: output, quality: null, audioSha256: sha(output) });
  await assert.rejects(assembleChapterAudio(bytes, async () => new Response(output)), /integrity/);
  await assert.rejects(assembleChapterAudio(bytes, async () => new Response(output, { headers: { "x-artifact-sha256": sha(output), "x-bookworm-audio-qc": "{}" } })), /quality report/);
  await assert.rejects(assembleChapterAudio(bytes, async () => new Response(output, { headers: { "content-length": String(151 * 1024 * 1024) } })), /limit/);
  await assert.rejects(assembleChapterAudio(bytes, async () => new Response(null, { status: 422 })), /cannot be decoded/);
  await assert.rejects(assembleChapterAudio(bytes, async () => { throw new Error("private network detail"); }), /assembly is unavailable/);
});

test("download route returns a private attachment and releases its concurrency slot", async () => {
  const data = fixture();
  const output = Buffer.from("ID3assembled-chapter");
  const app = Fastify();
  app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async (req) => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin);
  audiobookRoutes(app, { fetcher: async () => new Response(output, { headers: { "x-artifact-sha256": sha(output), "x-bookworm-audio-qc": JSON.stringify(quality) } }) });
  for (let index = 0; index < 2; index++) {
    const response = await app.inject({ method: "GET", url: `/audiobook-jobs/${PROJECT}/audio-download` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "audio/mpeg");
    assert.equal(response.headers["content-disposition"], 'attachment; filename="chapter.mp3"');
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(JSON.parse(String(response.headers["x-bookworm-audio-qc"])), quality);
    assert.equal(response.headers["x-bookworm-audio-qc-report-id"], QC_REPORT);
    assert.equal(response.headers["x-bookworm-audio-sha256"], sha(output));
    assert.deepEqual(response.rawPayload, output);
  }
  assert.equal(data.tables.audiobook_qc_reports.length, 1, "same measured artifact should have one immutable report");
  await app.close();
});

test("Google Play export queues idempotently without blocking for an archive and requires an approver", async () => {
  const data = fixture();
  let assemblyCalls = 0;
  const app = Fastify();
  app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async (req) => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin);
  audiobookRoutes(app, { fetcher: async () => { assemblyCalls++; return new Response("unused"); } });
  const url = `/editions/${EDITION}/audiobook-google-play-export`;
  const body = { identifier: ISBN, coverAssetId: COVER, idempotencyKey: "google-export-test-1" };
  const invalid = await app.inject({ method: "POST", url, payload: { ...body, identifier: "9780306406158" } });
  assert.equal(invalid.statusCode, 422, invalid.body);
  const missingKey = await app.inject({ method: "POST", url, payload: { identifier: ISBN, coverAssetId: COVER } });
  assert.equal(missingKey.statusCode, 422, missingKey.body);
  data.tables.workspace_members[0].role = "viewer";
  const viewer = await app.inject({ method: "POST", url, payload: body });
  assert.equal(viewer.statusCode, 403, viewer.body);
  data.tables.workspace_members[0].role = "reviewer";
  const response = await app.inject({ method: "POST", url, payload: body });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json().job, { id: "b6000000-0000-4000-8000-000000000011", editionId: EDITION, status: "queued",
    progressChapters: 0, progressTotal: 1, errorCode: null, createdAt: "2026-09-23T00:00:00Z", completedAt: null,
    downloadUrl: null, downloadExpiresIn: null, archiveSizeBytes: null, totalDurationSeconds: null, synthesizedVoiceDisclosureRequired: true });
  assert.deepEqual(data.rpcCalls.at(-1), { name: "queue_audiobook_google_play_export", args: {
    p_edition_id: EDITION, p_identifier: ISBN, p_cover_asset_id: COVER, p_idempotency_key: "google-export-test-1",
  } });
  assert.equal(assemblyCalls, 0, "archive assembly must run in the leased worker, not the API request");
  await app.close();
});

test("audio download retains measured QC when durable history is unavailable", async () => {
  const data = fixture();
  const output = Buffer.from("ID3assembled-chapter");
  const unavailableService = { from: () => ({ insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42P01" } }) }) }) }) } as never;
  const app = Fastify();
  app.decorate("supabaseFactory", (token?: string) => token ? data.sb : unavailableService);
  app.addHook("onRequest", async (req) => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin);
  audiobookRoutes(app, { fetcher: async () => new Response(output, { headers: { "x-artifact-sha256": sha(output), "x-bookworm-audio-qc": JSON.stringify(quality) } }) });
  const response = await app.inject({ method: "GET", url: `/audiobook-jobs/${PROJECT}/audio-download` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["x-bookworm-audio-qc-history"], "unavailable");
  assert.deepEqual(JSON.parse(String(response.headers["x-bookworm-audio-qc"])), quality);
  assert.equal(response.headers["x-bookworm-audio-qc-report-id"], undefined);
  assert.deepEqual(response.rawPayload, output);
  await app.close();
});

test("QC history is member-scoped and marks manuscript version and reviewer state", async () => {
  const data = fixture();
  data.tables.audiobook_qc_reports.push({ id: QC_REPORT, project_id: PROJECT, document_version_id: VERSION,
    audio_sha256: "a".repeat(64), source_manifest_sha256: "b".repeat(64), quality_report: quality,
    created_by: USER, created_at: "2026-09-23T00:00:00Z" });
  data.tables.audiobook_qc_signoffs.push({ report_id: QC_REPORT, reviewer_id: USER, listened_to_exact_audio: true, signed_at: "2026-09-23T00:05:00Z" });
  const app = Fastify();
  app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async (req) => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin);
  audiobookRoutes(app);
  const response = await app.inject({ method: "GET", url: `/audiobook-jobs/${PROJECT}/qc-reports` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json().reports[0], {
    id: QC_REPORT, documentVersionId: VERSION, audioSha256: "a".repeat(64), sourceManifestSha256: "b".repeat(64),
    qualityReport: quality, createdBy: USER, createdAt: "2026-09-23T00:00:00Z", isCurrentSource: true,
    signoffs: [{ reviewerId: USER, signedAt: "2026-09-23T00:05:00Z" }], signedByMe: true,
  });
  data.tables.chapters[0].current_document_version_id = ids[1];
  const stale = await app.inject({ method: "GET", url: `/audiobook-jobs/${PROJECT}/qc-reports` });
  assert.equal(stale.json().reports[0].isCurrentSource, false);
  data.tables.workspace_members[0].user_id = ids[1];
  const denied = await app.inject({ method: "GET", url: `/audiobook-jobs/${PROJECT}/qc-reports` });
  assert.equal(denied.statusCode, 403);
  await app.close();
});

test("QC listening sign-off requires an approver and exact report, then replays idempotently", async () => {
  const data = fixture();
  data.tables.audiobook_qc_reports.push({ id: QC_REPORT, project_id: PROJECT, document_version_id: VERSION,
    audio_sha256: "a".repeat(64), source_manifest_sha256: "b".repeat(64), quality_report: quality,
    created_by: USER, created_at: "2026-09-23T00:00:00Z" });
  const app = Fastify();
  app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async (req) => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin);
  audiobookRoutes(app);
  const url = `/audiobook-jobs/${PROJECT}/qc-signoffs`;
  assert.equal((await app.inject({ method: "POST", url, payload: { reportId: QC_REPORT, listenedToExactAudio: false } })).statusCode, 422);
  const first = await app.inject({ method: "POST", url, payload: { reportId: QC_REPORT, listenedToExactAudio: true } });
  assert.equal(first.statusCode, 201, first.body);
  assert.deepEqual(first.json(), { reportId: QC_REPORT, signedAt: "2026-09-23T00:05:00Z", listenedToExactAudio: true });
  const replay = await app.inject({ method: "POST", url, payload: { reportId: QC_REPORT, listenedToExactAudio: true } });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(data.tables.audiobook_qc_signoffs.length, 1);
  data.tables.chapters[0].current_document_version_id = ids[1];
  const stale = await app.inject({ method: "POST", url, payload: { reportId: QC_REPORT, listenedToExactAudio: true } });
  assert.equal(stale.statusCode, 409);
  const wrongProject = await app.inject({ method: "POST", url, payload: { reportId: ids[1], listenedToExactAudio: true } });
  assert.equal(wrongProject.statusCode, 404);
  data.tables.workspace_members[0].role = "viewer";
  const viewer = await app.inject({ method: "POST", url, payload: { reportId: QC_REPORT, listenedToExactAudio: true } });
  assert.equal(viewer.statusCode, 403);
  await app.close();
});
