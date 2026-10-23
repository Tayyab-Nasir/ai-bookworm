import { createHash } from "node:crypto";
import { z } from "zod";
import type { BookNode } from "@bookworm/book-model";
import { AppError } from "../errors.js";
import { parseNodes } from "./authoring.js";
import type { SupabaseClient } from "./supabase.js";

export const searchEvidenceSchema = z.object({
  chapterId: z.string().uuid(), documentVersionId: z.string().uuid(),
  nodeId: z.string().min(1).max(200),
  chunkIndex: z.number().int().min(0).max(4_000_000).multipleOf(1600),
  textHash: z.string().regex(/^[a-f0-9]{32}$/u),
  offset: z.number().int().min(0).max(4_000_000).optional(),
}).strict();

/** Exact projection of private.searchable_book_node_text, not rendered prose.
 * Captions, accessibility text and table cells can be searchable separately.
 * PostgreSQL substring offsets count Unicode code points, not JS UTF-16 units.
 */
export function searchableNodeText(node: BookNode): string {
  const fields = [node.text, node.caption, node.altText].filter((text): text is string => typeof text === "string" && text !== "");
  const cells = node.rows?.flat() ?? [];
  if (cells.length) fields.push(cells.join("\n"));
  return fields.join("\n");
}

// Caller must establish current book membership first. Never read the derived
// search index here, nor replace a cited version with the latest manuscript.
export async function readSearchEvidence(sb: SupabaseClient, bookId: string, input: z.infer<typeof searchEvidenceSchema>) {
  const { chapterId, documentVersionId, nodeId, chunkIndex, textHash } = input;
  const { data: chapter, error: chapterError } = await sb.from("chapters")
    .select("id,book_id,title,current_document_version_id").eq("id", chapterId).eq("book_id", bookId).maybeSingle();
  if (chapterError) throw new AppError(503, "The source chapter could not be loaded. Try again.");
  if (!chapter) throw new AppError(404, "Source chapter not found in this book.");
  if (chapter.id !== chapterId || chapter.book_id !== bookId || typeof chapter.title !== "string" || chapter.title.length > 1000
    || (chapter.current_document_version_id !== null && !z.string().uuid().safeParse(chapter.current_document_version_id).success)) {
    throw new AppError(503, "The source chapter identity could not be verified.");
  }
  const { data: version, error: versionError } = await sb.from("document_versions")
    .select("id,chapter_id,version_number,content_json").eq("id", documentVersionId).eq("chapter_id", chapterId).maybeSingle();
  if (versionError) throw new AppError(503, "The cited manuscript version could not be loaded. Try again.");
  if (!version) throw new AppError(404, "Cited manuscript version not found in this chapter.");
  if (version.id !== documentVersionId || version.chapter_id !== chapterId || !Number.isSafeInteger(version.version_number) || version.version_number < 1) {
    throw new AppError(503, "The saved source version could not be verified.");
  }
  const node = parseNodes(version.content_json).find(value => value.id === nodeId);
  if (!node) throw new AppError(404, "Cited source node not found.");
  const points = Array.from(searchableNodeText(node));
  // MD5 is the legacy FTS chunk fingerprint, not an authorization mechanism.
  // Scope comes from membership and the chapter/version queries above.
  const chunk = points.slice(chunkIndex, chunkIndex + 1800).join("");
  if (!chunk || createHash("md5").update(chunk).digest("hex") !== textHash) {
    throw new AppError(409, "This search citation does not match the saved source. Search again before using it.");
  }
  const startOffset = input.offset ?? Math.max(0, chunkIndex - 300);
  if (startOffset >= points.length) throw new AppError(422, "Choose a position within this saved source.");
  const endOffset = Math.min(points.length, startOffset + 6000);
  return { bookId, citation: { chapterId, documentVersionId, nodeId, chunkIndex, textHash },
    chapterTitle: chapter.title, versionNumber: version.version_number,
    isCurrentVersion: chapter.current_document_version_id === documentVersionId,
    text: points.slice(startOffset, endOffset).join(""), startOffset, endOffset, totalLength: points.length,
    previousOffset: startOffset ? Math.max(0, startOffset - 6000) : null,
    nextOffset: endOffset < points.length ? endOffset : null,
    matchedStart: chunkIndex, matchedEnd: Math.min(points.length, chunkIndex + 1800) };
}
