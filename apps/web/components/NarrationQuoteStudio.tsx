"use client";

import { useEffect, useRef, useState } from "react";
import { ApiClientError, type AudiobookVoice, type NarrationChapterAcceptance, type NarrationChapterQuote, type NarrationQuoteModel, type NarrationVoice } from "@bookworm/api-client";
import type { Chapter } from "@bookworm/types";
import { apiClient } from "./api";
import { assertNarrationChapterQuote, assertNarrationChapterAcceptance, readNarrationQuotePointer as readOfferPointer,
  type NarrationQuotePointer as OfferPointer, narrationQuoteStorageKey } from "../lib/narration-quote-ui-state";
import styles from "./NarrationQuoteStudio.module.css";

export default function NarrationQuoteStudio({ workspaceId, bookId, editionId, chapterId, chapters, voice, speed, instructions, canEdit, disabled, onChapterChange, onAccepted }: {
  workspaceId: string; bookId: string; editionId: string; chapterId: string; chapters: Chapter[];
  voice: AudiobookVoice; speed: number; instructions: string; canEdit: boolean; disabled: boolean;
  onChapterChange?: (chapterId: string) => void;
  onAccepted?: (projectId: string) => void;
}) {
  const api = apiClient();
  const scope = `${workspaceId}:${bookId}:${editionId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const epoch = useRef(0), inFlight = useRef(false);
  const intent = JSON.stringify([scope, chapterId, voice, speed, instructions, canEdit, disabled]);
  const currentIntent = useRef(intent); currentIntent.current = intent;
  const acceptedCallback = useRef(onAccepted); acceptedCallback.current = onAccepted;
  const lastReportedProject = useRef<string | null>(null);
  const [storageKey, setStorageKey] = useState("");
  const [models, setModels] = useState<NarrationQuoteModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [pointer, setPointer] = useState<OfferPointer | null>(null);
  const [offer, setOffer] = useState<NarrationChapterQuote | null>(null);
  const [phase, setPhase] = useState<"boot" | "idle" | "save" | "recover" | "accept">("boot");
  const [acceptance, setAcceptance] = useState<NarrationChapterAcceptance | null>(null);
  const [voiceConsent, setVoiceConsent] = useState(false), [generateConsent, setGenerateConsent] = useState(false);
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [catalogMessage, setCatalogMessage] = useState("");
  const [blocked, setBlocked] = useState(true);

  useEffect(() => { setConsent(false); setVoiceConsent(false); setGenerateConsent(false); }, [intent]);
  const reportAccepted = (result: NarrationChapterAcceptance, originalIntent: string) => {
    if (result.accepted && currentIntent.current === originalIntent && lastReportedProject.current !== result.project.id) {
      lastReportedProject.current = result.project.id;
      acceptedCallback.current?.(result.project.id);
    }
  };
  const rememberAndCheck = async (saved: OfferPointer, quote: NarrationChapterQuote, key: string, valid: () => boolean, originalIntent: string) => {
    if (!valid()) return;
    const remembered = { ...saved, quoteId: quote.quoteId };
    sessionStorage.setItem(key, JSON.stringify(remembered));
    setPointer(remembered); setOffer(quote); setAcceptance(null); setBlocked(true);
    setVoiceConsent(false); setGenerateConsent(false);
    const result = assertNarrationChapterAcceptance(await api.getNarrationChapterAcceptance(workspaceId, quote.quoteId), quote);
    if (!valid()) return;
    setAcceptance(result); setBlocked(false); reportAccepted(result, originalIntent);
    if (remembered.purchaseAttempted && !result.accepted) {
      setMessage("The earlier purchase is still unconfirmed. Keep this original quote and recover its status; do not purchase or prepare another offer.");
    }
  };

  const read = async (saved: OfferPointer) => {
    const result = saved.quoteId ? await api.getNarrationChapterQuote(workspaceId, saved.quoteId)
      : saved.idempotencyKey ? await api.recoverNarrationChapterQuote(workspaceId, saved.idempotencyKey) : null;
    const quote = assertNarrationChapterQuote(result, { bookId, editionId });
    if (saved.quoteId && quote.quoteId !== saved.quoteId) throw new Error("Saved offer identity changed. Keep the original recovery checkpoint.");
    return quote;
  };

  useEffect(() => {
    let active = true;
    const version = ++epoch.current;
    const valid = () => active && version === epoch.current && currentScope.current === scope;
    inFlight.current = false;
    lastReportedProject.current = null;
    setStorageKey(""); setModels([]); setModelId(""); setPointer(null); setOffer(null); setMessage(""); setCatalogMessage("");
    setConsent(false); setVoiceConsent(false); setGenerateConsent(false); setAcceptance(null); setPhase("boot"); setBlocked(true);
    if (!editionId) { setPhase("idle"); return () => { active = false; ++epoch.current; }; }
    void api.listNarrationModels(workspaceId).then(result => {
      if (valid()) { setModels(result.models); setModelId(result.models[0]?.id ?? ""); }
    }).catch(() => { if (valid()) setCatalogMessage("Approved narration prices are unavailable. You can still recover an existing offer; no paid generation is enabled."); });
    void (async () => {
      try {
        const session = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
        if (!session.ok) throw new Error("Sign in to recover your private chapter offers.");
        const account = await session.json();
        const key = narrationQuoteStorageKey(account.user?.id ?? "", workspaceId, bookId, editionId);
        if (!valid()) return;
        setStorageKey(key);
        const raw = sessionStorage.getItem(key), saved = readOfferPointer(raw);
        if (raw && !saved) throw new Error("Saved recovery checkpoint is invalid. No request was sent. Discard it explicitly to start again.");
        if (saved) {
          setPointer(saved); setPhase("recover"); inFlight.current = true;
          const quote = await read(saved);
          if (!valid()) return;
          await rememberAndCheck(saved, quote, key, valid, intent);
        }
        if (valid()) setBlocked(false);
      } catch (reason) { if (valid()) setMessage(reason instanceof Error ? reason.message : "Recovery is unavailable. Keep the original request key."); }
      finally { if (valid()) { inFlight.current = false; setPhase("idle"); } }
    })();
    return () => { active = false; ++epoch.current; };
  }, [scope]);

  const recover = async () => {
    if (phase !== "idle" || inFlight.current || !storageKey) return;
    const version = epoch.current;
    const valid = () => version === epoch.current && currentScope.current === scope;
    inFlight.current = true; setPhase("recover"); setMessage("");
    setAcceptance(null); setBlocked(true); setVoiceConsent(false); setGenerateConsent(false);
    try {
      const saved = pointer ?? readOfferPointer(sessionStorage.getItem(storageKey));
      if (!saved) throw new Error("Original offer checkpoint is unavailable. No new request was sent.");
      const quote = await read(saved);
      await rememberAndCheck(saved, quote, storageKey, valid, intent);
    } catch (reason) { if (version === epoch.current) setMessage(reason instanceof Error ? reason.message : "Recovery failed. Keep the original request key."); }
    finally { if (version === epoch.current) { inFlight.current = false; setPhase("idle"); } }
  };

  const create = async () => {
    if (!canEdit || disabled || !consent || !settingsValid || !chapterId || !modelId || pointer || offer || blocked || phase !== "idle" || inFlight.current) return;
    const version = epoch.current;
    const valid = () => version === epoch.current && currentScope.current === scope;
    inFlight.current = true; setPhase("save"); setMessage("");
    try {
      if (!storageKey) throw new Error("Browser recovery storage is unavailable. No offer was sent.");
      const saved = { idempotencyKey: crypto.randomUUID() };
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
      setPointer(saved);
      const result = await api.createNarrationChapterQuote(workspaceId, { editionId, chapterId, modelId, idempotencyKey: saved.idempotencyKey,
        voice: voice as NarrationVoice, speed, instructions: instructions || null, consentToQuoteStorage: true });
      if (version !== epoch.current || currentScope.current !== scope) return;
      const quote = assertNarrationChapterQuote(result, { bookId, editionId });
      if (quote.source.chapterId !== chapterId || quote.modelId !== modelId || quote.voice !== voice || quote.speed !== speed) {
        throw new Error("Saved delivery identity is unconfirmed. Recover the original request before starting another offer.");
      }
      setConsent(false);
      await rememberAndCheck(saved, quote, storageKey, valid, intent);
    } catch (reason) { if (version === epoch.current) setMessage(reason instanceof Error ? reason.message : "Offer save is unconfirmed. Recover the original key; no generation or charge was started."); }
    finally { if (version === epoch.current) { inFlight.current = false; setPhase("idle"); } }
  };

  const purchase = async () => {
    if (!canPurchase || inFlight.current || !offer || !pointer || !storageKey || Date.parse(offer.expiresAt) <= Date.now()) return;
    const version = epoch.current;
    const valid = () => version === epoch.current && currentScope.current === scope;
    inFlight.current = true; setPhase("accept"); setMessage(""); setVoiceConsent(false); setGenerateConsent(false);
    let attempted = false;
    try {
      const pending: OfferPointer = { ...pointer, quoteId: offer.quoteId, purchaseAttempted: true };
      // Persist before the request. A reload after any ambiguous reply must not repurchase.
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
      attempted = true; setPointer(pending); setAcceptance(null); setBlocked(true);
      const result = assertNarrationChapterAcceptance(await api.acceptNarrationChapterQuote(workspaceId, offer.quoteId,
        { expectedCredits: offer.reservedCredits, consentToAiVoice: true, consentToGenerate: true }), offer);
      if (!result.accepted) throw new Error("Chapter acceptance is unconfirmed.");
      if (!valid()) return;
      setAcceptance(result); setBlocked(false); reportAccepted(result, intent);
    } catch (reason) {
      if (!valid()) return;
      // These server errors occur before funding or after an atomic RPC rollback.
      // They permit a fresh read/consent, never an automatic POST retry.
      if (attempted && reason instanceof ApiClientError && [403, 404, 409, 422].includes(reason.status)) {
        const rejected: OfferPointer = { ...(pointer.idempotencyKey ? { idempotencyKey: pointer.idempotencyKey } : {}), quoteId: offer.quoteId };
        try { sessionStorage.setItem(storageKey, JSON.stringify(rejected)); setPointer(rejected); }
        catch { setMessage("Purchase was rejected, but recovery storage is unavailable. Keep the original quote and recover its status."); return; }
        setMessage(`${reason.message} Recover the original status before confirming again.`);
      } else setMessage(attempted ? "Purchase reply is unconfirmed. Recover this original quote before any new purchase. Do not assume nothing was charged."
        : reason instanceof Error ? reason.message : "Recovery storage is unavailable. No purchase was sent.");
    } finally { if (valid()) { inFlight.current = false; setPhase("idle"); } }
  };

  const discard = () => {
    if (phase !== "idle" || inFlight.current || !storageKey || (offer && !acceptance)
      || (pointer?.purchaseAttempted && !acceptance?.accepted)) return;
    try { sessionStorage.removeItem(storageKey); }
    catch { setMessage("Browser recovery storage is unavailable. No new request was sent."); setBlocked(true); return; }
    setPointer(null); setOffer(null); setAcceptance(null); setConsent(false); setVoiceConsent(false); setGenerateConsent(false); setMessage(""); setBlocked(false);
  };
  const settingsValid = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"].includes(voice)
    && speed >= 0.25 && speed <= 1.5 && /^\d+(?:\.\d{1,2})?$/.test(String(speed))
    && instructions === instructions.trim() && !/[\uD800-\uDFFF]/u.test(instructions) && instructions.length <= 2_000 && new TextEncoder().encode(instructions).byteLength < 1_800;
  const locked = !canEdit || disabled || Boolean(pointer) || blocked || phase !== "idle";
  const expired = Boolean(offer && (offer.expired || Date.parse(offer.expiresAt) <= Date.now()));
  const originalDeliveryMatches = Boolean(offer && offer.source.chapterId === chapterId && offer.voice === voice && offer.speed === speed
    && chapters.find(chapter => chapter.id === chapterId)?.current_document_version_id === offer.source.documentVersionId);
  const purchaseLocked = !canEdit || disabled || !settingsValid || !originalDeliveryMatches || expired || blocked || phase !== "idle"
    || !offer?.purchaseAvailable || !acceptance || acceptance.accepted || Boolean(pointer?.purchaseAttempted);
  const canPurchase = !purchaseLocked && voiceConsent && generateConsent;
  const cannotDiscard = phase !== "idle" || !storageKey || Boolean(offer && !acceptance) || Boolean(pointer?.purchaseAttempted && !acceptance?.accepted);
  const title = chapters.find(chapter => chapter.id === (offer?.source.chapterId ?? chapterId))?.title ?? "Saved chapter";

  return <section className={styles.root} aria-labelledby="narration-offer-title" aria-busy={phase !== "idle"}>
    <header className={styles.header}><div><p className={styles.eyebrow}>Audio studio / price review</p>
      <h2 id="narration-offer-title">A voice for every word.</h2>
      <p className={styles.description}>One offer covers the entire saved chapter. Review every part, confirm the exact maximum, then choose whether to start paid narration.</p></div>
      <span className={styles.badge}>Private · source-pinned</span></header>
    {catalogMessage && <p className={styles.message} role="status">{catalogMessage}</p>}
    {message && <p className={styles.message} role="alert">{message}</p>}
    {!editionId ? <p className={styles.description}>Save an audiobook edition first to prepare a chapter offer.</p> : <>
      {!offer && <div className={styles.controls}>{onChapterChange && <label>Saved chapter<select value={chapterId} disabled={locked} onChange={event => { setConsent(false); onChapterChange(event.target.value); }}>
        <option value="">Choose a chapter</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.order_index + 1}. {chapter.title}</option>)}
      </select></label>}<label>Approved narration model<select value={modelId} disabled={locked} onChange={event => { setConsent(false); setModelId(event.target.value); }}>
        {!models.length && <option value="">Prices not available</option>}{models.map(model => <option key={model.id} value={model.id}>{model.label} · {model.model}</option>)}
      </select></label><div className={styles.delivery}><strong>{title}</strong><span>{voice} · {speed.toFixed(2)}×</span><span>Uses the saved voice direction above.</span></div></div>}
      {!offer && !pointer && !blocked && <div className={styles.actions}><label className={styles.consent}><input type="checkbox" checked={consent} disabled={locked}
        onChange={event => setConsent(event.target.checked)} /><span>Save my private voice direction and source references for same-offer recovery. No manuscript copy, generation, or charge.</span></label>
        <button type="button" className={styles.primary} disabled={locked || !consent || !settingsValid || !modelId || !chapterId} onClick={() => void create()}>
          {phase === "save" ? "Saving offer…" : "Review full chapter price"}</button></div>}
      {!offer && (pointer || blocked) && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={phase !== "idle" || !storageKey} onClick={() => void recover()}>
        {phase === "recover" || phase === "boot" ? "Recovering offer…" : "Recover original offer"}</button>{storageKey && <button className={styles.textButton} type="button" disabled={cannotDiscard} onClick={discard}>Discard unconfirmed offer</button>}
        <p className={styles.description}>Recovery is read-only. It never saves another offer, generates audio, or moves credits.</p></div>}
      {!offer && !settingsValid && <p className={styles.message}>Choose a supported voice, speed from 0.25× to 1.50×, and already-trimmed voice direction below 1,800 UTF-8 bytes in the edition settings.</p>}
      {disabled && !offer && <p className={styles.description}>Save the edition settings before reviewing a narration price.</p>}
      {offer && <div className={styles.offer} aria-live="polite"><div className={styles.offerHeading}><div><p className={styles.eyebrow}>Complete chapter / maximum budget</p>
        <p className={styles.figure}>{Number(offer.reservedCredits).toLocaleString()} <span>credits</span></p><p className={styles.description}>{acceptance?.accepted
          ? "Original maximum budget at acceptance. Actual usage is reconciled separately; this is not the measured charge."
          : pointer?.purchaseAttempted ? "Purchase outcome unconfirmed. This is the original maximum; do not assume nothing was charged."
          : acceptance ? "Not charged or reserved. This is a conservative token ceiling, not measured usage."
          : "Acceptance is being verified. Do not assume this offer is unpurchased or submit another purchase."}</p></div>
        <button type="button" className={styles.secondary} disabled={phase !== "idle"} onClick={() => void recover()}>Refresh saved offer</button></div>
        <p className={styles.source}>{title} · {offer.model} · {offer.voice} · {offer.speed.toFixed(2)}×</p>
        <details className={styles.parts}><summary>{offer.segmentCount} ordered {offer.segmentCount === 1 ? "part" : "parts"} · full saved chapter</summary>
          <ol>{offer.segments.map(part => <li key={part.quoteId}><span>Part {part.segmentIndex + 1}<small>Source range {part.textStart}–{part.textEnd}</small></span>
            <span>{Number(part.reservedCredits).toLocaleString()} credits</span></li>)}</ol></details>
        <p className={styles.description}>Original source version and delivery settings stay pinned after recovery. Changing the edition does not change this offer.</p>
        <p className={styles.expiry}>{expired ? "Offer expired · read-only recovery remains available." : `Offer expires ${new Date(offer.expiresAt).toLocaleString()}.`}</p>
        {acceptance?.accepted && <div className={styles.accepted} role="status"><strong>Accepted narration · {acceptance.project.status}</strong>
          <p className={styles.description}>Original project recovered. Refresh saved audio below to listen when ready. Recovery never queues another purchase.</p></div>}
        {offer.purchaseAvailable && !acceptance?.accepted && <fieldset className={styles.purchase} disabled={purchaseLocked}>
          <legend>Confirm the complete chapter</legend>
          <label className={styles.consent}><input type="checkbox" checked={voiceConsent} onChange={event => setVoiceConsent(event.target.checked)} />
            <span>I understand this narration uses an AI-generated voice, not a human recording. AI disclosure must accompany delivery.</span></label>
          <label className={styles.consent}><input type="checkbox" checked={generateConsent} onChange={event => setGenerateConsent(event.target.checked)} />
            <span>Authorize up to {Number(offer.reservedCredits).toLocaleString()} token credits for all {offer.segmentCount} parts and start paid generation using the original saved source and voice direction.</span></label>
        </fieldset>}
        {!originalDeliveryMatches && !acceptance?.accepted && <p className={styles.description}>Current chapter, source or delivery differs from this saved offer. Prepare another offer explicitly; this one will not silently adopt your edits.</p>}
        <div className={styles.actions}>{!offer.purchaseAvailable && !acceptance?.accepted && <span className={styles.badge}>Paid narration not enabled</span>}
          {offer.purchaseAvailable && !acceptance?.accepted && <button type="button" className={styles.primary} disabled={!canPurchase} onClick={() => void purchase()}>
            {phase === "accept" ? "Confirming original purchase…" : "Accept & generate chapter"}</button>}
          <button type="button" className={styles.textButton} disabled={cannotDiscard} onClick={discard}>Prepare another offer</button></div>
        <p className={styles.description}>Saving or recovering an offer does not start narration. Only your explicit funded acceptance can queue generation; never resubmit after an uncertain reply.</p>
      </div>}
    </>}
  </section>;
}
