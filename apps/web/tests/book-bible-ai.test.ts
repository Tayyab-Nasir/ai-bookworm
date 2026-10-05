import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acceptBibleQuoteRequest, bibleGenerationBlocked, bibleQuoteIntentKey, canAcceptBibleQuote, createBibleQuoteIntent, parseBookBibleCandidates, requestBibleQuoteResult } from "../components/BookMemoryClient";

const ref = { chapterId: "chapter", documentVersionId: "version", nodeId: "n1", textHash: "a".repeat(64) };
const candidate = { suggestionKind: "book_bible_candidate", status: "pending", type: "character",
  name: "Elara", description: "A mapmaker", attributes: { eyes: "silver", maps: ["north", "east"] },
  confidence: 0.8, sourceRefs: [ref] };

test("Book Bible candidate parser preserves structured details and pinned evidence", () => {
  assert.deepEqual(parseBookBibleCandidates([candidate]), [{ type: "character", name: "Elara",
    description: "A mapmaker", attributes: candidate.attributes, confidence: 0.8, sourceRefs: [ref] }]);
  assert.deepEqual(parseBookBibleCandidates([]), []);
});

test("Book Bible candidate parser rejects unsupported or uncited drafts", () => {
  for (const value of [null, [candidate, ...Array(10).fill(candidate)],
    [{ ...candidate, sourceRefs: [] }], [{ ...candidate, sourceRefs: [{ ...ref, textHash: "bad" }] }],
    [{ ...candidate, attributes: { note: "x".repeat(25000) } }]]) {
    assert.throws(() => parseBookBibleCandidates(value), /invalid/i);
  }
});

test("Book Bible quote flow uses separate consent, status recovery, and unsaved candidate review", async () => {
  assert.equal(bibleGenerationBlocked(null), true);
  assert.equal(bibleGenerationBlocked([{ id: "job", createdAt: "now", status: "running" }]), true);
  assert.equal(bibleGenerationBlocked([]), false);
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(here, "..", "components", "BookMemoryClient.tsx"), "utf8");
  assert.match(source, /`\$\{endpoint\}\/bible\/models`/);
  assert.match(source, /\/bible\/quotes`, "POST"/);
  assert.match(source, /\/bible\/quotes\/\$\{encodeURIComponent\(intent\.requestId\)\}/);
  assert.match(source, /\/bible\/quotes\/\$\{encodeURIComponent\(requestId\)\}\/accept/);
  assert.match(source, /I agree to send the selected saved manuscript batch to OpenAI for input-token counting/);
  assert.match(source, /I approve this quote and authorize one candidate extraction/);
  assert.match(source, /expectedCredits/);
  assert.doesNotMatch(source, /\/bible\/generate/, "the paid author UI must not call the legacy fixed-credit endpoint");
  assert.match(source, /Recover existing result/);
  assert.match(source, />Open as unsaved entry<\/button>/);
  assert.match(source, /setEntryDirty\(true\)/);
  assert.match(source, /choose Save/);
  const openCandidate = source.slice(source.indexOf("function useBibleCandidate"), source.indexOf("const visibleItems"));
  assert.doesNotMatch(openCandidate, /request\s*</,
    "opening a candidate must not persist an entry");
});

test("Book Bible quote intent contains stable request identity and selected IDs, never manuscript text", () => {
  const intent = createBibleQuoteIntent({ modelId: "approved-model", idempotencyKey: "stable-quote-key-123", chapterIds: ["chapter-a", "chapter-b"], maxTokens: 6000,
    reading: { fingerprint: "a".repeat(64), pageIndex: 1 } });
  assert.deepEqual(intent, { idempotencyKey: "stable-quote-key-123", body: {
    modelId: "approved-model", idempotencyKey: "stable-quote-key-123", chapterIds: ["chapter-a", "chapter-b"], maxTokens: 6000,
    reading: { fingerprint: "a".repeat(64), pageIndex: 1 }, allowProviderTokenCounting: true,
  } });
  assert.equal(bibleQuoteIntentKey("book-1"), "bookworm:bible-quote:v1:book-1");
  assert.doesNotMatch(JSON.stringify(intent), /manuscript|private prose|chapter text/i);
});

test("an uncertain quote retry reuses the same key; request recovery is read-only and acceptance sends the exact quote", async () => {
  const intent = createBibleQuoteIntent({ modelId: "approved-model", idempotencyKey: "stable-quote-key-123", chapterIds: ["chapter-a"], maxTokens: 6000 });
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  let first = true;
  const retryRequest = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
    calls.push({ path, method, body });
    if (first) { first = false; throw new Error("connection lost after submission"); }
    return { request: { id: "request-1", status: "counting" }, quote: null } as T;
  };
  await assert.rejects(requestBibleQuoteResult(retryRequest, "/v1/books/book-1", intent), /connection lost/);
  const recovered = await requestBibleQuoteResult(retryRequest, "/v1/books/book-1", intent);
  assert.equal(recovered.request?.id, "request-1");
  assert.deepEqual(calls, [
    { path: "/v1/books/book-1/bible/quotes", method: "POST", body: intent.body },
    { path: "/v1/books/book-1/bible/quotes", method: "POST", body: intent.body },
  ]);

  const statusCalls: { path: string; method?: string; body?: unknown }[] = [];
  const readOnlyRequest = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
    statusCalls.push({ path, method, body });
    return { request: { id: "request-1", status: "ready" }, quote: null, job: { id: "job-1", status: "running" } } as T;
  };
  await requestBibleQuoteResult(readOnlyRequest, "/v1/books/book-1", { ...intent, requestId: "request-1" });
  assert.deepEqual(statusCalls, [{ path: "/v1/books/book-1/bible/quotes/request-1", method: undefined, body: undefined }]);

  const acceptCalls: { path: string; method?: string; body?: unknown }[] = [];
  const acceptRequest = async <T>(path: string, method?: string, body?: unknown): Promise<T> => {
    acceptCalls.push({ path, method, body }); return { jobId: "job-1", status: "queued" } as T;
  };
  await acceptBibleQuoteRequest(acceptRequest, "/v1/books/book-1", "request-1", 17);
  assert.deepEqual(acceptCalls, [{ path: "/v1/books/book-1/bible/quotes/request-1/accept", method: "POST", body: { expectedCredits: 17 } }]);
});

test("acceptance requires separate consent, exact positive credits, and a ready unexpired quote", () => {
  const quote = { requestId: "request-1", status: "ready" as const, model: "gpt-approved", countedInputTokens: 4321,
    maxOutputTokens: 6000, reservedCredits: 17, expiresAt: "2030-01-01T00:00:00.000Z" };
  const now = Date.parse("2029-01-01T00:00:00.000Z");
  assert.equal(canAcceptBibleQuote(quote, false, now), false);
  assert.equal(canAcceptBibleQuote(quote, true, now), true);
  assert.equal(canAcceptBibleQuote({ ...quote, status: "expired" }, true, now), false);
  assert.equal(canAcceptBibleQuote({ ...quote, reservedCredits: 0 }, true, now), false);
  assert.equal(canAcceptBibleQuote(quote, true, Date.parse("2031-01-01T00:00:00.000Z")), false);
});
