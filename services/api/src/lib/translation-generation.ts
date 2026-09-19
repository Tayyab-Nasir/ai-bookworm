import OpenAI from "openai";
import { AppError } from "../errors.js";
import { createHash } from "node:crypto";
import type { TokenQuantities } from "./usage-pricing.js";

export interface TranslationGenerationInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  model?: string;
  maxOutputTokens?: number;
}

export interface GeneratedTranslation {
  text: string;
  provider: "openai";
  model: string;
  requestId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    latencyMs: number;
    measuredTokens?: TokenQuantities;
  };
}

export type TranslationGenerator = (input: TranslationGenerationInput) => Promise<GeneratedTranslation>;

function estimateCost(model: string, inputTokens: number, outputTokens: number) {
  // Matches the server-side text model estimate in services/ai/gateway.py.
  if (!model.startsWith("gpt-6-astra")) return 0;
  const longContext = inputTokens > 272_000;
  return Number((inputTokens * 10e-6 * (longContext ? 2 : 1) + outputTokens * 50e-6 * (longContext ? 1.5 : 1)).toFixed(6));
}

const translationInstruction = "Translate the supplied manuscript chapter faithfully. Preserve paragraph breaks, dialogue, names, numbers, and intentional style. Return only the translated manuscript text; do not add commentary, notes, labels, or Markdown fences.";
export function translationProviderRequest(input: TranslationGenerationInput & { model: string }) {
  return { model: input.model, ...(input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens }),
    input: [{ role: "system" as const, content: translationInstruction },
      { role: "user" as const, content: `Source language: ${input.sourceLanguage}\nTarget language: ${input.targetLanguage}\n\n${input.text}` }] };
}
export function translationRequestHash(input: TranslationGenerationInput & { model: string; maxOutputTokens: number }) {
  return createHash("sha256").update(JSON.stringify(translationProviderRequest(input))).digest("hex");
}
export function measuredTranslationTokens(raw: unknown): TokenQuantities | undefined {
  const value = raw as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | null;
  const total = value?.input_tokens; const output = value?.output_tokens; const cached = value?.input_tokens_details?.cached_tokens;
  if (![total, output, cached].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || cached! > total! || (value?.input_tokens_details?.cache_write_tokens ?? 0) !== 0) return undefined;
  return [{ dimension: "text_input", tokens: String(total! - cached!) },
    { dimension: "text_cached_input", tokens: String(cached) }, { dimension: "text_output", tokens: String(output) }];
}

export const openAiTranslationGenerator: TranslationGenerator = async (input) => {
  const { text, sourceLanguage, targetLanguage } = input;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AppError(503, "Translation is not configured.", undefined, "translation_provider_not_configured");
  if (!text.trim() || Array.from(text).length > 32_000) throw new AppError(422, "Translation input is unavailable or too large.");
  const model = input.model ?? (process.env.OPENAI_TRANSLATION_MODEL?.trim() || process.env.DEFAULT_AI_MODEL?.trim() || "gpt-6-astra");
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 128000)) {
    throw new AppError(422, "Invalid translation output limit.");
  }
  const started = Date.now();
  const client = new OpenAI({ apiKey, timeout: 150_000, maxRetries: 0 });
  const response = await client.responses.create(translationProviderRequest({ ...input, model }), { timeout: 150_000, maxRetries: 0 });
  const translated = response.output_text?.trim() ?? "";
  if (response.status !== "completed" || !translated || Buffer.byteLength(translated, "utf8") > 128_000) {
    throw new AppError(503, "The translation provider returned invalid text.", undefined, "translation_invalid_output");
  }
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    text: translated,
    provider: "openai",
    model: response.model,
    requestId: (response as unknown as { _request_id?: string })._request_id ?? null,
    usage: { inputTokens, outputTokens, estimatedCostUsd: estimateCost(model, inputTokens, outputTokens), latencyMs: Date.now() - started,
      measuredTokens: measuredTranslationTokens(response.usage) },
  };
};
