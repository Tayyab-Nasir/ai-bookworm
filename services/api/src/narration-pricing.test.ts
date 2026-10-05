import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { readNarrationCatalog, availableNarrationModels, prepareNarrationQuote,
  narrationRequestHash, narrationPromptHash, reconcileNarrationUsage, validatedNarrationQuote,
  prepareNarrationChapterQuote, narrationChapterSegmentKey, narrationJobId, type NarrationQuoteRequest } from "./lib/narration-pricing.js";
import { quoteUsage, type UsageQuote } from "./lib/usage-pricing.js";

const now = "2026-10-05T05:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (suffix: number) => `a6300000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const text = "This café chapter is quoted.";
const request: NarrationQuoteRequest = { jobId: uuid(1), userId: uuid(2), workspaceId: uuid(3), bookId: uuid(4),
  editionId: uuid(5), chapterId: uuid(6), documentVersionId: uuid(7), segmentIndex: 0, textStart: 100,
  textEnd: 100 + Array.from(text).length, textSha256: sha(text), model: "gpt-realtime-2.1-mini", voice: "marin",
  speed: 1, instructions: null, maxOutputTokens: 1_024, promptVersion: "bookworm-realtime-narration-v1", promptSha256: narrationPromptHash(null) };
function catalog() {
  return { version: "fixture-20261005", approved: true, approvalReference: "synthetic test policy, not release authorization",
    effectiveAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-06T00:00:00.000Z", quoteLifetimeSeconds: 600,
    entries: [{ id: "mini", label: "Realtime Mini narration", maxInputTokens: 128_000, maxOutputTokens: 1_024,
      price: { version: "fixture-mini-20261005", provider: "openai", model: "gpt-realtime-2.1-mini", rates: [
        { dimension: "text_input", microUsdPerMillionTokens: "600000" },
        { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
        { dimension: "text_output", microUsdPerMillionTokens: "2400000" },
        { dimension: "audio_output", microUsdPerMillionTokens: "20000000" },
      ] }, policy: { version: "fixture-policy", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15_000,
        platformMicroUsd: "0", minimumCredits: "1" } }],
  };
}
const prepare = (value = request, sourceText = text, raw = catalog()) => prepareNarrationQuote(JSON.stringify(raw), { modelId: "mini", now, request: value, sourceText });
const rawUsage = { input_tokens: 60, output_tokens: 220, total_tokens: 280,
  input_token_details: { text_tokens: 60, audio_tokens: 0, cached_tokens: 10, cached_tokens_details: { text_tokens: 10, audio_tokens: 0 } },
  output_token_details: { text_tokens: 20, audio_tokens: 200 } };
const receipt = () => ({ jobId: request.jobId, userId: request.userId, workspaceId: request.workspaceId,
  requestSha256: narrationRequestHash(request), sourceSha256: request.textSha256, provider: "openai", model: request.model,
  responseId: "resp_fixture", transcript: text, rawUsage: structuredClone(rawUsage) });

test("narration offer is pure, approved, versioned, bounded and contains no manuscript text", () => {
  const result = prepare();
  assert.equal(result.pricingBasis, "maximum_token_budget"); assert.equal(result.catalogVersion, "fixture-20261005");
  assert.equal(result.quote.maximumProviderMicroUsd, "107418"); assert.equal(result.quote.reservedCredits, "1612");
  assert.equal(result.quote.expiresAt, "2026-10-05T05:10:00.000Z");
  assert.equal(result.quote.scope.inputSha256, narrationRequestHash(request));
  assert.equal(JSON.stringify(result).includes(text), false);
  assert.deepEqual(result.quote.maximumTokens, [{ dimension: "audio_output", tokens: "1024" },
    { dimension: "text_cached_input", tokens: "128000" }, { dimension: "text_input", tokens: "128000" }, { dimension: "text_output", tokens: "1024" }]);
  result.request.voice = "cedar"; assert.equal(request.voice, "marin", "offer must not alias caller objects");
});

test("public narration options disclose budget basis without private prices or approval references", () => {
  const models = availableNarrationModels(JSON.stringify(catalog()), now);
  assert.equal(models.pricingBasis, "maximum_token_budget"); assert.equal(models.voices.length, 10);
  assert.equal(models.minSpeed, 0.25); assert.equal(models.maxSpeed, 1.5);
  const encoded = JSON.stringify(models);
  assert.equal(encoded.includes("microUsd"), false); assert.equal(encoded.includes("approvalReference"), false);
});

for (const [name, change] of [
  ["unapproved", (value: any) => { value.approved = false; }],
  ["missing approval", (value: any) => { delete value.approvalReference; }],
  ["not effective", (value: any) => { value.effectiveAt = "2026-10-06T00:00:00.000Z"; }],
  ["expired", (value: any) => { value.expiresAt = now; }],
  ["wrong role model", (value: any) => { value.entries[0].price.model = "gpt-6-astra"; }],
  ["invented dated alias", (value: any) => { value.entries[0].price.model = "gpt-realtime-2.1-mini-2026-10-05"; }],
  ["missing audio rate", (value: any) => { value.entries[0].price.rates.pop(); }],
  ["extra image rate", (value: any) => { value.entries[0].price.rates.push({ dimension: "image_input", microUsdPerMillionTokens: "1" }); }],
  ["zero output rate", (value: any) => { value.entries[0].price.rates[3].microUsdPerMillionTokens = "0"; }],
  ["fractional rate", (value: any) => { value.entries[0].price.rates[0].microUsdPerMillionTokens = "0.6"; }],
  ["unknown context ceiling", (value: any) => { value.entries[0].maxInputTokens = 100; }],
  ["unbounded output", (value: any) => { value.entries[0].maxOutputTokens = 4097; }],
  ["duplicate option", (value: any) => { value.entries.push(structuredClone(value.entries[0])); }],
  ["ambiguous price version", (value: any) => { const other = structuredClone(value.entries[0]); other.id = "other"; other.price.rates[0].microUsdPerMillionTokens = "7"; value.entries.push(other); }],
  ["ambiguous policy version", (value: any) => { const other = structuredClone(value.entries[0]); other.id = "other"; other.policy.minimumCredits = "2"; value.entries.push(other); }],
] as const) test(`narration catalog fails closed for ${name}`, () => {
  const raw = catalog(); change(raw);
  assert.throws(() => readNarrationCatalog(JSON.stringify(raw), now), (error: unknown) => error instanceof AppError && error.code === "narration_catalog_unavailable");
});

test("missing, oversized, malformed catalogs and invalid clocks never become offers", () => {
  for (const raw of [undefined, "not json", "x".repeat(65_537)]) assert.throws(() => readNarrationCatalog(raw, now));
  assert.throws(() => readNarrationCatalog(JSON.stringify(catalog()), "invalid"));
});

test("quote expiration is clipped to the approved catalog expiry", () => {
  const value = catalog(); value.expiresAt = "2026-10-05T05:00:30.000Z";
  assert.equal(prepare(request, text, value).quote.expiresAt, value.expiresAt);
});

test("saved Unicode source, ranges, instructions, voice and speed must match exactly", () => {
  for (const change of [{ textSha256: sha("foreign") }, { textEnd: request.textEnd + 1 }, { textEnd: request.textStart },
    { model: "gpt-realtime-2.1" }, { voice: "fable" }, { speed: 1.005 }, { speed: 2 }, { instructions: " changed " },
    { instructions: "new delivery", promptSha256: request.promptSha256 }, { maxOutputTokens: 1023 },
    { promptVersion: "future" }, { extra: true }, { jobId: "invalid" }]) assert.throws(() => prepare({ ...request, ...change } as never));
  assert.throws(() => prepare(request, "different source"));
  assert.throws(() => prepare({ ...request, textSha256: sha("\ud800"), textStart: 0, textEnd: 1 }, "\ud800"));
  const unicode = "帰郷 😀 café";
  const next = { ...request, textStart: 0, textEnd: Array.from(unicode).length, textSha256: sha(unicode),
    speed: 0.29, instructions: "Warm", promptSha256: narrationPromptHash("Warm") };
  assert.equal(prepare(next, unicode).request.speed, 0.29);
  const oversized = "界".repeat(600);
  assert.throws(() => prepare({ ...next, textEnd: 600, textSha256: sha(oversized) }, oversized), /approved quote profile/);
});

test("every saved source, scope and delivery identity participates in the request digest", () => {
  const original = narrationRequestHash(request);
  for (const change of [{ jobId: uuid(8) }, { userId: uuid(8) }, { workspaceId: uuid(8) }, { bookId: uuid(8) },
    { editionId: uuid(8) }, { chapterId: uuid(8) }, { documentVersionId: uuid(8) }, { segmentIndex: 1 },
    { textStart: 101, textEnd: request.textEnd + 1 }, { textSha256: sha("other") }, { voice: "cedar" }, { speed: 0.9 },
    { instructions: "Warm", promptSha256: narrationPromptHash("Warm") }, { maxOutputTokens: 2000 }, { model: "gpt-realtime-2.1" }]) {
    assert.notEqual(narrationRequestHash({ ...request, ...change } as NarrationQuoteRequest), original);
  }
  const reversed = Object.fromEntries(Object.entries(request).reverse()) as NarrationQuoteRequest;
  assert.equal(narrationRequestHash(reversed), original);
});

test("measured receipt settles against the saved prices and returns only the unused maximum hold", () => {
  const offer = prepare();
  const settled = reconcileNarrationUsage(offer.quote, { request, sourceText: text, receipt: receipt() });
  assert.equal(settled.status, "settle");
  if (settled.status === "settle") {
    assert.equal(settled.providerMicroUsd, "4079"); assert.equal(settled.debitCredits, "62");
    assert.equal(settled.releaseCredits, "1550");
    assert.equal(BigInt(settled.debitCredits) + BigInt(settled.releaseCredits), BigInt(offer.quote.reservedCredits));
  }
});

test("unmeasured, malformed or changed narration retains the full hold for review", () => {
  const offer = prepare();
  for (const rawUsage of [null, {}, { ...rawUsageWithNewCounter() }, { huge: "x".repeat(20_000) }]) {
    const result = reconcileNarrationUsage(offer.quote, { request, sourceText: text, receipt: { ...receipt(), rawUsage } });
    assert.equal(result.status, "requires_review");
    if (result.status === "requires_review") {
      assert.equal(result.reason, "usage_unsupported"); assert.equal(result.heldCredits, offer.quote.reservedCredits);
      assert.equal("releaseCredits" in result, false);
    }
  }
  const changed = reconcileNarrationUsage(offer.quote, { request, sourceText: text, receipt: { ...receipt(), transcript: "Paraphrased chapter" } });
  assert.equal(changed.status, "requires_review");
  if (changed.status === "requires_review") assert.equal(changed.reason, "transcript_mismatch");
  const normalized = reconcileNarrationUsage(offer.quote, { request, sourceText: text, receipt: { ...receipt(), transcript: text.normalize("NFD") } });
  assert.equal(normalized.status, "settle");
});
function rawUsageWithNewCounter() { return { ...rawUsage, other_tokens: 1 }; }

test("foreign receipts and tampered quote arithmetic cannot reach settlement", () => {
  const offer = prepare();
  for (const change of [{ jobId: uuid(9) }, { userId: uuid(9) }, { workspaceId: uuid(9) }, { requestSha256: sha("other") },
    { sourceSha256: sha("other") }, { model: "gpt-realtime-2.1" }, { provider: "foreign" }, { responseId: " " }, { extra: true }]) {
    assert.throws(() => reconcileNarrationUsage(offer.quote, { request, sourceText: text, receipt: { ...receipt(), ...change } }));
  }
  assert.throws(() => reconcileNarrationUsage({ ...offer.quote, reservedCredits: "1" }, { request, sourceText: text, receipt: receipt() }));
  assert.throws(() => reconcileNarrationUsage(offer.quote, { request, sourceText: "other", receipt: receipt() }));
});

test("integer price/policy extremes are rejected before overflowing the funded ledger", () => {
  const value = catalog(); value.entries[0].price.rates[0].microUsdPerMillionTokens = "999999999999999999999";
  assert.throws(() => prepare(request, text, value), /ledger capacity/);
});

test("saved narration offer preserves the complete profile, not merely a valid pricing fingerprint", () => {
  const { quote } = prepare();
  assert.deepEqual(validatedNarrationQuote(quote, request), quote);
  const invalid: UsageQuote[] = [
    quoteUsage({ ...quote, maximumTokens: quote.maximumTokens.map(value => ({ ...value, tokens: "1" })) }),
    quoteUsage({ ...quote, price: { ...quote.price, model: "gpt-realtime-2.1" } }),
    quoteUsage({ ...quote, scope: { ...quote.scope, userId: uuid(9) } }),
    quoteUsage({ ...quote, price: { ...quote.price, rates: quote.price.rates.map(value =>
      value.dimension === "audio_output" ? { ...value, microUsdPerMillionTokens: "0" } : value) } }),
    quoteUsage({ ...quote, price: { ...quote.price, rates: quote.price.rates.filter(value => value.dimension !== "text_output") },
      maximumTokens: quote.maximumTokens.filter(value => value.dimension !== "text_output") }),
    quoteUsage({ ...quote, price: { ...quote.price, rates: quote.price.rates.map(value => ({ ...value, microUsdPerMillionTokens: "999999999999999999999" })) } }),
  ];
  for (const altered of invalid) {
    assert.deepEqual(quoteUsage(altered), altered, "fixture must retain entirely canonical arithmetic and fingerprint");
    assert.throws(() => validatedNarrationQuote(altered, request), (error: unknown) => error instanceof AppError && error.status === 500);
    assert.throws(() => reconcileNarrationUsage(altered, { request, sourceText: text, receipt: receipt() }));
  }
  for (const altered of [null, {}, { ...quote, extra: true }, { ...quote, fingerprint: sha("forged") }]) {
    assert.throws(() => validatedNarrationQuote(altered, request), /could not be verified/);
  }
  assert.throws(() => validatedNarrationQuote(quote, { ...request, promptSha256: sha("changed prompt") }), /could not be verified/);
});

test("cyclic original usage retains the complete hold without fabricated measurements", () => {
  const rawUsage: Record<string, unknown> = {};
  rawUsage.cycle = rawUsage;
  const { quote } = prepare();
  const result = reconcileNarrationUsage(quote, { request, sourceText: text, receipt: { ...receipt(), rawUsage } });
  assert.equal(result.status, "requires_review");
  if (result.status === "requires_review") {
    assert.equal(result.reason, "usage_unsupported");
    assert.equal(result.heldCredits, quote.reservedCredits);
  }
});

const chapterInput = { modelId: "mini", idempotencyKey: "original-chapter-key", now,
  userId: request.userId, workspaceId: request.workspaceId, bookId: request.bookId, editionId: request.editionId,
  chapterId: request.chapterId, documentVersionId: request.documentVersionId, voice: request.voice, speed: 1, instructions: null };
test("one chapter offer includes every saved segment and exactly aggregates individual maximum credits", () => {
  const sourceText = "A".repeat(4_000);
  const offer = prepareNarrationChapterQuote(JSON.stringify(catalog()), { ...chapterInput, sourceText });
  assert.equal(offer.offers.length, 3);
  assert.equal(offer.reservedCredits, "4836");
  assert.equal(offer.sourceSha256, sha(sourceText));
  assert.deepEqual(offer.offers.map(value => [value.request.segmentIndex, value.request.textStart, value.request.textEnd]),
    [[0, 0, 1800], [1, 1800, 3600], [2, 3600, 4000]]);
  for (const [index, child] of offer.offers.entries()) {
    assert.equal(child.request.jobId, narrationJobId(request.userId, narrationChapterSegmentKey(chapterInput.idempotencyKey, index)));
    assert.equal(child.quote.scope.inputSha256, narrationRequestHash(child.request));
    assert.deepEqual(validatedNarrationQuote(child.quote, child.request), child.quote);
  }
  assert(!JSON.stringify(offer).includes(sourceText), "chapter offers retain source pointers, not copied text");
  assert.deepEqual(prepareNarrationChapterQuote(JSON.stringify(catalog()), { ...chapterInput, sourceText }), offer);
});

test("chapter quote pins Unicode, whitespace gaps and exact delivery without missing source words", () => {
  const sourceText = " \n" + "Café 😀. ".repeat(300) + "\n\t ";
  const offer = prepareNarrationChapterQuote(JSON.stringify(catalog()), { ...chapterInput, sourceText, instructions: "Warm narration", speed: 0.29 });
  const points = Array.from(sourceText);
  let previousEnd = 0;
  for (const { request: value } of offer.offers) {
    assert(!points.slice(previousEnd, value.textStart).join("").trim());
    assert.equal(value.textSha256, sha(points.slice(value.textStart, value.textEnd).join("")));
    assert.equal(value.instructions, "Warm narration"); assert.equal(value.speed, 0.29);
    assert(Buffer.byteLength(points.slice(value.textStart, value.textEnd).join("")) + Buffer.byteLength(value.instructions) <= 1800);
    previousEnd = value.textEnd;
  }
  assert(!points.slice(previousEnd).join("").trim());
  assert.equal(offer.sourceSha256, sha(sourceText));
  assert.notEqual(offer.offers[0]!.request.jobId, narrationJobId(request.userId, chapterInput.idempotencyKey));
});

test("chapter quotes reject unsupported sources, scope, settings, budgets and aggregate ledger overflow", () => {
  for (const patch of [{ sourceText: " " }, { sourceText: "\ud800" }, { sourceText: "A".repeat(450_001) },
    { modelId: "unknown" }, { idempotencyKey: "short" }, { userId: "invalid" }, { instructions: " padded " },
    { instructions: "\ud800" }, { voice: "fable" }, { speed: 1.005 }]) {
    assert.throws(() => prepareNarrationChapterQuote(JSON.stringify(catalog()), { ...chapterInput, sourceText: text, ...patch } as never));
  }
  const expensive = catalog(); expensive.entries[0]!.policy.microUsdPerCredit = "1"; expensive.entries[0]!.policy.markupBasisPoints = 1_000_000;
  assert.throws(() => prepareNarrationChapterQuote(JSON.stringify(expensive), { ...chapterInput, sourceText: "A".repeat(450_000) }), /ledger capacity/);
});
