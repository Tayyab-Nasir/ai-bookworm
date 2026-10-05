import assert from "node:assert/strict";
import { test } from "node:test";
import { imageCatalog, imageRequestHash, prepareImageQuote, reconcileImageUsage, type ImageQuoteRequest } from "./lib/image-pricing.js";

const now = "2026-09-25T00:00:00.000Z";
const request: ImageQuoteRequest = {
  jobId: "ab000000-0000-4000-8000-000000000001", workspaceId: "ab000000-0000-4000-8000-000000000002",
  userId: "ab000000-0000-4000-8000-000000000003", bookId: null,
  kind: "illustration", model: "fixture-image", prompt: "A forest", size: "1024x1024", quality: "low", references: [],
};
function catalog() {
  return { version: "fixture-v1", approved: true, effectiveAt: now, expiresAt: "2026-09-25T00:05:00.000Z", quoteLifetimeSeconds: 600,
    entries: [{ id: "square-low", label: "Fixture only", size: "1024x1024", quality: "low", maxPromptBytes: 100,
      maxReferenceImages: 2, maximumTokens: { image_input: 100, image_output: 100, text_input: 100, text_output: 10 },
      price: { version: "fixture-price", provider: "openai", model: request.model,
        rates: ["text_input", "image_input", "text_output", "image_output"].map((dimension) => ({ dimension, microUsdPerMillionTokens: "1000000" })) },
      policy: { version: "fixture-policy", approved: true, microUsdPerCredit: "10", markupBasisPoints: 15000,
        platformMicroUsd: "0", minimumCredits: "1" } }] };
}
const usage = { input_tokens: 30, output_tokens: 20, total_tokens: 50,
  input_tokens_details: { text_tokens: 10, image_tokens: 20 }, output_tokens_details: { text_tokens: 0, image_tokens: 20 } };
const prepare = (value = request) => prepareImageQuote(JSON.stringify(catalog()), { modelId: "square-low", now, request: value });

test("image offers require explicit approved current catalog and exact dimensions", () => {
  for (const raw of [undefined, "{}", "invalid", JSON.stringify({ ...catalog(), approved: false }),
    JSON.stringify({ ...catalog(), expiresAt: now }), JSON.stringify({ ...catalog(), effectiveAt: "2026-09-26T00:00:00.000Z" })]) {
    assert.throws(() => imageCatalog(raw, now), /not configured/);
  }
  const duplicate = catalog(); duplicate.entries.push(duplicate.entries[0]!);
  assert.throws(() => imageCatalog(JSON.stringify(duplicate), now));
  const missing = catalog(); missing.entries[0]!.price.rates.pop();
  assert.throws(() => imageCatalog(JSON.stringify(missing), now));
  const { quote, pricingBasis } = prepare();
  assert.equal(pricingBasis, "maximum_token_budget");
  assert.equal(quote.expiresAt, catalog().expiresAt);
  assert.equal(quote.reservedCredits, "47");
});

test("image quote binds prompt bytes, quality, dimensions and ordered reference versions", () => {
  assert.throws(() => prepare({ ...request, prompt: "é".repeat(51) }));
  assert.throws(() => prepare({ ...request, quality: "high" }));
  assert.throws(() => prepare({ ...request, size: "1536x1024" }));
  assert.throws(() => prepare({ ...request, model: "another-model" }));
  const ref = { assetId: "ab000000-0000-4000-8000-000000000004", version: 1, sha256: "a".repeat(64), mimeType: "image/png" as const };
  assert.throws(() => prepare({ ...request, references: [ref, ref] }));
  const first = { ...request, references: [ref] };
  assert.notEqual(imageRequestHash(first), imageRequestHash({ ...first, references: [{ ...ref, version: 2 }] }));
  assert.notEqual(imageRequestHash(first), imageRequestHash({ ...first, references: [{ ...ref, sha256: "b".repeat(64) }] }));
  const second = { ...ref, assetId: "ab000000-0000-4000-8000-000000000005" };
  assert.notEqual(imageRequestHash({ ...request, references: [ref, second] }), imageRequestHash({ ...request, references: [second, ref] }));
});

test("image measured settlement balances credits and refuses ambiguous telemetry", () => {
  const { quote } = prepare();
  const reconcile = (providerUsage: unknown, value = request) => reconcileImageUsage(quote,
    { request: value, requestId: "fixture-receipt", model: request.model, providerUsage });
  const result = reconcile(usage);
  assert.equal(result.status, "settle");
  if (result.status !== "settle") assert.fail("expected settlement");
  assert.equal(result.debitCredits, "8");
  assert.equal(BigInt(result.debitCredits) + BigInt(result.releaseCredits), BigInt(quote.reservedCredits));
  assert.throws(() => reconcile({ input_tokens: 30, output_tokens: 20 }));
  assert.throws(() => reconcile({ ...usage, total_tokens: 51 }));
  assert.throws(() => reconcile({ ...usage, output_tokens_details: { text_tokens: 0, image_tokens: 19 } }));
  assert.throws(() => reconcile({ ...usage, input_tokens_details: { ...usage.input_tokens_details, cached_tokens: 5 } }));
  assert.throws(() => reconcile(usage, { ...request, prompt: "Changed forest" }));
  assert.equal(reconcile({ ...usage, output_tokens: 200, total_tokens: 230,
    output_tokens_details: { text_tokens: 0, image_tokens: 200 } }).status, "requires_review");
});
