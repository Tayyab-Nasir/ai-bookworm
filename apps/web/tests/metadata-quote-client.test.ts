import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";

test("metadata client separates consented creation, key-only recovery and exact acceptance", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({}); };
  try {
    const client = createClient({ baseUrl: "/api/backend", token: "test-only" });
    await client.createMetadataQuote("book", { modelId: "approved", idempotencyKey: "original-key", allowProviderTokenCounting: true });
    await client.recoverMetadataQuote("book", "original-key");
    await client.getMetadataQuote("book", "saved-request");
    await client.acceptMetadataQuote("book", "saved-request", 24);
    assert.deepEqual(calls.map((call) => [call.init?.method, call.url]), [
      ["POST", "/api/backend/v1/books/book/metadata/quotes"],
      ["POST", "/api/backend/v1/books/book/metadata/quotes/recover"],
      ["GET", "/api/backend/v1/books/book/metadata/quote-requests/saved-request"],
      ["POST", "/api/backend/v1/books/book/metadata/quotes/saved-request/accept"],
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { idempotencyKey: "original-key" });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { expectedCredits: 24 });
    assert.ok(calls.every((call) => call.init?.credentials === "same-origin"));
    assert.equal("generateBookMetadata" in client, false, "retired direct generation must not remain a client action");
  } finally { globalThis.fetch = original; }
});
