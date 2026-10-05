import type { AiJobReview, AiReviewUsageQuote, CreateAiJobRequest } from "@bookworm/api-client";

export type ReviewMode = CreateAiJobRequest["agentType"];
export type PendingReview = {
  schema: 1;
  userId: string;
  bookId: string;
  chapterId: string;
  key: string;
  modelId?: string;
  allowProviderTokenCounting?: true;
  quoteRequestId?: string;
  mode: ReviewMode;
  includeRelated: boolean;
  includeBookBible?: boolean;
  includeStyleGuide?: boolean;
  contextBudget: 4096 | 8192 | 16000;
  briefHash: string;
  savedAt: number;
};

export function canAcceptReviewQuote(quote: AiReviewUsageQuote | null, state: {
  pending: Pick<PendingReview, "bookId" | "chapterId" | "quoteRequestId"> | null; bookId: string; chapterId: string | null;
  editable: boolean; dirty: boolean; recoveryReady: boolean; busy: boolean; acceptanceUncertain: boolean;
}, now = Date.now()): boolean {
  return Boolean(quote?.status === "ready" && state.pending && state.editable && !state.dirty && state.recoveryReady && !state.busy && !state.acceptanceUncertain
    && state.pending.bookId === state.bookId && state.pending.chapterId === state.chapterId && state.pending.quoteRequestId === quote.requestId
    && Date.parse(quote.expiresAt) > now && Number.isSafeInteger(quote.reservedCredits) && quote.reservedCredits > 0);
}

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
      || (item.modelId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.modelId))
      || (item.allowProviderTokenCounting !== undefined && item.allowProviderTokenCounting !== true)
      || (item.quoteRequestId !== undefined && !uuid.test(item.quoteRequestId))
      || typeof item.includeRelated !== "boolean"
      || (item.includeBookBible !== undefined && typeof item.includeBookBible !== "boolean")
      || (item.includeStyleGuide !== undefined && typeof item.includeStyleGuide !== "boolean")
      || ![4096, 8192, 16000].includes(item.contextBudget ?? 0)
      || !/^[0-9a-f]{64}$/.test(item.briefHash ?? "") || !Number.isFinite(item.savedAt)
      || (item.savedAt ?? 0) > now || now - (item.savedAt ?? 0) > 7 * 24 * 60 * 60 * 1000) return null;
  return { ...item, includeBookBible: item.includeBookBible ?? true, includeStyleGuide: item.includeStyleGuide ?? true } as PendingReview;
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
    contextPolicy: { includeBookBible: pending.includeBookBible ?? true, includeStyleGuide: pending.includeStyleGuide ?? true,
      includeRelatedContext: pending.includeRelated, maxTokens: pending.contextBudget },
  };
}
