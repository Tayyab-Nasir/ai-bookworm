"use client";

import { useState } from "react";

type Citation = { chapterId: string; documentVersionId: string; nodeId: string; textHash: string };
type Passage = { chapterTitle: string; versionNumber: number; isCurrentVersion: boolean; text: string; truncated: boolean };

export default function BibleSourcePassage({ bookId, citation, title }: { bookId: string; citation: Citation; title: string }) {
  const [passage, setPassage] = useState<Passage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function read() {
    if (passage) { setOpen((value) => !value); return; }
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/backend/v1/books/${encodeURIComponent(bookId)}/bible/evidence`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify(citation),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "The saved passage could not be loaded.");
      if (typeof data.text !== "string" || typeof data.isCurrentVersion !== "boolean") throw new Error("The saved passage is unavailable.");
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
      <blockquote className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-sky-200/30 pl-3 text-sm leading-6 text-[#ddd]">{passage.text}</blockquote>
      {passage.truncated && <p className="mt-2 text-amber-100">Only the beginning of this long passage is displayed. Review the full saved version in the manuscript history.</p>}
    </div>}
  </div>;
}
