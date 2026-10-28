import { customerUuid, type CustomerAiReceipt } from "@bookworm/api-client/customer-ai";
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
