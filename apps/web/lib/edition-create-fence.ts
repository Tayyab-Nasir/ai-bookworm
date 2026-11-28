// Metadata only: an edition-create request is not idempotent on the server.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type EditionCreateFence = { actor: string; bookId: string; requestId: string; raw: string };
function key(bookId: string) {
  if (!uuid.test(bookId)) throw new Error("The book could not be verified.");
  return `bookworm-edition-create-v1:${bookId.toLowerCase()}`;
}
export function readEditionCreateFence(storage: Storage, bookId: string): EditionCreateFence | null {
  const raw = storage.getItem(key(bookId));
  if (raw === null) return null;
  if (raw.length > 512) throw new Error("The edition create warning could not be verified. Do not retry the earlier request.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("The edition create warning could not be verified. Do not retry the earlier request."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The edition create warning could not be verified. Do not retry the earlier request.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "actor,bookId,requestId,version" || item.version !== 1
      || typeof item.actor !== "string" || !uuid.test(item.actor) || typeof item.bookId !== "string" || item.bookId.toLowerCase() !== bookId.toLowerCase()
      || typeof item.requestId !== "string" || !uuid.test(item.requestId)) throw new Error("The edition create warning could not be verified. Do not retry the earlier request.");
  return { actor: item.actor, bookId: item.bookId, requestId: item.requestId, raw };
}
export function beginEditionCreateFence(storage: Storage, actor: string, bookId: string, requestId: string): EditionCreateFence {
  if (!uuid.test(actor) || !uuid.test(requestId)) throw new Error("The account or request could not be verified.");
  const name = key(bookId);
  if (storage.getItem(name) !== null) throw new Error("A previous new-edition save is still unconfirmed. Reload to review its warning.");
  const raw = JSON.stringify({ version: 1, actor, bookId, requestId });
  try { storage.setItem(name, raw); } catch { throw new Error("The browser cannot retain the save warning. No edition was sent; allow tab storage and try again."); }
  if (storage.getItem(name) !== raw) throw new Error("The browser could not verify the save warning. No edition was sent.");
  return { actor, bookId, requestId, raw };
}
export function clearEditionCreateFence(storage: Storage, fence: EditionCreateFence): void {
  const name = key(fence.bookId);
  const unavailable = "The browser could not confirm the edition warning was retained or removed. It may not survive a reload. A previous request could still finish; keep this tab open and contact support before creating another edition.";
  let current: string | null;
  try { current = storage.getItem(name); } catch { throw new Error(unavailable); }
  if (current !== fence.raw) throw new Error("The edition create warning changed. A previous request could still finish. Contact support before creating another edition.");
  try {
    storage.removeItem(name);
    if (storage.getItem(name) !== null) throw new Error(unavailable);
  } catch {
    // A partial failure may have removed the marker. Restore only if it is
    // demonstrably absent; never overwrite a different warning.
    try { if (storage.getItem(name) === null) storage.setItem(name, fence.raw); } catch { /* Keep the in-memory warning and explain the limitation. */ }
    throw new Error(unavailable);
  }
}
