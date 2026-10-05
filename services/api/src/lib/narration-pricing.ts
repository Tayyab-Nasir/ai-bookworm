/** Server-owned narration offers and measured reconciliation. No provider call,
 * database mutation, default prices or funding authorization happens here. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import { MAX_TTS_INPUT_BYTES, segmentSpeechText } from "./speech-generation.js";
import { REALTIME_NARRATION_MODELS, REALTIME_NARRATION_VOICES, measuredNarrationQuantities,
  narrationInstructions } from "./realtime-narration.js";
import { priceSchema, policySchema, quoteUsage, reconcileUsage, type UsageQuote } from "./usage-pricing.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scalarText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => Buffer.from(value, "utf8").toString("utf8") === value, "Invalid Unicode source.");
const outputBudget = z.number().int().min(1).max(4_096);
const dimensions = ["audio_output", "text_cached_input", "text_input", "text_output"] as const;
const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(100),
  price: priceSchema.extend({ model: z.enum(REALTIME_NARRATION_MODELS) }), policy: policySchema,
  // No Realtime-specific token-count receipt is available before dispatch here.
  // Reserve the supported context ceiling, not a character/token approximation.
  maxInputTokens: z.literal(128_000), maxOutputTokens: outputBudget,
}).strict();
const catalogSchema = z.object({
  version: z.string().trim().min(1).max(128), approved: z.literal(true),
  approvalReference: z.string().trim().min(1).max(256),
  effectiveAt: z.string().datetime(), expiresAt: z.string().datetime(),
  quoteLifetimeSeconds: z.number().int().min(30).max(3_600),
  entries: z.array(entrySchema).min(1).max(20),
}).strict();
export type NarrationCatalog = z.output<typeof catalogSchema>;
const unavailable = () => new AppError(503, "Usage-priced narration is not configured for purchase.", undefined, "narration_catalog_unavailable");

export function readNarrationCatalog(raw: string | undefined, now: string): NarrationCatalog {
  try {
    if (!raw || Buffer.byteLength(raw, "utf8") > 65_536) throw unavailable();
    const catalog = catalogSchema.parse(JSON.parse(raw));
    const time = Date.parse(z.string().datetime().parse(now));
    if (time < Date.parse(catalog.effectiveAt) || time >= Date.parse(catalog.expiresAt)
      || Date.parse(catalog.expiresAt) <= Date.parse(catalog.effectiveAt)
      || new Set(catalog.entries.map(entry => entry.id)).size !== catalog.entries.length) throw unavailable();
    const prices = new Map<string, string>(); const policies = new Map<string, string>();
    for (const entry of catalog.entries) {
      entry.price.rates.sort((a, b) => a.dimension.localeCompare(b.dimension));
      if (!isDeepStrictEqual(entry.price.rates.map(rate => rate.dimension), dimensions)
        || entry.price.rates.some(rate => rate.dimension !== "text_cached_input" && BigInt(rate.microUsdPerMillionTokens) === 0n)) throw unavailable();
      for (const [registry, version, value] of [
        [prices, entry.price.version, JSON.stringify(entry.price)],
        [policies, entry.policy.version, JSON.stringify(entry.policy)],
      ] as const) {
        if (registry.has(version) && registry.get(version) !== value) throw unavailable();
        registry.set(version, value);
      }
    }
    return catalog;
  } catch { throw unavailable(); }
}

export const narrationQuoteRequestSchema = z.object({
  jobId: id, userId: id, workspaceId: id, bookId: id, editionId: id, chapterId: id, documentVersionId: id,
  segmentIndex: z.number().int().min(0).max(249), textStart: z.number().int().min(0).max(999_999),
  textEnd: z.number().int().min(1).max(1_000_000), textSha256: hash,
  model: z.enum(REALTIME_NARRATION_MODELS), voice: z.enum(REALTIME_NARRATION_VOICES),
  // PostgreSQL stores numeric(4,2). Reject silent quote/dispatch rounding drift.
  speed: z.number().min(0.25).max(1.5).refine(value => /^\d+(?:\.\d{1,2})?$/u.test(String(value))),
  instructions: scalarText(2_000).refine(value => value === value.trim()).nullable(),
  maxOutputTokens: outputBudget, promptVersion: z.literal("bookworm-realtime-narration-v1"), promptSha256: hash,
}).strict().refine(value => value.textEnd > value.textStart && value.textEnd - value.textStart <= 4_096);
export type NarrationQuoteRequest = z.output<typeof narrationQuoteRequestSchema>;

function validatedRequest(value: unknown): NarrationQuoteRequest {
  const parsed = narrationQuoteRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.promptSha256 !== sha(narrationInstructions(parsed.data.instructions))) {
    throw new AppError(422, "Narration quote requires an exact supported source and delivery snapshot.");
  }
  return parsed.data;
}
export function narrationRequestHash(value: NarrationQuoteRequest) {
  // Schema parsing fixes key order. Ranges/hash pin saved text without copying it.
  return sha(JSON.stringify(validatedRequest(value)));
}
export function narrationPromptHash(instructions: string | null) {
  return sha(narrationInstructions(instructions));
}
export function availableNarrationModels(raw: string | undefined, now: string) {
  const catalog = readNarrationCatalog(raw, now);
  return { catalogVersion: catalog.version, pricingBasis: "maximum_token_budget" as const,
    models: catalog.entries.map(entry => ({ id: entry.id, label: entry.label, model: entry.price.model,
      priceVersion: entry.price.version, policyVersion: entry.policy.version, maxOutputTokens: entry.maxOutputTokens })),
    voices: [...REALTIME_NARRATION_VOICES], minSpeed: 0.25, maxSpeed: 1.5 };
}

/** sourceText must be read from the pinned canonical document version, not HTTP.
 * This pure offer must be persisted and atomically accepted/funded before use. */
