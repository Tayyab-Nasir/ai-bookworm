import { bookNodesPlainText } from "@bookworm/book-model/plain-text";
import type { BookNode } from "@bookworm/book-model";

/** A user-requested local backup, never uploaded or stored in browser recovery. */
export function chapterDraftBackup(input: {
  bookId: string; chapterId: string; baseVersion: number; nodes: BookNode[];
  capturedAt: string; validation?: { message: string; draftText: string; editorDocument?: unknown } | null;
}) {
  return {
    format: "bookworm-chapter-draft", formatVersion: 1,
    bookId: input.bookId, chapterId: input.chapterId, baseVersion: input.baseVersion,
    capturedAt: input.capturedAt,
    canonicalState: input.validation ? "last-valid-draft" : "current-draft",
    nodes: input.nodes,
    plainText: input.validation?.draftText ?? bookNodesPlainText(input.nodes),
    ...(input.validation ? { validationError: input.validation.message, editorDocument: input.validation.editorDocument ?? null } : {}),
    limitations: ["Local draft backup, not a saved server version.", "Artwork references are preserved; image bytes are not embedded.",
      "This JSON is not a manuscript upload format; review before manually recovering content."],
  };
}
