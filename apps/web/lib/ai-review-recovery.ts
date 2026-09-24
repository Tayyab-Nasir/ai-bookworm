import type { AiJobReview, CreateAiJobRequest } from "@bookworm/api-client";

export type ReviewMode = CreateAiJobRequest["agentType"];
export type PendingReview = {
  schema: 1;
  userId: string;
  bookId: string;
  chapterId: string;
  key: string;
  mode: ReviewMode;
  includeRelated: boolean;
  contextBudget: 4096 | 8192 | 16000;
  briefHash: string;
  savedAt: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modes = new Set<ReviewMode>(["writer", "proofreader", "copyeditor", "consistency"]);

export function reviewTargetsChapter(review: Pick<AiJobReview, "chapter_ids">, chapterId: string | null) {
  return chapterId != null && review.chapter_ids.includes(chapterId);
}

export function reviewRecoveryKey(userId: string, bookId: string, chapterId: string) {
  return `bookworm:ai-review:${userId}:${bookId}:${chapterId}`;
}

export function readPendingReview(raw: string | null, userId: string, bookId: string, chapterId: string, now = Date.now()): PendingReview | null {
  if (!raw || raw.length > 2_000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PendingReview>;
  if (item.schema !== 1 || item.userId !== userId || item.bookId !== bookId || item.chapterId !== chapterId
      || !uuid.test(item.key ?? "") || !modes.has(item.mode as ReviewMode)
      || typeof item.includeRelated !== "boolean" || ![4096, 8192, 16000].includes(item.contextBudget ?? 0)
      || !/^[0-9a-f]{64}$/.test(item.briefHash ?? "") || !Number.isFinite(item.savedAt)
      || (item.savedAt ?? 0) > now || now - (item.savedAt ?? 0) > 7 * 24 * 60 * 60 * 1000) return null;
  return item as PendingReview;
}

export async function reviewBriefHash(mode: ReviewMode, instruction: string) {
  const text = mode === "writer" ? instruction.trim() : "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function pendingReviewBody(pending: PendingReview, instruction: string): CreateAiJobRequest {
  return {
    bookId: pending.bookId, chapterIds: [pending.chapterId], agentType: pending.mode,
    ...(pending.mode === "writer" ? { userInstruction: instruction.trim() } : {}),
    idempotencyKey: pending.key,
    contextPolicy: { includeBookBible: true, includeStyleGuide: true,
      includeRelatedContext: pending.includeRelated, maxTokens: pending.contextBudget },
  };
}
