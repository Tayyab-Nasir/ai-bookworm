const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

const identity = /^[a-z0-9_-]{1,200}$/iu;

export type ChapterCreationPointer = {
  schema: 1;
  actorId: string;
  bookId: string;
  requestKey: string;
};

function key(actorId: string, bookId: string) {
  if (!identity.test(actorId) || !identity.test(bookId)) throw new Error("Verify the original account and book before creating a chapter.");
  return `bookworm:chapter-creation:v1:${actorId}:${bookId}`;
}

export function readChapterCreation(storage: Pick<Storage, "getItem">, actorId: string, bookId: string): ChapterCreationPointer | null {
  let raw: string | null;
  try { raw = storage.getItem(key(actorId, bookId)); }
  catch { throw new Error("Chapter recovery storage is unavailable. No new chapter was sent."); }
  if (raw === null) return null;
  try {
    if (raw.length > 512) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const p = value as Record<string, unknown>;
    if (Object.keys(p).length !== 4 || p.schema !== 1 || p.actorId !== actorId || p.bookId !== bookId
      || typeof p.requestKey !== "string" || !uuid.test(p.requestKey)) throw new Error();
    return p as ChapterCreationPointer;
  } catch { throw new Error("Chapter recovery details are unreadable. Keep this tab and contact support before creating another chapter."); }
}

export function saveChapterCreation(storage: Pick<Storage, "getItem" | "setItem">, pointer: ChapterCreationPointer) {
  if (!uuid.test(pointer.requestKey) || readChapterCreation(storage, pointer.actorId, pointer.bookId)) {
    throw new Error("Recover the earlier chapter request before creating another.");
  }
  const storageKey = key(pointer.actorId, pointer.bookId);
  const raw = JSON.stringify(pointer);
  try { storage.setItem(storageKey, raw); }
  catch { throw new Error("Chapter recovery could not be saved. No new chapter was sent."); }
  if (storage.getItem(storageKey) !== raw) throw new Error("Chapter recovery could not be saved. No new chapter was sent.");
}

export function clearChapterCreation(storage: Pick<Storage, "getItem" | "removeItem">, pointer: ChapterCreationPointer) {
  const current = readChapterCreation(storage, pointer.actorId, pointer.bookId);
  if (current && current.requestKey !== pointer.requestKey) throw new Error("A different chapter recovery record must not be removed.");
  const storageKey = key(pointer.actorId, pointer.bookId);
  try { storage.removeItem(storageKey); }
  catch { throw new Error("Chapter recovery could not be cleared. Check the original request again."); }
  if (storage.getItem(storageKey) !== null) throw new Error("Chapter recovery could not be cleared. Check the original request again.");
}
