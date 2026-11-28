import { chapterDraftBackup, parseChapterDraftBackup, MAX_CHAPTER_DRAFT_BACKUP_BYTES } from "./chapter-draft";
import type { BookNode } from "@bookworm/book-model";

type Scope = { userId: string; bookId: string; chapterId: string; baseVersion: number };
const valid = (value: string) => /^[a-z0-9_-]{1,200}$/iu.test(value);
export function chapterTabRecoveryKey(scope: Scope): string {
  if (![scope.userId, scope.bookId, scope.chapterId].every(valid) || !Number.isSafeInteger(scope.baseVersion) || scope.baseVersion < 0) throw new Error("The account or chapter could not be verified.");
  return `bookworm-tab-draft-v1:${JSON.stringify([scope.userId, scope.bookId, scope.chapterId])}`;
}
export function readChapterTabRecovery(storage: Storage, scope: Scope): string | null {
  const raw = storage.getItem(chapterTabRecoveryKey(scope));
  if (raw !== null && new TextEncoder().encode(raw).byteLength > MAX_CHAPTER_DRAFT_BACKUP_BYTES) throw new Error("The local draft exceeds the 5 MB recovery limit. Use your browser's site-data controls to remove it.");
  return raw;
}
export function openChapterTabRecovery(raw: string, scope: Scope): BookNode[] {
  if (new TextEncoder().encode(raw).byteLength > MAX_CHAPTER_DRAFT_BACKUP_BYTES) throw new Error("The local draft exceeds the 5 MB recovery limit.");
  return parseChapterDraftBackup(raw, scope);
}
/** Synchronous compare and replace avoids silently overwriting a different retained draft. */
export function writeChapterTabRecovery(storage: Storage, scope: Scope, nodes: BookNode[], expected: string | null): string {
  const key = chapterTabRecoveryKey(scope);
  if (storage.getItem(key) !== expected) throw new Error("A different local draft is present. Review it before changing the recovery copy.");
  const raw = JSON.stringify(chapterDraftBackup({ ...scope, nodes, capturedAt: new Date().toISOString() }));
  if (new TextEncoder().encode(raw).byteLength > MAX_CHAPTER_DRAFT_BACKUP_BYTES) throw new Error("This draft is too large for tab recovery. Download a draft backup instead.");
  openChapterTabRecovery(raw, scope);
  try { storage.setItem(key, raw); } catch { throw new Error("The browser could not store this draft. Download a draft backup instead."); }
  return raw;
}
export function discardChapterTabRecovery(storage: Storage, scope: Scope, expected: string): void {
  const key = chapterTabRecoveryKey(scope);
  if (storage.getItem(key) !== expected) throw new Error("The local draft changed. Reload before discarding it.");
  try { storage.removeItem(key); } catch { throw new Error("The browser could not remove this local draft."); }
}
