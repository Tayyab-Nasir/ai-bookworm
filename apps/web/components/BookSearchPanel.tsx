"use client";

import { useRef, useState, type FormEvent } from "react";
import type { BookSearchResult } from "@bookworm/api-client";
import { apiClient } from "./api";

export default function BookSearchPanel({ bookId }: { bookId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BookSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setResults([]); setSearched(false);
    try {
      const response = await apiClient().searchBook(bookId, { query: query.trim(), limit: 8 });
      if (current === generation.current) { setResults(response.results); setSearched(true); }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Search failed.");
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6" aria-labelledby="book-search-title">
    <h2 id="book-search-title" className="text-xl font-medium">Search your book</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-[#999]">Find exact words, names, and facts across saved chapters and Book Bible entries. Results cite current saved sources. This is private keyword search, not an AI-generated answer.</p>
    <form onSubmit={search} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="min-w-0 flex-1 text-xs text-[#aaa]">Words or phrase
        <input type="search" maxLength={1000} value={query} onChange={(event) => setQuery(event.target.value)} required placeholder='Try Elara, or "silver compass"' className="mt-2 w-full rounded-xl border border-white/15 bg-black px-4 py-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50" />
      </label>
      <button disabled={busy || !query.trim()} className="min-h-11 rounded-full bg-white px-5 py-3 text-sm font-semibold text-black disabled:opacity-50">{busy ? "Searching…" : "Search saved sources"}</button>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-red-200">{error}</p>}
    {searched && <p role="status" className="mt-4 text-xs text-[#999]">{results.length ? `${results.length} matching passages. Showing the highest-ranked results.` : "No matching passage. Try fewer words, another spelling, or OR between alternatives."}</p>}
    <div className="mt-4 grid gap-3 lg:grid-cols-2">{results.map((result) => <article key={result.id} className="min-w-0 rounded-xl border border-white/10 p-4">
      <p className="text-[10px] uppercase tracking-widest text-[#999]">{result.source_type === "bible" ? "Book Bible" : "Saved manuscript"}</p>
      <h3 className="mt-2 break-words font-medium">{result.title}</h3>
      <blockquote className="mt-3 whitespace-pre-wrap break-words border-l border-white/20 pl-3 text-sm leading-6 text-[#ccc]">{result.excerpt}</blockquote>
      <details className="mt-3 text-xs text-[#999]"><summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-white">Source citation</summary><dl className="mt-2 space-y-1 break-all">
        <dt>Source ID</dt><dd>{result.bible_item_id ?? result.chapter_id}</dd>
        {result.document_version_id && <><dt>Saved version</dt><dd>{result.document_version_id}</dd><dt>Node</dt><dd>{result.node_id}</dd></>}
        <dt>Passage fingerprint</dt><dd>{result.text_hash}</dd>
      </dl></details>
    </article>)}</div>
  </section>;
}
