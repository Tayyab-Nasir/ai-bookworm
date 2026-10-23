"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SearchPassageCitation, SearchSourcePassage as Passage } from "@bookworm/api-client";
import { parseSearchPassage } from "../lib/book-search";
import { apiClient } from "./api";

export default function SearchSourcePassage(props: { bookId: string; citation: SearchPassageCitation }) {
  const c = props.citation;
  return <SourceReader key={`${props.bookId}:${c.chapterId}:${c.documentVersionId}:${c.nodeId}:${c.chunkIndex}:${c.textHash}`} {...props} />;
}

function SourceReader({ bookId, citation }: { bookId: string; citation: SearchPassageCitation }) {
  const regionId = useId();
  const [passage, setPassage] = useState<Passage | null>(null), [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const generation = useRef(0), inFlight = useRef(false);
  useEffect(() => () => { ++generation.current; }, []);
  async function read(offset?: number) {
    if (inFlight.current) return;
    if (passage && offset === undefined) { setOpen(value => !value); return; }
    const current = ++generation.current; inFlight.current = true; setBusy(true); setError(null);
    try {
      const response = await apiClient().readSearchPassage(bookId, { ...citation, ...(offset === undefined ? {} : { offset }) });
      if (current !== generation.current) return;
      const verified = parseSearchPassage(response, bookId, citation, offset);
      if (passage && (passage.versionNumber !== verified.versionNumber || passage.totalLength !== verified.totalLength)) {
        throw new Error("The saved source changed unexpectedly. Search again before using this passage.");
      }
      setPassage(verified); setOpen(true);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "The cited source could not be read.");
    } finally { if (current === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  const points = passage ? Array.from(passage.text) : [];
  const from = passage ? Math.max(0, passage.matchedStart - passage.startOffset) : 0;
  const to = passage ? Math.min(points.length, passage.matchedEnd - passage.startOffset) : 0;
  const button = "min-h-11 rounded-lg px-3 py-2 text-sm text-sky-100 underline underline-offset-4 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
  return <div className="mt-3 min-w-0 rounded-lg border border-white/10 bg-black/20 p-3 [overflow-wrap:anywhere]" aria-busy={busy}>
    <button type="button" aria-disabled={busy} aria-expanded={open} aria-controls={regionId} onClick={() => void read()} className={button}>
      {busy ? "Loading cited source…" : open ? "Hide cited source" : "Read cited source"}
    </button>
    {error && <p role="alert" className="mt-2 text-sm text-red-200">{error}</p>}
    {open && passage && <div id={regionId} className="mt-2 border-t border-white/10 pt-3">
      <p role="status" className={`text-xs ${passage.isCurrentVersion ? "text-[#aaa]" : "text-amber-100"}`}>
        Saved version {passage.versionNumber}{passage.isCurrentVersion ? " · current when loaded" : " · earlier version; the chapter has changed"}
      </p>
      <blockquote tabIndex={0} aria-label="Cited source text" className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-sky-200/30 pl-3 text-sm leading-6 text-[#ddd] outline-none focus-visible:ring-2 focus-visible:ring-white/50">
        {from < to ? <>{points.slice(0, from).join("")}<mark className="rounded bg-sky-100/15 text-sky-100">{points.slice(from, to).join("")}</mark>{points.slice(to).join("")}</> : passage.text}
      </blockquote>
      <p className="mt-3 text-xs leading-5 text-[#999]">Saved searchable text, including captions, image descriptions and table cells when present. Highlighting identifies the cited search passage, not an AI answer.</p>
      <p aria-live="polite" className="mt-2 text-xs text-[#aaa]">Characters {(passage.startOffset + 1).toLocaleString()}–{passage.endOffset.toLocaleString()} of {passage.totalLength.toLocaleString()}</p>
      {(passage.previousOffset !== null || passage.nextOffset !== null) && <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" aria-disabled={busy || passage.previousOffset === null} onClick={() => passage.previousOffset !== null && void read(passage.previousOffset)} className={button}>Previous source section</button>
        <button type="button" aria-disabled={busy || passage.nextOffset === null} onClick={() => passage.nextOffset !== null && void read(passage.nextOffset)} className={button}>Next source section</button>
      </div>}
    </div>}
  </div>;
}
