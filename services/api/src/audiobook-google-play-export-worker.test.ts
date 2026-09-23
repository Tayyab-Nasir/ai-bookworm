import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { runOneGooglePlayAudioExport, uploadTusArchive } from "./lib/audiobook-google-play-export-worker.js";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function png() {
  const value = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(value);
  value.writeUInt32BE(1024,16); value.writeUInt32BE(1024,20); return value;
}

test("leased export preserves uploaded archives across uncertain completion and fences cleanup", async (t) => {
  for (const completion of ["success", "lost-reply", "late-commit", "rejected", "cover-invalid", "cover-receipt-mismatch", "cover-quarantined"] as const) await t.test(completion, async () => {
  const id = (n: string) => `e7000000-0000-4000-8000-${n.padStart(12, "0")}`;
  const jobId = id("1"); const workspace = id("2"); const book = id("3"); const edition = id("4");
  const chapter = id("5"); const version = id("6"); const project = id("7"); const report = id("8");
  const coverId = id("9"); const audioAssetId = id("10"); const creator = id("11"); const lease = id("12");
  const coverBytes = png(); const segment = Buffer.from("ID3 private saved narration"); const assembled = Buffer.from("ID3 full chapter audio");
  const quality = { schemaVersion:1, profile:"technical preflight", chapterDurationSeconds:300, sampleRateHz:44100, channels:1,
    bitRateKbps:192, bitRateMode:"cbr", rmsDbfs:-20, samplePeakDbfs:-4,
    technicalChecks:{noise:{status:"manual_review",value:null,limit:"human review"}}, reviewRequired:true,
    acxNarrationPolicy:"explicit_authorization_required_for_ai_voice" };
  const reportId = report; const idForIsbn = "9780306406157";
  const manifest = sha(JSON.stringify({ projectId:project, documentVersionId:version,
    assets:[{ id:audioAssetId, checksum:sha(segment), sizeBytes:segment.length }] }));
  const snapshot = { title:"A durable title", author:"Test author", coverMimeType:"image/png", coverStoragePath:"workspaces/export-test/assets/cover.png",
    coverSizeBytes:coverBytes.length, coverSha256:sha(coverBytes), chapters:[{ chapterId:chapter, orderIndex:0, title:"Chapter 1",
      documentVersionId:version, projectId:project, reportId, sourceManifestSha256:manifest, audioSha256:sha(assembled) }] };
  const tables: Record<string, Record<string, unknown>[]> = {
    audiobook_google_play_export_jobs:[{id:jobId,status:"running",output_storage_path:null,output_sha256:null}],
    asset_versions:[{asset_id:coverId,storage_path:snapshot.coverStoragePath,checksum:snapshot.coverSha256,
      mime_type:"image/png",size_bytes:coverBytes.length,scan_status:completion === "cover-quarantined" ? "pending" : "clean"}],
    editions:[{id:edition,book_id:book,type:"audiobook"}], books:[{id:book,workspace_id:workspace,title:snapshot.title,author_name:snapshot.author}],
    chapters:[{id:chapter,book_id:book,order_index:0,title:"Chapter 1",current_document_version_id:version}],
    audiobook_projects:[{id:project,workspace_id:workspace,book_id:book,edition_id:edition,chapter_id:chapter,document_version_id:version,status:"succeeded",segment_count:1}],
    audiobook_segments:[{project_id:project,segment_index:0,asset_id:audioAssetId,completed_at:"2026-09-23T00:00:00Z"}],
    assets:[{id:audioAssetId,workspace_id:workspace,storage_path:`workspaces/${workspace}/audiobooks/${project}/0.mp3`,mime_type:"audio/mpeg",type:"audiobook_segment",size_bytes:segment.length,checksum:sha(segment),deleted_at:null},
      {id:coverId,workspace_id:workspace,storage_path:snapshot.coverStoragePath,mime_type:"image/png",type:"cover",size_bytes:coverBytes.length,checksum:snapshot.coverSha256,deleted_at:null}],
    audiobook_qc_reports:[{id:report,project_id:project,document_version_id:version,source_manifest_sha256:manifest,audio_sha256:sha(assembled)}],
    audiobook_qc_signoffs:[{report_id:report}],
  };
  const calls: string[] = [];
  const claimed = { id:jobId,workspace_id:workspace,book_id:book,edition_id:edition,created_by:creator,identifier:idForIsbn,
    cover_asset_id:coverId,lease_token:lease,progress_total:1,attempts:1,snapshot_json:snapshot };
  const builderFor = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const rows = () => (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
    const builder: Record<string, any> = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
      is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
      in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
      order: () => builder, limit: () => builder,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows(), error: null }),
    };
    return builder;
  };
  const sb = {
    from: builderFor,
    storage: { from: () => ({
      download: async (path: string) => ({ data: new Blob([path.endsWith("cover.png") ? coverBytes : segment]), error: null }),
      remove: async () => {
        assert.equal(completion, "rejected", "must retain an archive while a completion may commit");
        assert.equal(calls.at(-1), "fail_audiobook_google_play_export", "cleanup must follow the database fence");
        calls.push("storage_remove"); return { error:null };
      },
    }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === "claim_audiobook_google_play_export") return { data:[{ ...claimed, lease_expires_at:"2099-01-01T00:00:00Z" }], error:null };
      if (name === "progress_audiobook_google_play_export") return { data:true,error:null };
      if (name === "complete_audiobook_google_play_export") {
        if (completion === "success") return { data:{id:jobId,status:"succeeded"},error:null };
        if (completion === "lost-reply") Object.assign(tables.audiobook_google_play_export_jobs[0], {
          status:"succeeded",output_storage_path:args.p_storage_path,output_sha256:args.p_sha256,
        });
        return {data:null,error:{code:"connection_lost"}};
      }
      if (name === "fail_audiobook_google_play_export") {
        if (completion === "late-commit") return {data:null,error:{code:"40001"}};
        return {data:{id:jobId,status:args.p_retryable ? "queued" : "failed"},error:null};
      }
      return { data:null,error:{code:"unknown_rpc"} };
    },
  } as never;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/images/inspect-cover")) {
      assert.notEqual(completion, "cover-quarantined", "quarantined cover reached the decoder");
      if (completion === "cover-invalid") return new Response(null, {status:422});
      return Response.json({width:1024,height:1024,mimeType:"image/png",
        sha256:completion === "cover-receipt-mismatch" ? "0".repeat(64) : sha(coverBytes)});
    }
    assert(!completion.startsWith("cover-"), "invalid cover reached audio assembly or storage upload");
    if (url.endsWith("/audio/assemble")) return new Response(assembled, {
      headers:{ "x-artifact-sha256":sha(assembled), "x-bookworm-audio-qc":JSON.stringify(quality) },
    });
    if (init?.method === "POST") return new Response(null,{status:201,headers:{location:"/storage/v1/upload/resumable/worker-test"}});
    if (init?.method === "PATCH") {
      const headers = new Headers(init.headers); const offset = Number(headers.get("upload-offset"));
      const length = Buffer.from(init.body as Uint8Array).length;
      return new Response(null,{status:204,headers:{"upload-offset":String(offset+length)}});
    }
    throw new Error("unexpected worker fetch");
  };
  const result = await runOneGooglePlayAudioExport(sb,{ fetcher, storage:{projectUrl:"https://project-ref.supabase.co",serviceKey:"service-role-fixture"} });
  assert.deepEqual(result,{status:["cover-invalid","cover-quarantined"].includes(completion) ? "failed" : completion === "cover-receipt-mismatch" ? "queued" : completion === "late-commit" ? "lease_lost" : completion === "rejected" ? "queued" : "succeeded",jobId});
  assert.deepEqual(calls,completion.startsWith("cover-") ? ["claim_audiobook_google_play_export","fail_audiobook_google_play_export"] : ["claim_audiobook_google_play_export","progress_audiobook_google_play_export","complete_audiobook_google_play_export",
    ...(["late-commit","rejected"].includes(completion) ? ["fail_audiobook_google_play_export"] : []),
    ...(completion === "rejected" ? ["storage_remove"] : [])]);
  });
});

