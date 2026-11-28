import { bookNodesPlainText } from "@bookworm/book-model/plain-text";
import { BookNodeSchema } from "@bookworm/book-model/schema";
import type { BookNode } from "@bookworm/book-model";

export const MAX_CHAPTER_DRAFT_BACKUP_BYTES = 5 * 1024 * 1024;

const validIdentity = (value: string) => /^[a-z0-9_-]{1,200}$/iu.test(value);

export function chapterDraftExportWarning(bytes: number, invalidEditorState: boolean, userId: string): string | null {
  if (invalidEditorState) return "This backup includes the last valid blocks and your invalid editor state. Review it separately; it cannot be reopened automatically.";
  if (bytes > MAX_CHAPTER_DRAFT_BACKUP_BYTES) return "This backup exceeds 5 MB. It can be downloaded for manual review, but cannot be reopened automatically.";
  if (!validIdentity(userId)) return "This backup has no verified account identity. It can be downloaded for manual review, but cannot be reopened automatically.";
  return null;
}

/** Builds a user-requested local backup; callers may store it only with explicit consent. */
export function chapterDraftBackup(input: {
  userId: string; bookId: string; chapterId: string; baseVersion: number; nodes: BookNode[];
  capturedAt: string; validation?: { message: string; draftText: string; editorDocument?: unknown } | null;
}) {
  return {
    format: "bookworm-chapter-draft", formatVersion: 2, userId: input.userId,
    bookId: input.bookId, chapterId: input.chapterId, baseVersion: input.baseVersion,
    capturedAt: input.capturedAt,
    canonicalState: input.validation ? "last-valid-draft" : "current-draft",
    nodes: input.nodes,
    plainText: input.validation?.draftText ?? bookNodesPlainText(input.nodes),
    ...(input.validation ? { validationError: input.validation.message, editorDocument: input.validation.editorDocument ?? null } : {}),
    limitations: ["Local draft backup, not a saved server version.", "Artwork references are preserved; image bytes are not embedded.",
      "Recovery is local and must be reviewed and saved separately."],
  };
}

/** Treat a local file as untrusted; metadata matches scope but is not a signature. */
export function inspectChapterDraftBackup(raw: string, scope: { userId: string; bookId: string; chapterId: string; baseVersion: number }): { nodes: BookNode[]; legacy: boolean } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("This file is not a valid JSON draft backup."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This file is not a valid chapter draft backup.");
  const backup = value as Record<string, unknown>;
  if (backup.format !== "bookworm-chapter-draft" || (backup.formatVersion !== 1 && backup.formatVersion !== 2)) throw new Error("This backup format cannot be opened automatically. Review it as JSON or text.");
  const legacy = backup.formatVersion === 1;
  if (!validIdentity(scope.userId) || !validIdentity(scope.bookId) || !validIdentity(scope.chapterId)) throw new Error("The account and chapter could not be verified.");
  if ((!legacy && backup.userId !== scope.userId) || backup.bookId !== scope.bookId || backup.chapterId !== scope.chapterId) throw new Error("This backup belongs to a different account, book, or chapter.");
  if (!Number.isSafeInteger(backup.baseVersion) || backup.baseVersion !== scope.baseVersion) throw new Error("The saved chapter has changed since this backup. Review the backup separately before merging.");
  if (backup.canonicalState !== "current-draft") throw new Error("This backup contains an invalid editor state and cannot be reopened automatically. Review its text separately.");
  const parsed = BookNodeSchema.array().max(20000).safeParse(backup.nodes);
  if (!parsed.success || new Set(parsed.data.map(node => node.id)).size !== parsed.data.length) throw new Error("This backup contains invalid manuscript blocks.");
  if (parsed.data.some(node => {
    const depth = node.attributes?.listDepth;
    return depth !== undefined && depth !== null && !((typeof depth === "number" || (typeof depth === "string" && depth.length <= 16)) && Number.isFinite(Number(depth)));
  })) throw new Error("This backup contains invalid manuscript blocks.");
  if (typeof backup.plainText !== "string" || backup.plainText !== bookNodesPlainText(parsed.data)) throw new Error("This backup's text does not match its manuscript blocks.");
  return { nodes: parsed.data, legacy };
}

/** Version 1 requires a separate author warning before its nodes can be used. */
export function parseChapterDraftBackup(raw: string, scope: { userId: string; bookId: string; chapterId: string; baseVersion: number }): BookNode[] {
  const parsed = inspectChapterDraftBackup(raw, scope);
  if (parsed.legacy) throw new Error("Earlier backups need explicit confirmation before opening.");
  return parsed.nodes;
}

/** Exports remain available even if local automatic reopening cannot accept them. */
export function chapterDraftReopenWarning(raw: string, bytes: number, invalidEditorState: boolean, scope: { userId: string; bookId: string; chapterId: string; baseVersion: number }): string | null {
  const warning = chapterDraftExportWarning(bytes, invalidEditorState, scope.userId);
  if (warning) return warning;
  try { parseChapterDraftBackup(raw, scope); return null; }
  catch { return "This backup can be downloaded for manual review, but its content cannot be reopened automatically."; }
}
