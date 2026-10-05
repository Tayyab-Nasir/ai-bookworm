import assert from "node:assert/strict";
import test from "node:test";
import { assertNarrationChapterQuote, assertNarrationChapterAcceptance, readNarrationQuotePointer, narrationQuoteStorageKey } from "../lib/narration-quote-ui-state.js";

const uuid = (n: number) => `a6700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { bookId: uuid(3), editionId: uuid(4) };
const offer = { quoteId: uuid(7), purchaseAvailable: false, pricingBasis: "maximum_token_budget", modelId: "mini", model: "gpt-realtime-2.1-mini",
  voice: "marin", speed: 0.29, source: { ...scope, chapterId: uuid(5), documentVersionId: uuid(6) }, segmentCount: 2,
  segments: [{ quoteId: uuid(8), segmentIndex: 0, textStart: 2, textEnd: 20, reservedCredits: "1612" },
    { quoteId: uuid(9), segmentIndex: 1, textStart: 22, textEnd: 40, reservedCredits: "1612" }],
  reservedCredits: "3224", priceVersion: "synthetic", policyVersion: "synthetic", expiresAt: "2030-01-01T00:00:00.000Z", expired: false };

test("chapter offer public validation retains exact Unicode ranges and aggregate, without requiring current source/catalog", () => {
  assert.deepEqual(assertNarrationChapterQuote(offer, scope), offer);
  assert.equal(assertNarrationChapterQuote({ ...offer, purchaseAvailable: true }, scope).purchaseAvailable, true);
  assert.deepEqual(assertNarrationChapterQuote({ ...offer, expired: true }, scope).segments, offer.segments);
});

test("chapter offer rejects foreign identities, unsupported delivery, private fields and malformed credit/range aggregates", () => {
  for (const change of [{ quoteId: "invalid" }, { purchaseAvailable: "true" }, { reservedCredits: "1" }, { reservedCredits: "0" },
    { reservedCredits: "2147483648" }, { reservedCredits: "01" }, { reservedCredits: 3224 }, { priceVersion: "" }, { policyVersion: 1 },
    { modelId: "" }, { model: "gpt-4o-mini-tts" }, { voice: "fable" }, { speed: 0.1 }, { speed: 1.005 }, { speed: 2 },
    { expiresAt: "invalid" }, { expired: "false" }, { instructions: "PRIVATE" }, { segmentCount: 0 }, { segmentCount: 251 },
    { segments: [] }, { segments: [...offer.segments].reverse() }, { source: { ...offer.source, editionId: uuid(10) } },
    { source: { ...offer.source, bookId: uuid(10) } }, { source: { ...offer.source, chapterId: "invalid" } },
    { source: { ...offer.source, plainText: "PRIVATE" } }]) {
    assert.throws(() => assertNarrationChapterQuote({ ...offer, ...change }, scope), /could not be verified/);
  }
  for (const patch of [{ quoteId: offer.segments[0]!.quoteId }, { textStart: 0 }, { textEnd: 22 }, { textEnd: 1000001 },
    { textEnd: 5000 }, { textStart: 1.5 }, { reservedCredits: "0" }, { plainText: "PRIVATE" }]) {
    assert.throws(() => assertNarrationChapterQuote({ ...offer, segments: [offer.segments[0], { ...offer.segments[1], ...patch }] }, scope));
  }
  for (const value of [null, [], "invalid", {}, { ...offer, source: null }, { ...offer, segments: [null, null] }]) {
    assert.throws(() => assertNarrationChapterQuote(value, scope), /could not be verified/);
  }
});

test("narration recovery storage is partitioned by authenticated account, workspace, book and edition", () => {
  const first = narrationQuoteStorageKey(uuid(1), uuid(2), scope.bookId, scope.editionId);
  assert.notEqual(first, narrationQuoteStorageKey(uuid(11), uuid(2), scope.bookId, scope.editionId));
  assert.notEqual(first, narrationQuoteStorageKey(uuid(1), uuid(12), scope.bookId, scope.editionId));
  assert.notEqual(first, narrationQuoteStorageKey(uuid(1), uuid(2), uuid(13), scope.editionId));
  assert.notEqual(first, narrationQuoteStorageKey(uuid(1), uuid(2), scope.bookId, uuid(14)));
  assert.throws(() => narrationQuoteStorageKey("", uuid(2), scope.bookId, scope.editionId), /Sign in/);
});

test("accepted chapter projection binds the original maximum and quote without private fields", () => {
  const status = { quoteId: offer.quoteId, accepted: true, project: { id: uuid(20), billingMode: "quoted", status: "queued", reservedCredits: offer.reservedCredits } };
  assert.deepEqual(assertNarrationChapterAcceptance({ quoteId: offer.quoteId, accepted: false, project: null }, offer).accepted, false);
  for (const state of ["queued", "running", "succeeded", "failed"]) {
    assert.equal(assertNarrationChapterAcceptance({ ...status, project: { ...status.project, status: state } }, offer).project?.status, state);
  }
  for (const change of [{ quoteId: uuid(21) }, { accepted: "true" }, { accepted: false }, { project: null }, { instructions: "PRIVATE" }, { receipt: {} }]) {
    assert.throws(() => assertNarrationChapterAcceptance({ ...status, ...change }, offer), /unconfirmed/);
  }
  for (const change of [{ id: "invalid" }, { billingMode: "operational" }, { status: "unknown" }, { reservedCredits: "1" },
    { reservedCredits: 3224 }, { reservedCredits: "2147483648" }, { instructions: "PRIVATE" }, { signedUrl: "private" }]) {
    assert.throws(() => assertNarrationChapterAcceptance({ ...status, project: { ...status.project, ...change } }, offer), /unconfirmed/);
  }
  for (const value of [null, [], {}, { quoteId: offer.quoteId, accepted: false, project: {} }]) {
    assert.throws(() => assertNarrationChapterAcceptance(value, offer), /unconfirmed/);
  }
});

test("narration pointer preserves an attempted purchase on reload but never copied preferences or billing evidence", () => {
  const pointer = { idempotencyKey: "original-key", quoteId: offer.quoteId, purchaseAttempted: true };
  assert.deepEqual(readNarrationQuotePointer(JSON.stringify(pointer)), pointer);
  assert.deepEqual(readNarrationQuotePointer(JSON.stringify({ quoteId: offer.quoteId })), { quoteId: offer.quoteId });
  assert.deepEqual(readNarrationQuotePointer(JSON.stringify({ idempotencyKey: "original-key" })), { idempotencyKey: "original-key" });
  for (const value of [{ ...pointer, purchaseAttempted: false }, { ...pointer, purchaseAttempted: "true" },
    { purchaseAttempted: true, idempotencyKey: "original-key" }, { ...pointer, instructions: "PRIVATE" },
    { ...pointer, expectedCredits: "3224" }, { ...pointer, projectId: uuid(20) }, { ...pointer, quoteId: "invalid" }, {}, []]) {
    assert.equal(readNarrationQuotePointer(JSON.stringify(value)), null);
  }
  assert.equal(readNarrationQuotePointer("invalid"), null);
  assert.equal(readNarrationQuotePointer(null), null);
});
