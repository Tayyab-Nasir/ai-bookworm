"use client";

import { useEffect, useId, useRef, useState } from "react";

type Citation = { chapterId: string; documentVersionId: string; nodeId: string; textHash: string };
type BatchRange = { startOffset: number; endOffset: number };
type Passage = { chapterTitle: string; versionNumber: number; isCurrentVersion: boolean; text: string; truncated: boolean;
  startOffset: number; endOffset: number; totalLength: number; nextOffset: number | null; batchRange?: BatchRange | null };

type Props = { actorId: string; bookId: string; citation: Citation; title: string; jobId?: string;
  readRequest: <T>(path: string, method?: string, body?: unknown) => Promise<T> };

export default function BibleSourcePassage(props: Props) {
  const { actorId, bookId, citation } = props;
  if (!actorId) return null;
  return <SourceReader key={JSON.stringify([actorId, bookId, props.jobId, citation.chapterId, citation.documentVersionId, citation.nodeId, citation.textHash])} {...props} />;
}

function SourceReader({ bookId, citation, title, jobId, readRequest }: Props) {
  const regionId = useId();
  const [passage, setPassage] = useState<Passage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const inFlight = useRef(false), generation = useRef(0);
  useEffect(() => () => { ++generation.current; }, []);

  async function read(offset?: number, force = false) {
    if (inFlight.current) return;
    if (passage && offset === undefined && !force) { setOpen((value) => !value); return; }
    const requestedOffset = offset ?? (jobId ? undefined : 0);
    const current = ++generation.current;
    inFlight.current = true; setLoading(true); setError(null);
    try {
      const data = await readRequest<Passage>(`/books/${encodeURIComponent(bookId)}/bible/evidence`, "POST", {
        ...citation, ...(jobId ? { jobId } : {}), ...(requestedOffset === undefined ? {} : { offset: requestedOffset }),
      });
      if (current !== generation.current) return;
      if (!data || typeof data.text !== "string" || typeof data.isCurrentVersion !== "boolean") throw new Error("The saved passage is unavailable.");
      const range = data.batchRange;
      if (jobId && (!Object.hasOwn(data, "batchRange") || (range !== null && (!range
        || !Number.isSafeInteger(range.startOffset) || !Number.isSafeInteger(range.endOffset)
        || range.startOffset < 0 || range.startOffset >= range.endOffset || range.endOffset > data.totalLength
        || range.endOffset - range.startOffset > 24000)))) throw new Error("The AI reading range could not be verified.");
      if (typeof data.chapterTitle !== "string" || data.chapterTitle.length > 1000
        || !Number.isSafeInteger(data.versionNumber) || data.versionNumber < 1 || typeof data.truncated !== "boolean"
        || !Number.isSafeInteger(data.startOffset) || data.startOffset !== (requestedOffset ?? range?.startOffset ?? 0)
        || !Number.isSafeInteger(data.endOffset) || !Number.isSafeInteger(data.totalLength)
        || data.totalLength < 0 || data.endOffset > data.startOffset + 24000
        || data.endOffset < data.startOffset || data.endOffset > data.totalLength
        || data.text.length !== data.endOffset - data.startOffset
        || data.truncated !== (data.endOffset < data.totalLength)
        || (passage && (passage.versionNumber !== data.versionNumber || passage.totalLength !== data.totalLength))
        || (passage?.batchRange && (!range || passage.batchRange.startOffset !== range.startOffset || passage.batchRange.endOffset !== range.endOffset))
        || (data.nextOffset === null) !== (data.endOffset === data.totalLength)
        || (data.nextOffset !== null && (data.nextOffset !== data.endOffset || data.nextOffset <= data.startOffset))) {
        throw new Error("The saved passage position could not be verified.");
      }
      if (passage && data.startOffset > passage.startOffset) setPreviousOffsets((current) => [...current, passage.startOffset]);
      else if (passage && data.startOffset < passage.startOffset) setPreviousOffsets((current) =>
        current.at(-1) === data.startOffset ? current.slice(0, -1) : []);
      setPassage(data); setOpen(true);
    } catch (reason) {
      if (current === generation.current) {
        const status = (reason as { status?: unknown } | null)?.status;
        if (status === 401 || status === 403 || status === 404 || status === 409) {
          setPassage(null); setOpen(false); setPreviousOffsets([]);
        }
        setError(reason instanceof Error ? reason.message : "The saved passage could not be loaded.");
      }
    }
    finally { if (current === generation.current) { inFlight.current = false; setLoading(false); } }
  }

  return <div aria-busy={loading} className="min-w-0 rounded-lg border border-white/10 p-3 text-xs leading-5 text-[#aaa] [overflow-wrap:anywhere]">
    <span className="font-medium text-[#ddd]">{title}</span>
    <button type="button" aria-disabled={loading} aria-expanded={open} aria-controls={regionId} onClick={() => void read()} className="ml-3 min-h-11 rounded-lg px-2 text-sky-100 underline underline-offset-4 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
      {loading ? "Loading passage…" : open ? "Hide source passage" : "Read source passage"}
    </button>
    {error && <p role="alert" className="mt-2 text-red-200">{error}</p>}
    {open && passage && <div id={regionId} className="mt-3 border-t border-white/10 pt-3">
      <p className={passage.isCurrentVersion ? "text-[#999]" : "text-amber-100"}>
        Saved version {passage.versionNumber}{passage.isCurrentVersion ? " · current when loaded" : " · an earlier version; the chapter has changed"}
      </p>
      <blockquote key={passage.startOffset} tabIndex={0} aria-label="Saved source passage" className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-sky-200/30 pl-3 text-sm leading-6 text-[#ddd] outline-none focus-visible:ring-2 focus-visible:ring-white/50">{(() => {
        const from = passage.batchRange ? Math.max(0, passage.batchRange.startOffset - passage.startOffset) : 0;
        const to = passage.batchRange ? Math.min(passage.text.length, passage.batchRange.endOffset - passage.startOffset) : 0;
        return from < to ? <>{passage.text.slice(0, from)}<mark className="rounded bg-sky-100/15 text-sky-100">{passage.text.slice(from, to)}</mark>{passage.text.slice(to)}</> : passage.text;
      })()}</blockquote>
      {jobId && (passage.batchRange
        ? <p className="mt-2 text-[#aaa]">Highlighted text was selected for this AI request. Review the passage; the citation does not verify the candidate.</p>
        : <p className="mt-2 text-amber-100">The AI reading range is unavailable for this saved request. Showing the saved passage without a batch highlight.</p>)}
      <p aria-live="polite" className="mt-2 text-[#999]">Text positions {passage.startOffset.toLocaleString()}–{passage.endOffset.toLocaleString()} of {passage.totalLength.toLocaleString()} · saved passage</p>
      {jobId && <div className="mt-2 flex flex-wrap gap-2">
        {passage.startOffset > 0 && <button type="button" aria-disabled={loading} onClick={() => void read(0)} className="min-h-11 rounded-lg px-2 text-sky-100 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-white aria-disabled:opacity-40">Start of saved passage</button>}
        {passage.batchRange && passage.startOffset !== passage.batchRange.startOffset && <button type="button" aria-disabled={loading} onClick={() => void read(passage.batchRange!.startOffset)} className="min-h-11 rounded-lg px-2 text-sky-100 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-white aria-disabled:opacity-40">Show AI reading batch</button>}
        {!passage.batchRange && <button type="button" aria-disabled={loading} onClick={() => void read(undefined, true)} className="min-h-11 rounded-lg px-2 text-sky-100 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-white aria-disabled:opacity-40">Recheck AI reading range</button>}
      </div>}
      {(previousOffsets.length > 0 || passage.nextOffset !== null) && <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" aria-disabled={loading || !previousOffsets.length} onClick={() => previousOffsets.length > 0 && void read(previousOffsets[previousOffsets.length - 1])} className="min-h-11 rounded-lg border border-white/15 px-3 text-sky-100 outline-none focus-visible:ring-2 focus-visible:ring-white aria-disabled:cursor-not-allowed aria-disabled:opacity-40">Previous passage section</button>
        <button type="button" aria-disabled={loading || passage.nextOffset === null} onClick={() => passage.nextOffset !== null && void read(passage.nextOffset)} className="min-h-11 rounded-lg border border-white/15 px-3 text-sky-100 outline-none focus-visible:ring-2 focus-visible:ring-white aria-disabled:cursor-not-allowed aria-disabled:opacity-40">Next passage section</button>
      </div>}
    </div>}
  </div>;
}
