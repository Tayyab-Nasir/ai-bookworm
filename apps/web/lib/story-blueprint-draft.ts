import type { StoryBlueprint } from "@bookworm/api-client";

export const STORY_BLUEPRINT_WRITER_BRIEF_LIMIT = 4_000;

export type StoryBlueprintWriterBrief =
  | { ok: true; instruction: string }
  | { ok: false; reason: string };

/**
 * Build a writer brief only from a saved plan item that is explicitly linked
 * to the selected manuscript chapter. The browser route carries IDs, never
 * the author's story text.
 */
export function storyBlueprintWriterBrief(
  blueprint: StoryBlueprint | null,
  planItemId: string,
  chapterId: string,
): StoryBlueprintWriterBrief {
  if (!blueprint) return { ok: false, reason: "No saved story blueprint is available. Nothing was sent or generated." };

  const planItem = blueprint.chapterPlan.find((item) => item.id === planItemId);
  if (!planItem) return { ok: false, reason: "This chapter plan item is no longer in the saved blueprint. Reload the plan before drafting." };

  const materialization = blueprint.materializations.find((entry) => entry.planItemId === planItemId);
  if (materialization?.chapterId !== chapterId) {
    return { ok: false, reason: "This saved plan is not linked to the selected manuscript chapter. No AI request was sent." };
  }

  const storyContext = [
    blueprint.story.workingTitle && `Working title: ${blueprint.story.workingTitle.trim()}`,
    blueprint.story.genre && `Genre: ${blueprint.story.genre.trim()}`,
    blueprint.story.tone && `Tone: ${blueprint.story.tone.trim()}`,
    blueprint.story.pointOfView && `Point of view: ${blueprint.story.pointOfView.trim()}`,
    blueprint.story.tense && `Tense: ${blueprint.story.tense.trim()}`,
    blueprint.story.premise && `Premise: ${blueprint.story.premise.trim()}`,
    blueprint.story.readerPromise && `Reader promise: ${blueprint.story.readerPromise.trim()}`,
    blueprint.story.theme && `Theme: ${blueprint.story.theme.trim()}`,
  ].filter(Boolean);

  const instruction = [
    "Draft only this planned chapter as a reviewable proposal. Preserve established Book Bible facts and relevant earlier manuscript continuity. Do not apply edits or change any other chapter.",
    storyContext.length ? `Saved story direction:\n${storyContext.join("\n")}` : "",
    `Planned chapter: ${planItem.title.trim()}`,
    planItem.purpose.trim() ? `Purpose: ${planItem.purpose.trim()}` : "",
    planItem.summary.trim() ? `Planned scenes and turns:\n${planItem.summary.trim()}` : "",
    planItem.targetWords ? `Planning target: about ${planItem.targetWords.toLocaleString()} words. A single proposal may be shorter; continue in reviewable sections when needed.` : "",
  ].filter(Boolean).join("\n\n");

  if (instruction.length > STORY_BLUEPRINT_WRITER_BRIEF_LIMIT) {
    return {
      ok: false,
      reason: "The saved story direction and chapter plan exceed the 4,000-character writer brief limit. Condense the saved plan or compose a shorter drafting brief; no AI request was sent.",
    };
  }

  return { ok: true, instruction };
}
