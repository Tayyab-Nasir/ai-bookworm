import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type CreateNarrationQuoteRequest, type NarrationQuote, type CreateNarrationChapterQuoteRequest,
  type NarrationChapterQuote, type AcceptNarrationChapterQuoteRequest, type NarrationChapterAcceptance } from "@bookworm/api-client";

test("narration client separates saved offers and private key-only recovery without acceptance", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const offer: NarrationQuote = { quoteId: "quote/one", purchaseAvailable: false, pricingBasis: "maximum_token_budget",
    modelId: "mini", model: "gpt-realtime-2.1-mini", voice: "marin", speed: 1,
    source: { bookId: "book", editionId: "edition", chapterId: "chapter", documentVersionId: "version", segmentIndex: 0, textStart: 0, textEnd: 20 },
    reservedCredits: "1612", priceVersion: "synthetic", policyVersion: "synthetic", expiresAt: "2026-10-05T06:00:00.000Z", expired: false };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(offer); };
  try {
    const client = createClient({ baseUrl: "/api/backend", token: "test-only" });
    const body: CreateNarrationQuoteRequest = { editionId: "edition", chapterId: "chapter", modelId: "mini", idempotencyKey: "private-original-key",
      segmentIndex: 0, voice: "marin", speed: 1, instructions: "Keep names clear", consentToQuoteStorage: true };
    await client.listNarrationModels("workspace/one");
    assert.deepEqual(await client.createNarrationQuote("workspace/one", body), offer);
    assert.deepEqual(await client.recoverNarrationQuote("workspace/one", "private-original-key"), offer);
    assert.deepEqual(await client.getNarrationQuote("workspace/one", "quote/one"), offer);
    assert.deepEqual(calls.map(call => [call.init?.method, call.url]), [
      ["GET", "/api/backend/v1/workspaces/workspace%2Fone/narration-models"],
      ["POST", "/api/backend/v1/workspaces/workspace%2Fone/narration-quotes"],
      ["POST", "/api/backend/v1/workspaces/workspace%2Fone/narration-quotes/recover"],
      ["GET", "/api/backend/v1/workspaces/workspace%2Fone/narration-quotes/quote%2Fone"],
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), body);
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { idempotencyKey: "private-original-key" });
    assert(calls.every(call => call.init?.credentials === "same-origin" && !call.url.includes("private-original-key")));
    assert.equal("acceptNarrationQuote" in client, false);
    assert.equal("generateNarration" in client, false);
    assert.equal("createAudiobookProject" in client, false, "unquoted creation must not be exposed by the SDK");
  } finally { globalThis.fetch = original; }
});

test("chapter narration client preserves the complete aggregate and recovers by private key only", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const offer: NarrationChapterQuote = { quoteId: "chapter-quote/one", purchaseAvailable: false, pricingBasis: "maximum_token_budget",
    modelId: "mini", model: "gpt-realtime-2.1-mini", voice: "marin", speed: 0.29,
    source: { bookId: "book", editionId: "edition", chapterId: "chapter", documentVersionId: "version" },
    segmentCount: 2, segments: [{ quoteId: "child-1", segmentIndex: 0, textStart: 0, textEnd: 100, reservedCredits: "1612" },
      { quoteId: "child-2", segmentIndex: 1, textStart: 101, textEnd: 200, reservedCredits: "1612" }],
    reservedCredits: "3224", priceVersion: "synthetic", policyVersion: "synthetic", expiresAt: "2026-10-05T06:00:00.000Z", expired: false };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(offer); };
  try {
    const client = createClient({ baseUrl: "/api/backend", token: "test-only" });
    const body: CreateNarrationChapterQuoteRequest = { editionId: "edition", chapterId: "chapter", modelId: "mini", idempotencyKey: "private-chapter-key",
      voice: "marin", speed: 0.29, instructions: "Keep names clear", consentToQuoteStorage: true };
    assert.deepEqual(await client.createNarrationChapterQuote("workspace/one", body), offer);
    assert.deepEqual(await client.recoverNarrationChapterQuote("workspace/one", "private-chapter-key"), offer);
    assert.deepEqual(await client.getNarrationChapterQuote("workspace/one", "chapter-quote/one"), offer);
    assert.deepEqual(calls.map(call => [call.init?.method, call.url]), [
      ["POST", "/api/backend/v1/workspaces/workspace%2Fone/narration-chapter-quotes"],
      ["POST", "/api/backend/v1/workspaces/workspace%2Fone/narration-chapter-quotes/recover"],
      ["GET", "/api/backend/v1/workspaces/workspace%2Fone/narration-chapter-quotes/chapter-quote%2Fone"],
    ]);
    assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), body);
    assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), { idempotencyKey: "private-chapter-key" });
    assert(calls.every(call => call.init?.credentials === "same-origin" && !call.url.includes("private-chapter-key")));
    assert.equal("acceptNarrationQuote" in client, false, "single-part purchases remain unsupported");
  } finally { globalThis.fetch = original; }
});

test("chapter purchase confirms the exact maximum and two consents; a lost reply only recovers the same quote", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const accepted: NarrationChapterAcceptance = { quoteId: "chapter-quote/one", accepted: true,
    project: { id: "original-project", billingMode: "quoted", status: "running", reservedCredits: "3224" } };
  let loseReply = true;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "POST" && loseReply) { loseReply = false; throw new Error("Synthetic lost acceptance reply"); }
    return Response.json(accepted);
  };
  try {
    const client = createClient({ baseUrl: "/api/backend", token: "test-only" });
    const body: AcceptNarrationChapterQuoteRequest = { expectedCredits: "3224", consentToAiVoice: true, consentToGenerate: true };
    await assert.rejects(client.acceptNarrationChapterQuote("workspace/one", "chapter-quote/one", body), /Synthetic lost acceptance reply/);
    assert.deepEqual(await client.getNarrationChapterAcceptance("workspace/one", "chapter-quote/one"), accepted);
    assert.deepEqual(calls.map(call => [call.init?.method, call.url]), [
      ["POST", "/api/backend/v1/workspaces/workspace%2Fone/narration-chapter-quotes/chapter-quote%2Fone/accept"],
      ["GET", "/api/backend/v1/workspaces/workspace%2Fone/narration-chapter-quotes/chapter-quote%2Fone/project"],
    ]);
    assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), body);
    assert.equal(calls[1]!.init!.body, undefined);
    assert(calls.every(call => call.init?.credentials === "same-origin"));
    assert.equal(calls.filter(call => call.init?.method === "POST").length, 1, "the SDK never retries an uncertain purchase");
    assert.deepEqual(await client.acceptNarrationChapterQuote("workspace/one", "chapter-quote/one", body), accepted);
    assert.deepEqual(JSON.parse(String(calls[2]!.init!.body)), body, "an explicit same-offer replay keeps the original confirmation");
  } finally { globalThis.fetch = original; }
});
