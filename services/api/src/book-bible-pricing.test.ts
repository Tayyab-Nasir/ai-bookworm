import { test } from "node:test";
import assert from "node:assert/strict";
import { availableBookBibleModels, prepareBookBibleQuote, type BookBibleTextRequest } from "./lib/book-bible-pricing.js";

const NOW = "2026-09-25T00:00:00.000Z";
const scope = { jobId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333", bookId: "44444444-4444-4444-8444-444444444444" };
const request: BookBibleTextRequest = { jobId: scope.jobId, workspaceId: scope.workspaceId, bookId: scope.bookId,
  agentType: "bookbible", model: "gpt-6-astra-2026-09-01", maxOutputTokens: 6000,
  contextPolicy: { includeBookBible: false, includeStyleGuide: false, includeRelatedContext: false, semanticTopK: 5, maxTokens: 12000 },
  input: { chapterIds: ["55555555-5555-4555-8555-555555555555"], chapters: {}, book: {}, styleGuide: {}, bookBible: [], relatedContext: [], userInstruction: "Extract cited entities." } };
function catalog(approved = true) { return JSON.stringify({ version: "synthetic-v1", approved, approvalReference: "test-only",
  effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 600,
  entries: [{ id: "bible-model", label: "Book Bible model", maxInputTokens: 10000, maxOutputTokens: 6000,
    price: { version: "price-v1", provider: "openai", model: request.model, rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" }] },
    policy: { version: "policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000, platformMicroUsd: "100", minimumCredits: "1" } }] }); }

test("Book Bible quote uses exact consented input, an approved catalog and 6000-token output ceiling", async (t) => {
  const previous = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "synthetic-token";
  t.after(() => previous === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previous);
  let sent: unknown;
  const result = await prepareBookBibleQuote(catalog(), { modelId: "bible-model", now: NOW, scope, request, allowProviderTokenCounting: true }, {
    clock: () => NOW,
    fetcher: async (url, init) => { assert.match(String(url), /\/v1\/ai\/text\/quote$/u);
      assert.equal(new Headers(init?.headers).get("x-service-token"), "synthetic-token"); sent = JSON.parse(String(init?.body));
      return Response.json({ inputTokens: 700, inputSha256: "a".repeat(64), model: request.model, maxOutputTokens: 6000, agentType: "bookbible" }); },
  });
  assert.deepEqual(sent, request);
  assert.equal(result.countedInputTokens, 700);
  assert.equal(result.quote.scope.inputSha256, "a".repeat(64));
  assert.deepEqual(result.quote.maximumTokens, [
    { dimension: "text_cached_input", tokens: "700" }, { dimension: "text_input", tokens: "700" },
    { dimension: "text_output", tokens: "6000" },
  ]);
  assert.ok(BigInt(result.quote.reservedCredits) > 0n);
  assert.equal(availableBookBibleModels(catalog(), NOW).models[0]?.id, "bible-model");
});

test("Book Bible quote fails closed without approval, consent, credentials, or trustworthy token count", async (t) => {
  const previous = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "synthetic-token";
  t.after(() => previous === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previous);
  let calls = 0;
  await assert.rejects(prepareBookBibleQuote(undefined, { modelId: "bible-model", now: NOW, scope, request, allowProviderTokenCounting: true }));
  await assert.rejects(prepareBookBibleQuote(catalog(false), { modelId: "bible-model", now: NOW, scope, request, allowProviderTokenCounting: true }));
  await assert.rejects(prepareBookBibleQuote(catalog(), { modelId: "bible-model", now: NOW, scope, request, allowProviderTokenCounting: false }, {
    fetcher: async () => { calls++; return Response.json({}); },
  }), /Consent/u);
  await assert.rejects(prepareBookBibleQuote(catalog(), { modelId: "bible-model", now: NOW, scope, request, allowProviderTokenCounting: true }, {
    fetcher: async () => { calls++; return Response.json({ inputTokens: 0, inputSha256: "bad", model: request.model, maxOutputTokens: 6000, agentType: "bookbible" }); },
  }));
  assert.equal(calls, 1);
});
