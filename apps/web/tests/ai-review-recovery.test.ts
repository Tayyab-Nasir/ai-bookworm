import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingReviewBody, readPendingReview, reviewBriefHash, reviewRecoveryKey, type PendingReview } from "../lib/ai-review-recovery";

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
