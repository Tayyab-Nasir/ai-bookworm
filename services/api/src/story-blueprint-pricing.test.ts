import { test } from "node:test";
import assert from "node:assert/strict";
import { availableStoryBlueprintModels, quoteStoryBlueprintUsage, storyBlueprintCatalogSnapshot } from "./lib/story-blueprint-pricing.js";

const now = "2026-09-19T12:00:00.000Z";
const raw = JSON.stringify({
  version: "story-blueprint-catalog-test", approved: true, approvalReference: "synthetic-test-only",
  effectiveAt: "2026-09-19T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", quoteLifetimeSeconds: 600,
  entries: [{ id: "story", label: "Story Blueprint test", maxInputTokens: 1000, maxOutputTokens: 2000,
    price: { version: "story-price-v1", provider: "openai", model: "test-model-2026-09-01", rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" },
    ] },
    policy: { version: "story-policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000, platformMicroUsd: "100", minimumCredits: "1" },
  }],
});
const scope = { jobId: "c9000000-0000-4000-8000-000000000001", userId: "c9000000-0000-4000-8000-000000000002",
  workspaceId: "c9000000-0000-4000-8000-000000000003", inputSha256: "a".repeat(64) };

test("story blueprint pricing pins one server-owned catalog snapshot and exact token bounds", () => {
  const snapshot = storyBlueprintCatalogSnapshot(raw, { modelId: "story", now });
  assert.equal(snapshot.version, "story-price-v1");
  assert.equal(snapshot.catalogVersion, "story-blueprint-catalog-test");
  assert.deepEqual(availableStoryBlueprintModels(raw, now).models, [{
    id: "story", label: "Story Blueprint test", model: "test-model-2026-09-01",
    priceVersion: "story-price-v1", policyVersion: "story-policy-v1",
  }]);
  const quote = quoteStoryBlueprintUsage(snapshot, { scope, countedInputTokens: 1000, now });
  assert.equal(quote.scope.inputSha256, scope.inputSha256);
  assert.equal(quote.price.model, snapshot.model);
  assert.equal(quote.expiresAt, "2026-09-19T12:10:00.000Z");
  assert.deepEqual(quote.maximumTokens.map((item) => item.dimension), ["text_cached_input", "text_input", "text_output"]);
});

test("story blueprint pricing fails closed without configured or in-bound token pricing", () => {
  assert.throws(() => storyBlueprintCatalogSnapshot(undefined, { modelId: "story", now }), /not configured/);
  const snapshot = storyBlueprintCatalogSnapshot(raw, { modelId: "story", now });
  for (const countedInputTokens of [0, -1, 1001, 1.5, Number.NaN]) {
    assert.throws(() => quoteStoryBlueprintUsage(snapshot, { scope, countedInputTokens, now }));
  }
});
