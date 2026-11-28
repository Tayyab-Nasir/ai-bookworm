import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyStoryBlueprint, moveStoryBlueprintPlanItem, newStoryBlueprintPlanItem, storyBlueprintMaterializationKey } from "../components/StoryBlueprintClient";
import { storyBlueprintWriterBrief } from "../lib/story-blueprint-draft";
import type { StoryBlueprint } from "@bookworm/api-client";

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

function savedBlueprint(): StoryBlueprint {
  const item = newStoryBlueprintPlanItem("22222222-2222-4222-8222-222222222222", 1);
  return {
    revision: 2,
    story: { ...emptyStoryBlueprint(), workingTitle: "A Lantern in Winter", genre: "literary mystery", premise: "A cartographer finds a map that changes overnight." },
    chapterPlan: [{ ...item, title: "The folded map", purpose: "Introduce Mara's doubt.", summary: "At the station, Mara discovers a route to a street that no longer exists.", targetWords: 1800 }],
    materializations: [{ planItemId: item.id, chapterId: "33333333-3333-4333-8333-333333333333" }],
  };
}

test("a materialized story plan becomes a bounded writer brief without exposing private planning notes", () => {
  const blueprint = savedBlueprint();
  blueprint.story.notes = "PRIVATE RESEARCH NOTES";
  const result = storyBlueprintWriterBrief(blueprint, blueprint.chapterPlan[0].id, blueprint.materializations[0].chapterId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.instruction, /A Lantern in Winter/);
  assert.match(result.instruction, /The folded map/);
  assert.match(result.instruction, /route to a street that no longer exists/);
  assert.match(result.instruction, /1,?800 words/);
  assert.doesNotMatch(result.instruction, /PRIVATE RESEARCH NOTES/);
  assert.ok(result.instruction.length <= 4_000);
});

test("a blueprint cannot draft a chapter until the saved plan item is linked to that exact chapter", () => {
  const blueprint = savedBlueprint();
  const itemId = blueprint.chapterPlan[0].id;
  assert.equal(storyBlueprintWriterBrief(blueprint, itemId, "44444444-4444-4444-8444-444444444444").ok, false);
  blueprint.materializations = [];
  assert.equal(storyBlueprintWriterBrief(blueprint, itemId, "33333333-3333-4333-8333-333333333333").ok, false);
});

test("oversized saved plans are rejected rather than silently truncated", () => {
  const blueprint = savedBlueprint();
  blueprint.chapterPlan[0].summary = "x".repeat(4_001);
  const result = storyBlueprintWriterBrief(blueprint, blueprint.chapterPlan[0].id, blueprint.materializations[0].chapterId);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /4,000-character/);
});
