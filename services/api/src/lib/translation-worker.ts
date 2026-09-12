import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { openAiTranslationGenerator, type TranslationGenerator } from "./translation-generation.js";

const inputSchema = z.object({
  translationProjectId: z.string().uuid(), translationChapterId: z.string().uuid(), chapterId: z.string().uuid(), documentVersionId: z.string().uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceLanguage: z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/),
  targetLanguage: z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/), creditUnits: z.number().int().min(1).max(32),
}).strict();
const claimSchema = z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), lease_token: z.string().uuid(), input_ref: inputSchema }).passthrough();
const projectSchema = z.object({ id: z.string().uuid(), source_language: z.string(), target_language: z.string(), status: z.string() }).passthrough();
const receiptSchema = z.object({
  p_job_id: z.string().uuid(), p_translated_text: z.string().min(1).max(128_000), p_provider: z.string().min(1).max(100),
  p_model: z.string().min(1).max(200), p_request_id: z.string().max(500).nullable(), p_usage: z.record(z.unknown()),
}).strict();

export type TranslationWorkerOutcome = { status: "idle" | "succeeded" | "queued" | "failed" | "lease_lost" | "completion_unknown"; jobId?: string };
class TranslationFailure extends Error { constructor(readonly code: string, readonly retryable: boolean) { super(code); } }
const row = (value: unknown): Record<string, unknown> | null => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
};

async function completeFromReceipt(sb: SupabaseClient, leaseToken: string, raw: unknown) {
  const receipt = receiptSchema.safeParse(raw);
  if (!receipt.success) return false;
  const completed = await sb.rpc("complete_translation_chapter", { ...receipt.data, p_lease_token: leaseToken });
  return !completed.error && Boolean(row(completed.data));
}

export async function runOneTranslationJob(
  sb: SupabaseClient,
  options: { generator?: TranslationGenerator; leaseSeconds?: number } = {},
): Promise<TranslationWorkerOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 600;
  const claim = await sb.rpc("claim_translation_job", { p_lease_seconds: leaseSeconds });
  if (claim.error) throw new Error("translation claim failed");
  const raw = row(claim.data);
  if (!raw) return { status: "idle" };
  const parsed = claimSchema.safeParse(raw);
  const jobId = String(raw.id); const leaseToken = String(raw.lease_token);
  if (!parsed.success) {
    await sb.rpc("fail_translation_job", { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: "translation_invalid_input", p_error_message: "Invalid queued translation job", p_retryable: false });
    return { status: "failed", jobId };
  }
  const abort = new AbortController(); let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = Promise.resolve(sb.rpc("renew_translation_lease", { p_job_id: jobId, p_lease_token: leaseToken, p_lease_seconds: leaseSeconds }))
      .then((renewed) => { if (renewed.error || renewed.data !== true) abort.abort(); })
      .catch(() => abort.abort()).finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3));
  heartbeat.unref();
  try {
    const prior = await sb.from("translation_completion_receipts").select("completion_json").eq("ai_job_id", jobId).maybeSingle();
    if (prior.error) return { status: "completion_unknown", jobId };
    if (prior.data) return { status: await completeFromReceipt(sb, leaseToken, prior.data.completion_json) ? "succeeded" : "completion_unknown", jobId };
    const renewed = await sb.rpc("renew_translation_lease", { p_job_id: jobId, p_lease_token: leaseToken, p_lease_seconds: leaseSeconds });
    if (renewed.error || renewed.data !== true) return { status: "lease_lost", jobId };
    const input = parsed.data.input_ref;
    const [{ data: project, error: projectError }, { data: document, error: documentError }] = await Promise.all([
      sb.from("translation_projects").select("*").eq("id", input.translationProjectId).maybeSingle(),
      sb.from("document_versions").select("id,chapter_id,plain_text").eq("id", input.documentVersionId).eq("chapter_id", input.chapterId).maybeSingle(),
    ]);
    const projectResult = projectSchema.safeParse(project);
    if (projectError || documentError || !projectResult.success || !document
      || projectResult.data.source_language !== input.sourceLanguage || projectResult.data.target_language !== input.targetLanguage) {
      throw new TranslationFailure("translation_source_unavailable", false);
    }
    const text = String(document.plain_text);
    if (!text.trim() || Array.from(text).length > 32_000 || createHash("sha256").update(text, "utf8").digest("hex") !== input.sourceSha256) {
      throw new TranslationFailure("translation_source_changed", false);
    }
    abort.signal.throwIfAborted();
    let generated;
    try {
      generated = await (options.generator ?? openAiTranslationGenerator)({ text, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage });
    } catch (error) {
      if (error instanceof AppError && error.code === "translation_invalid_output") throw new TranslationFailure("translation_invalid_output", false);
      throw new TranslationFailure("translation_provider_failed", true);
    }
    abort.signal.throwIfAborted();
    const completion = {
      p_job_id: jobId, p_translated_text: generated.text, p_provider: generated.provider, p_model: generated.model,
      p_request_id: generated.requestId, p_usage: generated.usage,
    };
    const saved = await sb.from("translation_completion_receipts").insert({ ai_job_id: jobId, completion_json: completion });
    if (saved.error) return { status: "completion_unknown", jobId };
    return { status: await completeFromReceipt(sb, leaseToken, completion) ? "succeeded" : "completion_unknown", jobId };
  } catch (error) {
    if (abort.signal.aborted) return { status: "lease_lost", jobId };
    const failure = error instanceof TranslationFailure ? error : new TranslationFailure("translation_execution_failed", true);
    const failed = await sb.rpc("fail_translation_job", { p_job_id: jobId, p_lease_token: leaseToken,
      p_error_code: failure.code, p_error_message: "Translation could not be completed.", p_retryable: failure.retryable });
    if (failed.error?.code === "40001") return { status: "lease_lost", jobId };
    if (failed.error || !row(failed.data)) throw new Error("translation failure persistence failed");
    return { status: row(failed.data)?.status === "queued" ? "queued" : "failed", jobId };
  } finally {
    clearInterval(heartbeat); await renewal;
  }
}
