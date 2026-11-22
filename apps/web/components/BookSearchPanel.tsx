"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BookSearchResult, SearchBibleEntry } from "@bookworm/api-client";
import type { BookBibleItem } from "@bookworm/types";
import { apiClient } from "./api";
import { parseSearchBibleEntry, parseSearchResults, searchCitation } from "../lib/book-search";
import SearchSourcePassage from "./SearchSourcePassage";

type ScopedRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export default function BookSearchPanel(props: { bookId: string; onOpenBibleEntry?: (item: BookBibleItem) => void; readRequest?: ScopedRequest }) {
  return <SearchPanel key={props.bookId} {...props} />;
}
function SearchPanel({ bookId, onOpenBibleEntry, readRequest }: { bookId: string; onOpenBibleEntry?: (item: BookBibleItem) => void; readRequest?: ScopedRequest }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BookSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingBibleId, setOpeningBibleId] = useState<string | null>(null);
  const opener = useRef(onOpenBibleEntry);
  useEffect(() => { opener.current = onOpenBibleEntry; }, [onOpenBibleEntry]);
  const generation = useRef(0);
  useEffect(() => () => { ++generation.current; }, []);
  function changeQuery(value: string) {
    // A response for the old phrase must never appear below the new phrase.
    ++generation.current;
    setQuery(value); setResults([]); setSearched(false); setError(null); setBusy(false); setOpeningBibleId(null);
  }
  function invalidateSources() {
    ++generation.current;
    setResults([]); setSearched(false); setBusy(false); setOpeningBibleId(null);
    setError("Search results were cleared because access or a saved citation changed. Check your access and search again.");
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setResults([]); setSearched(false); setOpeningBibleId(null);
    try {
      const response = readRequest
        ? await readRequest<{ results: BookSearchResult[]; strategy: "postgres_full_text"; query: string }>(`/books/${encodeURIComponent(bookId)}/search`, "POST", { query: query.trim(), limit: 8 })
        : await apiClient().searchBook(bookId, { query: query.trim(), limit: 8 });
      if (current === generation.current) { setResults(parseSearchResults(response, query.trim())); setSearched(true); }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Search failed.");
    } finally { if (current === generation.current) setBusy(false); }
  }
  async function openBible(result: BookSearchResult) {
    if (!opener.current || !result.bible_item_id || openingBibleId) return;
    const current = ++generation.current;
    const citation = { bibleItemId: result.bible_item_id, chunkIndex: result.chunk_index, textHash: result.text_hash };
    setOpeningBibleId(result.id); setError(null);
    try {
      const response = readRequest
        ? await readRequest<SearchBibleEntry>(`/books/${encodeURIComponent(bookId)}/search/bible-evidence`, "POST", citation)
        : await apiClient().readSearchBibleEntry(bookId, citation);
      if (current !== generation.current) return;
      opener.current?.(parseSearchBibleEntry(response, bookId, citation));
    } catch (reason) {
      if (current !== generation.current) return;
      const status = (reason as { status?: unknown } | null)?.status;
      if (status === 401 || status === 403 || status === 404 || status === 409) invalidateSources();
      else setError(reason instanceof Error ? reason.message : "Could not open the cited Book Bible entry.");
    } finally {
      if (current === generation.current) setOpeningBibleId(null);
    }
  }
  return <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6" aria-labelledby="book-search-title">
    <h2 id="book-search-title" className="text-xl font-medium">Search your book</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-[#999]">Find exact words, names, and facts across saved chapters and Book Bible entries. Results cite current saved sources. This is private keyword search, not an AI-generated answer.</p>
    <form onSubmit={search} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="min-w-0 flex-1 text-xs text-[#aaa]">Words or phrase
        <input type="search" maxLength={1000} value={query} onChange={(event) => changeQuery(event.target.value)} required placeholder='Try Elara, or "silver compass"' className="mt-2 w-full rounded-xl border border-white/15 bg-black px-4 py-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50" />
      </label>
      <button disabled={busy || !query.trim()} className="min-h-11 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black disabled:opacity-50">{busy ? "Searching…" : "Search saved sources"}</button>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-red-200">{error}</p>}
    {searched && <p role="status" className="mt-4 text-xs text-[#999]">{results.length ? `${results.length} matching passages. Showing the highest-ranked results.` : "No matching passage. Try fewer words, another spelling, or OR between alternatives."}</p>}
    <div className="mt-4 grid items-start gap-3 lg:grid-cols-2">{results.map((result) => <article key={result.id} className="min-w-0 rounded-xl border border-white/10 p-4">
      <p className="text-[10px] uppercase tracking-widest text-[#999]">{result.source_type === "bible" ? "Book Bible" : "Saved manuscript"}</p>
      <h3 className="mt-2 break-words font-medium">{result.title}</h3>
      <blockquote tabIndex={0} aria-label="Search excerpt" className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-l border-white/20 pl-3 text-sm leading-6 text-[#ccc] outline-none focus-visible:ring-2 focus-visible:ring-white/50">{result.excerpt}</blockquote>
      {searchCitation(result) && <SearchSourcePassage bookId={bookId} citation={searchCitation(result)!} readRequest={readRequest} onInvalidated={invalidateSources} />}
      {result.source_type === "manuscript" && result.chapter_id && <Link href={`/books/${encodeURIComponent(bookId)}?chapter=${encodeURIComponent(result.chapter_id)}`} className="mt-3 inline-flex min-h-10 items-center text-sm font-medium text-white underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-white">Open current chapter →</Link>}
      {result.source_type === "bible" && result.bible_item_id && onOpenBibleEntry && <button type="button" disabled={openingBibleId !== null}
        onClick={() => void openBible(result)} className="mt-3 block min-h-11 text-sm font-medium text-white underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50">
        {openingBibleId === result.id ? "Checking Book Bible entry…" : "Open Book Bible entry →"}
      </button>}
      <details className="mt-3 text-xs text-[#999]"><summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-white">Source citation</summary><dl className="mt-2 space-y-1 break-all">
        <dt>Source ID</dt><dd>{result.bible_item_id ?? result.chapter_id}</dd>
        {result.document_version_id && <><dt>Saved version</dt><dd>{result.document_version_id}</dd><dt>Node</dt><dd>{result.node_id}</dd></>}
        <dt>Passage fingerprint</dt><dd>{result.text_hash}</dd>
      </dl></details>
    </article>)}</div>
  </section>;
}
