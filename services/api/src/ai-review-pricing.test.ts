import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAiReviewQuote, availableAiReviewModels, type AiReviewGenerationRequest } from "./lib/ai-review-pricing.js";

const NOW = "2026-09-25T00:00:00.000Z";
const scope = { jobId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333", bookId: "44444444-4444-4444-8444-444444444444" };
const request: AiReviewGenerationRequest = {
  jobId: scope.jobId, workspaceId: scope.workspaceId, bookId: scope.bookId,
  agentType: "writer", model: "gpt-6-astra-2026-09-01", maxOutputTokens: 1200,
  contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false, semanticTopK: 5, maxTokens: 4096 },
  input: { chapterIds: ["55555555-5555-4555-8555-555555555555"], chapters: {}, book: {}, styleGuide: {}, bookBible: [], relatedContext: [], userInstruction: "Continue the scene." },
};
function catalog() { return JSON.stringify({ version: "synthetic-v1", approved: true, approvalReference: "test-only",
  effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 600,
  entries: [{ id: "writer", label: "Writer", maxInputTokens: 10000, maxOutputTokens: 1200,
    price: { version: "price-v1", provider: "openai", model: request.model, rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" }] },
    policy: { version: "policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000, platformMicroUsd: "100", minimumCredits: "1" } }] }); }

test("priced AI review quote counts the exact saved request and reserves cached/uncached maxima", async (t) => {
  const previous = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "synthetic-token";
  t.after(() => previous === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previous);
  let sent: unknown;
  const prepared = await prepareAiReviewQuote(catalog(), { modelId: "writer", now: NOW, scope, request, allowProviderTokenCounting: true }, {
    clock: () => NOW,
    fetcher: async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({
      inputTokens: 420, inputSha256: "a".repeat(64), model: request.model, maxOutputTokens: 1200, agentType: "writer",
    }); },
  });
  assert.deepEqual(sent, request);
  assert.equal(prepared.quote.scope.inputSha256, "a".repeat(64));
  assert.deepEqual(prepared.quote.maximumTokens, [
    { dimension: "text_cached_input", tokens: "420" },
    { dimension: "text_input", tokens: "420" },
    { dimension: "text_output", tokens: "1200" },
  ]);
  assert.ok(BigInt(prepared.quote.reservedCredits) > 0n);
  assert.equal(availableAiReviewModels(catalog(), NOW).models[0]?.id, "writer");
});

test("priced AI review requires explicit consent and never substitutes estimates for failed counting", async (t) => {
  const previous = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "synthetic-token";
  t.after(() => previous === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previous);
  let calls = 0;
  await assert.rejects(prepareAiReviewQuote(catalog(), { modelId: "writer", now: NOW, scope, request, allowProviderTokenCounting: false }, {
    fetcher: async () => { calls++; return Response.json({}); },
  }), /Consent/);
  assert.equal(calls, 0);
  await assert.rejects(prepareAiReviewQuote(catalog(), { modelId: "writer", now: NOW, scope, request, allowProviderTokenCounting: true }, {
    clock: () => NOW, fetcher: async () => new Response("unavailable", { status: 503 }),
  }), /No generation or credit reservation was started/);
});

test("priced AI review rejects changed model identity and over-limit token counts", async (t) => {
  const previous = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "synthetic-token";
  t.after(() => previous === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previous);
  const params = { modelId: "writer", now: NOW, scope, request, allowProviderTokenCounting: true } as const;
  await assert.rejects(prepareAiReviewQuote(catalog(), params, { clock: () => NOW, fetcher: async () => Response.json({
    inputTokens: 10, inputSha256: "b".repeat(64), model: "different-model", maxOutputTokens: 1200, agentType: "writer",
  }) }), /No generation or credit reservation was started/);
  await assert.rejects(prepareAiReviewQuote(catalog(), params, { clock: () => NOW, fetcher: async () => Response.json({
    inputTokens: 10001, inputSha256: "b".repeat(64), model: request.model, maxOutputTokens: 1200, agentType: "writer",
  }) }), /input exceeds/);
});
