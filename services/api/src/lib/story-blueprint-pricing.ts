/** Server-owned pricing snapshot for one review-only Story Blueprint proposal.
 * It reuses the already-audited token-price catalog shape, but deliberately
 * exposes no translation wording or customer-supplied price fields. */
import { z } from "zod";
import { AppError } from "../errors.js";
import { readTranslationCatalog } from "./translation-catalog.js";
import { policySchema, priceSchema, quoteUsage, type PricingScope } from "./usage-pricing.js";

const unavailable = () => new AppError(503, "Usage-priced Story Blueprint proposals are not configured for purchase.", undefined, "story_blueprint_catalog_unavailable");
const snapshotSchema = z.object({
  version: z.string().min(1).max(128), catalogVersion: z.string().min(1).max(128),
  model: z.string().min(1).max(128), provider: z.literal("openai"), approved: z.literal(true),
  expiresAt: z.string().datetime(), quoteLifetimeSeconds: z.number().int().min(60).max(3600),
  maxInputTokens: z.number().int().min(1).max(2_000_000), maxOutputTokens: z.number().int().min(1).max(128_000),
  price: priceSchema, policy: policySchema,
}).strict();
export type StoryBlueprintCatalogSnapshot = z.infer<typeof snapshotSchema>;

function catalog(raw: string | undefined, now: string) {
  try { return readTranslationCatalog(raw, now); } catch { throw unavailable(); }
}

export function availableStoryBlueprintModels(raw: string | undefined, now: string) {
  const value = catalog(raw, now);
  return {
    catalogVersion: value.version,
    models: value.entries.map((entry) => ({ id: entry.id, label: entry.label, model: entry.price.model,
      priceVersion: entry.price.version, policyVersion: entry.policy.version })),
  };
}

export function storyBlueprintCatalogSnapshot(raw: string | undefined, input: { modelId: string; now: string }): StoryBlueprintCatalogSnapshot {
  const value = catalog(raw, input.now);
  const entry = value.entries.find((item) => item.id === input.modelId);
  if (!entry) throw new AppError(422, "Choose an available Story Blueprint model.");
  return snapshotSchema.parse({
    // The SQL contract pins the price version, not a mutable display catalog ID.
    version: entry.price.version, catalogVersion: value.version, model: entry.price.model, provider: entry.price.provider,
    approved: true, expiresAt: value.expiresAt, quoteLifetimeSeconds: value.quoteLifetimeSeconds,
    maxInputTokens: entry.maxInputTokens, maxOutputTokens: entry.maxOutputTokens,
    price: entry.price, policy: entry.policy,
  });
}

export function quoteStoryBlueprintUsage(snapshotValue: StoryBlueprintCatalogSnapshot, input: {
  scope: PricingScope; countedInputTokens: number; now: string;
}) {
  const snapshot = snapshotSchema.parse(snapshotValue);
  if (!Number.isSafeInteger(input.countedInputTokens) || input.countedInputTokens < 1 || input.countedInputTokens > snapshot.maxInputTokens) {
    throw new AppError(422, "Story Blueprint input exceeds the selected model limit.");
  }
  const expiresAt = new Date(Math.min(
    Date.parse(input.now) + snapshot.quoteLifetimeSeconds * 1000,
    Date.parse(snapshot.expiresAt),
  )).toISOString();
  try {
    return quoteUsage({
      scope: input.scope,
      price: snapshot.price,
      policy: snapshot.policy,
      // Cached and uncached input are mutually exclusive at settlement. Hold
      // each full bound so provider cache behavior cannot underfund a job.
      maximumTokens: [
        { dimension: "text_input", tokens: String(input.countedInputTokens) },
        { dimension: "text_cached_input", tokens: String(input.countedInputTokens) },
        { dimension: "text_output", tokens: String(snapshot.maxOutputTokens) },
      ],
      createdAt: input.now,
      expiresAt,
    });
  } catch { throw new AppError(503, "Could not prepare the Story Blueprint quote."); }
}
