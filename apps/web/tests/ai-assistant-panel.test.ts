import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewTargetsChapter } from "../components/AiAssistantPanel";

test("saved AI reviews only reopen for the selected chapter", () => {
  const review = { chapter_ids: ["chapter-a"] };
  assert.equal(reviewTargetsChapter(review, "chapter-a"), true);
  assert.equal(reviewTargetsChapter(review, "chapter-b"), false);
  assert.equal(reviewTargetsChapter(review, null), false);
});
