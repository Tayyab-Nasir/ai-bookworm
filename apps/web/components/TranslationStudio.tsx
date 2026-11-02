"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TranslationBillingResult, TranslationProjectResult } from "@bookworm/api-client";
import type { Book } from "@bookworm/types";
import { apiClient } from "./api";
import TranslationQuotePanel from "./TranslationQuotePanel";
import { readBrowserSession } from "../lib/browser-session";

const editableRoles = new Set(["owner", "admin", "editor", "writer"]);
const panel = "rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6";
const field = "mt-2 h-11 w-full rounded-xl border border-white/15 bg-black/35 px-3 text-sm text-white outline-none focus:border-white/45";
const subtle = "rounded-full border border-white/15 px-4 py-2 text-sm text-white/75 transition hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";
const primary = "rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40";

function badge(status: string) {
  if (status === "succeeded") return "bg-emerald-400/15 text-emerald-100";
  if (status === "failed" || status === "cancelled") return "bg-red-400/15 text-red-100";
  return "bg-amber-300/10 text-amber-100";
}

function scopeSuperseded() { const error = new Error("Account check superseded."); error.name = "TranslationScopeChanged"; return error; }
function isSuperseded(error: unknown) { return error instanceof Error && error.name === "TranslationScopeChanged"; }
type TranslationScope = { actor: string; current: () => boolean; begin: () => () => boolean; checked: <T>(work: () => Promise<T>) => Promise<T> };

export default function TranslationStudio({ bookId }: { bookId: string }) {
  const latestBook = useRef(bookId); latestBook.current = bookId;
  return <ScopedTranslationStudio key={bookId} bookId={bookId} isBookCurrent={() => latestBook.current === bookId} />;
}

function ScopedTranslationStudio({ bookId, isBookCurrent }: { bookId: string; isBookCurrent: () => boolean }) {
  const [identity, setIdentity] = useState<{ actor: string } | null>(null);
  const [active, setActive] = useState(false), [checking, setChecking] = useState(true), [sessionError, setSessionError] = useState("");
  const epoch = useRef<object>({}); const actorRef = useRef<string | null>(null); const identityRef = useRef<{ actor: string } | null>(null); const activeRef = useRef(false); const mounted = useRef(false);
  const check = useCallback(async () => {
    if (!mounted.current) return;
    const token = {}; epoch.current = token; activeRef.current = false; setActive(false); setChecking(true); setSessionError("");
    try {
      const account = await readBrowserSession();
      if (mounted.current && epoch.current === token) {
        actorRef.current = account.id; activeRef.current = true;
        const next = identityRef.current?.actor === account.id ? identityRef.current : { actor: account.id };
        identityRef.current = next; setIdentity(next); setActive(true);
      }
    } catch { if (mounted.current && epoch.current === token) setSessionError("Your account could not be verified. Sign in again or retry."); }
    finally { if (mounted.current && epoch.current === token) setChecking(false); }
  }, []);
  useLayoutEffect(() => {
    mounted.current = true; void check();
    const focus = () => { void check(); };
    const visibility = () => { if (document.visibilityState === "visible") void check(); else { epoch.current = {}; activeRef.current = false; setActive(false); setChecking(true); setSessionError(""); } };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; epoch.current = {}; activeRef.current = false; window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); };
  }, [check]);
  const scope = useMemo<TranslationScope | null>(() => {
    if (!identity) return null;
    const current = () => mounted.current && isBookCurrent() && activeRef.current && actorRef.current === identity.actor && identityRef.current === identity;
    const begin = () => { const token = epoch.current; return () => current() && epoch.current === token; };
    const checked = async <T,>(work: () => Promise<T>): Promise<T> => {
      const token = epoch.current, valid = () => current() && epoch.current === token;
      try {
        await readBrowserSession(identity.actor); if (!valid()) throw scopeSuperseded();
        const result = await work(); if (!valid()) throw scopeSuperseded();
        await readBrowserSession(identity.actor); if (!valid()) throw scopeSuperseded();
        return result;
      } catch (error) {
        if (!valid()) throw scopeSuperseded();
        try { await readBrowserSession(identity.actor); } catch { if (valid()) void check(); }
        if (!valid()) throw scopeSuperseded();
        throw error;
      }
    };
    return { actor: identity.actor, current, begin, checked };
  }, [identity, isBookCurrent, check]);
  return <>
    {identity && scope && <TranslationWorkspace key={identity.actor} bookId={bookId} scope={scope} active={active} />}
    {!active && <main className="mx-auto max-w-6xl px-4 py-8 text-white"><h1 className="text-3xl">Translate this book</h1>
      {checking ? <p role="status" className="mt-5">Checking your account…</p> : <p role="alert" className="mt-5">{sessionError} <button className="underline" onClick={() => void check()}>Try again</button> <Link className="underline" href="/login">Sign in</Link></p>}
    </main>}
  </>;
}

