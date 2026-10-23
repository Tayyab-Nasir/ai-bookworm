import type { AiJobWithSuggestions, createClient } from "@bookworm/api-client";
import { reviewTargetsChapter } from "./ai-review-recovery";

export type SuggestionDecision = {
  schema: 1; userId: string; bookId: string; chapterId: string; jobId: string;
  suggestionId: string; action: "apply" | "reject"; expectedVersion: number;
};

export const suggestionDecisionKey = (userId: string, bookId: string, chapterId: string) =>
  `bookworm:ai-decision:${userId}:${bookId}:${chapterId}`;

/** Store identities only. An unresolved manuscript decision has no age-based discard. */
export function readSuggestionDecision(raw: string | null, userId: string, bookId: string, chapterId: string): SuggestionDecision | null {
  if (!raw || raw.length > 2000) return null;
  let item: SuggestionDecision;
  try { item = JSON.parse(raw); } catch { return null; }
  if (!item || item.schema !== 1 || item.userId !== userId || item.bookId !== bookId || item.chapterId !== chapterId
    || ![item.userId, item.bookId, item.chapterId, item.jobId, item.suggestionId].every(id => typeof id === "string" && /^[a-z0-9_-]{1,200}$/i.test(id))
    || !["apply", "reject"].includes(item.action) || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0 || item.expectedVersion > 2_147_483_647) return null;
  return { schema: 1, userId, bookId, chapterId, jobId: item.jobId, suggestionId: item.suggestionId,
    action: item.action, expectedVersion: item.expectedVersion };
}

type ReviewApi = Pick<ReturnType<typeof createClient>, "getAiJob" | "getChapterSaveStatus" | "getChapterDocument">;
export type RecoveredDecision = { job: AiJobWithSuggestions; status: "pending" | "accepted" | "rejected" | "stale"; version: number | null };

/** All recovery is read-only. A pending read never authorizes the opposite action. */
export async function recoverSuggestionDecision(api: ReviewApi, decision: SuggestionDecision): Promise<RecoveredDecision> {
  const inspect = (job: AiJobWithSuggestions) => {
    if (!job || job.id !== decision.jobId || job.book_id !== decision.bookId || !Array.isArray(job.chapter_ids)
      || !reviewTargetsChapter(job, decision.chapterId) || !Array.isArray(job.suggestions)) throw new Error("The saved review does not match this book and chapter.");
    const suggestion = job.suggestions.find(item => item.id === decision.suggestionId);
    const operation = suggestion?.operation_json;
    if (!suggestion || suggestion.ai_job_id !== job.id || suggestion.entity_type !== "chapter" || suggestion.entity_id !== decision.chapterId
      || !operation || typeof operation !== "object" || Array.isArray(operation) || operation.expectedVersion !== decision.expectedVersion
      || !["pending", "accepted", "rejected"].includes(suggestion.status)) throw new Error("The saved suggestion does not match the original decision.");
    return suggestion;
  };
  let job = await api.getAiJob(decision.jobId), suggestion = inspect(job);
  if (suggestion.status === "pending" && decision.action === "apply") {
    const current = await api.getChapterDocument(decision.chapterId);
    if (current.document?.chapterId !== decision.chapterId || !Number.isSafeInteger(current.document.version)
      || current.document.version < decision.expectedVersion) throw new Error("The saved chapter version could not be verified.");
    if (current.document.version > decision.expectedVersion) {
      // append_chapter_version checks the current version under its chapter lock.
      // A newer committed version fences any still-running original Apply.
      job = await api.getAiJob(decision.jobId); suggestion = inspect(job);
      if (suggestion.status === "pending") return { job, status: "stale", version: current.document.version };
    }
  }
  if (suggestion.status === "pending" || suggestion.status === "rejected") return { job, status: suggestion.status, version: null };
  const operationId = `ai-suggestion:${decision.suggestionId}`;
  const saved = await api.getChapterSaveStatus(decision.chapterId, operationId);
  if (saved.operationId !== operationId) throw new Error("The saved manuscript receipt does not match this suggestion.");
  if (saved.status === "not_found" && suggestion.reviewed_by && suggestion.reviewed_by !== decision.userId)
    return { job, status: "accepted", version: null };
  if (saved.status !== "saved" || !saved.versionId || saved.document?.chapterId !== decision.chapterId
    || saved.document.version !== decision.expectedVersion + 1 || !Array.isArray(saved.document.nodes))
    throw new Error("The accepted suggestion's manuscript receipt is unavailable. Keep the original decision and check again.");
  return { job, status: "accepted", version: saved.document.version };
}
