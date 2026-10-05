"use client";

import { useEffect, useRef, useState } from "react";
import type { Asset, Book } from "@bookworm/types";
import type { ImageQuoteModel } from "@bookworm/api-client";
import { apiClient } from "./api";
import { canAcceptImageQuote, isImageQuoteFormLocked, readImageQuotePointer, recoverSavedImageQuote, type ImageQuotePointer, type SavedImageQuote } from "../lib/image-quote-ui-state";

const card = "rounded-3xl border border-white/10 bg-white/[0.035] p-6 sm:p-8";
const field = "mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-3 text-white outline-none focus-visible:ring-2 focus-visible:ring-violet-300";
const button = "inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-violet-100 focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:opacity-45";

export default function ImageQuoteStudio({ workspaceId, books, assets, canEdit, onCompleted }: {
  workspaceId: string; books: Book[]; assets: Asset[]; canEdit: boolean; onCompleted: () => Promise<void>;
}) {
  const api = apiClient();
  const [models, setModels] = useState<ImageQuoteModel[]>([]);
  const [purchaseAvailable, setPurchaseAvailable] = useState(false);
  const [modelId, setModelId] = useState("");
  const [bookId, setBookId] = useState("");
  const [kind, setKind] = useState<"illustration" | "cover">("illustration");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [quote, setQuote] = useState<SavedImageQuote | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [savedQuoteId, setSavedQuoteId] = useState("");
  const [storeConsent, setStoreConsent] = useState(false);
  const [generateConsent, setGenerateConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(true);
  const [recoveredRequest, setRecoveredRequest] = useState(false);
  const [acceptanceUncertain, setAcceptanceUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const storageKey = `bookworm.image-quote.v1:${workspaceId}`;
  const requestVersion = useRef(0);
  const requestInFlight = useRef(false);
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    requestInFlight.current = false;
    setModels([]); setModelId(""); setPurchaseAvailable(false); setQuote(null); setMessage(""); setIdempotencyKey(""); setSavedQuoteId("");
    setBookId(""); setKind("illustration"); setPrompt(""); setReferences([]); setStoreConsent(false); setGenerateConsent(false);
    setBusy(false); setRecoveryBlocked(true); setRecoveredRequest(false); setAcceptanceUncertain(false);
    if (!workspaceId) return () => { active = false; };
    void api.listImageQuoteModels(workspaceId).then(result => {
      if (!active) return;
      setModels(result.models); setPurchaseAvailable(result.purchaseAvailable);
      setModelId(current => result.models.some(model => model.id === current) ? current : result.models[0]?.id ?? "");
    }).catch(() => { if (active) setMessage("Image quote options are unavailable right now."); });
    void (async () => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        const pointer = readImageQuotePointer(raw);
        if (raw && !pointer) throw new Error("The saved image recovery checkpoint is invalid. No new request was sent; discard it explicitly before preparing another quote.");
        if (pointer) {
          setIdempotencyKey(pointer.idempotencyKey ?? ""); setSavedQuoteId(pointer.quoteId ?? ""); setRecoveredRequest(true); setBusy(true); requestInFlight.current = true;
          const saved = await recoverSavedImageQuote(api, workspaceId, pointer);
          if (!active || version !== requestVersion.current || activeWorkspace.current !== workspaceId) return;
          sessionStorage.setItem(storageKey, JSON.stringify({ ...pointer, quoteId: saved.quoteId }));
          setSavedQuoteId(saved.quoteId); setQuote(saved);
        }
        if (active) setRecoveryBlocked(false);
      } catch (reason) {
        if (active) setMessage(reason instanceof Error ? reason.message : "Saved quote status could not be recovered. Keep the original request and try recovery again.");
      } finally { if (active && version === requestVersion.current) { requestInFlight.current = false; setBusy(false); } }
    })();
    return () => { active = false; ++requestVersion.current; };
  }, [workspaceId]);

  const refresh = async () => {
    if (busy || requestInFlight.current) return;
    const version = requestVersion.current;
    requestInFlight.current = true; setBusy(true); setMessage(""); setGenerateConsent(false);
    try {
      const pointer: ImageQuotePointer | null = savedQuoteId ? { quoteId: savedQuoteId, ...(idempotencyKey ? { idempotencyKey } : {}) }
        : readImageQuotePointer(sessionStorage.getItem(storageKey));
      if (!pointer) throw new Error("The original quote checkpoint is unavailable. No new request was sent.");
      const saved = await recoverSavedImageQuote(api, workspaceId, pointer);
      if (version !== requestVersion.current || activeWorkspace.current !== workspaceId) return;
      sessionStorage.setItem(storageKey, JSON.stringify({ ...pointer, quoteId: saved.quoteId }));
      setSavedQuoteId(saved.quoteId); setQuote(saved); setRecoveryBlocked(false); setAcceptanceUncertain(false);
      if (saved.job?.status === "succeeded") {
        try { await onCompleted(); }
        catch { if (version === requestVersion.current) setMessage("Artwork is saved. The asset library could not refresh; open it or refresh status again."); }
      }
    } catch (reason) { if (version === requestVersion.current) setMessage(reason instanceof Error ? reason.message : "Saved quote status could not be recovered. No new generation was started."); }
    finally { if (version === requestVersion.current) { requestInFlight.current = false; setBusy(false); } }
  };
  const createQuote = async () => {
    if (!canEdit || !storeConsent || !modelId || prompt.trim().length < 10 || busy || requestInFlight.current || recoveryBlocked || idempotencyKey || quote) return;
    const version = requestVersion.current;
    requestInFlight.current = true;
    setBusy(true); setMessage("");
    try {
      const key = crypto.randomUUID();
      sessionStorage.setItem(storageKey, JSON.stringify({ idempotencyKey: key }));
      setIdempotencyKey(key);
      const result = await api.createImageQuote(workspaceId, { modelId, idempotencyKey: key, ...(bookId ? { bookId } : {}), kind,
        prompt: prompt.trim(), referenceAssetIds: references, consentToQuoteStorage: true });
      if (version !== requestVersion.current || activeWorkspace.current !== workspaceId) return;
      setSavedQuoteId(result.quoteId);
      sessionStorage.setItem(storageKey, JSON.stringify({ quoteId: result.quoteId, idempotencyKey: key }));
      const saved = await recoverSavedImageQuote(api, workspaceId, { quoteId: result.quoteId });
      if (version !== requestVersion.current || activeWorkspace.current !== workspaceId) return;
      setQuote(saved); setGenerateConsent(false);
    } catch (reason) { if (version === requestVersion.current) setMessage(reason instanceof Error ? reason.message : "Quote creation is unconfirmed. Recover the original request before preparing another quote."); }
    finally { if (version === requestVersion.current) { requestInFlight.current = false; setBusy(false); } }
  };
  const accept = async () => {
    if (!quote || requestInFlight.current || recoveryBlocked || !canAcceptImageQuote({ canEdit, busy, purchaseAvailable, generateConsent, acceptanceUncertain, quote: quote.quote, hasJob: Boolean(quote.job) })) return;
    const version = requestVersion.current;
    requestInFlight.current = true; setBusy(true); setMessage(""); setGenerateConsent(false); setAcceptanceUncertain(true);
    try {
      // Confirm recovery storage before any financial mutation.
      sessionStorage.setItem(storageKey, JSON.stringify({ quoteId: quote.quoteId, ...(idempotencyKey ? { idempotencyKey } : {}) }));
      await api.acceptImageQuote(workspaceId, quote.quoteId, quote.quote.reservedCredits);
      const saved = await recoverSavedImageQuote(api, workspaceId, { quoteId: quote.quoteId });
      if (version !== requestVersion.current || activeWorkspace.current !== workspaceId) return;
      setQuote(saved); setAcceptanceUncertain(false);
      if (saved.job?.status === "succeeded") {
        try { await onCompleted(); }
        catch { if (version === requestVersion.current) setMessage("Artwork is saved. Open the asset library to view it."); }
      }
    } catch (reason) { if (version === requestVersion.current) setMessage(`${reason instanceof Error ? reason.message : "Acceptance is unconfirmed."} Refresh saved status before accepting again. No new purchase will be sent by recovery.`); }
    finally { if (version === requestVersion.current) { requestInFlight.current = false; setBusy(false); } }
  };
  const startFresh = () => {
    if (busy || requestInFlight.current || acceptanceUncertain || (!quote && savedQuoteId)) return;
    try { sessionStorage.removeItem(storageKey); }
    catch { setRecoveryBlocked(true); setMessage("Browser recovery storage is unavailable. No new image request was sent."); return; }
    setQuote(null); setIdempotencyKey(""); setSavedQuoteId(""); setPrompt(""); setReferences([]); setRecoveredRequest(false); setRecoveryBlocked(false);
    setStoreConsent(false); setGenerateConsent(false); setMessage("");
  };
  const option = models.find(item => item.id === modelId);
  const imageAssets = assets.filter(asset => asset.mime_type === "image/png" && asset.checksum !== "pending" && asset.size_bytes <= 5 * 1024 * 1024 && !asset.deleted_at);
  const activeJob = quote?.job;
  const formLocked = recoveryBlocked || isImageQuoteFormLocked({ canEdit, busy, hasRequestKey: Boolean(idempotencyKey), hasSavedQuote: Boolean(quote) });
  const acceptAllowed = !recoveryBlocked && canAcceptImageQuote({ canEdit, busy, purchaseAvailable, generateConsent, acceptanceUncertain, quote: quote?.quote ?? null, hasJob: Boolean(activeJob) });

  return <section className={card} aria-labelledby="image-quote-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-[11px] uppercase tracking-[0.18em] text-violet-200/70">Image studio · private drafts</p>
        <h2 id="image-quote-title" className="mt-2 text-2xl font-medium tracking-tight text-white">Illustrations and cover art</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">Create a book-aware brief, review the maximum token credit hold, then approve generation. Cover typography is composed later in Publishing Studio.</p></div>
      <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/60">Measured usage · private asset</span>
    </div>
    {message && <p role="alert" className="mt-5 rounded-xl border border-amber-200/20 bg-amber-100/5 p-3 text-sm text-amber-100">{message}</p>}
    {recoveredRequest && <p className="mt-5 text-sm leading-6 text-white/60" role="status">Recovered saved request. Its private brief and references remain in the server quote; this browser does not retain their text. Acceptance uses that saved request and the model and maximum credits below.</p>}
    {!recoveredRequest && <fieldset disabled={formLocked} className="mt-6 grid gap-4 md:grid-cols-2">
      <label className="text-sm text-white/70">Artwork type<select className={field} value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="illustration">Interior illustration</option><option value="cover">Cover artwork</option></select></label>
      <label className="text-sm text-white/70">Book context<select className={field} value={bookId} onChange={event => setBookId(event.target.value)}><option value="">No book context</option>{books.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
      <label className="text-sm text-white/70 md:col-span-2">Approved model and format<select className={field} value={modelId} onChange={event => setModelId(event.target.value)}>{models.map(model => <option key={model.id} value={model.id}>{model.label} · {model.size} · {model.quality}</option>)}</select></label>
      <label className="text-sm text-white/70 md:col-span-2">Describe the scene, characters, mood and visual style<textarea className={`${field} min-h-28 resize-y`} minLength={10} maxLength={8000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="A rain-soaked market at dusk, seen through the eyes of…" /></label>
      <fieldset className="md:col-span-2"><legend className="text-sm text-white/70">Optional clean PNG references</legend><p className="mt-1 text-xs text-white/45">Selected reference bytes and your brief are sent to the configured image provider after acceptance. The server rechecks ownership, scan state and file integrity.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{imageAssets.map(asset => <label key={asset.id} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-white/70"><input type="checkbox" checked={references.includes(asset.id)} disabled={!references.includes(asset.id) && references.length >= Math.min(3, option?.maxReferenceImages ?? 0)} onChange={event => setReferences(items => event.target.checked ? [...items, asset.id] : items.filter(item => item !== asset.id))} />{asset.name}</label>)}</div>
      </fieldset>
    </fieldset>}
    {!quote && (idempotencyKey || savedQuoteId || recoveryBlocked) ? <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-white/10 pt-5"><button type="button" className={button} disabled={busy} onClick={() => void refresh()}>{busy ? "Recovering status…" : "Recover same quote request"}</button>{!savedQuoteId && <button type="button" className="text-sm text-white/55 underline" disabled={busy} onClick={startFresh}>Discard unconfirmed request</button>}<p className="text-sm text-white/55">Recovery only reads the original offer and generation status. It never saves a new quote or starts generation.</p></div>
      : !quote && <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5"><label className="flex max-w-xl items-start gap-3 text-sm leading-5 text-white/60"><input type="checkbox" checked={storeConsent} disabled={!canEdit || busy} onChange={event => setStoreConsent(event.target.checked)} /><span>Save this private prompt and selected source references in the quote so I can recover the same offer later.</span></label><button type="button" className={button} disabled={!canEdit || busy || !storeConsent || !modelId || prompt.trim().length < 10} onClick={() => void createQuote()}>{busy ? "Preparing quote…" : "Prepare image quote"}</button></div>}
    {quote && <div className="mt-6 rounded-2xl border border-violet-200/20 bg-violet-200/[0.04] p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.14em] text-violet-100/60">Maximum credit hold</p><p className="mt-1 text-3xl tabular-nums text-white">{Number(quote.quote.reservedCredits).toLocaleString()} <span className="text-sm text-white/55">credits</span></p><p className="mt-2 text-xs text-white/50">{quote.quote.model} · {quote.quote.size} · {quote.quote.quality} · expires {new Date(quote.quote.expiresAt).toLocaleString()}</p></div><button className="min-h-10 rounded-full border border-white/15 px-4 text-sm text-white/75 hover:bg-white/5" disabled={busy} onClick={() => void refresh()} type="button">Refresh status</button></div>
      <p className="mt-3 text-sm leading-6 text-white/60">This is the maximum hold for the saved request. Final usage is reconciled from provider token measurements. Unsupported measurements remain under review. Your image stays a private draft until you use it in a book.</p>
      {activeJob && <p className="mt-3 text-sm text-white/75">Generation {activeJob.status}{activeJob.assetId ? ` · asset ${activeJob.assetId}` : ""}. Refreshing never starts another generation.</p>}
      {acceptanceUncertain && <p className="mt-3 text-sm text-amber-100" role="status">Acceptance is unconfirmed. Refresh status to recover the same job or confirm no acceptance before deciding again.</p>}
      {!activeJob && quote.quote.status === "ready" && <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4"><label className="flex max-w-xl items-start gap-3 text-sm leading-5 text-white/60"><input type="checkbox" checked={generateConsent} disabled={!canEdit || busy || recoveryBlocked || acceptanceUncertain || !purchaseAvailable} onChange={event => setGenerateConsent(event.target.checked)} /><span>I approve sending this saved prompt and selected references for paid image generation, up to {Number(quote.quote.reservedCredits).toLocaleString()} credits.</span></label><button className={button} type="button" disabled={!acceptAllowed} onClick={() => void accept()}>{purchaseAvailable ? `Accept quote · ${Number(quote.quote.reservedCredits).toLocaleString()} credits` : "Purchases not enabled"}</button></div>}
      {quote.quote.status === "expired" && <p className="mt-4 text-sm text-amber-100">This offer expired. Prepare a new quote to continue.</p>}
      {activeJob?.status === "succeeded" && <div className="mt-3 flex flex-wrap items-center gap-4"><p className="text-sm text-emerald-100">Artwork is saved in your private asset library and ready to select in Publishing Studio.</p><a className="text-sm underline" href={`/assets?ws=${encodeURIComponent(workspaceId)}`}>Open asset library</a><button type="button" className="text-sm underline" onClick={startFresh}>Create another image</button></div>}
      {activeJob && ["failed", "cancelled"].includes(activeJob.status) && <div className="mt-3 flex flex-wrap items-center gap-4"><p className="text-sm text-amber-100">This request is finished. Review your credit activity before preparing a new image.</p><button type="button" className="text-sm underline" onClick={startFresh}>Prepare a new quote</button></div>}
      {!activeJob && quote.quote.status === "expired" && <button type="button" className="mt-3 text-sm underline" onClick={startFresh}>Prepare a new quote</button>}
    </div>}
  </section>;
}
