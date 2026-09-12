import OpenAI from "openai";
import { AppError } from "../errors.js";

export interface TranslationGenerationInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
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
  };
}

export type TranslationGenerator = (input: TranslationGenerationInput) => Promise<GeneratedTranslation>;

function estimateCost(model: string, inputTokens: number, outputTokens: number) {
  // Matches the server-side text model estimate in services/ai/gateway.py.
  if (!model.startsWith("gpt-6-astra")) return 0;
  const longContext = inputTokens > 272_000;
  return Number((inputTokens * 10e-6 * (longContext ? 2 : 1) + outputTokens * 50e-6 * (longContext ? 1.5 : 1)).toFixed(6));
}

export const openAiTranslationGenerator: TranslationGenerator = async ({ text, sourceLanguage, targetLanguage }) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AppError(503, "Translation is not configured.", undefined, "translation_provider_not_configured");
  if (!text.trim() || Array.from(text).length > 32_000) throw new AppError(422, "Translation input is unavailable or too large.");
  const model = process.env.OPENAI_TRANSLATION_MODEL?.trim() || process.env.DEFAULT_AI_MODEL?.trim() || "gpt-6-astra";
  const started = Date.now();
  const client = new OpenAI({ apiKey, timeout: 150_000, maxRetries: 0 });
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: "Translate the supplied manuscript chapter faithfully. Preserve paragraph breaks, dialogue, names, numbers, and intentional style. Return only the translated manuscript text; do not add commentary, notes, labels, or Markdown fences.",
      },
      {
        role: "user",
        content: `Source language: ${sourceLanguage}\nTarget language: ${targetLanguage}\n\n${text}`,
      },
    ],
  }, { timeout: 150_000, maxRetries: 0 });
  const translated = response.output_text?.trim() ?? "";
  if (!translated || Buffer.byteLength(translated, "utf8") > 128_000) {
    throw new AppError(503, "The translation provider returned invalid text.", undefined, "translation_invalid_output");
  }
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    text: translated,
    provider: "openai",
    model,
    requestId: (response as unknown as { _request_id?: string })._request_id ?? null,
    usage: { inputTokens, outputTokens, estimatedCostUsd: estimateCost(model, inputTokens, outputTokens), latencyMs: Date.now() - started },
  };
};
