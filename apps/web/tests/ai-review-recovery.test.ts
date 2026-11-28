import assert from "node:assert/strict";
import { test } from "node:test";
import { canReplaceReviewQuote, pendingReviewBody, readPendingReview, recoverReviewRequest, reviewBriefHash, reviewRecoveryKey, verifiedReviewQuoteStatus, type PendingReview } from "../lib/ai-review-recovery";
import type { AiJobWithSuggestions } from "@bookworm/api-client";

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const pending = async (): Promise<PendingReview> => ({
  schema: 1, userId: id(1), bookId: id(2), chapterId: id(3), key: id(4),
  mode: "writer", includeRelated: true, includeBookBible: true, includeStyleGuide: true, contextBudget: 8192,
  briefHash: await reviewBriefHash("writer", "Private manuscript instruction"), savedAt: 1_000,
});

test("review checkpoint retains a request pointer and digest, never manuscript instructions", async () => {
  const value = await pending();
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes("Private manuscript instruction"), false);
  assert.equal(readPendingReview(encoded, id(1), id(2), id(3), 2_000)?.key, id(4));
  assert.equal(reviewRecoveryKey(id(1), id(2), id(3)).includes(id(3)), true);
  assert.deepEqual(pendingReviewBody(value, "  Private manuscript instruction  ").chapterIds, [id(3)]);
  assert.equal(pendingReviewBody(value, "  Private manuscript instruction  ").userInstruction, "Private manuscript instruction");
});

test("review checkpoint rejects foreign, expired and malformed pointers", async () => {
  const value = await pending();
  const encoded = JSON.stringify(value);
  assert.equal(readPendingReview(encoded, id(8), id(2), id(3), 2_000), null);
  assert.equal(readPendingReview(encoded, id(1), id(2), id(3), 8 * 24 * 60 * 60 * 1000), null);
  assert.equal(readPendingReview(JSON.stringify({ ...value, briefHash: "wrong" }), id(1), id(2), id(3), 2_000), null);
  assert.equal(readPendingReview("{", id(1), id(2), id(3), 2_000), null);
});

test("paid quote recovery stores consent and server quote ID without saving manuscript text", async () => {
  const value = { ...await pending(), modelId: "writer-v1", allowProviderTokenCounting: true as const,
    quoteRequestId: id(9) };
  const encoded = JSON.stringify(value);
  const recovered = readPendingReview(encoded, id(1), id(2), id(3), 2_000);
  assert.equal(recovered?.allowProviderTokenCounting, true);
  assert.equal(recovered?.quoteRequestId, id(9));
  assert.equal(recovered?.modelId, "writer-v1");
  assert.doesNotMatch(encoded, /Private manuscript instruction|Elara|Mira finds/i);
  assert.deepEqual(Object.keys(recovered ?? {}).sort(), Object.keys(value).sort());
});

test("writer recovery preserves selected Book Bible and style guide inclusion in the exact quote body", async () => {
  const value = { ...await pending(), includeBookBible: false, includeStyleGuide: true };
  const body = pendingReviewBody(value, "Private manuscript instruction");
  assert.deepEqual(body.contextPolicy, { includeBookBible: false, includeStyleGuide: true, includeRelatedContext: true, maxTokens: 8192 });
});

test("legacy recovery keeps prior Book Bible and style guide defaults; malformed choices are rejected", async () => {
  const value = await pending();
  delete value.includeBookBible;
  delete value.includeStyleGuide;
  const encoded = JSON.stringify(value);
  const legacy = readPendingReview(encoded, id(1), id(2), id(3), 2_000);
  assert.equal(legacy?.includeBookBible, true);
  assert.equal(legacy?.includeStyleGuide, true);
  assert.deepEqual(pendingReviewBody(legacy!, "Private manuscript instruction").contextPolicy,
    { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: true, maxTokens: 8192 });
  assert.equal(readPendingReview(JSON.stringify({ ...value, includeBookBible: "yes" }), id(1), id(2), id(3), 2_000), null);
});

test("non-writer retry never carries an old writer instruction", async () => {
  const value = { ...await pending(), mode: "proofreader" as const };
  assert.equal((await reviewBriefHash("proofreader", "old writer text")), (await reviewBriefHash("proofreader", "")));
  assert.equal("userInstruction" in pendingReviewBody(value, "old writer text"), false);
});

const readyQuote = () => ({ requestId: id(9), status: "ready" as const, agentType: "writer" as const, model: "approved-model",
  countedInputTokens: 420, maxOutputTokens: 1200, reservedCredits: 7, expiresAt: "2030-01-01T00:00:00Z" });

