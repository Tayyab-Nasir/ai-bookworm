import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";
import { isStoryBlueprintQuoteExpired, storyBlueprintProposalSessionKey, storyBlueprintQuoteIntentKey } from "../components/StoryBlueprintProposalPanel";
import type { StoryBlueprintQuote } from "@bookworm/api-client";

test("accepted paid proposals remain accepted after the offer deadline", () => {
  const quote: StoryBlueprintQuote = { id: "proposal", requestId: "request", sourceRevision: 1,
    model: "test-model", reservedCredits: 10, expiresAt: "2020-01-01T00:00:00Z",
    acceptedJobId: null, status: "ready" };
  assert.equal(isStoryBlueprintQuoteExpired(quote), true);
  assert.equal(isStoryBlueprintQuoteExpired({ ...quote, status: "accepted", acceptedJobId: "job" }), false);
});

test("Story Blueprint proposal client separates model lookup, token-count consent, funded acceptance, review, and apply", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({}); };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
  const bookId = "book-1";
  const proposalId = "proposal-1";
  const requestId = "request-1";
    await api.listStoryBlueprintModels(bookId);
    await api.requestStoryBlueprintQuote(bookId, { modelId: "astra", idempotencyKey: "story-blueprint-quote-1", allowProviderTokenCounting: true });
    await api.getStoryBlueprintQuoteRequest(bookId, requestId);
    await api.getStoryBlueprintQuote(bookId, proposalId);
    await api.acceptStoryBlueprintQuote(bookId, proposalId, 42);
    await api.getStoryBlueprintProposal(bookId, proposalId);
    await api.applyStoryBlueprintProposal(bookId, proposalId, 7);

    assert.deepEqual(calls.map((call) => call.url), [
      "/api/backend/v1/books/book-1/story-blueprint/models",
      "/api/backend/v1/books/book-1/story-blueprint/quotes",
      "/api/backend/v1/books/book-1/story-blueprint/quote-requests/request-1",
      "/api/backend/v1/books/book-1/story-blueprint/quotes/proposal-1",
      "/api/backend/v1/books/book-1/story-blueprint/quotes/proposal-1/accept",
      "/api/backend/v1/books/book-1/story-blueprint/proposals/proposal-1",
      "/api/backend/v1/books/book-1/story-blueprint/proposals/proposal-1/apply",
    ]);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      modelId: "astra", idempotencyKey: "story-blueprint-quote-1", allowProviderTokenCounting: true,
    });
    assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { expectedCredits: 42 });
    assert.deepEqual(JSON.parse(String(calls[6].init?.body)), { expectedRevision: 7 });
    assert.ok(calls.every((call) => call.init?.credentials === "same-origin"));
  } finally { globalThis.fetch = original; }
});

test("local proposal recovery and request identity do not retain author text", () => {
  const bookId = "11111111-1111-4111-8111-111111111111";
  const key = storyBlueprintProposalSessionKey(bookId);
  const intent = storyBlueprintQuoteIntentKey(bookId, 12, "gpt-6-astra");
  assert.equal(key, storyBlueprintProposalSessionKey(bookId));
  assert.equal(intent, storyBlueprintQuoteIntentKey(bookId, 12, "gpt-6-astra"));
  assert.match(key, /^story-blueprint-proposal:/);
  assert.match(intent, /^story-blueprint-quote:/);
  assert.doesNotMatch(`${key}:${intent}`, /premise|synopsis|notes|credit|openai/i);
});
