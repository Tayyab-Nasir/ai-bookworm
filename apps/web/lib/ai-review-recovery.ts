import type { AiJobReview, AiJobWithSuggestions, AiReviewUsageQuote, CreateAiJobRequest, createClient } from "@bookworm/api-client";

export type ReviewMode = CreateAiJobRequest["agentType"];
export type PendingReview = {
  schema: 1;
  userId: string;
  bookId: string;
  chapterId: string;
  key: string;
  modelId?: string;
  model?: string;
  allowProviderTokenCounting?: true;
  quoteRequestId?: string;
  acceptAttempted?: true;
  acceptanceRefused?: true;
  mode: ReviewMode;
  includeRelated: boolean;
  includeBookBible?: boolean;
  includeStyleGuide?: boolean;
  contextBudget: 4096 | 8192 | 16000;
  briefHash: string;
  savedAt: number;
};

export function canAcceptReviewQuote(quote: AiReviewUsageQuote | null, state: {
  pending: Pick<PendingReview, "bookId" | "chapterId" | "quoteRequestId" | "acceptanceRefused"> | null; bookId: string; chapterId: string | null;
  editable: boolean; dirty: boolean; recoveryReady: boolean; busy: boolean; acceptanceUncertain: boolean;
}, now = Date.now()): boolean {
  return Boolean(quote?.status === "ready" && state.pending && !state.pending.acceptanceRefused && state.editable && !state.dirty && state.recoveryReady && !state.busy && !state.acceptanceUncertain
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
      || (item.modelId !== undefined && (typeof item.modelId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.modelId)))
      || (item.model !== undefined && (typeof item.model !== "string" || !item.model || item.model.length > 200))
      || (item.allowProviderTokenCounting !== undefined && item.allowProviderTokenCounting !== true)
      || (item.acceptAttempted !== undefined && item.acceptAttempted !== true)
      || (item.acceptanceRefused !== undefined && item.acceptanceRefused !== true)
      || (item.acceptanceRefused === true && item.acceptAttempted === true)
      || (item.quoteRequestId !== undefined && !uuid.test(item.quoteRequestId))
      || typeof item.includeRelated !== "boolean"
      || (item.includeBookBible !== undefined && typeof item.includeBookBible !== "boolean")
      || (item.includeStyleGuide !== undefined && typeof item.includeStyleGuide !== "boolean")
      || ![4096, 8192, 16000].includes(item.contextBudget ?? 0)
      || !/^[0-9a-f]{64}$/.test(item.briefHash ?? "") || !Number.isFinite(item.savedAt)
      || (item.savedAt ?? 0) > now || now - (item.savedAt ?? 0) > 7 * 24 * 60 * 60 * 1000) return null;
  return { ...item, includeBookBible: item.includeBookBible ?? true, includeStyleGuide: item.includeStyleGuide ?? true } as PendingReview;
}

type ReviewApi = Pick<ReturnType<typeof createClient>, "getAiReviewQuote" | "recoverAiReviewQuote" | "getAiJob" | "getAiJobByRequest">;
export type ReviewQuoteStatus = Awaited<ReturnType<ReviewApi["getAiReviewQuote"]>>;
const jobStates = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

/** Validate paid offers before either approval or abandoning their recovery identity. */
export function verifiedReviewQuoteStatus(value: unknown, pending: PendingReview): ReviewQuoteStatus {
  const invalid = () => new Error("The saved quote response could not be verified. Keep the original request and recover its status.");
  if (!value || typeof value !== "object") throw invalid();
  const { quote, job } = value as ReviewQuoteStatus;
  if (!quote || !uuid.test(quote.requestId) || !["ready", "counting", "failed"].includes(quote.status)
      || (pending.quoteRequestId && quote.requestId !== pending.quoteRequestId)) throw invalid();
  if (quote.status === "ready" && (quote.agentType !== pending.mode || typeof quote.model !== "string" || !quote.model
      || (pending.model && quote.model !== pending.model)
      || ![quote.reservedCredits, quote.countedInputTokens, quote.maxOutputTokens].every(n => Number.isSafeInteger(n) && n > 0)
      || typeof quote.expiresAt !== "string" || !Number.isFinite(Date.parse(quote.expiresAt)))) throw invalid();
  if (job != null && (quote.status !== "ready" || !uuid.test(job.id) || !jobStates.has(job.status))) throw invalid();
  return { quote, ...(job ? { job } : {}) };
}

export function canReplaceReviewQuote(status: ReviewQuoteStatus | null, pending: PendingReview | null, now = Date.now()): boolean {
  return Boolean(status && pending && !status.job && !pending.acceptAttempted
    && (pending.acceptanceRefused || status.quote.status === "failed"
      || status.quote.status === "ready" && Date.parse(status.quote.expiresAt) <= now));
}

/** Recovery never posts, counts tokens, needs the private brief, or needs a live model catalog. */
export async function recoverReviewRequest(api: ReviewApi, pending: PendingReview): Promise<{ status: ReviewQuoteStatus | null; job: AiJobWithSuggestions | null }> {
  let status: ReviewQuoteStatus | null = null;
  let job: AiJobWithSuggestions | null;
  if (pending.modelId || pending.quoteRequestId) {
    status = verifiedReviewQuoteStatus(pending.quoteRequestId
      ? await api.getAiReviewQuote(pending.bookId, pending.quoteRequestId)
      : await api.recoverAiReviewQuote(pending.bookId, pending.key), pending);
    job = status.job ? await api.getAiJob(status.job.id) : null;
    if (job && job.id !== status.job!.id) throw new Error("The recovered review identity does not match the saved quote.");
  } else job = await api.getAiJobByRequest(pending.bookId, pending.key);
  if (job && (job.book_id !== pending.bookId || job.agent_type !== pending.mode || !Array.isArray(job.chapter_ids)
      || job.chapter_ids.length !== 1 || !reviewTargetsChapter(job, pending.chapterId)
      || !jobStates.has(job.status) || !Array.isArray(job.suggestions))) {
    throw new Error("The recovered AI review does not match this book, chapter and task. No new request was sent.");
  }
  return { status, job };
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
