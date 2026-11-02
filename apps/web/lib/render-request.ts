type RenderPointer = { schema: 1; actor: string; bookId: string; editionId: string; requestId: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = (actor: string, bookId: string, editionId: string) => {
  if (![actor, bookId, editionId].every(value => uuid.test(value))) throw new Error("Verify the account, book and edition before rendering.");
  return `bookworm:render:v1:${actor}:${bookId}:${editionId}`;
};

export function readRenderPointer(storage: Pick<Storage, "getItem">, actor: string, bookId: string, editionId: string): RenderPointer | null {
  const raw = storage.getItem(key(actor, bookId, editionId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as RenderPointer;
    if (raw.length > 600 || !value || Object.keys(value).sort().join() !== "actor,bookId,editionId,requestId,schema"
      || value.schema !== 1 || value.actor !== actor || value.bookId !== bookId || value.editionId !== editionId
      || typeof value.requestId !== "string" || !uuid.test(value.requestId)) throw new Error();
    return value;
  } catch { throw new Error("Saved render recovery is invalid. It has been retained; do not start another render."); }
}

export function persistRenderPointer(storage: Pick<Storage, "getItem" | "setItem">, pointer: RenderPointer): void {
  if (readRenderPointer(storage, pointer.actor, pointer.bookId, pointer.editionId)) throw new Error("Check the original render before starting another.");
  const target = key(pointer.actor, pointer.bookId, pointer.editionId), raw = JSON.stringify(pointer);
  readRenderPointer({ getItem: () => raw }, pointer.actor, pointer.bookId, pointer.editionId);
  try {
    storage.setItem(target, raw);
    if (storage.getItem(target) !== raw) throw new Error();
  } catch { throw new Error("Render recovery could not be saved in this browser. No render was sent."); }
}

export function clearRenderPointer(storage: Pick<Storage, "getItem" | "removeItem">, pointer: RenderPointer): void {
  const current = readRenderPointer(storage, pointer.actor, pointer.bookId, pointer.editionId);
  if (!current || current.requestId !== pointer.requestId) throw new Error("The original render request changed. Check it again.");
  const target = key(pointer.actor, pointer.bookId, pointer.editionId);
  storage.removeItem(target);
  if (storage.getItem(target) !== null) throw new Error("Render status was confirmed, but recovery could not be cleared.");
}

export function validateRenderStatus(value: unknown, pointer: RenderPointer): { id: string; status: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Render status could not be verified.");
  const result = value as { bookId?: unknown; editionId?: unknown; requestId?: unknown; job?: unknown };
  if (result.bookId !== pointer.bookId || result.editionId !== pointer.editionId || result.requestId !== pointer.requestId
    || !("job" in result)) throw new Error("Render status belongs to a different request.");
  if (result.job === null) return null;
  if (!result.job || typeof result.job !== "object" || Array.isArray(result.job)) throw new Error("Render status could not be verified.");
  const job = result.job as { id?: unknown; status?: unknown };
  if (typeof job.id !== "string" || !uuid.test(job.id) || typeof job.status !== "string"
    || !["queued", "running", "succeeded", "failed", "cancelled"].includes(job.status)) throw new Error("Render status could not be verified.");
  return { id: job.id, status: job.status };
}

export type { RenderPointer };
