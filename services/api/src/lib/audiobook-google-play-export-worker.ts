import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { AppError } from "../errors.js";
import { loadEnv } from "@bookworm/config";
import type { SupabaseClient } from "./supabase.js";
import { assembleChapterAudio, loadChapterAudio } from "./audio-download.js";
import { GooglePlayAudioZip, googlePlayCoverDimensions } from "./google-play-audio-export.js";

const BUCKET = "book-assets";
const MAX_ARCHIVE_BYTES = 3_750 * 1024 * 1024;
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
const chapterSchema = z.object({
  chapterId: z.string().uuid(), orderIndex: z.number().int(),
  title: z.string().max(500), documentVersionId: z.string().uuid(),
  projectId: z.string().uuid(), reportId: z.string().uuid(),
  sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const jobSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(),
  book_id: z.string().uuid(), edition_id: z.string().uuid(),
  created_by: z.string().uuid(), identifier: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  cover_asset_id: z.string().uuid(), lease_token: z.string().uuid(),
  progress_total: z.number().int().min(1).max(250), attempts: z.number().int().min(1).max(5),
  snapshot_json: z.object({
    title: z.string().max(500), author: z.string().max(300),
    coverMimeType: z.enum(["image/jpeg", "image/png"]),
    coverStoragePath: z.string().max(500), coverSizeBytes: z.number().int().min(1).max(25 * 1024 * 1024),
    coverSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    chapters: z.array(chapterSchema).min(1).max(250),
  }).strict(),
}).passthrough().refine((job) => job.progress_total === job.snapshot_json.chapters.length, "progress total must match the frozen chapter list");

export class AudioExportFailure extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, any> : null;
}

function storageEndpoint(projectUrl: string) {
  const url = new URL(projectUrl);
  if (url.hostname.endsWith(".supabase.co") && !url.hostname.endsWith(".storage.supabase.co")) {
    url.hostname = `${url.hostname.slice(0, -".supabase.co".length)}.storage.supabase.co`;
  }
  url.pathname = "/storage/v1/upload/resumable";
  url.search = "";
  url.hash = "";
  return url;
}

