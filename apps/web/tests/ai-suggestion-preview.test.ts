import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiSuggestion } from "@bookworm/types";
import { previewAiSuggestion } from "../lib/ai-suggestion-preview";

const chapter = "11111111-1111-4111-8111-111111111111";
const saved = { chapterId: chapter, version: 3, nodes: [{ id: "n1", type: "paragraph" as const, text: "The old moon rose over the harbor." }] };
const suggestion = (change: Record<string, unknown> = {}) => ({
  id: "suggestion-1", ai_job_id: "job-1", entity_type: "chapter", entity_id: chapter,
  rationale: "Clearer wording", confidence: 0.9, status: "pending", created_at: "2026-09-24T00:00:00.000Z", reviewed_by: null, reviewed_at: null,
  operation_json: {
    operationId: "op-1", type: "replace_text", target: { chapterId: chapter, nodeId: "n1" },
    payload: { nodeId: "n1", from: 4, to: 7, text: "silver" }, expectedVersion: 3,
    ...change,
  },
} as AiSuggestion);

test("AI proof sheet shows exact saved source and proposed replacement", () => {
  const preview = previewAiSuggestion(suggestion(), saved);
  assert.equal(preview.state, "ready");
  if (preview.state !== "ready") return;
  assert.equal(preview.prefix, "The ");
  assert.equal(preview.original, "old");
  assert.equal(preview.replacement, "silver");
  assert.equal(preview.suffix, " moon rose over the harbor.");
  assert.equal(preview.from, 4);
  assert.equal(preview.to, 7);
});

test("AI proof sheet refuses a stale version, another chapter and invalid source range", () => {
  assert.equal(previewAiSuggestion(suggestion(), { ...saved, version: 4 }).state, "stale");
  assert.equal(previewAiSuggestion(suggestion(), { ...saved, chapterId: "different" }).state, "unavailable");
  assert.equal(previewAiSuggestion(suggestion({ payload: { nodeId: "n1", from: 4, to: 900, text: "silver" } }), saved).state, "stale");
  assert.equal(previewAiSuggestion(suggestion(), null).state, "unavailable");
});

test("AI proof sheet distinguishes insertion and deletion and rejects a no-op", () => {
  const insert = previewAiSuggestion(suggestion({ payload: { nodeId: "n1", from: 4, to: 4, text: "bright " } }), saved);
  assert.equal(insert.state, "ready");
  if (insert.state === "ready") assert.equal(insert.original, "");
  const remove = previewAiSuggestion(suggestion({ payload: { nodeId: "n1", from: 4, to: 7, text: "" } }), saved);
  assert.equal(remove.state, "ready");
  if (remove.state === "ready") assert.equal(remove.replacement, "");
  assert.equal(previewAiSuggestion(suggestion({ payload: { nodeId: "n1", from: 4, to: 7, text: "old" } }), saved).state, "unavailable");
});
