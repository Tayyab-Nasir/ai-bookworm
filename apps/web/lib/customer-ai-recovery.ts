import { customerUuid, type CustomerAiReceipt, type CustomerAiSaved } from "@bookworm/api-client/customer-ai";

const receiptScalars = ["operationId", "workspaceId", "bookId", "connectionId", "credentialRevision", "policyId",
  "provider", "agentType", "model", "upstream", "maxOutputTokens", "providerCostStatus", "chapterCount",
  "contextOmitted", "createdAt", "expiresAt", "status", "jobId"] as const satisfies readonly (keyof CustomerAiSaved)[];
type ComparedFields = typeof receiptScalars[number] | "platformFee" | "sourceVersions";
const allReceiptFieldsCompared: Exclude<keyof CustomerAiSaved, ComparedFields> extends never ? true : never = true;
void allReceiptFieldsCompared;

/** These values have already passed the strict customer receipt parser.
 * Never use a recovered receipt to recreate private review by itself. */
export function sameReviewedPreparation(previous: CustomerAiReceipt | null, current: CustomerAiReceipt,
  operation: string, now = Date.now()): boolean {
  if (!previous || !("sourceVersions" in previous) || !("sourceVersions" in current)
    || previous.status !== "prepared" || current.status !== "prepared"
    || previous.jobId !== null || current.jobId !== null
    || previous.operationId !== operation || current.operationId !== operation
    || !Number.isFinite(now) || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= now) return false;
  return receiptScalars.every(field => previous[field] === current[field])
    && previous.platformFee.mode === current.platformFee.mode && previous.platformFee.credits === current.platformFee.credits
    && previous.sourceVersions.length === current.sourceVersions.length
    && previous.sourceVersions.every((source, index) => {
      const other = current.sourceVersions[index];
      return other !== undefined && source.chapterId === other.chapterId
        && source.documentVersionId === other.documentVersionId && source.version === other.version;
    });
}
function key(actor: string, book: string) {
  if (!customerUuid.test(actor) || !customerUuid.test(book)) throw new Error("Recheck the account and book before continuing.");
  return `bookworm:customer-ai:${actor}:${book}`;
}
export function readCustomerAiPending(actor: string, book: string): string | null {
  const value = sessionStorage.getItem(key(actor, book));
  if (value !== null && !customerUuid.test(value)) throw new Error("The saved request is unreadable. Contact support before creating another.");
  return value;
}
export function saveCustomerAiPending(actor: string, book: string, operation: string): void {
  if (!customerUuid.test(operation)) throw new Error("A valid recovery identity is required.");
  const previous = readCustomerAiPending(actor, book);
  if (previous !== null && previous !== operation) throw new Error("Resolve the earlier request before creating another.");
  // Only an opaque owner/book-bound operation UUID is retained. No instruction,
  // source text, fee, model, key or token ever enters browser storage.
  sessionStorage.setItem(key(actor, book), operation);
  if (readCustomerAiPending(actor, book) !== operation) throw new Error("Recovery could not be saved. No preparation was submitted.");
}
export function clearCustomerAiPending(actor: string, book: string, receipt: CustomerAiReceipt): void {
  if (!("bookId" in receipt) || receipt.bookId !== book || !["closed_before_prepare", "closed", "cancelled", "succeeded"].includes(receipt.status)) {
    throw new Error("This request is not safely finished. Keep its recovery record.");
  }
  if (readCustomerAiPending(actor, book) !== receipt.operationId) throw new Error("The recovery identity changed. Reload saved status.");
  sessionStorage.removeItem(key(actor, book));
  if (readCustomerAiPending(actor, book) !== null) throw new Error("Recovery could not be cleared.");
}
