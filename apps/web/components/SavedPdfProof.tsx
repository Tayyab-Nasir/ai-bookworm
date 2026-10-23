"use client";

import { useEffect, useRef, useState } from "react";
import type { PdfProofPage, RenderedEditionResult } from "@bookworm/api-client";
import { apiClient } from "./api";
import { validatePrintDownload, validatePrintHistory } from "../lib/saved-print";
import { verifyPdfProofPage } from "../lib/pdf-proof";

export default function SavedPdfProof({ bookId, workspaceId, editionId, rendered, disabled = false }: {
  bookId: string; workspaceId: string; editionId: string; rendered: RenderedEditionResult; disabled?: boolean;
}) {
  const api = apiClient();
  const pdfs = rendered.artifacts.filter(artifact => artifact.asset.mime_type === "application/pdf");
  const [assetId, setAssetId] = useState(pdfs[0]?.asset.id ?? "");
  const [pageNumber, setPageNumber] = useState(1), [jump, setJump] = useState("1");
  const [width, setWidth] = useState<720 | 1080 | 1440>(1080), [zoom, setZoom] = useState(100);
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(true);
  const [page, setPage] = useState<{ response: PdfProofPage; url: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = JSON.stringify([bookId, workspaceId, editionId, rendered.jobId, assetId, pageNumber, width, retry]);
  const current = useRef(requestKey); current.current = disabled ? "disabled" : requestKey;
  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const valid = () => live && current.current === requestKey && !controller.signal.aborted;
    setPage(null); setError(null); setBusy(!disabled);
    if (disabled) return () => { live = false; controller.abort(); };
    const timer = window.setTimeout(() => { controller.abort(); if (live && current.current === requestKey) {
      setBusy(false); setError("The saved page took too long to open. Retry is read-only; no new render will be created.");
    } }, 35_000);
    void (async () => {
      try {
        const artifact = rendered.artifacts.find(item => item.asset.id === assetId && item.asset.mime_type === "application/pdf");
        const proof = validatePrintHistory(await api.listPrintRenders(editionId, controller.signal), bookId, editionId)
          .find(item => item.jobId === rendered.jobId);
        if (!valid()) return;
        if (!proof || !artifact) throw new Error("This exact saved PDF is no longer available. Refresh print history.");
        validatePrintDownload(rendered, proof, workspaceId);
        const response = await api.readPrintPage(editionId, proof.jobId, pageNumber,
          { sha256: proof.source.sha256, fingerprint: proof.fingerprint, assetId, width }, controller.signal);
        if (!valid()) return;
        const url = verifyPdfProofPage(response, proof, artifact, pageNumber, width);
        if (valid()) setPage({ response, url, key: requestKey });
      } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not open this saved PDF page."); }
      finally { window.clearTimeout(timer); if (valid()) setBusy(false); }
    })();
    return () => { live = false; window.clearTimeout(timer); controller.abort(); };
  }, [api, requestKey, disabled, bookId, workspaceId, editionId, rendered, assetId, pageNumber, width]);
  const visible = !disabled && page?.key === requestKey ? page : null;
  const turn = (number: number) => { setPageNumber(number); setJump(String(number)); };
  const button = "min-h-11 rounded-full border border-white/20 px-4 text-xs focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40";
  return <section aria-label="Saved PDF page proof" className="mt-5 min-w-0 rounded-xl border border-white/15 bg-black/30 p-4 sm:p-5">
    <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Exact saved file</p>
    <h3 className="mt-1 text-lg font-medium">PDF page proof</h3>
    <p className="mt-2 text-xs leading-5 text-white/55">Private, verified page images. No browser PDF plugin required. These are the saved bytes, not current manuscript edits. Download the original PDF for final print inspection.</p>
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className="text-xs text-white/65">Document<select aria-label="PDF document" value={assetId} disabled={disabled || busy} onChange={event => { setAssetId(event.target.value); turn(1); }} className="ml-2 min-h-11 max-w-52 rounded-lg border border-white/20 bg-black p-2 text-white">{pdfs.map(item => <option key={item.asset.id} value={item.asset.id}>{item.role === "rendered_print" ? "Book interior" : "Full cover"}</option>)}</select></label>
      <label className="text-xs text-white/65">Detail<select aria-label="PDF detail" value={width} disabled={disabled || busy} onChange={event => setWidth(Number(event.target.value) as 720 | 1080 | 1440)} className="ml-2 min-h-11 rounded-lg border border-white/20 bg-black p-2 text-white"><option value={720}>Standard</option><option value={1080}>High</option><option value={1440}>Extra high</option></select></label>
      <label className="text-xs text-white/65">Zoom<select aria-label="PDF zoom" value={zoom} onChange={event => setZoom(Number(event.target.value))} className="ml-2 min-h-11 rounded-lg border border-white/20 bg-black p-2 text-white">{[100, 125, 150, 200].map(n => <option key={n} value={n}>{n === 100 ? "Fit width" : `${n}%`}</option>)}</select></label>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" className={button} disabled={disabled || busy || pageNumber <= 1} onClick={() => turn(pageNumber - 1)}>Previous page</button>
      <p role="status" aria-live="polite" className="text-sm text-white/70">Page {pageNumber}{visible ? ` of ${visible.response.pageCount}` : ""}{busy ? " · opening…" : ""}</p>
      <button type="button" className={button} disabled={disabled || busy || !visible || pageNumber >= visible.response.pageCount} onClick={() => turn(pageNumber + 1)}>Next page</button>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); const n = Number(jump); if (visible && Number.isSafeInteger(n) && n >= 1 && n <= visible.response.pageCount) turn(n); }}>
        <label className="sr-only" htmlFor={`pdf-page-${rendered.jobId}`}>Go to PDF page</label><input id={`pdf-page-${rendered.jobId}`} type="number" min={1} max={visible?.response.pageCount ?? 20_000} value={jump} onChange={event => setJump(event.target.value)} className="min-h-11 w-20 rounded-lg border border-white/20 bg-black p-2 text-sm" />
        <button type="submit" className={button} disabled={disabled || busy || !visible}>Go</button>
      </form>
    </div>
    {error && <div role="alert" className="mt-4 rounded-lg border border-red-400/25 p-3 text-sm text-red-100"><p>{error}</p><button type="button" disabled={disabled || busy} className={`${button} mt-3`} onClick={() => setRetry(n => n + 1)}>Retry saved page</button></div>}
    {disabled && <p className="mt-4 text-sm text-white/50">Finish the current action or save your settings to inspect this proof.</p>}
    {visible && <>
      <div role="region" aria-label={`PDF page ${pageNumber} image`} tabIndex={0} className="mt-4 max-h-[75vh] min-w-0 overflow-auto rounded-lg border border-white/10 bg-neutral-800 p-3 focus-visible:ring-2 focus-visible:ring-white">
        <img src={visible.url} onError={() => { if (current.current === requestKey) { setPage(null); setError("The verified page image could not be displayed. Retry the page or download the original PDF."); } }} alt={`Saved ${pdfs.find(item => item.asset.id === assetId)?.role === "rendered_cover" ? "cover" : "interior"}, page ${pageNumber} of ${visible.response.pageCount}`} width={visible.response.image.width} height={visible.response.image.height} style={{ width: `${zoom}%`, maxWidth: "none", height: "auto" }} className="block bg-white shadow-xl" />
      </div>
      <p className="mt-2 text-xs text-white/45">{visible.response.pageWidthPoints} × {visible.response.pageHeightPoints} pt · SHA-256 {visible.response.source.sha256.slice(0, 16)}…</p>
      <details className="mt-3 text-sm text-white/70"><summary className="cursor-pointer py-2">Page text (reading order may differ)</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{visible.response.text || "No extractable text on this page."}</p>{visible.response.textTruncated && <p className="mt-2 text-xs">Text preview stops at 6,000 characters. Download the PDF for the full page.</p>}</details>
    </>}
  </section>;
}
