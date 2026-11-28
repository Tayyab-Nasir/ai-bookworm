/** Server deployment configuration, not an HTTP payload. No default prices.
 * Approval metadata records the operator's release decision; it does not prove
 * commercial approval or grant permission to activate production billing. */
import { z } from "zod";
import { AppError } from "../errors.js";
import { priceSchema, policySchema, quoteUsage, type PricingScope } from "./usage-pricing.js";

const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(100),
  price: priceSchema, policy: policySchema,
  maxInputTokens: z.number().int().min(1).max(2000000),
  maxOutputTokens: z.number().int().min(1).max(128000),
}).strict();
const catalogSchema = z.object({
  version: z.string().trim().min(1).max(128), approved: z.literal(true),
  approvalReference: z.string().trim().min(1).max(256),
  effectiveAt: z.string().datetime(), expiresAt: z.string().datetime(),
  quoteLifetimeSeconds: z.number().int().min(60).max(3600),
  entries: z.array(entrySchema).min(1).max(20),
}).strict();
export type TranslationCatalog = z.infer<typeof catalogSchema>;
const unavailable = () => new AppError(503, "Usage-priced translations are not configured for purchase.", undefined, "translation_catalog_unavailable");

export function readTranslationCatalog(raw: string | undefined, now: string): TranslationCatalog {
  try {
    if (!raw || Buffer.byteLength(raw, "utf8") > 65536) throw unavailable();
    const catalog = catalogSchema.parse(JSON.parse(raw));
    const time = Date.parse(z.string().datetime().parse(now));
    if (time < Date.parse(catalog.effectiveAt) || time >= Date.parse(catalog.expiresAt)
      || Date.parse(catalog.expiresAt) <= Date.parse(catalog.effectiveAt)) throw unavailable();
    if (new Set(catalog.entries.map((entry) => entry.id)).size !== catalog.entries.length) throw unavailable();
    // Different versions may price the same model, but one version identifier
    // cannot ambiguously describe two different prices or retail policies.
    const prices = new Map<string,string>(), policies = new Map<string,string>();
    for (const entry of catalog.entries) {
      if (!/-\d{4}-\d{2}-\d{2}$/.test(entry.price.model)) throw unavailable();
      const rates = [...entry.price.rates].sort((a,b) => a.dimension.localeCompare(b.dimension));
      if (rates.map((r) => r.dimension).join(",") !== "text_cached_input,text_input,text_output") throw unavailable();
      if (rates.some((r) => r.dimension !== "text_cached_input" && BigInt(r.microUsdPerMillionTokens) === 0n)) throw unavailable();
      entry.price.rates = rates;
      for (const [registry, version, value] of [
        [prices, entry.price.version, JSON.stringify(entry.price)],
        [policies, entry.policy.version, JSON.stringify(entry.policy)],
      ] as const) {
        if (registry.has(version) && registry.get(version) !== value) throw unavailable();
        registry.set(version,value);
      }
    }
    return catalog;
  } catch { throw unavailable(); }
}

export function availableTranslationModels(catalog: TranslationCatalog) {
  return { catalogVersion: catalog.version, models: catalog.entries.map((entry) => ({
    id: entry.id, label: entry.label, model: entry.price.model,
    priceVersion: entry.price.version, policyVersion: entry.policy.version,
  })) };
}

/** Bounds must be produced by a trusted server tokenizer/counting path, never
 * accepted from customer input. This calculation is not enqueue authorization. */
export function quoteCatalogTranslation(raw: string | undefined, input: {
  modelId: string; scope: PricingScope; maximumInputTokens: number; now: string;
}) {
  const catalog = readTranslationCatalog(raw,input.now);
  const entry = catalog.entries.find((item) => item.id === input.modelId);
  if (!entry) throw new AppError(422,"Choose an available translation model.");
  if (!Number.isSafeInteger(input.maximumInputTokens) || input.maximumInputTokens <= 0
    || input.maximumInputTokens > entry.maxInputTokens) throw new AppError(422,"Translation input exceeds the priced model limit.");
  const expiresAt = new Date(Math.min(Date.parse(input.now) + catalog.quoteLifetimeSeconds * 1000, Date.parse(catalog.expiresAt))).toISOString();
  // Cached and uncached bounds each admit the entire input; this deliberately
  // over-reserves until provider-measured mutually exclusive counts settle it.
  const quote = quoteUsage({ scope: input.scope, price: entry.price, policy: entry.policy,
    maximumTokens: [{dimension:"text_input",tokens:String(input.maximumInputTokens)},
      {dimension:"text_cached_input",tokens:String(input.maximumInputTokens)},
      {dimension:"text_output",tokens:String(entry.maxOutputTokens)}], createdAt:input.now, expiresAt });
  if (BigInt(quote.reservedCredits) > 2147483647n) throw new AppError(422,"Translation quote exceeds the credit ledger limit.");
  return { catalogVersion:catalog.version, modelId:entry.id, quote };
}
