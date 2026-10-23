import { BookNodeSchema, type BookNode } from "@bookworm/book-model/schema";
import type { ChapterDocument, ManualChapterSaveResult } from "@bookworm/api-client";

export type ChapterSaveScope = { userId: string; bookId: string; chapterId: string };
export type ChapterSavePointer = ChapterSaveScope & { schema: 1; operationId: string; expectedVersion: number; digest: string };
const identity = /^[a-z0-9_-]{1,200}$/iu;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const fields = ["schema", "userId", "bookId", "chapterId", "operationId", "expectedVersion", "digest"] as const;
const version = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 2_147_483_647;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export const chapterSaveKey = ({ userId, bookId, chapterId }: ChapterSaveScope) => `bookworm:manual-save:v1:${userId}:${bookId}:${chapterId}`;

/** No expiry: an unconfirmed write must not silently become a new request. */
export function parseChapterSave(raw: string | null, scope: ChapterSaveScope): ChapterSavePointer | null {
  if (raw === null) return null;
  try {
    if (raw.length > 1800) throw Error();
    const p: unknown = JSON.parse(raw);
    if (!record(p) || p.schema !== 1 || Object.keys(p).length !== fields.length || Object.keys(p).some(k => !fields.includes(k as typeof fields[number]))
      || (["userId", "bookId", "chapterId"] as const).some(key => !identity.test(scope[key]) || p[key] !== scope[key])
      || typeof p.operationId !== "string" || !uuid.test(p.operationId) || !version(p.expectedVersion) || p.expectedVersion > 2_147_483_645
      || typeof p.digest !== "string" || !/^[a-f0-9]{64}$/u.test(p.digest)) throw Error();
    return p as ChapterSavePointer;
  } catch { throw Error("The manual save recovery record is invalid. It is retained; do not replace it with a new save."); }
}

export function persistChapterSave(storage: Pick<Storage, "getItem" | "setItem">, p: ChapterSavePointer) {
  const key = chapterSaveKey(p), raw = JSON.stringify(Object.fromEntries(fields.map(k => [k, p[k]])));
  parseChapterSave(raw, p);
  const previous = parseChapterSave(storage.getItem(key), p);
  if (previous && fields.some(key => previous[key] !== p[key])) throw Error("A different pending save must be recovered first.");
  try { storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw Error(); }
  catch { throw Error("Browser session storage is unavailable. No manuscript save was sent."); }
}

export function clearChapterSave(storage: Pick<Storage, "getItem" | "removeItem">, p: ChapterSavePointer) {
  const key = chapterSaveKey(p), previous = parseChapterSave(storage.getItem(key), p);
  if (previous && fields.some(key => previous[key] !== p[key])) throw Error("A different pending save must not be removed.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw Error("The confirmed recovery record could not be cleared. Check saved status again.");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
}
export async function chapterSaveDigest(nodes: BookNode[]) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(nodes))));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function editorAccount(expected?: string) {
  const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
  const value = await response.json();
  if (!response.ok || typeof value?.user?.id !== "string" || !identity.test(value.user.id)) throw Error("Verify your signed-in account before saving or recovering this chapter.");
  if (expected && value.user.id !== expected) throw Error("Your account changed. Reload before saving or recovering this chapter.");
  return value.user.id as string;
}

function validNodes(nodes: unknown): nodes is BookNode[] {
  return Array.isArray(nodes) && nodes.length <= 20000 && nodes.every(n => BookNodeSchema.safeParse(n).success)
    && new Set(nodes.map(n => n.id)).size === nodes.length && JSON.stringify(nodes).length <= 4_000_000;
}

export function validateCurrentChapter(document: unknown, chapterId: string, minimumVersion = 0): asserts document is ChapterDocument {
  if (!record(document) || document.chapterId !== chapterId || !version(document.version) || document.version < minimumVersion || !validNodes(document.nodes))
    throw Error("The current chapter could not be verified. Keep any recovery record and check again.");
}

export async function validateSavedChapter(document: ChapterDocument, p: ChapterSavePointer) {
  if (!document || document.chapterId !== p.chapterId || document.version !== p.expectedVersion + 1
    || !validNodes(document.nodes) || await chapterSaveDigest(document.nodes) !== p.digest)
    throw Error("The saved manuscript receipt does not match this exact save. Keep its recovery record.");
}

export async function validateChapterSaveResult(raw: unknown, p: ChapterSavePointer): Promise<ManualChapterSaveResult> {
  const fail = () => Error("The manual save result could not be confirmed. Keep the original recovery record.");
  if (!record(raw) || raw.operationId !== p.operationId || raw.bookId !== p.bookId || raw.chapterId !== p.chapterId || raw.expectedVersion !== p.expectedVersion
    || !version(raw.currentVersion) || raw.currentVersion < p.expectedVersion || !["saved", "closed", "superseded", "not_found"].includes(String(raw.status))) throw fail();
  const result = raw as unknown as ManualChapterSaveResult;
  if (result.status === "saved" || result.status === "closed") {
    if (!result.receipt || typeof result.receipt.versionId !== "string" || !result.receipt.versionId || result.receipt.document?.chapterId !== p.chapterId
      || result.receipt.document.version !== p.expectedVersion + 1 || result.currentVersion < result.receipt.document.version
      || !validNodes(result.receipt.document.nodes)) throw fail();
    if (result.status === "saved") await validateSavedChapter(result.receipt.document, p);
  } else if (result.receipt !== null || (result.status === "not_found" ? result.currentVersion !== p.expectedVersion : result.currentVersion <= p.expectedVersion)) throw fail();
  return result;
}
