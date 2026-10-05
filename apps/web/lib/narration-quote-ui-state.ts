import type { NarrationChapterQuote, NarrationChapterAcceptance } from "@bookworm/api-client";
import { readImageQuotePointer, type ImageQuotePointer } from "./image-quote-ui-state";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, any>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => key in value);
const credit = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) && BigInt(value) <= 2_147_483_647n;

/** Public projection only. Never retain a malformed, foreign or mismatched aggregate. */
export function assertNarrationChapterQuote(value: unknown, scope: { bookId: string; editionId: string }): NarrationChapterQuote {
  const invalid = () => { throw new Error("The saved chapter offer could not be verified. Keep the original request key and recover again."); };
  if (!record(value) || !keys(value, ["quoteId", "purchaseAvailable", "pricingBasis", "modelId", "model", "voice", "speed", "source",
    "segmentCount", "segments", "reservedCredits", "priceVersion", "policyVersion", "expiresAt", "expired"])) return invalid();
  if (!uuid.test(value.quoteId) || typeof value.purchaseAvailable !== "boolean" || value.pricingBasis !== "maximum_token_budget"
    || typeof value.modelId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.modelId)
    || !["gpt-realtime-2.1-mini", "gpt-realtime-2.1"].includes(value.model)
    || !["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"].includes(value.voice)
    || typeof value.speed !== "number" || value.speed < 0.25 || value.speed > 1.5 || !/^\d+(?:\.\d{1,2})?$/.test(String(value.speed))
    || !credit(value.reservedCredits) || typeof value.expired !== "boolean" || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return invalid();
  for (const version of [value.priceVersion, value.policyVersion]) if (typeof version !== "string" || !version.trim() || version.length > 128) return invalid();
  if (!record(value.source) || !keys(value.source, ["bookId", "editionId", "chapterId", "documentVersionId"])
    || !Object.values(value.source).every(id => typeof id === "string" && uuid.test(id))
    || value.source.bookId !== scope.bookId || value.source.editionId !== scope.editionId) return invalid();
  if (!Number.isInteger(value.segmentCount) || value.segmentCount < 1 || value.segmentCount > 250
    || !Array.isArray(value.segments) || value.segments.length !== value.segmentCount) return invalid();
  let end = 0, total = 0n;
  const identities = new Set<string>();
  for (const [index, part] of value.segments.entries()) {
    if (!record(part) || !keys(part, ["quoteId", "segmentIndex", "textStart", "textEnd", "reservedCredits"])
      || typeof part.quoteId !== "string" || !uuid.test(part.quoteId) || identities.has(part.quoteId) || part.segmentIndex !== index
      || !Number.isInteger(part.textStart) || !Number.isInteger(part.textEnd) || part.textStart < end || part.textStart < 0
      || part.textEnd <= part.textStart || part.textEnd > 1_000_000 || part.textEnd - part.textStart > 4_096 || !credit(part.reservedCredits)) return invalid();
    identities.add(part.quoteId); end = part.textEnd; total += BigInt(part.reservedCredits);
  }
  if (total !== BigInt(value.reservedCredits)) return invalid();
  return value as NarrationChapterQuote;
}

/** Read-only server confirmation; an unknown response never means unpurchased. */
export function assertNarrationChapterAcceptance(value: unknown, quote: Pick<NarrationChapterQuote, "quoteId" | "reservedCredits">): NarrationChapterAcceptance {
  const invalid = () => { throw new Error("Chapter acceptance is unconfirmed. Recover the same quote before any new purchase."); };
  if (!record(value) || !keys(value, ["quoteId", "accepted", "project"]) || value.quoteId !== quote.quoteId
    || !uuid.test(value.quoteId) || typeof value.accepted !== "boolean") return invalid();
  if (!value.accepted) { if (value.project !== null) return invalid(); }
  else {
    const project = value.project;
    if (!record(project) || !keys(project, ["id", "billingMode", "status", "reservedCredits"]) || !uuid.test(project.id)
      || project.billingMode !== "quoted" || !["queued", "running", "succeeded", "failed"].includes(project.status)
      || !credit(project.reservedCredits) || project.reservedCredits !== quote.reservedCredits) return invalid();
  }
  return value as NarrationChapterAcceptance;
}

export type NarrationQuotePointer = ImageQuotePointer & { purchaseAttempted?: true };
/** Opaque recovery identity only; preserve ambiguous purchase attempts across reloads. */
export function readNarrationQuotePointer(raw: string | null): NarrationQuotePointer | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!record(value) || Object.keys(value).some(key => !["quoteId", "idempotencyKey", "purchaseAttempted"].includes(key))
      || (value.purchaseAttempted !== undefined && (value.purchaseAttempted !== true || !value.quoteId))) return null;
    const identity = readImageQuotePointer(raw);
    return identity ? { ...identity, ...(value.purchaseAttempted === true ? { purchaseAttempted: true as const } : {}) } : null;
  } catch { return null; }
}

export function narrationQuoteStorageKey(userId: string, workspaceId: string, bookId: string, editionId: string) {
  if (![userId, workspaceId, bookId, editionId].every(id => uuid.test(id))) throw new Error("Sign in and save an audiobook edition before preparing a quote.");
  return `bookworm.narration-chapter-quote.v1:${userId}:${workspaceId}:${bookId}:${editionId}`;
}
