import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingReviewBody, readPendingReview, reviewBriefHash, reviewRecoveryKey, type PendingReview } from "../lib/ai-review-recovery";

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const pending = async (): Promise<PendingReview> => ({
  schema: 1, userId: id(1), bookId: id(2), chapterId: id(3), key: id(4),
  mode: "writer", includeRelated: true, contextBudget: 8192,
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

test("non-writer retry never carries an old writer instruction", async () => {
  const value = { ...await pending(), mode: "proofreader" as const };
  assert.equal((await reviewBriefHash("proofreader", "old writer text")), (await reviewBriefHash("proofreader", "")));
  assert.equal("userInstruction" in pendingReviewBody(value, "old writer text"), false);
});
