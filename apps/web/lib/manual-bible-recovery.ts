import type { BookBibleItem } from "@bookworm/types";

export type ManualBibleAction = "create" | "update" | "delete";
export type ManualBiblePointer = {
  schema: 1 | 2;
  userId: string;
  bookId: string;
  requestId: string;
  action: ManualBibleAction;
  targetId: string | null;
  expectedUpdatedAt: string | null;
  expectedIncarnationId?: string | null;
  intentDigest: string;
};
export type ManualBibleReceipt = {
  requestId: string; bookId: string; action: ManualBibleAction; itemId: string;
  intentHash: string; resultHash: string; resultUpdatedAt: string; committedAt: string;
};
export type ManualBibleResult = {
  receipt: ManualBibleReceipt | null;
  disposition: "unchanged" | "changed" | "deleted" | null;
  item: BookBibleItem | null;
  replayed: boolean;
  closed: boolean;
  closure: { requestId: string; bookId: string; closedAt: string } | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const legacyPointerFields = ["schema", "userId", "bookId", "requestId", "action", "targetId", "expectedUpdatedAt", "intentDigest"];
const pointerFields = [...legacyPointerFields, "expectedIncarnationId"];
const actions = new Set<ManualBibleAction>(["create", "update", "delete"]);
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 80 && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function manualBibleRecoveryKey(userId: string, bookId: string) {
  if (!uuid.test(userId) || !uuid.test(bookId)) throw new Error("Verify your account and saved book before changing Book Bible entries.");
  return `bookworm:manual-bible:v1:${userId}:${bookId}`;
}

export function parseManualBiblePointer(raw: string | null, userId: string, bookId: string): ManualBiblePointer | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const fields = record(value) && value.schema === 1 ? legacyPointerFields : pointerFields;
    if (raw.length > 1200 || !record(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
      || (value.schema !== 1 && value.schema !== 2) || value.userId !== userId || value.bookId !== bookId
      || !uuid.test(userId) || !uuid.test(bookId) || typeof value.requestId !== "string" || !uuid.test(value.requestId)
      || !actions.has(value.action as ManualBibleAction) || typeof value.intentDigest !== "string" || !digest.test(value.intentDigest)
      || (value.action === "create" ? value.targetId !== null || value.expectedUpdatedAt !== null
        : typeof value.targetId !== "string" || !uuid.test(value.targetId) || !timestamp(value.expectedUpdatedAt))
      || (value.schema === 2 && (value.action === "create" ? value.expectedIncarnationId !== null
        : typeof value.expectedIncarnationId !== "string" || !uuid.test(value.expectedIncarnationId)))) {
      throw new Error("invalid recovery pointer");
    }
    return value as ManualBiblePointer;
  } catch {
    throw new Error("The saved manual Book Bible request is invalid. It is retained; no new request will replace it.");
  }
}

export function manualBibleRetryAllowed(pointer: ManualBiblePointer) {
  return pointer.schema === 2 && (pointer.action === "create" ? pointer.expectedIncarnationId === null
    : typeof pointer.expectedIncarnationId === "string" && uuid.test(pointer.expectedIncarnationId));
}

export function persistManualBiblePointer(storage: Pick<Storage, "getItem" | "setItem">, pointer: ManualBiblePointer) {
  const key = manualBibleRecoveryKey(pointer.userId, pointer.bookId);
  const fields = pointer.schema === 1 ? legacyPointerFields : pointerFields;
  const raw = JSON.stringify(Object.fromEntries(fields.map(field => [field, pointer[field as keyof ManualBiblePointer]])));
  parseManualBiblePointer(raw, pointer.userId, pointer.bookId);
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error("recovery pointer did not persist");
  } catch {
    throw new Error("Browser session recovery is unavailable. No manual Book Bible write was sent. Enable session storage and retry.");
  }
}

export function clearManualBiblePointer(storage: Pick<Storage, "getItem" | "removeItem">, pointer: ManualBiblePointer) {
  const key = manualBibleRecoveryKey(pointer.userId, pointer.bookId);
  const stored = parseManualBiblePointer(storage.getItem(key), pointer.userId, pointer.bookId);
  if (stored && stored.requestId !== pointer.requestId) throw new Error("A newer saved request must not be removed.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("The confirmed recovery pointer could not be cleared.");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

export async function manualBibleIntentDigest(action: ManualBibleAction, targetId: string | null, body: Record<string, unknown>) {
  const { requestId: _requestId, ...intent } = body;
  const serialized = JSON.stringify(canonical({ action, targetId, body: intent }));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function validateManualBibleResult(value: unknown, pointer: ManualBiblePointer): ManualBibleResult {
  if (!record(value) || typeof value.replayed !== "boolean" || typeof value.closed !== "boolean") throw new Error("The saved request result could not be confirmed. Recover this same request before continuing.");
  if (value.receipt === null) {
    if (value.item !== null || value.disposition !== null || value.replayed !== false) throw new Error("The missing request result could not be confirmed.");
    if (value.closed) {
      const closure = value.closure;
      if (!record(closure) || closure.requestId !== pointer.requestId || closure.bookId !== pointer.bookId
        || !timestamp(closure.closedAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(closure.closedAt)) {
        throw new Error("The saved closure does not match this Book Bible request. Its original pointer is retained.");
      }
      return { receipt: null, item: null, disposition: null, replayed: false, closed: true, closure: closure as ManualBibleResult["closure"] };
    }
    if (value.closure !== undefined && value.closure !== null) throw new Error("The missing request returned inconsistent closure details.");
    return { receipt: null, item: null, disposition: null, replayed: false, closed: false, closure: null };
  }
  const receipt = value.receipt;
  if (value.closed || (value.closure !== undefined && value.closure !== null) || !record(receipt) || receipt.requestId !== pointer.requestId || receipt.bookId !== pointer.bookId || receipt.action !== pointer.action
    || typeof receipt.itemId !== "string" || !uuid.test(receipt.itemId) || (pointer.targetId !== null && receipt.itemId !== pointer.targetId)
    || typeof receipt.intentHash !== "string" || !digest.test(receipt.intentHash) || typeof receipt.resultHash !== "string" || !digest.test(receipt.resultHash)
    || !timestamp(receipt.resultUpdatedAt) || !timestamp(receipt.committedAt) || !["unchanged", "changed", "deleted"].includes(String(value.disposition))
    || (pointer.action === "delete" && value.disposition === "unchanged")) {
    throw new Error("The saved request receipt does not match this Book Bible action. Its original pointer is retained.");
  }
  if (value.disposition === "deleted") {
    if (value.item !== null) throw new Error("The saved request returned inconsistent deletion details.");
  } else {
    const item = value.item;
    if (!record(item) || item.id !== receipt.itemId || item.book_id !== pointer.bookId || typeof item.type !== "string" || typeof item.name !== "string"
      || typeof item.mutation_incarnation_id !== "string" || !uuid.test(item.mutation_incarnation_id)
      || (item.description !== null && typeof item.description !== "string") || !record(item.attributes_json) || !Array.isArray(item.source_refs_json)
      || !timestamp(item.updated_at) || (value.disposition === "unchanged" && Date.parse(item.updated_at) !== Date.parse(receipt.resultUpdatedAt))) {
      throw new Error("The current Book Bible entry could not be confirmed. Recover the saved request again.");
    }
  }
  return value as ManualBibleResult;
}
