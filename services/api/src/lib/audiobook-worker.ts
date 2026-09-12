import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { openAiSpeechGenerator, type SpeechGenerator } from "./speech-generation.js";

const BUCKET = "book-assets";
const claimSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), lease_token: z.string().uuid(),
  input_ref: z.object({
    audiobookProjectId: z.string().uuid(), documentVersionId: z.string().uuid(),
    segmentIndex: z.number().int().min(0).max(249), textStart: z.number().int().nonnegative(),
    textEnd: z.number().int().positive(), textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    creditUnits: z.number().int().min(1).max(5),
  }).strict(),
}).passthrough();
const projectSchema = z.object({
  id: z.string().uuid(), voice: z.enum(["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"]),
  instructions: z.string().nullable(), speed: z.coerce.number().min(0.25).max(4), status: z.string(),
}).passthrough();
const receiptSchema = z.object({
  p_job_id: z.string().uuid(), p_asset_id: z.string().uuid(), p_storage_path: z.string(),
  p_mime_type: z.literal("audio/mpeg"), p_size_bytes: z.number().int().positive().max(50 * 1024 * 1024),
  p_checksum: z.string().regex(/^[a-f0-9]{64}$/), p_provider: z.string(), p_model: z.string(),
  p_request_id: z.string().nullable(), p_usage: z.record(z.unknown()),
}).strict();
export type AudiobookWorkerOutcome = { status: "idle" | "succeeded" | "failed" | "lease_lost" | "completion_unknown"; jobId?: string };

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

async function completeFromReceipt(sb: SupabaseClient, leaseToken: string, raw: unknown) {
  const receipt = receiptSchema.safeParse(raw);
  if (!receipt.success) return false;
  const stored = await sb.storage.from(BUCKET).download(receipt.data.p_storage_path);
  if (stored.error || !stored.data) return false;
  const bytes = Buffer.from(await stored.data.arrayBuffer());
  if (bytes.length !== receipt.data.p_size_bytes || createHash("sha256").update(bytes).digest("hex") !== receipt.data.p_checksum) return false;
  const completed = await sb.rpc("complete_audiobook_segment", { ...receipt.data, p_lease_token: leaseToken });
  return !completed.error && Boolean(row(completed.data));
}

export async function runOneAudiobookJob(
  sb: SupabaseClient,
  options: { speechGenerator?: SpeechGenerator; leaseSeconds?: number } = {},
): Promise<AudiobookWorkerOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 600;
  const claim = await sb.rpc("claim_audiobook_job", { p_lease_seconds: leaseSeconds });
  if (claim.error) throw new Error("audiobook claim failed");
  const raw = row(claim.data);
  if (!raw) return { status: "idle" };
  const parsed = claimSchema.safeParse(raw);
  const jobId = String(raw.id);
  const leaseToken = String(raw.lease_token);
  if (!parsed.success) {
    await sb.rpc("fail_audiobook_job", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: "audio_invalid_input", p_error_message: "Invalid queued narration job", p_retryable: false });
    return { status: "failed", jobId };
  }

  const prior = await sb.from("audiobook_completion_receipts").select("completion_json").eq("ai_job_id", jobId).maybeSingle();
  if (prior.error) return { status: "completion_unknown", jobId };
  if (prior.data) {
    const recovered = await completeFromReceipt(sb, leaseToken, prior.data.completion_json);
    return { status: recovered ? "succeeded" : "completion_unknown", jobId };
  }

  const renewed = await sb.rpc("renew_audiobook_lease", { p_job_id: jobId, p_lease_token: leaseToken, p_lease_seconds: leaseSeconds });
  if (renewed.error || renewed.data !== true) return { status: "lease_lost", jobId };
  const input = parsed.data.input_ref;
  const [{ data: project, error: projectError }, { data: document, error: documentError }] = await Promise.all([
    sb.from("audiobook_projects").select("*").eq("id", input.audiobookProjectId).maybeSingle(),
    sb.from("document_versions").select("id,plain_text").eq("id", input.documentVersionId).maybeSingle(),
  ]);
  const projectResult = projectSchema.safeParse(project);
  if (projectError || documentError || !projectResult.success || !document) {
    await sb.rpc("fail_audiobook_job", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: "audio_source_unavailable", p_error_message: "Saved narration source is unavailable", p_retryable: false });
    return { status: "failed", jobId };
  }
  const text = Array.from(String(document.plain_text)).slice(input.textStart, input.textEnd).join("");
  if (!text || Array.from(text).length > 4_096 || createHash("sha256").update(text, "utf8").digest("hex") !== input.textSha256) {
    await sb.rpc("fail_audiobook_job", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: "audio_source_changed", p_error_message: "Saved narration segment no longer matches", p_retryable: false });
    return { status: "failed", jobId };
  }

  const storagePath = `workspaces/${parsed.data.workspace_id}/audiobooks/${input.audiobookProjectId}/${input.segmentIndex}.mp3`;
  const existing = await sb.storage.from(BUCKET).download(storagePath);
  if (!existing.error && existing.data) return { status: "completion_unknown", jobId };

  let generated;
  try {
    generated = await (options.speechGenerator ?? openAiSpeechGenerator)({
      text, voice: projectResult.data.voice, instructions: projectResult.data.instructions, speed: projectResult.data.speed,
    });
  } catch {
    await sb.rpc("fail_audiobook_job", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: "speech_provider_failed", p_error_message: "Speech generation failed", p_retryable: false });
    return { status: "failed", jobId };
  }

  const assetId = randomUUID();
  const checksum = createHash("sha256").update(generated.bytes).digest("hex");
  const uploaded = await sb.storage.from(BUCKET).upload(storagePath, generated.bytes, { contentType: generated.mimeType, upsert: false });
  if (uploaded.error) return { status: "completion_unknown", jobId };
  const completion = {
    p_job_id: jobId, p_asset_id: assetId, p_storage_path: storagePath, p_mime_type: generated.mimeType,
    p_size_bytes: generated.bytes.length, p_checksum: checksum, p_provider: generated.provider,
    p_model: generated.model, p_request_id: generated.requestId, p_usage: generated.usage,
  };
  const saved = await sb.from("audiobook_completion_receipts").insert({ ai_job_id: jobId, completion_json: completion });
  if (saved.error) return { status: "completion_unknown", jobId };
  const completed = await completeFromReceipt(sb, leaseToken, completion);
  return { status: completed ? "succeeded" : "completion_unknown", jobId };
}
