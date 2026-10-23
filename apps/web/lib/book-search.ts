import type { BookSearchResult, SearchPassageCitation, SearchSourcePassage } from "@bookworm/api-client";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, min = 0): value is string => typeof value === "string" && value.length >= min && value.length <= max;
const position = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4_000_000;
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const invalid = () => new Error("The saved search evidence could not be verified. Search again or retry reading the source.");

export function parseSearchResults(value: unknown, query: string): BookSearchResult[] {
  if (!record(value) || value.strategy !== "postgres_full_text" || value.query !== query || !Array.isArray(value.results) || value.results.length > 8) throw invalid();
  const ids = new Set<string>();
  return value.results.map((row: unknown) => {
    if (!record(row) || !uuid(row.id) || ids.has(row.id) || !text(row.title, 1000)
      || !text(row.excerpt, 3600, 1) || Array.from(row.excerpt).length > 1800 || !fingerprint(row.text_hash)
      || !position(row.chunk_index) || row.chunk_index % 1600 !== 0
      || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0) throw invalid();
    if (row.source_type === "manuscript" ? !uuid(row.chapter_id) || !uuid(row.document_version_id) || !text(row.node_id, 200, 1) || row.bible_item_id !== null
      : row.source_type !== "bible" || !uuid(row.bible_item_id) || row.chapter_id !== null || row.document_version_id !== null || row.node_id !== null) throw invalid();
    ids.add(row.id);
    return { id: row.id, source_type: row.source_type, chapter_id: row.chapter_id, bible_item_id: row.bible_item_id,
      document_version_id: row.document_version_id, node_id: row.node_id, chunk_index: row.chunk_index,
      title: row.title, excerpt: row.excerpt, text_hash: row.text_hash, score: row.score } as BookSearchResult;
  });
}

export function searchCitation(result: BookSearchResult): SearchPassageCitation | null {
  return result.source_type === "manuscript" && result.chapter_id && result.document_version_id && result.node_id
    ? { chapterId: result.chapter_id, documentVersionId: result.document_version_id, nodeId: result.node_id,
      chunkIndex: result.chunk_index, textHash: result.text_hash } : null;
}

export function parseSearchPassage(value: unknown, bookId: string, citation: SearchPassageCitation, offset?: number): SearchSourcePassage {
  if (!record(value) || !record(value.citation)) throw invalid();
  const returnedCitation = value.citation;
  if (value.bookId !== bookId
    || Object.keys(citation).some(key => returnedCitation[key] !== citation[key as keyof SearchPassageCitation])
    || !text(value.chapterTitle, 1000) || !Number.isSafeInteger(value.versionNumber) || Number(value.versionNumber) < 1
    || typeof value.isCurrentVersion !== "boolean" || !text(value.text, 12000, 1)
    || !position(value.startOffset) || !position(value.endOffset) || !position(value.totalLength) || value.totalLength < 1
    || value.startOffset !== (offset ?? Math.max(0, citation.chunkIndex - 300))
    || value.startOffset >= value.totalLength || value.endOffset !== Math.min(value.totalLength, value.startOffset + 6000)
    || Array.from(value.text).length !== value.endOffset - value.startOffset
    || value.previousOffset !== (value.startOffset ? Math.max(0, value.startOffset - 6000) : null)
    || value.nextOffset !== (value.endOffset < value.totalLength ? value.endOffset : null)
    || citation.chunkIndex >= value.totalLength || value.matchedStart !== citation.chunkIndex
    || value.matchedEnd !== Math.min(value.totalLength, citation.chunkIndex + 1800)) throw invalid();
  return { bookId, citation: { ...citation }, chapterTitle: value.chapterTitle, versionNumber: Number(value.versionNumber),
    isCurrentVersion: value.isCurrentVersion, text: value.text, startOffset: value.startOffset, endOffset: value.endOffset,
    totalLength: value.totalLength, previousOffset: value.previousOffset as number | null,
    nextOffset: value.nextOffset as number | null, matchedStart: value.matchedStart as number, matchedEnd: value.matchedEnd as number };
}
