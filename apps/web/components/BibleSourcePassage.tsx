"use client";

import { useState } from "react";

type Citation = { chapterId: string; documentVersionId: string; nodeId: string; textHash: string };
type Passage = { chapterTitle: string; versionNumber: number; isCurrentVersion: boolean; text: string; truncated: boolean;
  startOffset: number; endOffset: number; totalLength: number; nextOffset: number | null };

export default function BibleSourcePassage({ bookId, citation, title }: { bookId: string; citation: Citation; title: string }) {
  const [passage, setPassage] = useState<Passage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);

  async function read(offset?: number) {
    if (passage && offset === undefined) { setOpen((value) => !value); return; }
    const requestedOffset = offset ?? 0;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/backend/v1/books/${encodeURIComponent(bookId)}/bible/evidence`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ...citation, offset: requestedOffset }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "The saved passage could not be loaded.");
      if (typeof data.text !== "string" || typeof data.isCurrentVersion !== "boolean") throw new Error("The saved passage is unavailable.");
      if (data.startOffset !== requestedOffset || !Number.isInteger(data.endOffset) || !Number.isInteger(data.totalLength)
        || data.endOffset < data.startOffset || data.endOffset > data.totalLength
        || data.text.length !== data.endOffset - data.startOffset
        || (data.nextOffset === null) !== (data.endOffset === data.totalLength)
        || (data.nextOffset !== null && (data.nextOffset !== data.endOffset || data.nextOffset <= data.startOffset))) {
        throw new Error("The saved passage position could not be verified.");
      }
      if (passage && requestedOffset > passage.startOffset) setPreviousOffsets((current) => [...current, passage.startOffset]);
      else if (passage && requestedOffset < passage.startOffset) setPreviousOffsets((current) => current.slice(0, -1));
      setPassage(data); setOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The saved passage could not be loaded."); }
    finally { setLoading(false); }
  }

  return <div className="rounded-lg border border-white/10 p-3 text-xs leading-5 text-[#aaa]">
    <span className="font-medium text-[#ddd]">{title}</span>
    <button type="button" disabled={loading} aria-expanded={open} onClick={() => void read()} className="ml-3 min-h-9 rounded-lg px-2 text-sky-100 underline underline-offset-4 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50">
      {loading ? "Loading passage…" : open ? "Hide source passage" : "Read source passage"}
    </button>
    {error && <p role="alert" className="mt-2 text-red-200">{error}</p>}
    {open && passage && <div className="mt-3 border-t border-white/10 pt-3">
      <p className={passage.isCurrentVersion ? "text-[#999]" : "text-amber-100"}>
        Saved version {passage.versionNumber}{passage.isCurrentVersion ? " · current when loaded" : " · an earlier version; the chapter has changed"}
      </p>
      <blockquote key={passage.startOffset} className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-sky-200/30 pl-3 text-sm leading-6 text-[#ddd]">{passage.text}</blockquote>
      <p aria-live="polite" className="mt-2 text-[#999]">Text positions {passage.startOffset.toLocaleString()}–{passage.endOffset.toLocaleString()} of {passage.totalLength.toLocaleString()} · saved passage</p>
      {(previousOffsets.length > 0 || passage.nextOffset !== null) && <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" disabled={loading || !previousOffsets.length} onClick={() => void read(previousOffsets[previousOffsets.length - 1])} className="min-h-10 rounded-lg border border-white/15 px-3 text-sky-100 disabled:opacity-40">Previous passage section</button>
        <button type="button" disabled={loading || passage.nextOffset === null} onClick={() => passage.nextOffset !== null && void read(passage.nextOffset)} className="min-h-10 rounded-lg border border-white/15 px-3 text-sky-100 disabled:opacity-40">Next passage section</button>
      </div>}
    </div>}
  </div>;
}
