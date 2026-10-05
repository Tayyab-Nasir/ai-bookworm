import type { ImageQuote, ImageQuoteJob } from "@bookworm/api-client";

export type ImageQuoteFormLockState = {
  canEdit: boolean;
  busy: boolean;
  hasRequestKey: boolean;
  hasSavedQuote: boolean;
};

/** Keep the visible brief/settings aligned with the immutable quote or retry key. */
export function isImageQuoteFormLocked(state: ImageQuoteFormLockState): boolean {
  return !state.canEdit || state.busy || state.hasRequestKey || state.hasSavedQuote;
}

export type ImageQuotePointer = { quoteId?: string; idempotencyKey?: string };
export type SavedImageQuote = { quoteId: string; quote: ImageQuote; job: ImageQuoteJob | null };

/** Recovery storage deliberately excludes prompts and private source context. */
export function readImageQuotePointer(raw: string | null): ImageQuotePointer | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.quoteId !== undefined && (typeof value.quoteId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.quoteId))) return null;
    if (value.idempotencyKey !== undefined && (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length < 8 || value.idempotencyKey.length > 200)) return null;
    if (!value.quoteId && !value.idempotencyKey) return null;
    return { ...(value.quoteId ? { quoteId: value.quoteId } : {}), ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {}) };
  } catch { return null; }
}

/** Only authoritative reads may resolve an interrupted quote or acceptance. */
export async function recoverSavedImageQuote(api: {
  recoverImageQuote: (workspaceId: string, key: string) => Promise<{ quoteId: string }>;
  getImageQuote: (workspaceId: string, quoteId: string) => Promise<{ quote: ImageQuote }>;
  getImageQuoteJob: (workspaceId: string, quoteId: string) => Promise<{ quoteId: string; job: ImageQuoteJob | null }>;
}, workspaceId: string, pointer: ImageQuotePointer): Promise<SavedImageQuote> {
  const quoteId = pointer.quoteId ?? (pointer.idempotencyKey ? (await api.recoverImageQuote(workspaceId, pointer.idempotencyKey)).quoteId : null);
  if (!quoteId) throw new Error("The original image quote identity is required for recovery.");
  const [offer, accepted] = await Promise.all([api.getImageQuote(workspaceId, quoteId), api.getImageQuoteJob(workspaceId, quoteId)]);
  if (offer.quote.id !== quoteId || accepted.quoteId !== quoteId) throw new Error("The saved image quote identity could not be verified.");
  return { quoteId, quote: offer.quote, job: accepted.job };
}

export function canAcceptImageQuote(state: {
  canEdit: boolean; busy: boolean; purchaseAvailable: boolean; generateConsent: boolean; acceptanceUncertain: boolean;
  quote: ImageQuote | null; hasJob: boolean;
}, now = Date.now()): boolean {
  return state.canEdit && !state.busy && state.purchaseAvailable && state.generateConsent && !state.acceptanceUncertain
    && state.quote?.status === "ready" && !state.hasJob && Date.parse(state.quote.expiresAt) > now
    && Number.isSafeInteger(Number(state.quote.reservedCredits)) && Number(state.quote.reservedCredits) > 0;
}