test("recovered quote validation binds original identity, task, model and positive exact prices", async () => {
  const request = { ...await pending(), modelId: "approved", model: "approved-model", quoteRequestId: id(9) };
  assert.deepEqual(verifiedReviewQuoteStatus({ quote: readyQuote() }, request), { quote: readyQuote() });
  for (const change of [{ requestId: id(8) }, { agentType: "copyeditor" }, { model: "unexpected-model" },
    { reservedCredits: 0 }, { reservedCredits: 1.2 }, { countedInputTokens: -1 }, { maxOutputTokens: null }, { expiresAt: "invalid" }, { status: "accepted" }]) {
    assert.throws(() => verifiedReviewQuoteStatus({ quote: { ...readyQuote(), ...change } }, request), /could not be verified/);
  }
  for (const value of [null, {}, { quote: null }, { quote: readyQuote(), job: {} }, { quote: readyQuote(), job: { id: id(10), status: "missing" } },
    { quote: { requestId: id(9), status: "counting" }, job: { id: id(10), status: "running" } }])
    assert.throws(() => verifiedReviewQuoteStatus(value, request), /could not be verified/);
});

test("only expired, failed or definitely refused unaccepted quotes allow a fresh request", async () => {
  const request = await pending(), status = { quote: readyQuote() }, now = Date.parse("2031-01-01T00:00:00Z");
  assert.equal(canReplaceReviewQuote(status, request, now), true);
  assert.equal(canReplaceReviewQuote(status, request, Date.parse("2029-01-01T00:00:00Z")), false);
  assert.equal(canReplaceReviewQuote(status, { ...request, acceptAttempted: true }, now), false);
  assert.equal(canReplaceReviewQuote({ ...status, job: { id: id(10), status: "queued" } }, request, now), false);
  assert.equal(canReplaceReviewQuote({ quote: { requestId: id(9), status: "failed" } }, request, now), true);
  assert.equal(canReplaceReviewQuote({ quote: { requestId: id(9), status: "counting" } }, request, now), false);
  assert.equal(canReplaceReviewQuote(status, { ...request, acceptanceRefused: true }, Date.parse("2029-01-01T00:00:00Z")), true);
  assert.equal(canReplaceReviewQuote(null, request, now), false);
});

test("acceptance attempt survives reload and malformed attempt markers fail closed", async () => {
  const request = { ...await pending(), modelId: "approved", model: "approved-model", acceptAttempted: true as const };
  assert.equal(readPendingReview(JSON.stringify(request), id(1), id(2), id(3), 2000)?.acceptAttempted, true);
  for (const change of [{ acceptAttempted: "true" }, { acceptAttempted: false }, { acceptanceRefused: true }, { model: 10 }, { modelId: 10 }])
    assert.equal(readPendingReview(JSON.stringify({ ...request, ...change }), id(1), id(2), id(3), 2000), null);
});

test("lost quote recovery reads the exact key and accepted job, never a create/count method", async () => {
  const request = { ...await pending(), modelId: "approved" }, calls: string[] = [];
  const job: AiJobWithSuggestions = { id: id(10), book_id: id(2), agent_type: "writer", status: "succeeded", model: "approved-model",
    chapter_ids: [id(3)], context_source_count: 1, usage_json: {}, error_code: null, error_message: null,
    created_at: "2026-10-23T00:00:00Z", started_at: null, completed_at: null, suggestions: [] };
  const status = { quote: readyQuote(), job: { id: job.id, status: job.status } };
  const api = {
    getAiReviewQuote: async (book: string, quote: string) => { calls.push(`id:${book}:${quote}`); return status; },
    recoverAiReviewQuote: async (book: string, key: string) => { calls.push(`key:${book}:${key}`); return status; },
    getAiJob: async (id: string) => { calls.push(`job:${id}`); return job; },
    getAiJobByRequest: async () => { throw new Error("legacy fallback must not run for a paid quote"); },
  };
  assert.equal((await recoverReviewRequest(api, request)).job?.id, id(10));
  assert.deepEqual(calls, [`key:${id(2)}:${id(4)}`, `job:${id(10)}`]);
  calls.length = 0;
  await recoverReviewRequest(api, { ...request, quoteRequestId: id(9) });
  assert.deepEqual(calls, [`id:${id(2)}:${id(9)}`, `job:${id(10)}`]);
  await assert.rejects(recoverReviewRequest({ ...api, getAiJob: async () => ({ ...job, book_id: id(7) }) }, request), /does not match/);
  await assert.rejects(recoverReviewRequest({ ...api, getAiJob: async () => ({ ...job, chapter_ids: [id(3), id(8)] }) }, request), /does not match/);
  await assert.rejects(recoverReviewRequest({ ...api, getAiJob: async () => ({ ...job, id: id(8) }) }, request), /identity does not match/);
});