test("large private audiobook export uses bounded 6 MiB TUS chunks and no archive buffering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bookworm-tus-test-"));
  const path = join(directory, "export.zip");
  const data = randomBytes(6 * 1024 * 1024 + 19);
  await writeFile(path, data, { mode: 0o600 });
  const offsets: number[] = [];
  let creates = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://project-ref.storage.supabase.co");
    assert.equal(init?.headers && new Headers(init.headers).get("authorization"), "Bearer service-secret-fixture");
    if (init?.method === "POST") {
      creates++;
      assert.equal(url.pathname, "/storage/v1/upload/resumable");
      assert.equal(new Headers(init.headers).get("upload-length"), String(data.length));
      assert.match(new Headers(init.headers).get("upload-metadata") ?? "", /bucketName Ym9vay1hc3NldHM/u);
      assert.match(new Headers(init.headers).get("upload-metadata") ?? "", /objectName d29ya3NwYWNlcy9hL2Jvb2tzL2V4cG9ydC56aXA/u);
      return new Response(null, { status: 201, headers: { location: "/storage/v1/upload/resumable/private-upload-id" } });
    }
    assert.equal(init?.method, "PATCH");
    const headers = new Headers(init?.headers);
    const offset = Number(headers.get("upload-offset"));
    const chunk = Buffer.from(init?.body as Uint8Array);
    assert.equal(chunk.length, Number(headers.get("content-length")));
    offsets.push(offset);
    return new Response(null, { status: 204, headers: { "upload-offset": String(offset + chunk.length) } });
  };
  try {
    await uploadTusArchive(path, "workspaces/a/books/export.zip", {
      projectUrl: "https://project-ref.supabase.co", serviceKey: "service-secret-fixture", signal: new AbortController().signal, fetcher,
    });
    assert.equal(creates, 1);
    assert.deepEqual(offsets, [0, 6 * 1024 * 1024]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("TUS upload refuses a cross-origin upload location before sending private bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bookworm-tus-origin-test-"));
  const path = join(directory, "export.zip");
  await writeFile(path, Buffer.from("zip fixture"), { mode: 0o600 });
  let patches = 0;
  try {
    await assert.rejects(uploadTusArchive(path, "workspaces/a/books/export.zip", {
      projectUrl: "https://project-ref.supabase.co", serviceKey: "service-secret-fixture", signal: new AbortController().signal,
      fetcher: async (_input, init) => {
        if (init?.method === "PATCH") patches++;
        return new Response(null, { status: 201, headers: { location: "https://attacker.invalid/upload" } });
      },
    }), /export_storage_invalid_response/u);
    assert.equal(patches, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
