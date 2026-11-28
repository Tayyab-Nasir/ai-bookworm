import assert from "node:assert/strict";
import test from "node:test";
import { isImageQuoteFormLocked, canAcceptImageQuote, readImageQuotePointer, recoverSavedImageQuote } from "../lib/image-quote-ui-state.js";

test("image request fields remain editable before a quote is requested", () => {
  assert.equal(isImageQuoteFormLocked({ canEdit: true, busy: false, hasRequestKey: false, hasSavedQuote: false }), false);
});

test("an immutable saved quote locks the visible prompt and settings before paid acceptance", () => {
  assert.equal(isImageQuoteFormLocked({ canEdit: true, busy: false, hasRequestKey: true, hasSavedQuote: true }), true);
});

test("an interrupted request keeps the same-key payload immutable for recovery", () => {
  assert.equal(isImageQuoteFormLocked({ canEdit: true, busy: false, hasRequestKey: true, hasSavedQuote: false }), true);
});

test("busy and read-only states cannot edit image request fields", () => {
  assert.equal(isImageQuoteFormLocked({ canEdit: false, busy: false, hasRequestKey: false, hasSavedQuote: false }), true);
  assert.equal(isImageQuoteFormLocked({ canEdit: true, busy: true, hasRequestKey: false, hasSavedQuote: false }), true);
});

const quoteId = "11111111-1111-4111-8111-111111111111";
const offer = { id: quoteId, status: "ready" as const, model: "approved-image", size: "1024x1024", quality: "high", kind: "illustration" as const,
  reservedCredits: "47", expiresAt: "2030-01-01T00:00:00.000Z", pricingBasis: "maximum_token_budget" as const, purchaseAvailable: false as const };

test("recovery pointers contain only valid server identity, never a private brief", () => {
  assert.deepEqual(readImageQuotePointer(JSON.stringify({ idempotencyKey: "original-key", prompt: "private brief" })), { idempotencyKey: "original-key" });
  assert.deepEqual(readImageQuotePointer(JSON.stringify({ quoteId })), { quoteId });
  for (const raw of ["{", "null", "[]", "{}", JSON.stringify({ quoteId: "foreign-path" }), JSON.stringify({ idempotencyKey: "short" })]) {
    assert.equal(readImageQuotePointer(raw), null);
  }
});

test("lost quote-save recovery reads the same key without a model, prompt, catalog or new request", async () => {
  const calls: string[] = [];
  const result = await recoverSavedImageQuote({
    recoverImageQuote: async (workspace, key) => { calls.push(`recover:${workspace}:${key}`); return { quoteId }; },
    getImageQuote: async (_workspace, id) => { calls.push(`quote:${id}`); return { quote: offer }; },
    getImageQuoteJob: async (_workspace, id) => { calls.push(`job:${id}`); return { quoteId: id, job: null }; },
  }, "workspace", { idempotencyKey: "original-key" });
  assert.equal(result.quoteId, quoteId);
  assert.equal(result.quote, offer);
  assert.deepEqual(calls, [`recover:workspace:original-key`, `quote:${quoteId}`, `job:${quoteId}`]);
});

test("a lost acceptance reply recovers the accepted job through reads only", async () => {
  const job = { id: "job", status: "running" as const, assetId: null };
  const result = await recoverSavedImageQuote({
    recoverImageQuote: async () => { assert.fail("saved quote identity must not be recreated"); },
    getImageQuote: async () => ({ quote: offer }),
    getImageQuoteJob: async () => ({ quoteId, job }),
  }, "workspace", { quoteId });
  assert.equal(result.job, job);
});

test("failed or mismatched recovery does not replace a quote or start generation", async () => {
  await assert.rejects(recoverSavedImageQuote({
    recoverImageQuote: async () => { throw new Error("recovery unavailable"); },
    getImageQuote: async () => { assert.fail("no identity was recovered"); },
    getImageQuoteJob: async () => { assert.fail("no identity was recovered"); },
  }, "workspace", { idempotencyKey: "original-key" }), /recovery unavailable/);
  await assert.rejects(recoverSavedImageQuote({
    recoverImageQuote: async () => ({ quoteId }),
    getImageQuote: async () => ({ quote: offer }),
    getImageQuoteJob: async () => ({ quoteId: "another-quote", job: null }),
  }, "workspace", { quoteId }), /identity/);
});

test("paid image acceptance requires edit permission, separate consent and confirmed current status", () => {
  const state = { canEdit: true, busy: false, purchaseAvailable: true, generateConsent: true, acceptanceUncertain: false, quote: offer, hasJob: false };
  assert.equal(canAcceptImageQuote(state), true);
  for (const denied of [{ canEdit: false }, { busy: true }, { purchaseAvailable: false }, { generateConsent: false }, { acceptanceUncertain: true }, { hasJob: true }, { quote: null }, { quote: { ...offer, status: "expired" as const } }]) {
    assert.equal(canAcceptImageQuote({ ...state, ...denied }), false);
  }
  assert.equal(canAcceptImageQuote(state, Date.parse("2031-01-01T00:00:00.000Z")), false);
  assert.equal(canAcceptImageQuote({ ...state, quote: { ...offer, reservedCredits: "1.5" } }), false);
  assert.equal(canAcceptImageQuote({ ...state, quote: { ...offer, reservedCredits: "9007199254740993" } }), false);
});
