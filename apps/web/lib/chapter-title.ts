import type { ChapterTitleChangeResult, ChapterTitleState } from "@bookworm/api-client";

type Scope = { userId: string; bookId: string; chapterId: string };
export type TitleChangePointer = Scope & { schema: 1; operationId: string; expectedRevision: number; titleDigest: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const identity = /^[a-z0-9_-]{1,200}$/iu;
const fields = ["schema", "userId", "bookId", "chapterId", "operationId", "expectedRevision", "titleDigest"] as const;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2_147_483_646;
export const validChapterTitle = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 500 && v === v.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
export const titleChangeKey = (scope: Scope) => `bookworm:chapter-title:v1:${scope.userId}:${scope.bookId}:${scope.chapterId}`;

export function parseTitleChange(raw: string | null, scope: Scope): TitleChangePointer | null {
  if (raw === null) return null;
  try {
    if (raw.length > 1800) throw Error();
    const p: unknown = JSON.parse(raw);
    if (!record(p) || Object.keys(p).length !== fields.length || Object.keys(p).some(k => !fields.includes(k as typeof fields[number]))
      || p.schema !== 1 || (["userId", "bookId", "chapterId"] as const).some(k => !identity.test(scope[k]) || p[k] !== scope[k])
      || typeof p.operationId !== "string" || !uuid.test(p.operationId) || !revision(p.expectedRevision)
      || typeof p.titleDigest !== "string" || !/^[a-f0-9]{64}$/u.test(p.titleDigest)) throw Error();
    return p as TitleChangePointer;
  } catch { throw Error("The title recovery record is invalid. It is retained; do not replace it with a new request."); }
}
export function persistTitleChange(storage: Pick<Storage, "getItem" | "setItem">, p: TitleChangePointer) {
  const raw = JSON.stringify(Object.fromEntries(fields.map(k => [k, p[k]]))), key = titleChangeKey(p);
  parseTitleChange(raw, p);
  const old = parseTitleChange(storage.getItem(key), p);
  if (old && fields.some(k => old[k] !== p[k])) throw Error("Recover the existing title change first.");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error("Browser recovery storage is unavailable. No title change was sent.");
}
export function clearTitleChange(storage: Pick<Storage, "getItem" | "removeItem">, p: TitleChangePointer) {
  const old = parseTitleChange(storage.getItem(titleChangeKey(p)), p);
  if (old && fields.some(k => old[k] !== p[k])) throw Error("A different title recovery record must not be removed.");
  storage.removeItem(titleChangeKey(p));
  if (storage.getItem(titleChangeKey(p)) !== null) throw Error("The confirmed recovery record could not be cleared. Check again.");
}
export async function titleDigest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function validateTitleState(v: unknown): asserts v is ChapterTitleState {
  if (!record(v) || typeof v.title !== "string" || v.title.length > 500 || !revision(v.revision)
    || typeof v.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(v.updatedAt) || !Number.isFinite(Date.parse(v.updatedAt)))
    throw Error("The saved chapter title could not be verified.");
}
export async function validateTitleResult(v: unknown, p: TitleChangePointer): Promise<ChapterTitleChangeResult> {
  const fail = () => Error("The title-change result does not match this request. Keep its recovery record.");
  if (!record(v) || v.chapterId !== p.chapterId || v.bookId !== p.bookId || v.operationId !== p.operationId
    || v.expectedRevision !== p.expectedRevision || v.titleDigest !== p.titleDigest || !["saved", "closed", "conflict", "not_found"].includes(String(v.status))) throw fail();
  validateTitleState(v.current);
  if (v.status === "saved") {
    if (!record(v.receipt) || !validChapterTitle(v.receipt.title) || !revision(v.receipt.revision)
      || v.receipt.revision < p.expectedRevision || v.receipt.revision > p.expectedRevision + 1
      || await titleDigest(v.receipt.title) !== p.titleDigest || v.current.revision < v.receipt.revision
      || (v.current.revision === v.receipt.revision && v.current.title !== v.receipt.title)) throw fail();
  } else if (v.receipt !== null) throw fail();
  return v as unknown as ChapterTitleChangeResult;
}
