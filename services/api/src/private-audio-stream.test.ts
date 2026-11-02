import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import Fastify from "fastify";
import { loadChapterAudio, assembleChapterAudio } from "./lib/audio-download.js";
import { audiobookRoutes } from "./routes/audiobooks.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { makeAuthPlugin } from "./plugins/auth.js";

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
    ai_jobs: [],
  };
  const reads: string[] = [];
  const signedPaths: string[] = [], tableReads: string[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const sb = {
    from: (name: string) => {
      tableReads.push(name);
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
    }, createSignedUrl: async (path: string) => {
      signedPaths.push(path); return { data: { signedUrl: "https://private.example/audio.mp3" }, error: null };
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
  return { sb, tables, reads, signedPaths, tableReads, rpcCalls };
}

test("private segment streams verified bytes and supports bounded single ranges", async () => {
  const data = fixture();
  const app = Fastify(); app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async req => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin); audiobookRoutes(app);
  try {
    const url = `/audiobook-jobs/${PROJECT}/segments/0/private-audio`;
    const whole = await app.inject({method:"GET",url,headers:{"x-bookworm-actor":USER}});
    assert.equal(whole.statusCode,200); assert.deepEqual(whole.rawPayload,bytes[0]);
    assert.equal(whole.headers["cache-control"],"private, no-store"); assert.equal(whole.headers["accept-ranges"],"bytes");
    for (const [range, expected, contentRange] of [["bytes=0-2","ID3",`bytes 0-2/${bytes[0].length}`],["bytes=-3","one",`bytes ${bytes[0].length-3}-${bytes[0].length-1}/${bytes[0].length}`]]) {
      const part=await app.inject({method:"GET",url,headers:{"x-bookworm-actor":USER,range}});
      assert.equal(part.statusCode,206); assert.equal(part.body,expected); assert.equal(part.headers["content-range"],contentRange);
    }
    for (const range of ["bytes=9999-", "bytes=2-1", "bytes=0-1,3-4", "bytes=-0"]) {
      const bad=await app.inject({method:"GET",url,headers:{"x-bookworm-actor":USER,range}});
      assert.equal(bad.statusCode,416); assert.equal(bad.headers["content-range"],`bytes */${bytes[0].length}`);
    }
    assert.equal(data.signedPaths.length,0);
  } finally { await app.close(); }
});

test("private segment denies wrong actor, foreign path, missing completion and corrupt bytes", async () => {
  const data = fixture(); const app = Fastify(); app.decorate("supabaseFactory", () => data.sb);
  app.addHook("onRequest", async req => { req.userId = USER; req.userToken = "fixture"; });
  await app.register(errorHandlerPlugin); audiobookRoutes(app);
  try {
    const url = `/audiobook-jobs/${PROJECT}/segments/0/private-audio`;
    assert.equal((await app.inject({method:"GET",url,headers:{"x-bookworm-actor":VERSION}})).statusCode,409);
    assert.equal(data.reads.length,0);
    data.tables.assets[0].storage_path=`workspaces/${WORKSPACE}/audiobooks/${VERSION}/0.mp3`;
    assert.equal((await app.inject({method:"GET",url,headers:{"x-bookworm-actor":USER}})).statusCode,404);
    assert.equal(data.reads.length,0);
    data.tables.assets[0].storage_path=`workspaces/${WORKSPACE}/audiobooks/${PROJECT}/0.mp3`;
    data.tables.audiobook_segments[0].completed_at=null;
    assert.equal((await app.inject({method:"GET",url,headers:{"x-bookworm-actor":USER}})).statusCode,404);
    data.tables.audiobook_segments[0].completed_at="2026-09-18"; data.tables.assets[0].checksum="a".repeat(64);
    assert.equal((await app.inject({method:"GET",url,headers:{"x-bookworm-actor":USER}})).statusCode,503);
  } finally { await app.close(); }
});

test("private segment requires the original actor through real authentication middleware", async () => {
  const data = fixture(); const app = Fastify();
  const caller = Object.assign({}, data.sb, {auth:{getUser:async () => ({data:{user:{id:USER}},error:null})}});
  await app.register(errorHandlerPlugin); await app.register(makeAuthPlugin(() => caller as never)); audiobookRoutes(app);
  try {
    const url=`/audiobook-jobs/${PROJECT}/segments/0/private-audio`;
    assert.equal((await app.inject({method:"GET",url})).statusCode,401);
    assert.equal((await app.inject({method:"GET",url,headers:{authorization:"Bearer fixture","x-bookworm-actor":VERSION}})).statusCode,409);
    assert.equal((await app.inject({method:"GET",url,headers:{authorization:"Bearer fixture"}})).statusCode,409);
    assert.equal((await app.inject({method:"GET",url,headers:{authorization:"Bearer fixture","x-bookworm-actor":USER}})).statusCode,200);
  } finally { await app.close(); }
});

test("proxy delivery history contains availability but no Storage bearer links while legacy shape remains compatible", async () => {
  const data=fixture(); const app=Fastify(); app.decorate("supabaseFactory",()=>data.sb);
  app.addHook("onRequest",async req=>{req.userId=USER; req.userToken="fixture";});
  await app.register(errorHandlerPlugin); audiobookRoutes(app);
  try {
    for (const url of [`/editions/${EDITION}/audiobook-jobs?delivery=proxy`,`/audiobook-jobs/${PROJECT}?delivery=proxy`]) {
      const response=await app.inject({method:"GET",url}); assert.equal(response.statusCode,200);
      const payload=response.json(); const project=payload.projects?.[0] ?? payload;
      assert.equal(project.segments.length,2);
      for (const segment of project.segments) { assert.equal(segment.audioAvailable,true); assert.equal(Object.hasOwn(segment,"download"),false); }
      assert.equal(data.signedPaths.length,0);
    }
    const legacy=await app.inject({method:"GET",url:`/audiobook-jobs/${PROJECT}`});
    assert.equal(legacy.statusCode,200); assert.equal(typeof legacy.json().segments[0].download.url,"string");
    assert.equal(data.signedPaths.length,2);
  } finally {await app.close();}
});

test("segment access is rechecked after Storage and concurrent work is bounded", async () => {
  const data=fixture(), app=Fastify();
  const caller=data.sb as any;
  let release!:()=>void, notify!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{notify=resolve;});
  caller.storage.from=()=>({download:async()=>{notify(); await wait; return {data:new Blob([bytes[0]]),error:null};}});
  app.decorate("supabaseFactory",()=>caller); app.addHook("onRequest",async req=>{req.userId=USER;req.userToken="fixture";});
  await app.register(errorHandlerPlugin); audiobookRoutes(app);
  try {
    const url=`/audiobook-jobs/${PROJECT}/segments/0/private-audio`, options={method:"GET" as const,url,headers:{"x-bookworm-actor":USER}};
    const first=app.inject(options); await started;
    assert.equal((await app.inject(options)).statusCode,429);
    data.tables.audiobook_projects.length=0; release();
    assert.equal((await first).statusCode,403);
  } finally {release(); await app.close();}
});

