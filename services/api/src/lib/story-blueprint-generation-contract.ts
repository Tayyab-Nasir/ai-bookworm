/**
 * Server-only contract shared by the paid Story Blueprint quote route and its
 * leased worker. Keeping this tiny shape in one module prevents the quote
 * request and the paid dispatch from silently assembling different prompts.
 */
import { z } from "zod";
import { storyBlueprintChapterPlanSchema, storyBlueprintStorySchema } from "../routes/story-blueprints.js";

export const storyBlueprintGenerationContextPolicy = Object.freeze({
  includeBookBible: false,
  includeStyleGuide: false,
  includeRelatedContext: false,
  semanticTopK: 5,
  maxTokens: 16_000,
});

export const storyBlueprintSourceSnapshotSchema = z.object({
  details: storyBlueprintStorySchema,
  chapterPlan: storyBlueprintChapterPlanSchema,
}).strict();

export const storyBlueprintCandidateSchema = z.object({
  suggestionKind: z.literal("story_blueprint_candidate"),
  status: z.literal("pending"),
  story: storyBlueprintStorySchema,
  chapterPlan: storyBlueprintChapterPlanSchema.refine((items) => items.length >= 1, "At least one planned chapter is required."),
  rationale: z.string().trim().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
}).strict();
