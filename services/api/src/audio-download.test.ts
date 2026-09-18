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
const ids = ["b6000000-0000-4000-8000-000000000004", "b6000000-0000-4000-8000-000000000005"];
const bytes = [Buffer.from("ID3fixture-one"), Buffer.from("ID3fixture-two")];
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function fixture() {
  const tables: Record<string, Record<string, any>[]> = {
    audiobook_projects: [{ id: PROJECT, workspace_id: WORKSPACE, status: "succeeded", segment_count: 2 }],
    audiobook_segments: ids.map((id, index) => ({ project_id: PROJECT, segment_index: index, asset_id: id, completed_at: "2026-09-18" })),
    assets: ids.map((id, index) => ({ id, workspace_id: WORKSPACE, storage_path: `workspaces/${WORKSPACE}/audiobooks/${PROJECT}/${index}.mp3`,
      mime_type: "audio/mpeg", type: "audiobook_segment", size_bytes: bytes[index].length, checksum: sha(bytes[index]), deleted_at: null })),
  };
  const reads: string[] = [];
  const sb = {
    from: (name: string) => {
      const filters: ((row: Record<string, any>) => boolean)[] = [];
      const rows = () => tables[name].filter((row) => filters.every((filter) => filter(row)));
      const builder = { select: () => builder, eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
        order: () => builder, maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
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
  assert.deepEqual(await loadChapterAudio(data.sb, PROJECT), bytes);
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
    return new Response(output, { headers: { "content-type": "audio/mpeg", "x-artifact-sha256": sha(output) } });
  };
  assert.deepEqual(await assembleChapterAudio(bytes, fetcher), output);
  await assert.rejects(assembleChapterAudio(bytes, async () => new Response(output)), /integrity/);
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
  audiobookRoutes(app, { fetcher: async () => new Response(output, { headers: { "x-artifact-sha256": sha(output) } }) });
  for (let index = 0; index < 2; index++) {
    const response = await app.inject({ method: "GET", url: `/audiobook-jobs/${PROJECT}/audio-download` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "audio/mpeg");
    assert.equal(response.headers["content-disposition"], 'attachment; filename="chapter.mp3"');
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(response.rawPayload, output);
  }
  await app.close();
});