test("disconnected segment request releases its slot when Storage ignores abort", async () => {
  const data = fixture(), app = Fastify(), caller = data.sb as any;
  let release!: () => void, notify!: () => void, closed!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notify = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  let first = true;
  caller.storage.from = () => ({ download: async () => {
    if (first) { first = false; notify(); await wait; }
    return { data: new Blob([bytes[0]]), error: null };
  } });
  app.decorate("supabaseFactory", () => caller);
  app.addHook("onRequest", async (req, reply) => {
    req.userId = USER; req.userToken = "fixture";
    reply.raw.once("close", closed);
  });
  await app.register(errorHandlerPlugin); audiobookRoutes(app);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `/audiobook-jobs/${PROJECT}/segments/0/private-audio`;
    const request = httpRequest(address + url, { headers: { "x-bookworm-actor": USER } });
    request.on("error", () => {}); request.end();
    await started;
    request.destroy(); await disconnected; release();
    let response;
    for (let attempts = 0; attempts < 50; attempts++) {
      response = await app.inject({ method: "GET", url, headers: { "x-bookworm-actor": USER } });
      if (response.statusCode !== 429) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(response?.statusCode, 200);
    assert.deepEqual(response?.rawPayload, bytes[0]);
  } finally { release(); await app.close(); }
});