export async function uploadTusArchive(path: string, objectPath: string, options: { projectUrl: string; serviceKey: string; signal: AbortSignal; fetcher?: typeof fetch }) {
  const fetcher = options.fetcher ?? fetch;
  const endpoint = storageEndpoint(options.projectUrl);
  const size = (await stat(path)).size;
  if (!size || size > MAX_ARCHIVE_BYTES) throw new AudioExportFailure("export_archive_too_large", false);
  const metadata = {
    bucketName: BUCKET, objectName: objectPath, contentType: "application/zip", cacheControl: "0",
  };
  const encoded = Object.entries(metadata).map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`).join(",");
  let uploadUrl: URL | undefined;
  try {
    const created = await fetcher(endpoint, {
      method: "POST", headers: {
        authorization: `Bearer ${options.serviceKey}`, apikey: options.serviceKey,
        "tus-resumable": "1.0.0", "upload-length": String(size), "upload-metadata": encoded,
        "x-upsert": "false", "cache-control": "no-store",
      }, signal: options.signal,
    });
    if (created.status !== 201 && created.status !== 204) throw new AudioExportFailure("export_storage_unavailable", true);
    const location = created.headers.get("location");
    if (!location) throw new AudioExportFailure("export_storage_invalid_response", true);
    const candidateUrl = new URL(location, endpoint);
    if (candidateUrl.origin !== endpoint.origin || !candidateUrl.pathname.startsWith("/storage/v1/upload/resumable/")) {
      throw new AudioExportFailure("export_storage_invalid_response", false);
    }
    uploadUrl = candidateUrl;
    const handle = await open(path, "r");
    try {
      let offset = 0;
      while (offset < size) {
        options.signal.throwIfAborted();
        const length = Math.min(TUS_CHUNK_BYTES, size - offset);
        const bytes = Buffer.allocUnsafe(length);
        const read = await handle.read(bytes, 0, length, offset);
        if (read.bytesRead !== length) throw new AudioExportFailure("export_archive_read_failed", true);
        const response = await fetcher(uploadUrl, {
          method: "PATCH", headers: {
            authorization: `Bearer ${options.serviceKey}`, apikey: options.serviceKey,
            "tus-resumable": "1.0.0", "upload-offset": String(offset),
            "content-type": "application/offset+octet-stream", "content-length": String(length),
          }, body: bytes, signal: options.signal,
        });
        const nextOffset = Number(response.headers.get("upload-offset"));
        if (response.status !== 204 || nextOffset !== offset + length) throw new AudioExportFailure("export_storage_upload_failed", true);
        offset = nextOffset;
      }
    } finally { await handle.close(); }
  } catch (error) {
    if (uploadUrl) {
      try { await fetcher(uploadUrl, { method: "DELETE", headers: { authorization: `Bearer ${options.serviceKey}`, apikey: options.serviceKey, "tus-resumable": "1.0.0" }, signal: AbortSignal.timeout(10_000) }); }
      catch { /* Supabase expires abandoned resumable URLs; never leak upload URLs into logs. */ }
    }
    if (error instanceof AudioExportFailure) throw error;
    if (options.signal.aborted) throw options.signal.reason ?? new AudioExportFailure("export_cancelled", false);
    throw new AudioExportFailure("export_storage_unavailable", true);
  }
}

async function sha256File(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    signal.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function assertSnapshotCurrent(sb: SupabaseClient, job: ReturnType<typeof jobSchema.parse>) {
  const [{ data: edition, error: editionError }, { data: book, error: bookError }, { data: chapters, error: chaptersError }] = await Promise.all([
    sb.from("editions").select("id,book_id,type").eq("id", job.edition_id).maybeSingle(),
    sb.from("books").select("id,workspace_id,title,author_name").eq("id", job.book_id).maybeSingle(),
    sb.from("chapters").select("id,order_index,title,current_document_version_id").eq("book_id", job.book_id)
      .order("order_index", { ascending: true }).order("id", { ascending: true }),
  ]);
  if (editionError || bookError || chaptersError) throw new AudioExportFailure("export_database_unavailable", true);
  if (!edition || edition.type !== "audiobook" || edition.book_id !== job.book_id || !book || book.workspace_id !== job.workspace_id
    || String(book.title).slice(0, 500) !== job.snapshot_json.title || String(book.author_name ?? "").slice(0, 300) !== job.snapshot_json.author
    || (chapters ?? []).length !== job.snapshot_json.chapters.length) throw new AudioExportFailure("export_source_changed", false);
  for (const [index, chapter] of (chapters ?? []).entries()) {
    const saved = job.snapshot_json.chapters[index]!;
    if (chapter.id !== saved.chapterId || chapter.order_index !== saved.orderIndex || chapter.title !== saved.title
      || chapter.current_document_version_id !== saved.documentVersionId) throw new AudioExportFailure("export_source_changed", false);
  }
  const { data: cover, error } = await sb.from("assets").select("id,workspace_id,storage_path,mime_type,size_bytes,checksum,deleted_at")
    .eq("id", job.cover_asset_id).maybeSingle();
  if (error) throw new AudioExportFailure("export_database_unavailable", true);
  const snap = job.snapshot_json;
  if (!cover || cover.workspace_id !== job.workspace_id || cover.deleted_at || cover.storage_path !== snap.coverStoragePath
    || cover.mime_type !== snap.coverMimeType || cover.size_bytes !== snap.coverSizeBytes || String(cover.checksum).toLowerCase() !== snap.coverSha256) {
    throw new AudioExportFailure("export_cover_changed", false);
  }
  const downloaded = await sb.storage.from(BUCKET).download(cover.storage_path);
  if (downloaded.error || !downloaded.data) throw new AudioExportFailure("export_cover_unavailable", true);
  if (downloaded.data.size !== snap.coverSizeBytes || downloaded.data.size > 25 * 1024 * 1024) throw new AudioExportFailure("export_cover_changed", false);
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== snap.coverSha256) throw new AudioExportFailure("export_cover_integrity_failed", false);
  const dimensions = googlePlayCoverDimensions(bytes, snap.coverMimeType);
  return { book, coverBytes: bytes, coverExtension: dimensions.extension };
}

async function createArchive(sb: SupabaseClient, job: ReturnType<typeof jobSchema.parse>, signal: AbortSignal,
  fetcher: typeof fetch, progress: (completed: number) => Promise<boolean>) {
  const source = await assertSnapshotCurrent(sb, job);
  const archive = await GooglePlayAudioZip.create();
  let duration = 0;
  try {
    for (const [index, chapter] of job.snapshot_json.chapters.entries()) {
      signal.throwIfAborted();
      const { data: project, error } = await sb.from("audiobook_projects").select("id,workspace_id,book_id,edition_id,chapter_id,document_version_id,status")
        .eq("id", chapter.projectId).maybeSingle();
      if (error) throw new AudioExportFailure("export_database_unavailable", true);
      if (!project || project.status !== "succeeded" || project.workspace_id !== job.workspace_id || project.book_id !== job.book_id
        || project.edition_id !== job.edition_id || project.chapter_id !== chapter.chapterId || project.document_version_id !== chapter.documentVersionId) {
        throw new AudioExportFailure("export_narration_changed", false);
      }
      const loaded = await loadChapterAudio(sb, chapter.projectId);
      const assembled = await assembleChapterAudio(loaded.segments, fetcher, signal);
      const quality = assembled.quality;
      if (!quality || quality.sampleRateHz !== 44_100 || quality.channels < 1
        || quality.bitRateKbps < (quality.channels === 1 ? 128 : 256)) throw new AudioExportFailure("export_audio_quality_failed", false);
      const { data: report, error: reportError } = await sb.from("audiobook_qc_reports")
        .select("id,document_version_id,source_manifest_sha256,audio_sha256").eq("id", chapter.reportId).eq("project_id", project.id).maybeSingle();
      if (reportError) throw new AudioExportFailure("export_database_unavailable", true);
      if (!report || report.document_version_id !== chapter.documentVersionId || report.source_manifest_sha256 !== loaded.sourceManifestSha256
        || report.source_manifest_sha256 !== chapter.sourceManifestSha256 || report.audio_sha256 !== assembled.audioSha256
        || report.audio_sha256 !== chapter.audioSha256) throw new AudioExportFailure("export_qc_source_changed", false);
      const { data: signoffs, error: signoffError } = await sb.from("audiobook_qc_signoffs").select("report_id").eq("report_id", report.id).limit(1);
      if (signoffError) throw new AudioExportFailure("export_database_unavailable", true);
      if (!signoffs?.length) throw new AudioExportFailure("export_signoff_missing", false);
      duration += quality.chapterDurationSeconds;
      if (!Number.isFinite(duration) || duration > 360_000) throw new AudioExportFailure("export_duration_invalid", false);
      await archive.add(`Audio/${job.identifier}_ch${index + 1}.mp3`, assembled.bytes);
      if (!await progress(index + 1)) throw new AudioExportFailure("export_cancelled", false);
    }
    if (duration < 300) throw new AudioExportFailure("export_duration_too_short", false);
    await archive.add(`Cover/${job.identifier}.${source.coverExtension}`, source.coverBytes);
    const details = await archive.finish();
    if (details.size > MAX_ARCHIVE_BYTES) throw new AudioExportFailure("export_archive_too_large", false);
    return { archive, durationSeconds: Math.round(duration), sizeBytes: details.size };
  } catch (error) {
    await archive.dispose();
    if (error instanceof AudioExportFailure) throw error;
    if (error instanceof AppError) throw new AudioExportFailure(error.status >= 500 ? "export_dependency_failed" : "export_source_invalid", error.status >= 500);
    throw new AudioExportFailure("export_build_failed", true);
  }
}

export type AudioExportOutcome = { status: "idle" | "succeeded" | "queued" | "failed" | "cancelled" | "lease_lost" | "completion_unknown"; jobId?: string };

export async function runOneGooglePlayAudioExport(sb: SupabaseClient, options: {
  fetcher?: typeof fetch; leaseSeconds?: number; storage?: { projectUrl: string; serviceKey: string };
} = {}): Promise<AudioExportOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 300;
  const storage = options.storage
    ? { SUPABASE_URL: options.storage.projectUrl, SUPABASE_SERVICE_ROLE_KEY: options.storage.serviceKey }
    : loadEnv();
  const claim = await sb.rpc("claim_audiobook_google_play_export", { p_lease_seconds: leaseSeconds });
  if (claim.error) throw new AudioExportFailure("export_claim_failed", true);
  const raw = row(claim.data);
  if (!raw) return { status: "idle" };
  const parsed = jobSchema.safeParse(raw);
  const jobId = String(raw.id);
  const leaseToken = String(raw.lease_token);
  if (!parsed.success) {
    await sb.rpc("fail_audiobook_google_play_export", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: "export_invalid_input", p_retryable: false });
    return { status: "failed", jobId };
  }
  const job = parsed.data;
  const abort = new AbortController();
  let heartbeatPending: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = (async () => {
      try {
        const response = await sb.rpc("heartbeat_audiobook_google_play_export", {
          p_job_id: job.id, p_lease_token: leaseToken, p_lease_seconds: leaseSeconds,
        });
        const result = row(response.data);
        if (response.error || result?.leased !== true || result.cancelled === true) {
          abort.abort(new AudioExportFailure(result?.cancelled === true ? "export_cancelled" : "export_lease_lost", false));
        }
      } catch { abort.abort(new AudioExportFailure("export_lease_lost", false)); }
    })().finally(() => { heartbeatPending = undefined; });
  }, Math.max(10_000, Math.floor(leaseSeconds * 1000 / 3)));
  heartbeat.unref();
  let archive: Awaited<ReturnType<typeof createArchive>>["archive"] | undefined;
  const objectPath = `workspaces/${job.workspace_id}/audiobook-exports/${job.id}/${leaseToken}.zip`;
  let uploadCompleted = false;
  try {
    const built = await createArchive(sb, job, abort.signal, options.fetcher ?? fetch, async (completed) => {
      const update = await sb.rpc("progress_audiobook_google_play_export", { p_job_id: job.id, p_lease_token: leaseToken, p_progress: completed });
      return !update.error && update.data === true;
    });
    archive = built.archive;
    const sha256 = await sha256File(archive.path, abort.signal);
    abort.signal.throwIfAborted();
    await uploadTusArchive(archive.path, objectPath, { projectUrl: storage.SUPABASE_URL, serviceKey: storage.SUPABASE_SERVICE_ROLE_KEY, signal: abort.signal, fetcher: options.fetcher });
    uploadCompleted = true;
    abort.signal.throwIfAborted();
    const completed = await sb.rpc("complete_audiobook_google_play_export", {
      p_job_id: job.id, p_lease_token: leaseToken, p_storage_path: objectPath,
      p_size_bytes: built.sizeBytes, p_sha256: sha256, p_duration_seconds: built.durationSeconds,
    });
    if (completed.error || row(completed.data)?.status !== "succeeded") {
      const readback = await sb.from("audiobook_google_play_export_jobs").select("status,output_storage_path,output_sha256")
        .eq("id", job.id).maybeSingle();
      if (!readback.error && readback.data?.status === "succeeded" && readback.data.output_storage_path === objectPath && readback.data.output_sha256 === sha256) {
        return { status: "succeeded", jobId };
      }
      if (readback.error || !readback.data) return { status: "completion_unknown", jobId };
      throw new AudioExportFailure("export_completion_failed", true);
    }
    return { status: "succeeded", jobId };
  } catch (error) {
    if (uploadCompleted) {
      const readback = await sb.from("audiobook_google_play_export_jobs").select("status,output_storage_path")
        .eq("id", job.id).maybeSingle();
      if (readback.error || !readback.data) return { status: "completion_unknown", jobId };
      if (readback.data.status === "succeeded" && readback.data.output_storage_path === objectPath) return { status: "succeeded", jobId };
    }
    const failure = error instanceof AudioExportFailure ? error : abort.signal.aborted
      ? abort.signal.reason as AudioExportFailure : new AudioExportFailure("export_worker_failed", true);
    const failed = await sb.rpc("fail_audiobook_google_play_export", {
      p_job_id: job.id, p_lease_token: leaseToken,
      p_error_code: failure.code, p_retryable: failure.retryable,
    });
    if (failed.error?.code === "40001") return { status: "lease_lost", jobId };
    if (failed.error || !row(failed.data)) throw new AudioExportFailure("export_failure_persistence_failed", true);
    // Fence the lease in the database BEFORE removing an uploaded object. A
    // timed-out completion request may still commit after a stale readback.
    // Successful failure persistence makes that late completion impossible.
    if (uploadCompleted) {
      try { await sb.storage.from(BUCKET).remove([objectPath]); }
      catch { /* The orphan report accounts for uploads left by failed cleanup. */ }
    }
    const status = row(failed.data)!.status;
    return { status: status === "cancelled" ? "cancelled" : status === "queued" ? "queued" : "failed", jobId };
  } finally {
    clearInterval(heartbeat);
    await heartbeatPending;
    await archive?.dispose();
  }
}
