/** Exact, version-pinned pricing math. No provider rates or retail offers are
 * hardcoded. Callers must persist the quote and atomically reserve its credits
 * before dispatch; this module neither grants funds nor authorizes generation.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const integer = z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
const positive = integer.refine((v) => BigInt(v) > 0n);
const dimension = z.enum(["text_input", "text_cached_input", "text_output", "image_input", "image_cached_input", "image_output", "audio_input", "audio_cached_input", "audio_output"]);
const priceSchema = z.object({
  version: z.string().min(1).max(128), provider: z.literal("openai"), model: z.string().min(1).max(128),
  // Every listed quantity is mutually exclusive (cached input is not repeated
  // in uncached input). Units are provider tokens, not source character counts.
  rates: z.array(z.object({ dimension, microUsdPerMillionTokens: integer }).strict()).min(1).max(9),
}).strict();
const policySchema = z.object({
  version: z.string().min(1).max(128), approved: z.literal(true),
  microUsdPerCredit: positive,
  // Multiplier, NOT gross-margin percentage: 15000 means cost * 1.5.
  markupBasisPoints: z.number().int().min(10000).max(1000000),
  platformMicroUsd: integer,
  minimumCredits: positive,
}).strict();
const scopeSchema = z.object({
  jobId: z.string().uuid(), workspaceId: z.string().uuid(), userId: z.string().uuid(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const quantitySchema = z.array(z.object({ dimension, tokens: integer }).strict()).min(1).max(9);
export type PriceSnapshot = z.infer<typeof priceSchema>;
export type CreditPolicy = z.infer<typeof policySchema>;
export type PricingScope = z.infer<typeof scopeSchema>;
export type TokenQuantities = z.infer<typeof quantitySchema>;

function sorted<T extends { dimension: string }>(values: T[]): T[] {
  if (new Set(values.map((v) => v.dimension)).size !== values.length) throw new Error("duplicate usage dimension");
  return [...values].sort((a, b) => a.dimension.localeCompare(b.dimension));
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function cost(price: PriceSnapshot, quantities: TokenQuantities) {
  const rates = sorted(price.rates); const usage = sorted(quantitySchema.parse(quantities));
  if (rates.length !== usage.length || rates.some((r, i) => r.dimension !== usage[i].dimension)) {
    throw new Error("usage must explicitly cover every priced dimension");
  }
  return rates.reduce((sum, r, i) => sum + BigInt(r.microUsdPerMillionTokens) * BigInt(usage[i].tokens), 0n);
}
function debit(numerator: bigint, policy: CreditPolicy) {
  // Keep fractional microdollars exact until the FINAL credit rounding.
  const total = (numerator + BigInt(policy.platformMicroUsd) * 1000000n) * BigInt(policy.markupBasisPoints);
  const credits = ceil(total, 1000000n * 10000n * BigInt(policy.microUsdPerCredit));
  return credits > BigInt(policy.minimumCredits) ? credits : BigInt(policy.minimumCredits);
}
export function quoteUsage(input: {
  scope: PricingScope; price: PriceSnapshot; policy: CreditPolicy;
  maximumTokens: TokenQuantities; createdAt: string; expiresAt: string;
}) {
  const scope = scopeSchema.parse(input.scope);
  const price = priceSchema.parse(input.price); price.rates = sorted(price.rates);
  const policy = policySchema.parse(input.policy);
  const maximumTokens = sorted(quantitySchema.parse(input.maximumTokens));
  const createdAt = z.string().datetime().parse(input.createdAt);
  const expiresAt = z.string().datetime().parse(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) - Date.parse(createdAt) > 3600000) {
    throw new Error("quote lifetime must be positive and at most one hour");
  }
  const numerator = cost(price, maximumTokens);
  const body = { scope, price, policy, maximumTokens, createdAt, expiresAt,
    maximumProviderMicroUsd: ceil(numerator, 1000000n).toString(),
    reservedCredits: debit(numerator, policy).toString() };
  return { ...body, fingerprint: hash(body) };
}
export type UsageQuote = ReturnType<typeof quoteUsage>;

export function reconcileUsage(quote: UsageQuote, receipt: {
  scope: PricingScope; provider: "openai"; model: string; requestId: string;
  measurement: "measured" | "estimated"; tokens: TokenQuantities;
}) {
  // Recompute rather than trusting a client-supplied reserve or fingerprint.
  const canonical = quoteUsage(quote);
  if (quote.fingerprint !== canonical.fingerprint || quote.reservedCredits !== canonical.reservedCredits
    || quote.maximumProviderMicroUsd !== canonical.maximumProviderMicroUsd) throw new Error("quote integrity mismatch");
  if (hash(scopeSchema.parse(receipt.scope)) !== hash(canonical.scope)
    || receipt.provider !== canonical.price.provider || receipt.model !== canonical.price.model) {
    throw new Error("receipt does not match quoted request");
  }
  if (receipt.measurement !== "measured") throw new Error("estimated usage requires reconciliation before customer billing");
  const requestId = z.string().trim().min(1).max(256).parse(receipt.requestId);
  const tokens = sorted(quantitySchema.parse(receipt.tokens));
  const numerator = cost(canonical.price, tokens);
  const exceedsBound = tokens.some((q, i) => BigInt(q.tokens) > BigInt(canonical.maximumTokens[i].tokens));
  const actualCredits = debit(numerator, canonical.policy);
  // Do not silently overdraw, clamp the bill, or free an uncertain reservation.
  if (exceedsBound || actualCredits > BigInt(canonical.reservedCredits)) {
    return { status: "requires_review" as const, requestId, reason: "usage_exceeds_quote" as const,
      heldCredits: canonical.reservedCredits, fingerprint: canonical.fingerprint };
  }
  return { status: "settle" as const, requestId, fingerprint: canonical.fingerprint,
    priceVersion: canonical.price.version, policyVersion: canonical.policy.version,
    providerMicroUsd: ceil(numerator, 1000000n).toString(),
    debitCredits: actualCredits.toString(), releaseCredits: (BigInt(canonical.reservedCredits) - actualCredits).toString(),
    tokens };
}

export function assertQuoteDispatchable(quote: UsageQuote, now: string) {
  const canonical = quoteUsage(quote);
  if (quote.fingerprint !== canonical.fingerprint || quote.reservedCredits !== canonical.reservedCredits
    || quote.maximumProviderMicroUsd !== canonical.maximumProviderMicroUsd) throw new Error("quote integrity mismatch");
  const time = Date.parse(z.string().datetime().parse(now));
  if (time < Date.parse(canonical.createdAt) || time >= Date.parse(canonical.expiresAt)) throw new Error("quote is not valid for dispatch");
  // A valid quote is not evidence of a funded reservation.
}
