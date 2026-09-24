import { test } from "node:test";
import assert from "node:assert/strict";
import { aiUsageSchema } from "./lib/ai-usage.js";

const usage = { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.002,
  measuredTokens: [{ dimension: "text_input", tokens: "75" }, { dimension: "text_cached_input", tokens: "25" }, { dimension: "text_output", tokens: "20" }] };
test("AI usage preserves the gateway's measured split instead of rejecting a paid success", () => {
  assert.deepEqual(aiUsageSchema.parse(usage), usage);
  const { measuredTokens: _measured, ...legacy } = usage;
  assert.deepEqual(aiUsageSchema.parse(legacy), legacy);
});
test("AI usage rejects fabricated, overlapping, inconsistent or missing counters", () => {
  for (const invalid of [
    { ...usage, measuredTokens: [...usage.measuredTokens.slice(0, 2), usage.measuredTokens[0]] },
    { ...usage, inputTokens: 99 }, { ...usage, outputTokens: 21 },
    { ...usage, measuredTokens: [{ dimension: "text_input", tokens: "-1" }, ...usage.measuredTokens.slice(1)] },
    { ...usage, measuredTokens: [{ dimension: "text_input", tokens: "not-a-number" }, ...usage.measuredTokens.slice(1)] },
    { ...usage, measuredTokens: [{ dimension: "text_input", tokens: "9".repeat(100) }, ...usage.measuredTokens.slice(1)] },
    { ...usage, inputTokens: undefined }, { ...usage, outputTokens: undefined },
    { ...usage, inputTokens: true }, { ...usage, estimatedCostUsd: Infinity },
    { ...usage, unexpected: true },
  ]) assert.equal(aiUsageSchema.safeParse(invalid).success, false);
});
