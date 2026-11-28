import { z } from "zod";

const measuredTextTokens = z.array(z.object({
  dimension: z.enum(["text_input", "text_cached_input", "text_output"]),
  tokens: z.string().regex(/^(0|[1-9][0-9]*)$/u).max(10),
}).strict()).length(3);

// Matches the Python gateway's receipt. Preserve optional measured dimensions
// for audit; operational units are not a substitute for quoted retail pricing.
export const aiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(2147483647),
  outputTokens: z.number().int().nonnegative().max(2147483647),
  estimatedCostUsd: z.number().finite().nonnegative(),
  latencyMs: z.number().int().nonnegative().max(2147483647).optional(),
  measuredTokens: measuredTextTokens.optional(),
}).strict().superRefine((usage, context) => {
  if (!usage.measuredTokens || !measuredTextTokens.safeParse(usage.measuredTokens).success) return;
  const values = new Map(usage.measuredTokens.map((entry) => [entry.dimension, BigInt(entry.tokens)]));
  if (values.size !== 3 || values.get("text_input")! + values.get("text_cached_input")! !== BigInt(usage.inputTokens)
    || values.get("text_output") !== BigInt(usage.outputTokens)) {
    context.addIssue({ code: "custom", path: ["measuredTokens"], message: "Measured token dimensions must be unique and agree with aggregate usage." });
  }
});
