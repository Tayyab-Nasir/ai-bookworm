import { AI_PROVIDERS, type AiConnectionPending } from "@bookworm/api-client/ai-connections";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function key(actor: string) {
  if (!uuid.test(actor)) throw new Error("Recheck your account before changing an AI key.");
  return `bookworm:ai-connection:${actor}`;
}
export function parsePendingConnection(value: unknown): AiConnectionPending {
  const row = value as Partial<AiConnectionPending> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join() !== "action,connectionId,expectedRevision,operationId,provider"
    || typeof row.connectionId !== "string" || !uuid.test(row.connectionId) || typeof row.operationId !== "string" || !uuid.test(row.operationId)
    || !AI_PROVIDERS.includes(row.provider!) || !["save", "revoke"].includes(row.action!)
    || (row.expectedRevision !== null && (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision! < 1 || row.expectedRevision! >= 2_147_483_647))) {
    throw new Error("The saved AI connection recovery details are unreadable. Contact support before changing keys.");
  }
  return { connectionId: row.connectionId, operationId: row.operationId, expectedRevision: row.expectedRevision!, provider: row.provider!, action: row.action! };
}
export function readPendingConnection(actor: string): AiConnectionPending | null {
  const raw = sessionStorage.getItem(key(actor));
  if (raw === null) return null;
  if (raw.length > 700) throw new Error("The saved AI connection recovery details are unreadable.");
  return parsePendingConnection(JSON.parse(raw));
}
export function savePendingConnection(actor: string, pending: AiConnectionPending): void {
  const encoded = JSON.stringify(parsePendingConnection(pending));
  // No key, prompt, label or token is persisted. Refuse dispatch when recovery
  // cannot survive a page reload; a tab close may still clear session storage.
  sessionStorage.setItem(key(actor), encoded);
  if (sessionStorage.getItem(key(actor)) !== encoded) throw new Error("Connection recovery could not be saved. No key was submitted.");
}
export function clearPendingConnection(actor: string, operationId: string): void {
  if (readPendingConnection(actor)?.operationId === operationId) sessionStorage.removeItem(key(actor));
}
