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
const ids = ["b6000000-0000-4000-8000-000000000004", "b6000000-0000-4000-8000-000000000005"];
const bytes = [Buffer.from("ID3fixture-one"), Buffer.from("ID3fixture-two")];
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const quality = { schemaVersion: 1, profile: "ACX technical preflight; not retailer approval", chapterDurationSeconds: 30,
  sampleRateHz: 44100, channels: 1, bitRateKbps: 192, bitRateMode: "cbr", rmsDbfs: -20, samplePeakDbfs: -4,
  technicalChecks: { rms: { status: "pass", value: -20, unit: "dBFS", limit: "-23 to -18 dB RMS" },
    noiseFloor: { status: "manual_review", value: null, limit: "listening required" } }, reviewRequired: true,
  acxNarrationPolicy: "explicit_authorization_required_for_ai_voice" };
function fixture() {
  const tables: Record<string, Record<string, any>[]> = {
    audiobook_projects: [{ id: PROJECT, workspace_id: WORKSPACE, chapter_id: ids[0], document_version_id: VERSION, status: "succeeded", segment_count: 2 }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, status: "active", role: "reviewer" }],
    chapters: [{ id: ids[0], current_document_version_id: VERSION }],
    audiobook_segments: ids.map((id, index) => ({ project_id: PROJECT, segment_index: index, asset_id: id, completed_at: "2026-09-18" })),
    assets: ids.map((id, index) => ({ id, workspace_id: WORKSPACE, storage_path: `workspaces/${WORKSPACE}/audiobooks/${PROJECT}/${index}.mp3`,
      mime_type: "audio/mpeg", type: "audiobook_segment", size_bytes: bytes[index].length, checksum: sha(bytes[index]), deleted_at: null })),
    audiobook_qc_reports: [],
    audiobook_qc_signoffs: [],
  };
  const reads: string[] = [];
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
      reads.push(path); const index = path.endsWith("/0.mp3") ? 0 : 1;
      return { data: new Blob([bytes[index]]), error: null };
    } }) },
  } as never;
  return { sb, tables, reads };
}

test("chapter assembly reads exact, ordered, RLS-scoped private segments", async () => {
  const data = fixture();
  const loaded = await loadChapterAudio(data.sb, PROJECT);
  assert.deepEqual(loaded.segments, bytes);
  assert.equal(loaded.projectId, PROJECT);
  assert.equal(loaded.workspaceId, WORKSPACE);
  assert.equal(loaded.documentVersionId, VERSION);
  assert.match(loaded.sourceManifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(data.reads, data.tables.assets.map((asset) => asset.storage_path));
  await assert.rejects(loadChapterAudio(data.sb, USER), /not found/);
  await assert.rejects(loadChapterAudio(data.sb, "invalid"), /not found/);
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
