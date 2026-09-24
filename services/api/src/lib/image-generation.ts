import OpenAI, { toFile } from "openai";
import { AppError } from "../errors.js";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
export type ImageQuality = "low" | "medium" | "high";

export interface ImageGenerationInput {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  referenceImages?: { bytes: Buffer; mimeType: "image/png" }[];
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: "image/png";
  provider: "openai";
  model: string;
  requestId: string | null;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMs: number };
}

export type ImageGenerator = (input: ImageGenerationInput) => Promise<GeneratedImage>;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function estimatedImageCost(model: string, usage: unknown): number {
  // Diagnostic provider estimate, not the customer credit debit. Prices are
  // standard Image API USD per token, reviewed against OpenAI on 2026-09-24.
  const rates = /^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(model)
    ? { textInput: 5e-6, imageInput: 8e-6, output: 30e-6 }
    : /^gpt-image-2(?:-|$)/.test(model)
      ? { textInput: 2.5e-6, imageInput: 4e-6, output: 15e-6 }
      : null;
  if (!rates) return 0;
  const value = usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } } | undefined;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const totalInput = valid(value?.input_tokens) ? value.input_tokens : 0;
  const textInput = valid(value?.input_tokens_details?.text_tokens) ? value.input_tokens_details.text_tokens : 0;
  const imageInput = valid(value?.input_tokens_details?.image_tokens) ? value.input_tokens_details.image_tokens : 0;
  const output = valid(value?.output_tokens) ? value.output_tokens : 0;
  // A partial modality breakdown must not make the unclassified input free.
  // Charge the unclassified remainder at the higher image-input rate.
  const knownText = Math.min(totalInput, textInput);
  const knownImage = Math.min(totalInput - knownText, imageInput);
  const unclassified = totalInput - knownText - knownImage;
  return Number((knownText * rates.textInput + (knownImage + unclassified) * rates.imageInput
    + output * rates.output).toFixed(6));
}

export const openAiImageGenerator: ImageGenerator = async ({ prompt, size, quality, referenceImages }) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError(503, "Image generation is not configured.", undefined, "image_provider_not_configured");
  }

  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2.5-sunburst";
  // An automatic retry after a lost response can generate and bill twice.
  // The caller holds an unresolved job for recovery instead of redispatching.
  const client = new OpenAI({ apiKey, timeout: 130_000, maxRetries: 0 });
  const started = Date.now();
  const result = referenceImages?.length ? await client.images.edit({
    model, prompt, size, quality, output_format: "png",
    image: await Promise.all(referenceImages.map((image, index) => toFile(image.bytes, `reference-${index + 1}.png`, { type: image.mimeType }))),
  }, { timeout: 130_000, maxRetries: 0 }) : await client.images.generate(
    { model, prompt, size, quality, output_format: "png" },
    { timeout: 130_000, maxRetries: 0 },
  );
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new AppError(503, "The image provider returned no image.", undefined, "image_provider_failed");

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AppError(503, "The image provider returned an invalid image.", undefined, "invalid_image_output");
  }

  return {
    bytes,
    mimeType: "image/png",
    provider: "openai",
    model,
    requestId: result._request_id ?? null,
    usage: {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      estimatedCostUsd: estimatedImageCost(model, result.usage),
      latencyMs: Date.now() - started,
    },
  };
};
