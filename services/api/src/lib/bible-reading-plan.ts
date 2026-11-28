import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

export type BibleReadingChapter = { id: string; title: string; order: number; version: number;
  documentVersionId: string; nodes: { id: string; text?: unknown }[] };
type Range = { chapterId: string; documentVersionId: string; nodeId: string; textHash: string;
  startOffset: number; endOffset: number };
export type BibleReadingPage = { ranges: Range[]; chapters: Record<string, unknown>; bytes: number };

/** Deterministic, gap-free UTF-16 offsets; never split a Unicode code point.
 * Hashes identify full saved nodes, even when a page reads only an excerpt.
 * No model, persistence or debit happens during planning. */
export function buildBibleReadingPlan(chapters: BibleReadingChapter[], maxTokens: number) {
  const budget = Math.min(24000, Math.floor(maxTokens * 1.7));
  if (!Number.isInteger(maxTokens) || maxTokens < 4096 || maxTokens > 16000) throw new AppError(422, "Invalid reading budget.");
  const pages: BibleReadingPage[] = [];
  let page: BibleReadingPage = { ranges: [], chapters: {}, bytes: 0 };
  let totalBytes = 0;
  for (const chapter of chapters) {
    const seen = new Set<string>();
    for (const node of chapter.nodes) {
      if (seen.has(node.id)) throw new AppError(422, "Saved manuscript node identifiers must be unique.");
      seen.add(node.id);
      const text = typeof node.text === "string" ? node.text : "";
      if (!text.trim()) continue;
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > 8_000_000) throw new AppError(422, "Select fewer chapters: this reading plan exceeds 8 MB of text.");
      const textHash = createHash("sha256").update(text).digest("hex");
      let start = 0;
      while (start < text.length) {
        if (page.ranges.length >= 100 || budget - page.bytes <= 520) {
          pages.push(page); page = { ranges: [], chapters: {}, bytes: 0 };
        }
        const available = budget - page.bytes - 512;
        let end = start, bytes = 0;
        // JSON escaping is budgeted too, rather than undercounting control characters.
        for (let cursor = start; cursor < text.length;) {
          const point = String.fromCodePoint(text.codePointAt(cursor)!);
          const size = Buffer.byteLength(JSON.stringify(point)) - 2;
          if (bytes + size > available) break;
          bytes += size; end += point.length; cursor += point.length;
        }
        if (end === start) throw new AppError(422, "The saved passage cannot fit this reading budget.");
        page.ranges.push({ chapterId: chapter.id, documentVersionId: chapter.documentVersionId,
          nodeId: node.id, textHash, startOffset: start, endOffset: end });
        const entry = page.chapters[chapter.id] as { nodes: unknown[] } | undefined;
        const output: { nodes: unknown[]; [key: string]: unknown } = entry ?? { id: chapter.id, title: chapter.title, order: chapter.order,
          version: chapter.version, documentVersionId: chapter.documentVersionId, nodes: [] };
        output.nodes.push({ id: node.id, text: text.slice(start, end), textHash,
          excerptStart: start, excerptEnd: end, fullTextLength: text.length });
        page.chapters[chapter.id] = output;
        page.bytes += bytes + 512; start = end;
      }
    }
  }
  if (page.ranges.length) pages.push(page);
  if (!pages.length) throw new AppError(422, "Add saved manuscript text before extracting Book Bible candidates.");
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, maxTokens,
    chapters: chapters.map(({ nodes: _nodes, ...chapter }) => chapter),
    pages: pages.map(({ ranges }) => ranges) })).digest("hex");
  return { fingerprint, pages, totalBytes };
}
