/** Pure image quote contract. No provider calls, reservations or retail defaults.
 * A quote is only an offer; dispatch still requires an atomic funded acceptance.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { policySchema, priceSchema, quoteUsage, reconcileUsage, type UsageQuote } from "./usage-pricing.js";

const dimensions = ["image_input", "image_output", "text_input", "text_output"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limit = z.number().int().positive().max(10_000_000);
const entrySchema = z.object({
  id: z.string().min(1).max(128), label: z.string().min(1).max(128),
  price: priceSchema, policy: policySchema,
  size: z.enum(["1024x1024", "1024x1536", "1536x1024"]), quality: z.enum(["low", "medium", "high"]),
  maxPromptBytes: limit, maxReferenceImages: z.number().int().min(0).max(3),
  maximumTokens: z.object({ image_input: integer, image_output: limit, text_input: limit, text_output: integer }).strict(),
}).strict();
const catalogSchema = z.object({
  version: z.string().min(1).max(128), approved: z.literal(true),
  effectiveAt: z.string().datetime(), expiresAt: z.string().datetime(),
  quoteLifetimeSeconds: z.number().int().min(30).max(3600),
  entries: z.array(entrySchema).min(1).max(50),
}).strict();
const requestSchema = z.object({
  jobId: z.string().uuid(), workspaceId: z.string().uuid(), userId: z.string().uuid(), bookId: z.string().uuid().nullable(),
  kind: z.enum(["illustration", "cover"]), model: z.string().min(1).max(128),
  prompt: z.string().min(1), size: entrySchema.shape.size, quality: entrySchema.shape.quality,
  references: z.array(z.object({ assetId: z.string().uuid(), version: z.number().int().positive(),
    sha256: hash, mimeType: z.literal("image/png") }).strict()).max(3),
}).strict();
export type ImageQuoteRequest = z.infer<typeof requestSchema>;

export function imageCatalog(raw: string | undefined, now: string) {
  try {
    const time = Date.parse(z.string().datetime().parse(now));
    const catalog = catalogSchema.parse(JSON.parse(raw ?? ""));
    if (time < Date.parse(catalog.effectiveAt) || time >= Date.parse(catalog.expiresAt)
      || new Set(catalog.entries.map((entry) => entry.id)).size !== catalog.entries.length) throw new Error("invalid catalog");
    for (const entry of catalog.entries) {
      const rates = entry.price.rates.map((rate) => rate.dimension).sort();
      if (JSON.stringify(rates) !== JSON.stringify(dimensions)
        || (entry.maxReferenceImages > 0 && entry.maximumTokens.image_input === 0)) throw new Error("invalid image dimensions");
    }
    return catalog;
  } catch {
    throw new AppError(503, "Usage-priced images are not configured for purchase.", undefined, "image_catalog_unavailable");
  }
}

export function imageRequestHash(value: ImageQuoteRequest): string {
  // Parsing fixes object field order. Reference array order is provider-significant.
  return createHash("sha256").update(JSON.stringify(requestSchema.parse(value))).digest("hex");
}

export function prepareImageQuote(raw: string | undefined, input: {
  modelId: string; now: string; request: ImageQuoteRequest;
}) {
  const catalog = imageCatalog(raw, input.now);
  const entry = catalog.entries.find((item) => item.id === input.modelId);
  const request = requestSchema.parse(input.request);
  if (!entry || request.model !== entry.price.model || request.size !== entry.size || request.quality !== entry.quality
    || Buffer.byteLength(request.prompt, "utf8") > entry.maxPromptBytes
    || request.references.length > entry.maxReferenceImages
    || new Set(request.references.map((ref) => ref.assetId)).size !== request.references.length) {
    throw new AppError(422, "The image request does not match an approved pricing option.");
  }
  const quote = quoteUsage({ scope: { jobId: request.jobId, workspaceId: request.workspaceId,
    userId: request.userId, inputSha256: imageRequestHash(request) }, price: entry.price, policy: entry.policy,
    maximumTokens: dimensions.map((dimension) => ({ dimension, tokens: String(entry.maximumTokens[dimension]) })),
    createdAt: input.now,
    expiresAt: new Date(Math.min(Date.parse(input.now) + catalog.quoteLifetimeSeconds * 1000, Date.parse(catalog.expiresAt))).toISOString(),
  });
  if (BigInt(quote.reservedCredits) > 2_147_483_647n) throw new AppError(422, "Image quote exceeds the credit ledger limit.");
  return { quote, request, catalogVersion: catalog.version, pricingBasis: "maximum_token_budget" as const };
}

const modality = z.object({ text_tokens: integer, image_tokens: integer }).strict();
const receiptSchema = z.object({ input_tokens: integer, output_tokens: integer, total_tokens: integer,
  input_tokens_details: modality, output_tokens_details: modality }).strict();

export function reconcileImageUsage(quote: UsageQuote, input: {
  request: ImageQuoteRequest; requestId: string; model: string; providerUsage: unknown;
}) {
  const request = requestSchema.parse(input.request);
  const measured = receiptSchema.parse(input.providerUsage);
  if (BigInt(measured.input_tokens_details.text_tokens) + BigInt(measured.input_tokens_details.image_tokens) !== BigInt(measured.input_tokens)
    || BigInt(measured.output_tokens_details.text_tokens) + BigInt(measured.output_tokens_details.image_tokens) !== BigInt(measured.output_tokens)
    || BigInt(measured.input_tokens) + BigInt(measured.output_tokens) !== BigInt(measured.total_tokens)) {
    throw new Error("Image provider token totals require review");
  }
  return reconcileUsage(quote, { scope: { jobId: request.jobId, workspaceId: request.workspaceId,
    userId: request.userId, inputSha256: imageRequestHash(request) }, provider: "openai", model: input.model,
    requestId: input.requestId, measurement: "measured", tokens: [
      { dimension: "text_input", tokens: String(measured.input_tokens_details.text_tokens) },
      { dimension: "image_input", tokens: String(measured.input_tokens_details.image_tokens) },
      { dimension: "text_output", tokens: String(measured.output_tokens_details.text_tokens) },
      { dimension: "image_output", tokens: String(measured.output_tokens_details.image_tokens) },
    ] });
}
