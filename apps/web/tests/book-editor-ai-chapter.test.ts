import assert from "node:assert/strict";
import { test } from "node:test";
import { chapterDraftIdempotencyKey } from "../lib/ai-draft-request";

test("new chapter drafts use a stable pointer-only idempotency key", () => {
  const bookId = "11111111-1111-4111-8111-111111111111";
  const chapterId = "22222222-2222-4222-8222-222222222222";
  const key = chapterDraftIdempotencyKey(bookId, chapterId);
  assert.equal(key, chapterDraftIdempotencyKey(bookId, chapterId));
  assert.match(key, /^chapter-draft:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222$/);
  assert.doesNotMatch(key, /story|brief|prompt/i);
});
