import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyStoryBlueprint, moveStoryBlueprintPlanItem, newStoryBlueprintPlanItem, storyBlueprintMaterializationKey } from "../components/StoryBlueprintClient";

test("story blueprint defaults keep every author-facing field explicit", () => {
  assert.deepEqual(emptyStoryBlueprint(), {
    workingTitle: "", premise: "", readerPromise: "", genre: "", tone: "", pointOfView: "", tense: "",
    targetWordCount: null, synopsis: "", theme: "", notes: "",
  });
});

test("chapter plan IDs survive edits and reordering", () => {
  const first = newStoryBlueprintPlanItem("11111111-1111-4111-8111-111111111111", 1);
  const second = newStoryBlueprintPlanItem("22222222-2222-4222-8222-222222222222", 2);
  const moved = moveStoryBlueprintPlanItem([{ ...first, title: "Opening" }, second], second.id, -1);
  assert.deepEqual(moved.map((item) => item.id), [second.id, first.id]);
  assert.equal(moved[1].title, "Opening");
  assert.equal(moveStoryBlueprintPlanItem(moved, second.id, -1), moved, "an out-of-range move leaves the same plan intact");
});

test("materialization retry identity is stable and contains no author text", () => {
  const bookId = "11111111-1111-4111-8111-111111111111";
  const planItemId = "22222222-2222-4222-8222-222222222222";
  const key = storyBlueprintMaterializationKey(bookId, planItemId);
  assert.equal(key, storyBlueprintMaterializationKey(bookId, planItemId));
  assert.match(key, /^story-blueprint:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222$/);
  assert.doesNotMatch(key, /opening|premise|summary|credit|ai/i);
});
