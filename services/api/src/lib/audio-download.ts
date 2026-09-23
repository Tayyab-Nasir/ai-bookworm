import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";

const MAX_INPUT = 100 * 1024 * 1024;
const MAX_OUTPUT = 150 * 1024 * 1024;
const projectSchema = z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), document_version_id: z.string().uuid(), status: z.literal("succeeded"), segment_count: z.number().int().min(1).max(250) }).passthrough();
const assetSchema = z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), storage_path: z.string(), mime_type: z.literal("audio/mpeg"),
  type: z.literal("audiobook_segment"), size_bytes: z.number().int().positive().max(50 * 1024 * 1024), checksum: z.string().regex(/^[a-f0-9]{64}$/i), deleted_at: z.null().optional() }).passthrough();
const audioQualitySchema = z.object({
  schemaVersion: z.literal(1), profile: z.string().max(120), chapterDurationSeconds: z.number().finite().nonnegative().max(7200),
  sampleRateHz: z.number().int().positive(), channels: z.number().int().positive().max(2), bitRateKbps: z.number().int().positive(),
  bitRateMode: z.enum(["cbr", "vbr", "unknown"]), rmsDbfs: z.number().finite().min(-200).max(0), samplePeakDbfs: z.number().finite().min(-200).max(0),
  technicalChecks: z.record(z.string().max(60), z.object({ status: z.enum(["pass", "attention", "fail", "manual_review"]),
    value: z.union([z.number().finite(), z.string().max(120)]).nullable(), unit: z.string().max(30).optional(), limit: z.string().max(200) }).strict()),
  reviewRequired: z.boolean(), acxNarrationPolicy: z.literal("explicit_authorization_required_for_ai_voice"),
}).strict();
export type AudioQualityReport = z.infer<typeof audioQualitySchema>;
export type LoadedChapterAudio = {
  projectId: string;
  workspaceId: string;
  documentVersionId: string;
  segments: Buffer[];
  sourceManifestSha256: string;
};

/** Uses the caller's RLS-scoped client; never accepts URLs or source paths from a request. */
export async function loadChapterAudio(sb: SupabaseClient, projectId: string): Promise<LoadedChapterAudio> {
  if (!z.string().uuid().safeParse(projectId).success) throw new AppError(404, "Narration not found.");
  const projectResult = await sb.from("audiobook_projects").select("*").eq("id", projectId).maybeSingle();
  if (projectResult.error) throw new AppError(503, "Could not load narration.");
  if (!projectResult.data) throw new AppError(404, "Narration not found.");
  const parsed = projectSchema.safeParse(projectResult.data);
  if (!parsed.success) throw new AppError(409, "All narration segments must complete before assembly.");
  const project = parsed.data;
  const result = await sb.from("audiobook_segments").select("segment_index,asset_id,completed_at").eq("project_id", project.id).order("segment_index");
  if (result.error) throw new AppError(503, "Could not load narration segments.");
  const segments = result.data ?? [];
  if (segments.length !== project.segment_count || segments.some((segment, index) => segment.segment_index !== index || !segment.asset_id || !segment.completed_at)) {
    throw new AppError(409, "The chapter has missing or unfinished narration segments.");
  }
  const assetsResult = await sb.from("assets").select("*").eq("workspace_id", project.workspace_id).is("deleted_at", null).in("id", segments.map((segment) => segment.asset_id));
  if (assetsResult.error) throw new AppError(503, "Could not load narration files.");
  const assets = new Map((assetsResult.data ?? []).map((asset) => [asset.id, asset]));
  const descriptors = segments.map((segment, index) => {
    const asset = assetSchema.safeParse(assets.get(segment.asset_id));
    if (!asset.success || asset.data.workspace_id !== project.workspace_id || asset.data.storage_path !== `workspaces/${project.workspace_id}/audiobooks/${project.id}/${index}.mp3`) {
      throw new AppError(422, "A narration file is missing or does not belong to this chapter.");
    }
    return asset.data;
  });
  if (descriptors.reduce((total, asset) => total + asset.size_bytes, 0) > MAX_INPUT) throw new AppError(413, "This chapter exceeds the 100 MiB assembly limit.");
  const output: Buffer[] = [];
  for (const asset of descriptors) {
    const file = await sb.storage.from("book-assets").download(asset.storage_path);
    if (file.error || !file.data) throw new AppError(503, "A private narration file is unavailable.");
    if (file.data.size !== asset.size_bytes) throw new AppError(422, "Narration file size changed; assembly stopped.");
    const bytes = Buffer.from(await file.data.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum.toLowerCase()) throw new AppError(422, "Narration file integrity check failed.");
    output.push(bytes);
  }
  const sourceManifestSha256 = createHash("sha256").update(JSON.stringify({
    projectId: project.id,
    documentVersionId: project.document_version_id,
    assets: descriptors.map(({ id, checksum, size_bytes }) => ({ id, checksum: checksum.toLowerCase(), sizeBytes: size_bytes })),
  })).digest("hex");
  return { projectId: project.id, workspaceId: project.workspace_id, documentVersionId: project.document_version_id, segments: output, sourceManifestSha256 };
}

export async function assembleChapterAudio(segments: Buffer[], fetcher: typeof fetch = fetch): Promise<{ bytes: Buffer; quality: AudioQualityReport | null; audioSha256: string }> {
  const base = process.env.RENDERING_SERVICE_URL ?? `http://127.0.0.1:${process.env.RENDERING_SERVICE_PORT ?? "8002"}`;
  const token = process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN;
  const response = await fetcher(`${base.replace(/\/$/, "")}/audio/assemble`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-service-token": token } : {}) },
    body: JSON.stringify({ segmentsBase64: segments.map((bytes) => bytes.toString("base64")) }),
    redirect: "error", signal: AbortSignal.timeout(150_000),
  }).catch(() => { throw new AppError(503, "Audio assembly is unavailable. Your saved narration is unchanged."); });
  if (response.status === 422) throw new AppError(422, "Narration files cannot be decoded within the chapter assembly limits.");
  if (!response.ok || !response.body) throw new AppError(503, "Audio assembly is unavailable. Your saved narration is unchanged.");
  if (Number(response.headers.get("content-length")) > MAX_OUTPUT) { await response.body.cancel(); throw new AppError(503, "Assembled chapter exceeds the download limit."); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_OUTPUT) { await reader.cancel(); throw new AppError(503, "Assembled chapter exceeds the download limit."); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const mp3 = bytes.subarray(0, 3).toString() === "ID3" || (bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const audioSha256 = createHash("sha256").update(bytes).digest("hex");
  if (!mp3 || audioSha256 !== response.headers.get("x-artifact-sha256")) throw new AppError(503, "Assembled chapter integrity check failed.");
  const qualityHeader = response.headers.get("x-bookworm-audio-qc");
  let qualityResult: ReturnType<typeof audioQualitySchema.safeParse> | null = null;
  if (qualityHeader) {
    try { qualityResult = qualityHeader.length <= 8192 ? audioQualitySchema.safeParse(JSON.parse(qualityHeader)) : null; }
    catch { qualityResult = null; }
  }
  if (qualityHeader && !qualityResult?.success) throw new AppError(503, "Audio quality report could not be verified.");
  return { bytes, quality: qualityResult?.success ? qualityResult.data : null, audioSha256 };
}
