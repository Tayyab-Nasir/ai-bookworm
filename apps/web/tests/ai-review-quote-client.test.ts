import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";
import { canAcceptReviewQuote } from "../lib/ai-review-recovery";

test("AI quote approval is bound to the saved chapter, current permission and confirmed recovery", () => {
  const quote = { requestId: "request", status: "ready" as const, agentType: "proofreader" as const, model: "approved",
    countedInputTokens: 3100, maxOutputTokens: 6000, reservedCredits: 24, expiresAt: "2030-01-01T00:00:00.000Z" };
  const state = { pending: { bookId: "book", chapterId: "chapter", quoteRequestId: "request" }, bookId: "book", chapterId: "chapter",
    editable: true, dirty: false, recoveryReady: true, busy: false, acceptanceUncertain: false };
  const now = Date.parse("2029-01-01T00:00:00.000Z");
  assert.equal(canAcceptReviewQuote(quote, state, now), true);
  for (const change of [{ editable: false }, { dirty: true }, { recoveryReady: false }, { busy: true }, { acceptanceUncertain: true }, { chapterId: "other" }, { bookId: "other" }, { pending: null }]) {
    assert.equal(canAcceptReviewQuote(quote, { ...state, ...change }, now), false);
  }
  assert.equal(canAcceptReviewQuote({ ...quote, requestId: "other" }, state, now), false);
  assert.equal(canAcceptReviewQuote({ ...quote, status: "accepted" } as unknown as typeof quote, state, now), false);
  assert.equal(canAcceptReviewQuote({ ...quote, reservedCredits: 1.5 }, state, now), false);
  assert.equal(canAcceptReviewQuote(quote, state, Date.parse("2031-01-01T00:00:00.000Z")), false);
});

test("AI review client keeps counting, exact quote acceptance and recovery on the same-origin API", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({}); };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    const bookId = "book-1";
    const requestId = "quote-1";
    await api.listAiReviewModels(bookId);
    await api.createAiReviewQuote(bookId, {
      chapterIds: ["chapter-1"], agentType: "proofreader", idempotencyKey: "review-key-0001",
      modelId: "astra", allowProviderTokenCounting: true,
      contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false, semanticTopK: 5, maxTokens: 8192 },
    });
    await api.getAiReviewQuote(bookId, requestId);
    await api.acceptAiReviewQuote(bookId, requestId, 24);

    assert.deepEqual(calls.map((call) => call.url), [
      "/api/backend/v1/books/book-1/ai-review/models",
      "/api/backend/v1/books/book-1/ai-review/quotes",
      "/api/backend/v1/books/book-1/ai-review/quotes/quote-1",
      "/api/backend/v1/books/book-1/ai-review/quotes/quote-1/accept",
    ]);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      chapterIds: ["chapter-1"], agentType: "proofreader", idempotencyKey: "review-key-0001",
      modelId: "astra", allowProviderTokenCounting: true,
      contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false, semanticTopK: 5, maxTokens: 8192 },
    });
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { expectedCredits: 24 });
    assert.equal(calls[2].init?.method, "GET");
    assert.ok(calls.every((call) => call.init?.credentials === "same-origin"));
  } finally { globalThis.fetch = original; }
});
