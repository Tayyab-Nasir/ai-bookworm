import type { BookNode } from "@bookworm/book-model";
import type { AiSuggestion } from "@bookworm/types";

export type SavedChapterPreview = { chapterId: string; version: number; nodes: BookNode[] };
export type SuggestionPreview =
  | { state: "ready"; from: number; to: number; prefix: string; original: string; replacement: string; suffix: string; leading: boolean; trailing: boolean }
  | { state: "stale" | "unavailable"; message: string };

/** Preview the exact UTF-16 slice that the canonical replace_text engine will replace. */
export function previewAiSuggestion(suggestion: AiSuggestion, saved: SavedChapterPreview | null): SuggestionPreview {
  if (!saved) return { state: "unavailable", message: "Load the saved chapter to inspect this edit before applying it." };
  const raw = suggestion.operation_json;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "unavailable", message: "This edit cannot be previewed as a text replacement. Do not apply it here." };
  }
  const operation = raw as Record<string, unknown>;
  const target = operation.target && typeof operation.target === "object" && !Array.isArray(operation.target)
    ? operation.target as Record<string, unknown> : null;
  const payload = operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload)
    ? operation.payload as Record<string, unknown> : null;
  if (operation.type !== "replace_text" || !target || !payload || typeof payload.nodeId !== "string"
      || typeof payload.text !== "string" || !Number.isInteger(payload.from) || !Number.isInteger(payload.to)
      || !Number.isInteger(operation.expectedVersion)) {
    return { state: "unavailable", message: "This edit cannot be previewed as a text replacement. Do not apply it here." };
  }
  const from = payload.from as number;
  const to = payload.to as number;
  if (target.chapterId !== saved.chapterId || suggestion.entity_id !== saved.chapterId
      || target.nodeId !== payload.nodeId) {
    return { state: "unavailable", message: "This edit does not target the open chapter. Open its original chapter to review it." };
  }
  if (operation.expectedVersion !== saved.version) {
    return { state: "stale", message: "The chapter has a newer saved version than this AI review. Run a new review before applying edits." };
  }
  const node = saved.nodes.find((item) => item.id === payload.nodeId);
  if (!node || typeof node.text !== "string" || from < 0 || to < 0 || from > to || to > node.text.length) {
    return { state: "stale", message: "The source text or edit range is no longer available in the saved chapter. Run a new review." };
  }
  const original = node.text.slice(from, to);
  if (original === payload.text) {
    return { state: "unavailable", message: "This proposal does not change the saved text. There is nothing to apply." };
  }
  const start = Math.max(0, from - 72);
  const end = Math.min(node.text.length, to + 72);
  return {
    state: "ready", from, to,
    prefix: node.text.slice(start, from), original,
    replacement: payload.text, suffix: node.text.slice(to, end),
    leading: start > 0, trailing: end < node.text.length,
  };
}
