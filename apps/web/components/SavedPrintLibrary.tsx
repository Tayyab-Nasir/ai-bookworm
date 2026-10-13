"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, type RenderedEditionResult, type SavedPrintRender } from "@bookworm/api-client";
import { apiClient } from "./api";
import { validatePrintDownload, validatePrintHistory } from "../lib/saved-print";

export default function SavedPrintLibrary({ bookId, workspaceId, editionId, refreshKey = "", disabled = false, dirty = false, onSelect, onInvalidate }: {
  bookId: string; workspaceId: string; editionId: string; refreshKey?: string; disabled?: boolean; dirty?: boolean;
  onSelect: (result: RenderedEditionResult, expiresAt: number) => void; onInvalidate: (jobId: string) => void;
}) {
  const api = apiClient(); const owner = `${bookId}:${workspaceId}:${editionId}`;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const currentDisabled = useRef(disabled); currentDisabled.current = disabled;
  const epoch = useRef(0); const busyRef = useRef(false);
  const needsHistory = useRef(true);
  const selection = useRef<string | null>(null);
  const [visibleOwner, setVisibleOwner] = useState(owner);
  const [renders, setRenders] = useState<SavedPrintRender[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ jobId: string; expiresAt: number } | null>(null);
  const invalidate = useCallback(() => {
    if (selection.current) onInvalidate(selection.current);
    selection.current = null; setOpened(null);
  }, [onInvalidate]);
  const refresh = useCallback(async () => {
    if (busyRef.current || currentDisabled.current) return;
    const ticket = ++epoch.current; const valid = () => currentOwner.current === owner && epoch.current === ticket;
    needsHistory.current = false;
    busyRef.current = true; setBusy(true); setError(null); invalidate(); setRenders([]); setVisibleOwner(owner);
    try {
      const response = await api.listPrintRenders(editionId);
      if (valid()) setRenders(validatePrintHistory(response, bookId, editionId));
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not refresh print history."); }
    finally { if (valid()) { busyRef.current = false; setBusy(false); } }
  }, [api, bookId, editionId, invalidate, owner]);
  useEffect(() => {
    epoch.current++; busyRef.current = false; needsHistory.current = true; setBusy(false); invalidate(); setRenders([]); setVisibleOwner(owner);
    if (!disabled) void refresh();
    return () => { epoch.current++; busyRef.current = false; };
  }, [owner, refreshKey, refresh]);
  useEffect(() => {
    if (!dirty) return;
    epoch.current++; busyRef.current = false; setBusy(false); invalidate();
  }, [dirty, invalidate]);
  useEffect(() => { if (!disabled && !dirty && needsHistory.current) void refresh(); }, [disabled, dirty, refresh]);
  useEffect(() => {
    if (!opened) return;
    const timer = window.setTimeout(() => { if (selection.current === opened.jobId) invalidate(); }, Math.max(0, opened.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [opened, invalidate]);
  const open = async (proof: SavedPrintRender) => {
    if (busyRef.current || currentDisabled.current || currentOwner.current !== owner) return;
    const ticket = ++epoch.current; const valid = () => currentOwner.current === owner && epoch.current === ticket && !currentDisabled.current;
    busyRef.current = true; setBusy(true); setError(null); invalidate();
    const startedAt = Date.now();
    try {
      const response = await api.downloadPrintRender(editionId, proof.jobId, proof.source.sha256, proof.fingerprint);
      if (!valid()) return;
      const confirmed = validatePrintDownload(response, proof, workspaceId);
      const expiresAt = startedAt + Math.min(...confirmed.artifacts.map(artifact => artifact.download.expiresIn)) * 1000;
      if (expiresAt <= Date.now()) throw new Error("These private links expired before they arrived. Open the saved print again to renew them; no new render is needed.");
      selection.current = proof.jobId;
      setOpened({ jobId: proof.jobId, expiresAt });
      onSelect(confirmed, expiresAt);
    } catch (reason) {
      if (!valid()) return;
      if (reason instanceof ApiClientError && [401, 403].includes(reason.status)) setRenders([]);
      setError(reason instanceof Error ? reason.message : "Could not verify this saved print proof. No new render was created.");
    } finally { if (currentOwner.current === owner && epoch.current === ticket) { busyRef.current = false; setBusy(false); } }
  };
  const visible = visibleOwner === owner ? renders : [];
  return <section aria-labelledby={`saved-print-${editionId}`} className="mt-5 min-w-0 rounded-xl border border-white/15 bg-black/30 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Proof archive</p><h3 id={`saved-print-${editionId}`} className="mt-1 text-lg font-medium">Saved print proofs</h3></div>
      <button type="button" disabled={busy || disabled} onClick={() => void refresh()} className="min-h-11 rounded-full border border-white/15 px-4 text-xs focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">{busy ? "Checking proofs…" : "Refresh print history"}</button></div>
    <p className="mt-2 text-xs leading-5 text-white/50">Open a previous PDF and its exact cover without rendering again. Private links expire after five minutes. Older proofs keep their saved content; run fresh preflight before packaging.</p>
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-400/20 p-3 text-sm text-red-100">{error}</p>}
    {visible.length ? <ol className="mt-4 space-y-2">{visible.map((proof, index) => <li key={proof.jobId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3"><div className="min-w-0"><p className="text-sm">Print proof {visible.length - index}{opened?.jobId === proof.jobId ? " · opened" : ""}</p><p className="mt-1 text-xs text-white/45">{new Date(proof.createdAt).toLocaleString()} · {(proof.source.sizeBytes / (1024 * 1024)).toFixed(1)} MiB</p><p className="mt-1 break-all font-mono text-[10px] text-white/35">SHA-256 {proof.source.sha256.slice(0, 16)}…</p></div><button type="button" onClick={() => void open(proof)} disabled={busy || disabled} className="min-h-11 rounded-full border border-white/20 px-4 text-xs focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">{opened?.jobId === proof.jobId ? "Renew private links" : "Open saved print"}</button></li>)}</ol>
      : !busy && !error && <p role="status" className="mt-4 text-sm text-white/45">No verified saved print proofs are available. Save this edition and render a PDF to create one.</p>}
  </section>;
}
