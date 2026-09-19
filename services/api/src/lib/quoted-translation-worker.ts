import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { loadFundedUsage, claimPricedDispatch, settlePricedUsage } from "./funded-usage.js";
import { reconcileUsage, type TokenQuantities } from "./usage-pricing.js";
import { openAiTranslationGenerator, translationRequestHash, type TranslationGenerator } from "./translation-generation.js";

const jobSchema = z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), created_by: z.string().uuid(),
  billing_mode: z.literal("quoted"), lease_token: z.string().uuid(), input_ref: z.object({
    translationProjectId: z.string().uuid(), translationChapterId: z.string().uuid(), chapterId: z.string().uuid(), documentVersionId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceLanguage: z.string(), targetLanguage: z.string(), creditUnits: z.number().int().positive(),
  }).strict() }).passthrough();
const completionSchema = z.object({ p_job_id: z.string().uuid(), p_translated_text: z.string().min(1).max(128000),
  p_provider: z.literal("openai"), p_model: z.string().min(1), p_request_id: z.string().min(1).max(256),
  p_usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(), latencyMs: z.number().int().nonnegative(),
    measuredTokens: z.array(z.object({ dimension: z.enum(["text_input","text_cached_input","text_output"]), tokens: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict()),
  }).strict() }).strict();
export type QuotedTranslationOutcome = { status: "idle" | "succeeded" | "completion_unknown" | "requires_review"; jobId?: string };

export async function runOneQuotedTranslationJob(sb: SupabaseClient, options: { generator?: TranslationGenerator } = {}): Promise<QuotedTranslationOutcome> {
  const claimed = await sb.rpc("claim_quoted_translation_job", { p_lease_seconds: 600 });
  if (claimed.error) throw new Error("quoted translation claim unavailable");
  const raw = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  if (!raw) return { status: "idle" };
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success) return { status: "completion_unknown" };
  const job = parsed.data;
  let renewal: Promise<void> | undefined; let leaseLost = false;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = Promise.resolve(sb.rpc("renew_translation_lease", { p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: 600 }))
      .then((r) => { if (r.error || r.data !== true) leaseLost = true; }).catch(() => { leaseLost = true; }).finally(() => { renewal = undefined; });
  }, 180000); heartbeat.unref();
  try {
    const savedQuote = await loadFundedUsage(sb, job.id);
    if (!savedQuote || savedQuote.user_id !== job.created_by || savedQuote.workspace_id !== job.workspace_id) throw new Error("quote mismatch");
    const quote = savedQuote.quote_json;
    const prior = await sb.from("translation_completion_receipts").select("completion_json").eq("ai_job_id", job.id).maybeSingle();
    if (prior.error) throw new Error("receipt unavailable");
    let completion: unknown = prior.data?.completion_json;
    if (!completion) {
      const document = await sb.from("document_versions").select("id,chapter_id,plain_text").eq("id", job.input_ref.documentVersionId).eq("chapter_id", job.input_ref.chapterId).maybeSingle();
      const text = document.data?.plain_text;
      if (document.error || typeof text !== "string" || !text.trim() || Array.from(text).length > 32000
        || createHash("sha256").update(text).digest("hex") !== job.input_ref.sourceSha256) throw new Error("source mismatch");
      const outputBound = quote.maximumTokens.find((q) => q.dimension === "text_output")?.tokens;
      if (!outputBound || BigInt(outputBound) < 1n || BigInt(outputBound) > 128000n) throw new Error("invalid quoted output bound");
      const request = { text, sourceLanguage: job.input_ref.sourceLanguage, targetLanguage: job.input_ref.targetLanguage,
        model: quote.price.model, maxOutputTokens: Number(outputBound) };
      if (translationRequestHash(request) !== quote.scope.inputSha256 || leaseLost) throw new Error("quoted request mismatch");
      await claimPricedDispatch(sb, { jobId: job.id, leaseToken: job.lease_token, model: request.model, inputSha256: translationRequestHash(request) });
      const generated = await (options.generator ?? openAiTranslationGenerator)(request);
      completion = { p_job_id: job.id, p_translated_text: generated.text, p_provider: generated.provider,
        p_model: generated.model, p_request_id: generated.requestId, p_usage: generated.usage };
      // Persist even a non-billable/malformed usage receipt. Never regenerate it.
      const written = await sb.from("translation_completion_receipts").insert({ ai_job_id: job.id, completion_json: completion });
      if (written.error) throw new Error("receipt persistence uncertain");
    }
    const receipt = completionSchema.parse(completion);
    if (receipt.p_job_id !== job.id || Buffer.byteLength(receipt.p_translated_text, "utf8") > 128000) throw new Error("receipt mismatch");
    const counts = receipt.p_usage.measuredTokens;
    if (counts.length !== 3 || new Set(counts.map((v) => v.dimension)).size !== 3
      || BigInt(counts.find((v) => v.dimension === "text_input")!.tokens) + BigInt(counts.find((v) => v.dimension === "text_cached_input")!.tokens) !== BigInt(receipt.p_usage.inputTokens)
      || BigInt(counts.find((v) => v.dimension === "text_output")!.tokens) !== BigInt(receipt.p_usage.outputTokens)) throw new Error("inconsistent measured usage");
    const measured = { scope: quote.scope, provider: receipt.p_provider, model: receipt.p_model, requestId: receipt.p_request_id,
      measurement: "measured" as const, tokens: receipt.p_usage.measuredTokens as TokenQuantities };
    const settlement = reconcileUsage(quote, measured);
    clearInterval(heartbeat); await renewal;
    if (leaseLost) throw new Error("lease lost");
    if (settlement.status === "requires_review") {
      await settlePricedUsage(sb, job.id, measured);
      return { status: "requires_review", jobId: job.id };
    }
    const completed = await sb.rpc("complete_quoted_translation", { ...receipt, p_lease_token: job.lease_token, p_settlement: settlement });
    if (completed.error || !completed.data) throw new Error("completion uncertain");
    return { status: "succeeded", jobId: job.id };
  } catch {
    // No fail/requeue/refund on uncertain outcomes. Lease recovery can read a
    // saved receipt; the irreversible dispatch marker prohibits a second call.
    return { status: "completion_unknown", jobId: job.id };
  } finally { clearInterval(heartbeat); await renewal; }
}