function TranslationWorkspace({ bookId, scope, active }: { bookId: string; scope: TranslationScope; active: boolean }) {
  const api = apiClient(); const router = useRouter();
  const [book, setBook] = useState<Book | null>(null); const [role, setRole] = useState<string | null>(null);
  const [projects, setProjects] = useState<TranslationProjectResult[]>([]); const [selected, setSelected] = useState<TranslationProjectResult | null>(null);
  const selectedRef = useRef<TranslationProjectResult | null>(null);
  useLayoutEffect(() => { selectedRef.current = selected; }, [selected]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const historySequence = useRef(0); const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { if (!active) setHistoryState("loading"); }, [active]);
  const [adoptTitle, setAdoptTitle] = useState("");
  const [busy, setBusy] = useState<"queue" | "refresh" | "preview" | "adopt" | "cancel" | null>(null); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [cancelConfirmation, setCancelConfirmation] = useState<string | null>(null);
  const [billing, setBilling] = useState<TranslationBillingResult | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingRevision, setBillingRevision] = useState(0);
  const billingProjectId = selected?.canViewBilling ? selected.id : null;
  useEffect(() => {
    let live = true; setBilling(null); setBillingError(null);
    if (active && billingProjectId) void scope.checked(() => api.getTranslationBilling(billingProjectId, scope.actor)).then((result) => {
      if (live && scope.current()) setBilling(result);
    }).catch(() => { if (live && scope.current()) setBillingError("Billing could not be confirmed. Refresh to check your held credits; do not pay again to resolve this message."); });
    return () => { live = false; };
  }, [api, billingProjectId, billingRevision, scope, active]);
  const editable = role ? editableRoles.has(role) : false;

  const load = useCallback(async () => {
    const sequence = ++historySequence.current, selectedAtStart = selectedRef.current; setHistoryState("loading");
    try {
      const [identity, history] = await scope.checked(() => Promise.all([api.getBook(bookId, scope.actor), api.listTranslationProjects(bookId, scope.actor)]));
      if (identity.book.id !== bookId || history.projects.some(project => project.bookId !== bookId)) throw new Error("Translation results do not match this book.");
      let verifiedSelection: TranslationProjectResult | null = null;
      if (selectedAtStart) {
        try {
          const includeText = selectedAtStart.chapters.some(chapter => Boolean(chapter.translatedText));
          const refreshed = await scope.checked(() => api.getTranslationProject(selectedAtStart.id, includeText, scope.actor));
          if (refreshed.id !== selectedAtStart.id || refreshed.bookId !== bookId) throw new Error("Selected translation did not match.");
          verifiedSelection = refreshed;
        } catch (error) { if (isSuperseded(error)) throw error; }
      }
      if (scope.current() && historySequence.current === sequence) {
        setBook(identity.book); setRole(identity.role); setProjects(history.projects);
        if (selectedAtStart) { setSelected(current => current?.id === selectedAtStart.id ? verifiedSelection : current); if (!verifiedSelection) setBilling(null); }
        setHistoryState("ready");
      }
    } catch(error) { if (scope.current() && historySequence.current === sequence && !isSuperseded(error)) setHistoryState("error"); throw error; }
  }, [api, bookId, scope]);

  useEffect(() => { if (active) void load().catch((error) => { if (scope.current() && !isSuperseded(error)) setError("Could not load translations. Recheck your account and try again."); }); }, [load, scope, active]);

  const refreshHistory = async () => {
    if (busy) return;
    setBusy("refresh"); setError(null);
    try { await load(); }
    catch (error) { if (scope.current() && !isSuperseded(error)) setError("Could not refresh translations. Recheck your account and try again."); }
    finally { if (mounted.current) setBusy(null); }
  };

  const preview = async (projectId: string, includeText: boolean) => {
    if (busy) return; setBusy(includeText ? "preview" : "refresh"); setError(null); setNotice(null);
    try {
      const project = await scope.checked(() => api.getTranslationProject(projectId, includeText, scope.actor));
      if (project.id !== projectId || project.bookId !== bookId) throw new Error("Translation does not match this book.");
      setSelected(project);
      setBillingRevision((revision) => revision + 1);
      setProjects((current) => current.map((item) => item.id === project.id ? { ...project, chapters: project.chapters.map(({ translatedText: _text, ...chapter }) => chapter) } : item));
      setAdoptTitle((current) => current || `${book?.title ?? "Untitled"} (${project.targetLanguage.toUpperCase()})`);
    } catch (error) { if (scope.current() && !isSuperseded(error)) setError("Could not refresh translation. Recheck your account and try again."); }
    finally { if (mounted.current) setBusy(null); }
  };

  const adopt = async () => {
    if (!selected || busy || !adoptTitle.trim()) { setError("Give the translated draft a title before creating it."); return; }
    setBusy("adopt"); setError(null); setNotice(null);
    try {
      const submittedTitle = adoptTitle.trim();
      const { book: draft } = await scope.checked(() => api.adoptTranslationProject(selected.id, { title: submittedTitle }, scope.actor));
      if (!draft.id || !book || draft.workspace_id !== book.workspace_id || draft.title !== submittedTitle) throw new Error("The translated draft could not be confirmed.");
      setNotice("Translated draft created. Review every chapter before layout or publishing.");
      setProjects((current) => current.map((item) => item.id === selected.id ? { ...item, adoptedBookId: draft.id } : item));
      setSelected((current) => current ? { ...current, adoptedBookId: draft.id } : current);
      router.push(`/books/${draft.id}`);
    } catch (error) { if (scope.current() && !isSuperseded(error)) setError("The translated draft or its title is not confirmed. Refresh its status before trying again; an earlier draft may already exist."); }
    finally { if (mounted.current) setBusy(null); }
  };

  const cancel = async () => {
    if (!selected || busy || cancelConfirmation !== selected.id) return;
    setBusy("cancel"); setError(null); setNotice(null);
    try {
      const result = await scope.checked(() => api.cancelQuotedTranslation(selected.id, scope.actor));
      if (result.projectId !== selected.id || result.status !== "cancelled" || !/^\d+$/.test(result.releasedCredits)) throw new Error("Cancellation receipt did not match.");
      setSelected((current) => current?.id === result.projectId ? {
        ...current, status: "cancelled", canCancelBeforeDispatch: false,
        chapters: current.chapters.map((chapter) => ({ ...chapter, status: "cancelled" })),
      } : current);
      setProjects((current) => current.map((item) => item.id === result.projectId ? { ...item, status: "cancelled", canCancelBeforeDispatch: false } : item));
      setCancelConfirmation(null);
      setBilling(null); setBillingRevision((revision) => revision + 1);
      setNotice(`Translation cancelled before dispatch. ${result.releasedCredits} held credits returned.`);
    } catch (error) { if (scope.current() && !isSuperseded(error)) setError("Could not confirm cancellation. Refresh the project before retrying."); }
    finally { if (mounted.current) setBusy(null); }
  };

  return <main className="mx-auto min-h-[calc(100dvh-84px)] max-w-6xl bg-black px-4 py-8 text-white sm:px-6 lg:py-12">
    {active && <><div className="flex flex-wrap items-start justify-between gap-5"><div><Link href={`/books/${bookId}`} className="text-sm text-white/50 hover:text-white">← Manuscript</Link><h1 className="mt-3 text-3xl font-medium tracking-[-0.04em]">Translate this book</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Create a paid, version-pinned translation of your saved chapters. Nothing replaces your source book. You review the output before creating a separate draft.</p></div><Link href={`/books/${bookId}/publish`} className={subtle}>Layout & publish</Link></div>
    {error && <p role="alert" className="mt-6 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-100">{error}</p>}
    {notice && <p role="status" className="mt-6 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-50">{notice}</p>}

    </>}
    <TranslationQuotePanel key={bookId} bookId={bookId} scope={scope} active={active && historyState === "ready"} sourceLanguage={book?.language ?? ""} editable={editable} disabled={Boolean(busy)||historyState!=="ready"} onAccepted={(project) => {
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]); setSelected(project);
      setAdoptTitle(`${book?.title ?? "Untitled"} (${project.targetLanguage.toUpperCase()})`);
      setNotice("Translation purchase confirmed. Track chapter progress and your held credits below.");
    }} />

    {active && <><section className={`${panel} mt-6`} aria-labelledby="translation-history"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 id="translation-history" className="text-xl font-medium">Translation history</h2><p className="mt-2 text-sm text-white/50">Refresh to see worker progress. Previewed text is never put into browser storage.</p></div><button type="button" onClick={() => void refreshHistory()} disabled={Boolean(busy)} className={subtle}>{busy === "refresh" ? "Refreshing…" : "Refresh history"}</button></div>
{historyState === "loading" ? <p className="mt-6 text-sm text-white/45">Loading translation history…</p> : historyState === "error" ? <p className="mt-6 text-sm text-white/45">Translation history is unavailable. Refresh before starting another translation.</p> : projects.length ? <ul className="mt-6 space-y-3">{projects.map((project) => <li key={project.id} className="rounded-xl border border-white/10 bg-black/25 p-4"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-medium">{project.sourceLanguage.toUpperCase()} → {project.targetLanguage.toUpperCase()}</p><p className="mt-1 text-sm text-white/45">{project.completedChapterCount}/{project.chapterCount} chapters · {project.billingMode === "quoted" ? "Usage-priced" : `${project.creditUnits} translation credits`}</p></div><div className="flex flex-wrap items-center gap-3"><span className={`rounded-full px-3 py-1 text-xs ${badge(project.status)}`}>{project.status}</span><button type="button" onClick={() => void preview(project.id, project.status === "succeeded")} disabled={Boolean(busy)} className={subtle}>{project.status === "succeeded" ? "Preview" : "Check progress"}</button></div></div>{project.adoptedBookId && <Link href={`/books/${project.adoptedBookId}`} className="mt-4 inline-block text-sm text-emerald-100 underline">Open translated draft</Link>}</li>)}</ul> : <p className="mt-6 text-sm text-white/45">No translations have been queued for this book.</p>}
    </section>

    {historyState === "ready" && selected && <section className={`${panel} mt-6`} aria-labelledby="translation-preview"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="translation-preview" className="text-xl font-medium">{selected.sourceLanguage.toUpperCase()} → {selected.targetLanguage.toUpperCase()} review</h2><p className="mt-2 text-sm text-white/50">{selected.completedChapterCount}/{selected.chapterCount} completed chapters. Review text against your source before creating a new manuscript draft.</p></div><span className={`rounded-full px-3 py-1 text-xs ${badge(selected.status)}`}>{selected.status}</span></div>
      {selected.canViewBilling && <section className="mt-5 rounded-xl border border-white/15 p-4" aria-label="Translation credit summary">
        <h3 className="font-medium">Your translation credits</h3>
        {billingError ? <p role="alert" className="mt-3 text-sm text-amber-100">{billingError}</p> : billing ? <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[["Originally reserved", billing.reservedCredits], ["Still held", billing.heldCredits], ["Charged", billing.chargedCredits], ["Returned", billing.returnedCredits]].map(([label, amount]) => <div key={label}><dt className="text-xs text-white/55">{label}</dt><dd className="mt-1 text-lg tabular-nums">{amount}</dd></div>)}
          </dl>
          <p className="mt-3 text-xs leading-5 text-white/55">Held credits are not a final charge. Returned credits are restored to your balance. These totals cover this translation, not your whole account.</p>
          {billing.reviewChapters > 0 && <p role="status" className="mt-3 text-sm text-amber-100">{billing.reviewChapters} chapter(s) need billing review. Their credits remain held; do not start another translation to retry them.</p>}
        </> : <p role="status" className="mt-3 text-sm text-white/55">Loading credit summary…</p>}
        <button type="button" className={`${subtle} mt-3`} disabled={Boolean(busy)} onClick={() => { setBilling(null); setBillingRevision((revision) => revision + 1); }}>Refresh billing</button>
      </section>}
      {editable && selected.canCancelBeforeDispatch && <div className="mt-5 rounded-xl border border-white/15 p-4">
        <p className="text-sm leading-6 text-white/65">You can cancel this usage-priced translation only before any chapter is dispatched. The server checks again before returning held credits.</p>
        {cancelConfirmation === selected.id ? <div className="mt-3 flex flex-wrap items-center gap-3"><p className="w-full text-sm text-amber-100">Cancel all chapters in this translation? Your source manuscript stays unchanged.</p><button type="button" className={subtle} disabled={Boolean(busy)} onClick={() => void cancel()}>{busy === "cancel" ? "Cancelling…" : "Confirm cancellation"}</button><button type="button" className={subtle} disabled={Boolean(busy)} onClick={() => setCancelConfirmation(null)}>Keep translation</button></div>
          : <button type="button" className={`${subtle} mt-3`} disabled={Boolean(busy)} onClick={() => setCancelConfirmation(selected.id)}>Cancel before dispatch</button>}
      </div>}
      <div className="mt-6 space-y-3">{selected.chapters.map((chapter) => <details key={chapter.id} className="rounded-xl border border-white/10 bg-black/25 p-4"><summary className="cursor-pointer list-none"><div className="flex flex-wrap items-center justify-between gap-3 pr-6"><span className="font-medium">{chapter.chapterOrder + 1}. {chapter.chapterTitle}</span><span className={`rounded-full px-3 py-1 text-xs ${badge(chapter.status)}`}>{chapter.status}</span></div></summary>{chapter.translatedText ? <p className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap border-t border-white/10 pt-4 text-sm leading-7 text-white/80">{chapter.translatedText}</p> : <p className="mt-4 border-t border-white/10 pt-4 text-sm text-white/45">{chapter.failureCode ? `This chapter stopped: ${chapter.failureCode}.` : "Translation text will appear after the worker completes this chapter."}</p>}</details>)}</div>
      {selected.status === "succeeded" && !selected.adoptedBookId && <div className="mt-7 border-t border-white/10 pt-6"><h3 className="font-medium">Create a translated draft</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-amber-100">This makes a separate draft with the translated chapter text. It does not copy a cover, publish anything, or certify translation quality. Review the manuscript, metadata, illustrations, and layout before publishing.</p><div className="mt-4 flex flex-col gap-3 sm:flex-row"><input value={adoptTitle} onChange={(event) => setAdoptTitle(event.target.value)} maxLength={500} className={field} aria-label="Translated draft title" /><button type="button" onClick={() => void adopt()} disabled={!editable || busy === "adopt"} className={primary}>{busy === "adopt" ? "Creating…" : "Create separate draft"}</button></div></div>}
      {selected.adoptedBookId && <Link href={`/books/${selected.adoptedBookId}`} className="mt-6 inline-block text-sm text-emerald-100 underline">Open translated draft</Link>}
    </section>}</>}
  </main>;
}
