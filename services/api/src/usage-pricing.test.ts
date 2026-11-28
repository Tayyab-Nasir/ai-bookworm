import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteUsage, reconcileUsage, assertQuoteDispatchable, type TokenQuantities } from "./lib/usage-pricing.js";

const scope = { jobId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333", inputSha256: "a".repeat(64) };
// Synthetic prices only: not OpenAI rates or approved Bookworm offers.
const price = { version: "synthetic-v1", provider: "openai" as const, model: "synthetic-model", rates: [
  { dimension: "text_input" as const, microUsdPerMillionTokens: "2000000" },
  { dimension: "text_output" as const, microUsdPerMillionTokens: "8000000" },
] };
const policy = { version: "test-only", approved: true as const, microUsdPerCredit: "10000", markupBasisPoints: 15000, platformMicroUsd: "0", minimumCredits: "1" };
const tokens = (input: string, output: string): TokenQuantities => [{ dimension: "text_input", tokens: input }, { dimension: "text_output", tokens: output }];
const make = () => quoteUsage({ scope, price, policy, maximumTokens: tokens("1000", "2000"), createdAt: "2026-09-19T00:00:00Z", expiresAt: "2026-09-19T00:15:00Z" });
const receipt = (quantities = tokens("500", "500")) => ({ scope, provider: "openai" as const, model: price.model, requestId: "req-synthetic", measurement: "measured" as const, tokens: quantities });

test("versioned quote reserves ceiling and releases unused credits from measured receipt", () => {
  const q = make(); assert.equal(q.maximumProviderMicroUsd, "18000"); assert.equal(q.reservedCredits, "3");
  const r = reconcileUsage(q, receipt()); assert.equal(r.status, "settle");
  if (r.status === "settle") { assert.equal(r.providerMicroUsd, "5000"); assert.equal(r.debitCredits, "1"); assert.equal(r.releaseCredits, "2"); }
  assert.deepEqual(reconcileUsage(q, receipt()), r);
  assert.doesNotThrow(() => JSON.stringify(r));
});
test("missing, duplicated, unknown and invalid quantities fail closed", () => {
  for (const bad of [tokens("-1", "0"), tokens("0.5", "0"), tokens("NaN", "0"), [tokens("1", "1")[0]], [tokens("1", "1")[0], tokens("1", "1")[0]]]) {
    assert.throws(() => reconcileUsage(make(), receipt(bad)));
  }
  assert.throws(() => reconcileUsage(make(), receipt([{ dimension: "audio_output", tokens: "1" }])));
});
test("scope, model, estimates, tampering and dispatch expiry cannot authorize billing", () => {
  const q = make();
  assert.throws(() => reconcileUsage(q, { ...receipt(), model: "another-model" }), /does not match/);
  assert.throws(() => reconcileUsage(q, { ...receipt(), scope: { ...scope, inputSha256: "b".repeat(64) } }), /does not match/);
  assert.throws(() => reconcileUsage(q, { ...receipt(), measurement: "estimated" }), /estimated/);
  assert.throws(() => reconcileUsage({ ...q, reservedCredits: "999" }, receipt()), /integrity/);
  assert.throws(() => assertQuoteDispatchable(q, q.expiresAt), /not valid/);
  assert.throws(() => assertQuoteDispatchable(q, "2026-09-18T00:00:00Z"), /not valid/);
  assert.doesNotThrow(() => assertQuoteDispatchable(q, q.createdAt));
  // Late receipts may settle previously dispatched jobs after quote expiry.
  assert.equal(reconcileUsage(q, receipt()).status, "settle");
});
test("unapproved policy fails and over-bound usage retains hold for review", () => {
  const q = make();
  assert.throws(() => quoteUsage({ ...q, policy: { ...policy, approved: false } as never }));
  const r = reconcileUsage(q, receipt(tokens("1001", "0")));
  assert.equal(r.status, "requires_review"); assert.ok(!("releaseCredits" in r));
  assert.equal(reconcileUsage(q, receipt(tokens("1000", "2001"))).status, "requires_review");
});
test("exact integer arithmetic is stable beyond Number safe precision and independent of dimension order", () => {
  const q = make();
  assert.equal(quoteUsage({ ...q, maximumTokens: [...q.maximumTokens].reverse(), price: { ...q.price, rates: [...q.price.rates].reverse() } }).fingerprint, q.fingerprint);
  const huge = quoteUsage({ ...q, maximumTokens: tokens("9007199254740993", "0") });
  assert.equal(huge.maximumProviderMicroUsd, "18014398509481986");
  assert.equal(reconcileUsage(huge, receipt(tokens("9007199254740993", "0"))).status, "settle");
  assert.notEqual(quoteUsage({ ...q, policy: { ...policy, version: "test-v2" } }).fingerprint, q.fingerprint);
});