export function prepareNarrationQuote(raw: string | undefined, input: {
  modelId: string; now: string; request: NarrationQuoteRequest; sourceText: string;
}) {
  const catalog = readNarrationCatalog(raw, input.now);
  return prepareWithCatalog(catalog, input);
}
function prepareWithCatalog(catalog: NarrationCatalog, input: {
  modelId: string; now: string; request: NarrationQuoteRequest; sourceText: string;
}) {
  const request = validatedRequest(input.request);
  const entry = catalog.entries.find(item => item.id === input.modelId);
  const text = scalarText(4_096).safeParse(input.sourceText);
  if (!entry || request.model !== entry.price.model || request.maxOutputTokens !== entry.maxOutputTokens
    || !text.success || !text.data.trim() || Array.from(text.data).length !== request.textEnd - request.textStart
    || sha(text.data) !== request.textSha256
    || Buffer.byteLength(text.data, "utf8") + Buffer.byteLength(request.instructions ?? "", "utf8") > MAX_TTS_INPUT_BYTES) {
    throw new AppError(422, "Narration source or delivery does not match the approved quote profile.");
  }
  const quote = quoteUsage({
    scope: { jobId: request.jobId, userId: request.userId, workspaceId: request.workspaceId, inputSha256: narrationRequestHash(request) },
    price: entry.price, policy: entry.policy,
    // Each cached/uncached input and text/audio output dimension admits its full
    // ceiling independently. This deliberately over-reserves; measured mutually
    // exclusive counts settle it. Never present these as counted actual usage.
    maximumTokens: [
      { dimension: "text_input", tokens: String(entry.maxInputTokens) },
      { dimension: "text_cached_input", tokens: String(entry.maxInputTokens) },
      { dimension: "text_output", tokens: String(entry.maxOutputTokens) },
      { dimension: "audio_output", tokens: String(entry.maxOutputTokens) },
    ],
    createdAt: input.now,
    expiresAt: new Date(Math.min(Date.parse(input.now) + catalog.quoteLifetimeSeconds * 1_000, Date.parse(catalog.expiresAt))).toISOString(),
  });
  if (BigInt(quote.reservedCredits) > 2_147_483_647n) throw new AppError(422, "Narration quote exceeds credit ledger capacity.");
  return { request, quote, catalogVersion: catalog.version, modelId: entry.id, pricingBasis: "maximum_token_budget" as const };
}

