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
    await api.recoverStoryBlueprintQuoteRequest(bookId, "original-request-key");
    await api.closeStoryBlueprintQuoteRequest(bookId, "original-request-key");
    await api.resolveStoryBlueprintQuote(bookId, proposalId);
    await api.listStoryBlueprintProposals(bookId, { createdAt: "2026-10-01T00:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" });

    assert.deepEqual(calls.map((call) => call.url), [
      "/api/backend/v1/books/book-1/story-blueprint/models",
      "/api/backend/v1/books/book-1/story-blueprint/quotes",
      "/api/backend/v1/books/book-1/story-blueprint/quote-requests/request-1",
      "/api/backend/v1/books/book-1/story-blueprint/quotes/proposal-1",
      "/api/backend/v1/books/book-1/story-blueprint/quotes/proposal-1/accept",
      "/api/backend/v1/books/book-1/story-blueprint/proposals/proposal-1",
      "/api/backend/v1/books/book-1/story-blueprint/proposals/proposal-1/apply",
      "/api/backend/v1/books/book-1/story-blueprint/quote-requests/recover",
      "/api/backend/v1/books/book-1/story-blueprint/quote-requests/close",
      "/api/backend/v1/books/book-1/story-blueprint/quotes/proposal-1/resolve",
      "/api/backend/v1/books/book-1/story-blueprint/proposals?beforeCreatedAt=2026-10-01T00%3A00%3A00.000Z&beforeId=11111111-1111-4111-8111-111111111111",
    ]);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      modelId: "astra", idempotencyKey: "story-blueprint-quote-1", allowProviderTokenCounting: true,
    });
    assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { expectedCredits: 42 });
    assert.deepEqual(JSON.parse(String(calls[6].init?.body)), { expectedRevision: 7 });
    assert.deepEqual(JSON.parse(String(calls[7].init?.body)), { idempotencyKey: "original-request-key" });
    assert.deepEqual(JSON.parse(String(calls[8].init?.body)), { idempotencyKey: "original-request-key" });
    assert.deepEqual(JSON.parse(String(calls[9].init?.body)), {});
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

test("all Story Blueprint reads, writes and quote recovery carry the original actor", async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init ?? {}); return Response.json({}); };
  try {
    const actor = "11111111-1111-4111-8111-111111111111";
    const api = createClient({ baseUrl: "/api/backend", expectedActor: actor });
    await api.getStoryBlueprint("book");
    await api.saveStoryBlueprint("book", {} as never);
    await api.materializeStoryBlueprintChapter("book", "chapter", {} as never);
    await api.listStoryBlueprintModels("book");
    await api.requestStoryBlueprintQuote("book", { modelId: "model", idempotencyKey: "original-key", allowProviderTokenCounting: true });
    await api.recoverStoryBlueprintQuoteRequest("book", "original-key");
    await api.closeStoryBlueprintQuoteRequest("book", "original-key");
    await api.getStoryBlueprintQuoteRequest("book", "request");
    await api.getStoryBlueprintProposal("book", "proposal");
    await api.acceptStoryBlueprintQuote("book", "proposal", 42);
    await api.resolveStoryBlueprintQuote("book", "proposal");
    await api.listStoryBlueprintProposals("book");
    await api.applyStoryBlueprintProposal("book", "proposal", 1);
    assert.ok(calls.every(call => new Headers(call.headers).get("x-bookworm-actor") === actor));
    assert.equal(new Headers(calls[5].headers).has("idempotency-key"), false);
    assert.equal(new Headers(calls[6].headers).has("idempotency-key"), false);
  } finally { globalThis.fetch = original; }
});
