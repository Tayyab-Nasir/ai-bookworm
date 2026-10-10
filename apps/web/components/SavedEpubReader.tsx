"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiClientError, type EpubReaderResource, type EpubReaderResult, type SavedEpubRender, type SavedEpubSource } from "@bookworm/api-client";
import { apiClient } from "./api";
import { buildReaderDocument, createReaderFence, readerImageOccurrences, readerSourceKey, retainReaderImage, validateReaderDownload, validateReaderHistory, validateReaderSection, verifyReaderResource, type ReaderPreferences, type RetainedReaderImage } from "../lib/epub-reader";

const control = "min-h-11 rounded-lg border border-[var(--bookworm-proof-edge)] bg-[var(--bookworm-proof-paper)] px-3 py-2 text-sm text-[var(--bookworm-proof-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bookworm-proof-action)] disabled:opacity-45";
const authorizationFailure = (reason: unknown) => reason instanceof ApiClientError && [401, 403].includes(reason.status);
const retryMessage = (reason: unknown) => reason instanceof ApiClientError && reason.status === 503 ? "The saved reader is busy. Retry this saved export in a moment; no credits are used." : "This saved export could not be read or verified. Retry, or download the exact EPUB for inspection.";

export default function SavedEpubReader({ bookId, editionId, dirty = false, refreshKey = "" }: { bookId: string; editionId: string; dirty?: boolean; refreshKey?: string }) {
  const api = apiClient(); const id = useId(); const owner = `${bookId}:${editionId}`;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const [visibleOwner, setVisibleOwner] = useState(owner);
  const [renders, setRenders] = useState<SavedEpubRender[]>([]);
  const [source, setSource] = useState<SavedEpubSource | null>(null);
  const [section, setSection] = useState<EpubReaderResult | null>(null);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const [occurrenceIndex, setOccurrenceIndex] = useState(0);
  const [occurrenceInput, setOccurrenceInput] = useState("1");
  const [inspecting, setInspecting] = useState(false);
  const [images, setImages] = useState<Map<number, RetainedReaderImage>>(new Map());
  const imagesRef = useRef(images);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [sectionBusy, setSectionBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState<number | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [download, setDownload] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<ReaderPreferences>({ font: "serif", size: 20, leading: 1.7 });
  const [zoom, setZoom] = useState(100);
  const [stageWidth, setStageWidth] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const historyFence = useRef(createReaderFence()); const contentFence = useRef(createReaderFence());
  const sectionValid = useRef<() => boolean>(() => false);
  const downloadGeneration = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // The private reader API admits one byte read at a time. Queue GETs rather
  // than racing sections and images; stale queued work never sends a request.
  const readerGet = useCallback(<T,>(valid: () => boolean, call: () => Promise<T>): Promise<T | undefined> => {
    const request = queue.current.catch(() => undefined).then(() => valid() ? call() : undefined);
    queue.current = request.then(() => undefined, () => undefined);
    return request;
  }, []);
  const clearContent = useCallback(() => {
    contentFence.current.clear(); sectionValid.current = () => false; downloadGeneration.current++;
    imagesRef.current = new Map(); setImages(new Map()); setSection(null); setSource(null);
    setSectionBusy(false); setImageBusy(null); setImageIndex(null); setDownload(null); setDownloadBusy(false);
    setOccurrenceIndex(0); setOccurrenceInput("1"); setInspecting(false);
  }, []);
  const failAuthorization = useCallback(() => {
    historyFence.current.clear(); clearContent(); setRenders([]); setHistoryBusy(false);
    setError("Your session or access changed. Sign in again before opening private saved exports.");
  }, [clearContent]);
  const loadImage = useCallback(async (document: EpubReaderResult, descriptor: EpubReaderResource, valid: () => boolean) => {
    if (!valid()) return;
    setImageBusy(descriptor.index); setError(null);
    try {
      const result = await readerGet(valid, () => api.readEpubResource(editionId, document.source.jobId, descriptor.index, document.source.sha256));
      if (!valid() || !result) return;
      const url = verifyReaderResource(result, document.source, descriptor);
      const next = retainReaderImage(imagesRef.current, descriptor.index, url, descriptor.sizeBytes, descriptor.width, descriptor.height);
      imagesRef.current = next; setImages(next);
    } catch (reason) { if (valid()) { if (authorizationFailure(reason)) failAuthorization(); else setError(retryMessage(reason)); } }
    finally { if (valid()) setImageBusy(null); }
  }, [api, editionId, failAuthorization, readerGet]);
  const readSection = useCallback(async (selected: SavedEpubSource, index: number) => {
    const ticket = contentFence.current.reset(`${owner}:${readerSourceKey(selected)}:${index}`);
    const valid = () => ownerRef.current === owner && ticket(); sectionValid.current = valid;
    downloadGeneration.current++; setDownload(null); setDownloadBusy(false);
    imagesRef.current = new Map(); setImages(new Map()); setSection(null); setSource(selected);
    setSectionIndex(index); setImageIndex(null); setImageBusy(null); setSectionBusy(true); setError(null); setZoom(100);
    setOccurrenceIndex(0); setOccurrenceInput("1"); setInspecting(false);
    try {
      const result = await readerGet(valid, () => api.readEpubSection(editionId, selected.jobId, index, selected.sha256));
      if (!valid() || !result) return;
      const verified = validateReaderSection(result, selected, index);
      setSection(verified); setSectionBusy(false);
      const firstOccurrence = readerImageOccurrences(verified)[0];
      const first = verified.document.resources.find((image) => image.index === firstOccurrence?.resourceIndex); setImageIndex(first?.index ?? null);
      // One initial raster keeps fixed pages immediately useful. Every other
      // illustration is explicitly available through the parent controls.
      if (first) void loadImage(verified, first, valid);
    } catch (reason) { if (valid()) { if (authorizationFailure(reason)) failAuthorization(); else setError(retryMessage(reason)); } }
    finally { if (valid()) setSectionBusy(false); }
  }, [api, editionId, failAuthorization, loadImage, owner, readerGet]);
  const refreshHistory = useCallback(async () => {
    const ticket = historyFence.current.reset(owner); const valid = () => ownerRef.current === owner && ticket();
    clearContent(); setVisibleOwner(owner); setRenders([]); setError(null); setHistoryBusy(true);
    try {
      const result = await api.listEditionRenders(editionId); if (!valid()) return;
      const verified = validateReaderHistory(result, bookId, editionId); setRenders(verified);
      if (verified[0]) void readSection(verified[0].source, 0);
    } catch (reason) { if (valid()) { if (authorizationFailure(reason)) failAuthorization(); else setError(retryMessage(reason)); } }
    finally { if (valid()) setHistoryBusy(false); }
  }, [api, bookId, clearContent, editionId, failAuthorization, owner, readSection]);
  useEffect(() => {
    void refreshHistory();
    return () => { historyFence.current.clear(); contentFence.current.clear(); sectionValid.current = () => false; downloadGeneration.current++; imagesRef.current.clear(); };
  }, [refreshHistory, refreshKey]);
  useEffect(() => {
    if (!download) return;
    const timer = window.setTimeout(() => setDownload(null), Math.max(0, download.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [download]);
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width)); observer.observe(element);
    return () => observer.disconnect();
  }, [section?.document.layout]);

  const current = visibleOwner === owner;
  const activeSection = current && source && section && readerSourceKey(section.source) === readerSourceKey(source) ? section : null;
  const activeRender = current && source ? renders.find((render) => readerSourceKey(render.source) === readerSourceKey(source)) : null;
  const occurrences = useMemo(() => activeSection ? readerImageOccurrences(activeSection) : [], [activeSection]);
  const frame = useMemo(() => {
    if (!activeSection) return { html: null, failed: false, deferred: 0 };
    try {
      const html = buildReaderDocument(activeSection, new Map([...images].map(([index, image]) => [index, image.url])), preferences, { selectedOccurrence: occurrenceIndex });
      return { html, failed: false, deferred: (html.match(/<span class="reader-placeholder" data-reader-deferred="1"/g) ?? []).length };
    } catch { return { html: null, failed: true, deferred: 0 }; }
  }, [activeSection, images, preferences, occurrenceIndex]);
  const fixed = activeSection?.document.layout === "pre-paginated";
  const pageRatio = fixed ? activeSection.document.width! / activeSection.document.height! : 1;
  const fitWidth = Math.min(stageWidth || 320, 680 * pageRatio);
  const pageWidth = fitWidth * zoom / 100; const pageHeight = pageWidth / pageRatio;
  const selectedImage = activeSection?.document.resources.find((image) => image.index === imageIndex);
  const selectedOccurrence = occurrences[occurrenceIndex];
  const enteredOccurrence = Number(occurrenceInput);
  const validOccurrence = /^\d+$/.test(occurrenceInput) && Number.isSafeInteger(enteredOccurrence) && enteredOccurrence >= 1 && enteredOccurrence <= occurrences.length;
  const retainedBytes = [...images.values()].reduce((sum, image) => sum + image.sizeBytes, 0);
  function inspectOccurrence(position: number) {
    if (!activeSection || imageBusy !== null || !occurrences[position]) return;
    const occurrence = occurrences[position];
    setOccurrenceIndex(position); setOccurrenceInput(String(position + 1)); setImageIndex(occurrence.resourceIndex); setInspecting(true);
    const descriptor = activeSection.document.resources.find((image) => image.index === occurrence.resourceIndex);
    if (descriptor && !images.has(descriptor.index)) void loadImage(activeSection, descriptor, sectionValid.current);
  }
  async function renewDownload() {
    if (!source || !current || downloadBusy) return;
    const selected = source; const validSection = sectionValid.current; const generation = ++downloadGeneration.current;
    const valid = () => ownerRef.current === owner && validSection() && generation === downloadGeneration.current;
    setDownload(null); setDownloadBusy(true); setError(null);
    try {
      const result = await api.getAssetDownloadUrl(selected.assetId, 1); if (!valid()) return;
      setDownload({ url: validateReaderDownload(result), expiresAt: Date.now() + result.expiresIn * 1000 });
    } catch (reason) { if (valid()) { if (authorizationFailure(reason)) failAuthorization(); else setError("The private download link is unavailable. Renew it to download this exact saved version."); } }
    finally { if (valid()) setDownloadBusy(false); }
  }

  return <section aria-labelledby={`${id}-title`} data-saved-epub-reader className="min-w-0 overflow-hidden rounded-2xl border border-[var(--bookworm-proof-edge)] bg-[var(--bookworm-proof-paper)] text-[var(--bookworm-proof-ink)]">
    <header className="border-b border-[var(--bookworm-proof-edge)] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--bookworm-proof-muted)]">Bookworm / proof desk</p><h2 id={`${id}-title`} className="mt-2 pb-1 font-instrument text-4xl italic leading-[1.1] sm:text-5xl">Saved EPUB proof</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--bookworm-proof-copy)]">Read a private, dated export. This opens the saved file, not a new render, and uses no generation credits.</p></div><button type="button" onClick={() => void refreshHistory()} disabled={historyBusy} className={control}>{historyBusy ? "Checking exports…" : "Refresh saved exports"}</button></div>
      <p className="mt-4 border-s-2 border-[var(--bookworm-proof-edge)] ps-3 text-sm leading-6 text-[var(--bookworm-proof-copy)]">{dirty ? "Unsaved edition settings are not included. " : ""}Manuscript and settings changes after the export are not included in this snapshot.</p>
      {(current && renders.length > 0) && <label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-[var(--bookworm-proof-muted)]">Saved export<select aria-label="Saved EPUB export" value={source?.jobId ?? ""} onChange={(event) => { const render = renders.find((entry) => entry.jobId === event.target.value); if (render) void readSection(render.source, 0); }} className={`${control} mt-2 block w-full min-w-0 font-normal normal-case tracking-normal`}><option value="" disabled>Select a saved export</option>{renders.map((render) => <option key={render.jobId} value={render.jobId}>{new Date(render.createdAt).toLocaleString()} · {render.source.sha256.slice(0, 12)}…</option>)}</select></label>}
      {activeRender && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--bookworm-proof-muted)]"><p><time dateTime={activeRender.createdAt}>{new Date(activeRender.createdAt).toLocaleString()}</time> · immutable v1 · {(activeRender.source.sizeBytes / 1024).toFixed(0)} KB</p><details className="min-w-0 max-w-full"><summary className="cursor-pointer rounded py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Source & checksum</summary><dl className="mt-2 grid gap-2 break-all font-mono text-[11px]"><dt>SHA-256</dt><dd>{activeRender.source.sha256}</dd><dt>Saved job / asset v1</dt><dd>{activeRender.source.jobId} / {activeRender.source.assetId}</dd></dl></details></div>}
    </header>
    {current && (error || frame.failed) && <div role="alert" className="m-5 rounded-lg border border-[var(--bookworm-proof-edge)] p-4 text-sm leading-6">{error ?? "The saved section could not be safely displayed. Retry it or download the exact EPUB for inspection."}</div>}
    {current && (historyBusy || sectionBusy) && <p role="status" className="p-5 text-sm text-[var(--bookworm-proof-muted)]">{historyBusy ? "Checking private saved exports…" : "Opening this exact saved section…"}</p>}
    {current && !historyBusy && renders.length === 0 && !error && <p className="p-6 text-sm leading-6 text-[var(--bookworm-proof-copy)]">No saved EPUB is available for this edition. Save your settings and use Render EPUB above to create one, then refresh here.</p>}
    {current && source && !sectionBusy && !activeSection && <div className="px-5 pb-5"><button type="button" onClick={() => void readSection(source, sectionIndex)} className={control}>Retry saved section</button></div>}
    {activeSection && <>
      <div className="grid gap-4 border-b border-[var(--bookworm-proof-edge)] p-5 sm:p-6">
        <div className="flex min-w-0 flex-wrap items-end gap-3"><label className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-[var(--bookworm-proof-muted)]">{fixed ? "Page / section" : "Chapter / section"}<select aria-label="Saved EPUB section" value={activeSection.document.index} onChange={(event) => void readSection(activeSection.source, Number(event.target.value))} className={`${control} mt-2 block w-full min-w-0 font-normal normal-case tracking-normal`}>{activeSection.spine.map((item) => <option key={item.index} value={item.index}>{item.index + 1}. {item.title || "Untitled section"}{item.layout === "pre-paginated" ? " · fixed page" : ""}</option>)}</select></label><div className="flex gap-2"><button type="button" onClick={() => void readSection(activeSection.source, activeSection.document.index - 1)} disabled={activeSection.document.index === 0} className={control} aria-label="Previous saved section">Previous</button><button type="button" onClick={() => void readSection(activeSection.source, activeSection.document.index + 1)} disabled={activeSection.document.index === activeSection.spine.length - 1} className={control} aria-label="Next saved section">Next</button></div></div>
        {fixed ? <div className="flex flex-wrap items-center gap-3"><label className="text-sm">Page zoom<select aria-label="Fixed page zoom" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className={`${control} ms-3`}>{[50, 100, 125, 150, 200].map((value) => <option key={value} value={value}>{value === 100 ? "Fit page" : `${value}%`}</option>)}</select></label><span className="text-xs text-[var(--bookworm-proof-muted)]">{activeSection.document.width} × {activeSection.document.height} · fixed layout</span></div> : <div className="flex flex-wrap gap-3"><label className="text-sm">Reader type<select aria-label="Reader type" value={preferences.font} onChange={(event) => setPreferences({ ...preferences, font: event.target.value as ReaderPreferences["font"] })} className={`${control} ms-2`}><option value="serif">Book serif</option><option value="sans">Plain sans</option></select></label><label className="text-sm">Size<select aria-label="Reader text size" value={preferences.size} onChange={(event) => setPreferences({ ...preferences, size: Number(event.target.value) })} className={`${control} ms-2`}>{[16, 18, 20, 22, 24, 28].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label><label className="text-sm">Spacing<select aria-label="Reader line spacing" value={preferences.leading} onChange={(event) => setPreferences({ ...preferences, leading: Number(event.target.value) })} className={`${control} ms-2`}><option value={1.5}>Compact</option><option value={1.7}>Comfortable</option><option value={1.9}>Open</option></select></label></div>}
        {activeSection.document.resources.length > 0 && <div className="border-t border-[var(--bookworm-proof-edge)] pt-4">
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <label className="w-full min-w-0 text-xs font-semibold uppercase tracking-wider text-[var(--bookworm-proof-muted)] sm:min-w-48 sm:flex-1">Illustration<select aria-label="Saved EPUB illustration" value={imageIndex ?? ""} onChange={(event) => {
              const index = Number(event.target.value); setImageIndex(index);
              const position = occurrences.findIndex((occurrence) => occurrence.resourceIndex === index);
              if (position >= 0) { setOccurrenceIndex(position); setOccurrenceInput(String(position + 1)); setInspecting(true); }
            }} className={`${control} mt-2 block w-full min-w-0 font-normal normal-case tracking-normal`}>{activeSection.document.resources.map((image) => <option key={image.index} value={image.index}>Illustration {image.index + 1} · {image.width} × {image.height}{images.has(image.index) ? " · loaded" : " · not loaded"}</option>)}</select></label>
            <button type="button" disabled={!selectedImage || imageBusy !== null} onClick={() => { if (selectedImage) void loadImage(activeSection, selectedImage, sectionValid.current); }} className={control}>{imageBusy !== null ? "Loading illustration…" : selectedImage && images.has(selectedImage.index) ? "Reload illustration" : "Load illustration"}</button>
            <button type="button" onClick={() => { imagesRef.current = new Map(); setImages(new Map()); }} disabled={images.size === 0 || imageBusy !== null} className={control}>Release previews</button>
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--bookworm-proof-muted)]">Every illustration is available on demand. Verified resources retain at most 50 MiB of source bytes and 40 million unique pixels (about 153 MiB at four bytes per decoded pixel). Older previews are released when needed. Loaded {(retainedBytes / 1024 / 1024).toFixed(1)} MiB of source bytes. Browser overhead and transient decoding are additional, not a total memory guarantee.</p>
          {occurrences.length > 1 && <>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="text-sm">Image occurrence<input type="number" min={1} max={occurrences.length} step={1} aria-label="Saved EPUB image occurrence" value={occurrenceInput} onChange={(event) => setOccurrenceInput(event.target.value)} className={`${control} mt-2 block w-28`} /></label>
              <button type="button" onClick={() => { if (validOccurrence) inspectOccurrence(enteredOccurrence - 1); }} disabled={!validOccurrence || imageBusy !== null} className={control}>Inspect occurrence</button>
              <button type="button" onClick={() => inspectOccurrence(occurrenceIndex - 1)} disabled={occurrenceIndex === 0 || imageBusy !== null} className={control}>Previous occurrence</button>
              <button type="button" onClick={() => inspectOccurrence(occurrenceIndex + 1)} disabled={occurrenceIndex === occurrences.length - 1 || imageBusy !== null} className={control}>Next occurrence</button>
            </div>
            <p className="mt-3 text-xs leading-5 text-[var(--bookworm-proof-muted)]">Generated raster markup is limited to 96 MiB, not total browser memory. {frame.deferred > 0 ? `${frame.deferred} image occurrences are deferred below. ` : ""}All saved text and reading order remain available. Select any occurrence to prioritize it and inspect its exact verified image here without regenerating the book.</p>
            {inspecting && selectedOccurrence && <section aria-label="Selected saved illustration occurrence" className="mt-4 rounded-lg border border-[var(--bookworm-proof-edge)] p-4">
              <h3 className="text-sm font-semibold">Occurrence {occurrenceIndex + 1} of {occurrences.length} · Illustration {selectedOccurrence.resourceIndex + 1}</h3>
              {images.has(selectedOccurrence.resourceIndex) ? <img src={images.get(selectedOccurrence.resourceIndex)!.url} alt={selectedOccurrence.alt || `Saved illustration ${selectedOccurrence.resourceIndex + 1}`} referrerPolicy="no-referrer" className="mt-3 max-h-96 w-full object-contain" /> : <p className="mt-2 text-sm text-[var(--bookworm-proof-muted)]">This image is not loaded. Use Load illustration to open its verified bytes.</p>}
            </section>}
          </>}
          {imageBusy !== null && <p role="status" className="mt-2 text-sm">Verifying illustration {imageBusy + 1}…</p>}
        </div>}
      </div>
      <div ref={stage} role={fixed ? "region" : undefined} aria-label={fixed ? "Saved fixed-page scroll area" : undefined} tabIndex={fixed ? 0 : undefined} className={`min-w-0 overflow-auto bg-[var(--bookworm-proof-edge)]/20 p-3 sm:p-6 ${fixed ? "max-h-[760px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--bookworm-proof-ink)]" : ""}`}>
        {frame.html && <div className="mx-auto overflow-hidden border border-[var(--bookworm-proof-edge)] shadow-sm" style={fixed ? { width: pageWidth, height: pageHeight } : undefined}><iframe key={`${readerSourceKey(activeSection.source)}:${activeSection.document.index}`} title={`Saved EPUB proof: ${activeSection.document.title || `section ${activeSection.document.index + 1}`}`} srcDoc={frame.html} sandbox="" referrerPolicy="no-referrer" className={fixed ? "block h-full w-full border-0" : "block h-[640px] w-full border-0"} /></div>}
      </div>
      <footer className="border-t border-[var(--bookworm-proof-edge)] p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-4"><p className="max-w-xl text-xs leading-5 text-[var(--bookworm-proof-muted)]">Safe reading view of the saved export. Original fonts, unsupported styles and active links are not replayed. This is not retailer approval or a pixel-faithful reflowable preview.{activeSection.warnings.length > 0 ? ` ${activeSection.warnings.map((warning) => ({ "active-content-removed": "Active content removed", "unsupported-styles-ignored": "Unsupported styles ignored", "links-disabled": "Links disabled", "unsupported-markup-removed": "Unsupported markup removed" })[warning]).join(". ")}.` : ""}</p><div className="flex flex-wrap gap-3"><button type="button" disabled={downloadBusy} onClick={() => void renewDownload()} className={control}>{downloadBusy ? "Renewing private link…" : "Renew exact EPUB download"}</button>{download && <a href={download.url} download rel="noopener noreferrer" referrerPolicy="no-referrer" className={control} onClick={(event) => { if (Date.now() >= download.expiresAt) { event.preventDefault(); setDownload(null); } }}>Download saved EPUB v1</a>}</div></div></footer>
    </>}
  </section>;
}
