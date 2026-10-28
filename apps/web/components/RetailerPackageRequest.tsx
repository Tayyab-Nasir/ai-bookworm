"use client";

import { useEffect, useRef, useState } from "react";
import type { PublishingPackageJob, PublishingPackageRequest } from "@bookworm/api-client";
import { apiClient } from "./api";
import { clearPackagePointer, packageRecoveryKey, persistPackagePointer, readPackagePointer, validatePackageResult, downloadClock, type DownloadClock, type PackagePointer } from "../lib/publishing-request";

type Props = {
  bookId: string; request: Omit<PublishingPackageRequest, "idempotencyKey"> | null;
  canEdit: boolean; disabled: boolean; onBusy: (busy: boolean) => void; onJob: (job: PublishingPackageJob, startedAt: DownloadClock) => void;
};
const button = "min-h-11 rounded-full border border-white/25 px-4 py-2 text-sm disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";

export default function RetailerPackageRequest(props: Props) {
  const api = apiClient();
  const latest = useRef(props); latest.current = props;
  const epoch = useRef(0), locked = useRef(false);
  const owner = useRef<string | null>(null), saved = useRef<PackagePointer | null>(null);
  const [pointer, setPointer] = useState<PackagePointer | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [closeConfirmed, setCloseConfirmed] = useState(false), [closeUncertain, setCloseUncertain] = useState(false);
  const bookId = props.bookId;

  async function account() {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = await response.json().catch(() => null);
    if (!response.ok || typeof session?.user?.id !== "string") throw new Error("Sign in and reload before recovering or creating an export.");
    packageRecoveryKey(session.user.id, bookId);
    return session.user.id as string;
  }

  useEffect(() => {
    const version = ++epoch.current;
    const current = () => epoch.current === version && latest.current.bookId === bookId;
    owner.current = null; saved.current = null; locked.current = false;
    setReady(false); setPointer(null); setError(null); setNotice(null); setCloseConfirmed(false); setCloseUncertain(false);
    void (async () => {
      try {
        const userId = await account(); if (!current()) return;
        const pending = readPackagePointer(window.sessionStorage, userId, bookId);
        if (await account() !== userId) throw new Error("Your account changed. Reload to verify this account.");
        if (!current()) return;
        owner.current = userId; saved.current = pending; setPointer(pending); setCloseUncertain(Boolean(pending?.closing)); setReady(true);
      } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "Export recovery could not be loaded."); }
    })();
    return () => { ++epoch.current; };
  }, [bookId]);

  async function act(action: "create" | "recover" | "retry" | "close") {
    if (!ready || locked.current || props.disabled || !owner.current) return;
    if (action !== "recover" && !props.canEdit) return;
    if (action === "create" && (saved.current || !props.request)) return;
    if (action !== "create" && !saved.current) return;
    if (action === "retry" && (closeUncertain || saved.current?.closing)) return;
    if (action === "close" && !closeConfirmed) return;
    const version = epoch.current, userId = owner.current;
    const current = () => epoch.current === version && latest.current.bookId === bookId;
    const verify = async () => {
      const observed = await account();
      if (!current()) return false;
      if (observed !== userId) {
        owner.current = null; saved.current = null; setPointer(null); setReady(false);
        throw new Error("Your account changed. Reload saved data. The original export request remains with its owner.");
      }
      return true;
    };
    locked.current = true; setBusy(true); props.onBusy(true); setError(null); setNotice(null);
    try {
      if (!await verify()) return;
      const original = saved.current;
      const intent: PackagePointer = original ? { ...original, ...(action === "close" ? { closing: true as const } : {}) }
        : { schema: 1, userId, request: { ...props.request!, idempotencyKey: crypto.randomUUID() } };
      if (action !== "recover") persistPackagePointer(window.sessionStorage, intent);
      if (!current()) return;
      saved.current = intent; setPointer(intent);
      if (action === "close") { setCloseUncertain(true); setCloseConfirmed(false); }
      const requestStartedAt = downloadClock();
      let job: unknown;
      if (action === "recover" || action === "close") {
        const result = action === "recover"
          ? await api.getPublishingRequest(bookId, intent.request.idempotencyKey, userId)
          : await api.closePublishingRequest(intent.request, userId);
        if (!current() || !await verify()) return;
        if (result?.requestId !== intent.request.idempotencyKey) throw new Error("The recovery reply did not match the original export request.");
        if (result.job === null) {
          if (action === "close") throw new Error("Closure was not confirmed. Recover this same export request.");
          setNotice(intent.closing
            ? "Closure is not confirmed yet. Recover again or repeat closing this same request. Its export retry remains blocked."
            : "No saved export was found. Recovery sent no write. Retry the original request or explicitly close it before starting another export.");
          return;
        }
        job = result.job;
      } else {
        job = await api.createPublishingJob(intent.request, userId);
        if (!current() || !await verify()) return;
      }
      const confirmed = validatePackageResult(job, intent);
      if (action === "create" || action === "retry") {
        if (confirmed.status !== "succeeded") throw new Error("Export creation is not confirmed. Recover the original request.");
      }
      props.onJob(confirmed, requestStartedAt);
      if (confirmed.status === "queued" || confirmed.status === "running") {
        setNotice("This export is already in progress. Recover its status again; no new export is needed."); return;
      }
      clearPackagePointer(window.sessionStorage, intent);
      saved.current = null; setPointer(null); setCloseUncertain(false);
      setNotice(confirmed.status === "succeeded"
        ? action === "create" && confirmed.package ? `${confirmed.channel} package is ready for manual submission.`
          : "Saved export confirmed in package history for the original request. Unavailable files are not regenerated."
        : confirmed.status === "cancelled" ? "Saved request closed. Late retries cannot create its export. You can prepare a new request."
          : "The original export failed. Its saved status is confirmed; review the error in history before creating another export.");
    } catch (reason) {
      if (current()) setError(`${reason instanceof Error ? reason.message : "The export outcome is unconfirmed."}${saved.current ? " Keep this saved request and recover its status before another export." : ""}`);
    } finally {
      if (current()) { locked.current = false; setBusy(false); props.onBusy(false); }
    }
  }

  return <div className="mt-5 min-w-0" aria-label="Retailer request recovery">
    {error && <p role="alert" className="mb-3 text-sm text-red-100">{error}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-white/75">{notice}</p>}
    {pointer ? <div className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-4">
      <p className="text-sm font-medium">Saved {pointer.request.channel} export request</p>
      <p className="mt-2 text-sm text-white/65">Recovery uses the original saved edition and proofs. Only account, book and request identifiers are kept in this browser session; no manuscript or download links.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={button} disabled={busy || props.disabled || !ready} onClick={() => void act("recover")}>Recover saved export</button>
        <button type="button" className={button} disabled={busy || props.disabled || !ready || !props.canEdit || closeUncertain} onClick={() => void act("retry")}>Retry original export</button>
      </div>
      <label className="mt-4 flex items-start gap-2 text-sm text-white/65"><input type="checkbox" className="mt-1" checked={closeConfirmed} disabled={busy || !props.canEdit}
        onChange={event => setCloseConfirmed(event.target.checked)} />Close this request only if the server has not accepted it. Existing work will be kept.</label>
      <button type="button" className={`${button} mt-3`} disabled={busy || props.disabled || !props.canEdit || !closeConfirmed || !ready} onClick={() => void act("close")}>Close unaccepted export request</button>
    </div> : <button type="button" onClick={() => void act("create")} disabled={!ready || busy || props.disabled || !props.canEdit || !props.request}
      className="glass-solid min-h-11 rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy ? "Packaging…" : "Create retailer package"}</button>}
  </div>;
}