export function narrationJobId(userId: string, retryKey: string) {
  const digest = createHash("sha256").update(`narration-quote:${userId}:${retryKey}`).digest();
  digest[6] = (digest[6]! & 15) | 80; digest[8] = (digest[8]! & 63) | 128;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function narrationChapterSegmentKey(retryKey: string, index: number) {
  return `narration-chapter:${sha(retryKey)}:${index}`;
}

/** One chapter consent binds every saved non-whitespace character. The database
 * must persist all children and their aggregate atomically, never piecemeal. */
export function prepareNarrationChapterQuote(raw: string | undefined, input: {
  modelId: string; idempotencyKey: string; now: string; sourceText: string;
  userId: string; workspaceId: string; bookId: string; editionId: string; chapterId: string; documentVersionId: string;
  voice: NarrationQuoteRequest["voice"]; speed: number; instructions: string | null;
}) {
  const catalog = readNarrationCatalog(raw, input.now);
  const key = z.string().min(8).max(200).safeParse(input.idempotencyKey);
  const source = scalarText(1_000_000).safeParse(input.sourceText);
  const entry = catalog.entries.find(item => item.id === input.modelId);
  if (!key.success || !source.success || !entry) throw new AppError(422, "Choose a supported saved chapter and narration option.");
  const segments = segmentSpeechText(source.data, 4_096, input.instructions);
  const offers = segments.map(segment => prepareWithCatalog(catalog, {
    modelId: input.modelId, now: input.now, sourceText: segment.text,
    request: { jobId: narrationJobId(input.userId, narrationChapterSegmentKey(key.data, segment.index)),
      userId: input.userId, workspaceId: input.workspaceId, bookId: input.bookId, editionId: input.editionId,
      chapterId: input.chapterId, documentVersionId: input.documentVersionId, segmentIndex: segment.index,
      textStart: segment.start, textEnd: segment.end, textSha256: segment.sha256,
      model: entry.price.model, voice: input.voice, speed: input.speed, instructions: input.instructions,
      maxOutputTokens: entry.maxOutputTokens, promptVersion: "bookworm-realtime-narration-v1", promptSha256: narrationPromptHash(input.instructions) },
  }));
  const reservedCredits = offers.reduce((sum, offer) => sum + BigInt(offer.quote.reservedCredits), 0n);
  if (reservedCredits > 2_147_483_647n) throw new AppError(422, "Chapter narration quote exceeds credit ledger capacity.");
  return { catalogVersion: catalog.version, modelId: entry.id, sourceSha256: sha(source.data),
    offers: offers.map(({ request, quote }) => ({ request, quote })), reservedCredits: String(reservedCredits),
    expiresAt: offers[0]!.quote.expiresAt, pricingBasis: "maximum_token_budget" as const };
}

const receiptSchema = z.object({
  jobId: id, userId: id, workspaceId: id, requestSha256: hash, sourceSha256: hash,
  provider: z.literal("openai"), model: z.enum(REALTIME_NARRATION_MODELS),
  responseId: z.string().trim().min(1).max(256), transcript: scalarText(8_192), rawUsage: z.unknown(),
}).strict();
const normalized = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();

/** A saved offer must retain the profile's entire maximum budget, not just
 * self-consistent arithmetic. Never consult a changed catalog on recovery. */
export function validatedNarrationQuote(value: unknown, savedRequest: NarrationQuoteRequest): UsageQuote {
  try {
    const request = validatedRequest(savedRequest);
    const canonical = quoteUsage(value as UsageQuote);
    const maximum = [{ dimension: "audio_output", tokens: String(request.maxOutputTokens) },
      { dimension: "text_cached_input", tokens: "128000" }, { dimension: "text_input", tokens: "128000" },
      { dimension: "text_output", tokens: String(request.maxOutputTokens) }];
    if (!isDeepStrictEqual(value, canonical) || canonical.price.model !== request.model
      || canonical.scope.jobId !== request.jobId || canonical.scope.userId !== request.userId
      || canonical.scope.workspaceId !== request.workspaceId || canonical.scope.inputSha256 !== narrationRequestHash(request)
      || !isDeepStrictEqual(canonical.maximumTokens, maximum)
      || !isDeepStrictEqual(canonical.price.rates.map(rate => rate.dimension), dimensions)
      || canonical.price.rates.some(rate => rate.dimension !== "text_cached_input" && BigInt(rate.microUsdPerMillionTokens) === 0n)
      || BigInt(canonical.reservedCredits) > 2_147_483_647n) throw new Error("saved narration profile mismatch");
    return canonical;
  } catch { throw new AppError(500, "Saved narration quote identity or maximum budget could not be verified."); }
}

/** Only a trusted worker's bound original provider receipt may reach this path.
 * Return a review hold on unknown usage/fidelity; never invent measurements. */
export function reconcileNarrationUsage(quote: UsageQuote, input: {
  request: NarrationQuoteRequest; sourceText: string; receipt: unknown;
}) {
  const request = validatedRequest(input.request);
  const canonical = validatedNarrationQuote(quote, request);
  const parsed = receiptSchema.safeParse(input.receipt);
  const requestSha256 = narrationRequestHash(request);
  if (!parsed.success) {
    throw new AppError(500, "Saved narration quote or receipt identity could not be verified.");
  }
  const receipt = parsed.data;
  if (receipt.jobId !== request.jobId || receipt.userId !== request.userId || receipt.workspaceId !== request.workspaceId
    || receipt.model !== request.model || receipt.requestSha256 !== requestSha256
    || receipt.sourceSha256 !== request.textSha256 || sha(input.sourceText) !== request.textSha256) {
    throw new AppError(500, "Narration receipt does not match the quoted source and request.");
  }
  let tokens = null;
  try {
    const encoded = JSON.stringify(receipt.rawUsage);
    if (encoded && Buffer.byteLength(encoded, "utf8") <= 16_384) tokens = measuredNarrationQuantities(receipt.rawUsage, request.maxOutputTokens);
  } catch { /* Unsupported original evidence retains its funded hold. */ }
  if (!tokens || normalized(receipt.transcript) !== normalized(input.sourceText)) {
    return { status: "requires_review" as const, requestId: receipt.responseId,
      reason: !tokens ? "usage_unsupported" as const : "transcript_mismatch" as const,
      heldCredits: canonical.reservedCredits, fingerprint: canonical.fingerprint };
  }
  return reconcileUsage(canonical, { scope: canonical.scope, provider: "openai", model: receipt.model,
    requestId: receipt.responseId, measurement: "measured", tokens });
}
