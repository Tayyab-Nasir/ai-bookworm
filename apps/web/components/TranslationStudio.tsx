"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { TranslationBillingResult, TranslationProjectResult } from "@bookworm/api-client";
import type { Book } from "@bookworm/types";
import { apiClient } from "./api";
import TranslationQuotePanel from "./TranslationQuotePanel";

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

export default function TranslationStudio({ bookId }: { bookId: string }) {
  const api = apiClient(); const router = useRouter();
  const [book, setBook] = useState<Book | null>(null); const [role, setRole] = useState<string | null>(null);
  const [projects, setProjects] = useState<TranslationProjectResult[]>([]); const [selected, setSelected] = useState<TranslationProjectResult | null>(null);
  const [adoptTitle, setAdoptTitle] = useState("");
  const [busy, setBusy] = useState<"queue" | "refresh" | "preview" | "adopt" | "cancel" | null>(null); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [cancelConfirmation, setCancelConfirmation] = useState<string | null>(null);
  const [billing, setBilling] = useState<TranslationBillingResult | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingRevision, setBillingRevision] = useState(0);
  const billingProjectId = selected?.canViewBilling ? selected.id : null;
  useEffect(() => {
    let active = true; setBilling(null); setBillingError(null);
    if (billingProjectId) void api.getTranslationBilling(billingProjectId).then((result) => {
      if (active) setBilling(result);
    }).catch(() => { if (active) setBillingError("Billing could not be confirmed. Refresh to check your held credits; do not pay again to resolve this message."); });
    return () => { active = false; };
  }, [api, billingProjectId, billingRevision]);
  const editable = role ? editableRoles.has(role) : false;

  const load = useCallback(async () => {
    const [identity, history] = await Promise.all([api.getBook(bookId), api.listTranslationProjects(bookId)]);
    setBook(identity.book); setRole(identity.role); setProjects(history.projects);
  }, [api, bookId]);

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load translations.")); }, [load]);

  const refreshHistory = async () => {
    if (busy) return;
    setBusy("refresh"); setError(null);
    try { await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh translations."); }
    finally { setBusy(null); }
  };

  const preview = async (projectId: string, includeText: boolean) => {
    if (busy) return; setBusy(includeText ? "preview" : "refresh"); setError(null); setNotice(null);
    try {
      const project = await api.getTranslationProject(projectId, includeText); setSelected(project);
      setBillingRevision((revision) => revision + 1);
      setProjects((current) => current.map((item) => item.id === project.id ? { ...project, chapters: project.chapters.map(({ translatedText: _text, ...chapter }) => chapter) } : item));
      setAdoptTitle((current) => current || `${book?.title ?? "Untitled"} (${project.targetLanguage.toUpperCase()})`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh translation."); }
    finally { setBusy(null); }
  };

  const adopt = async () => {
    if (!selected || busy || !adoptTitle.trim()) { setError("Give the translated draft a title before creating it."); return; }
    setBusy("adopt"); setError(null); setNotice(null);
    try {
      const { book: draft } = await api.adoptTranslationProject(selected.id, { title: adoptTitle.trim() });
      setNotice("Translated draft created. Review every chapter before layout or publishing.");
      setProjects((current) => current.map((item) => item.id === selected.id ? { ...item, adoptedBookId: draft.id } : item));
      setSelected((current) => current ? { ...current, adoptedBookId: draft.id } : current);
      router.push(`/books/${draft.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create translated draft."); }
    finally { setBusy(null); }
  };

  const cancel = async () => {
    if (!selected || busy || cancelConfirmation !== selected.id) return;
    setBusy("cancel"); setError(null); setNotice(null);
    try {
      const result = await api.cancelQuotedTranslation(selected.id);
      setSelected((current) => current?.id === result.projectId ? {
        ...current, status: "cancelled", canCancelBeforeDispatch: false,
        chapters: current.chapters.map((chapter) => ({ ...chapter, status: "cancelled" })),
      } : current);
      setProjects((current) => current.map((item) => item.id === result.projectId ? { ...item, status: "cancelled", canCancelBeforeDispatch: false } : item));
      setCancelConfirmation(null);
      setBilling(null); setBillingRevision((revision) => revision + 1);
      setNotice(`Translation cancelled before dispatch. ${result.releasedCredits} held credits returned.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not confirm cancellation. Refresh the project before retrying."); }
    finally { setBusy(null); }
  };

  return <main className="mx-auto min-h-[calc(100dvh-84px)] max-w-6xl bg-black px-4 py-8 text-white sm:px-6 lg:py-12">
    <div className="flex flex-wrap items-start justify-between gap-5"><div><Link href={`/books/${bookId}`} className="text-sm text-white/50 hover:text-white">← Manuscript</Link><h1 className="mt-3 text-3xl font-medium tracking-[-0.04em]">Translate this book</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/55">Create a paid, version-pinned translation of your saved chapters. Nothing replaces your source book. You review the output before creating a separate draft.</p></div><Link href={`/books/${bookId}/publish`} className={subtle}>Layout & publish</Link></div>
    {error && <p role="alert" className="mt-6 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-100">{error}</p>}
    {notice && <p role="status" className="mt-6 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-50">{notice}</p>}

    <TranslationQuotePanel key={bookId} bookId={bookId} sourceLanguage={book?.language ?? ""} editable={editable} disabled={Boolean(busy)} onAccepted={(project) => {
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]); setSelected(project);
      setAdoptTitle(`${book?.title ?? "Untitled"} (${project.targetLanguage.toUpperCase()})`);
      setNotice("Translation purchase confirmed. Track chapter progress and your held credits below.");
    }} />

    <section className={`${panel} mt-6`} aria-labelledby="translation-history"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 id="translation-history" className="text-xl font-medium">Translation history</h2><p className="mt-2 text-sm text-white/50">Refresh to see worker progress. Previewed text is never put into browser storage.</p></div><button type="button" onClick={() => void refreshHistory()} disabled={Boolean(busy)} className={subtle}>{busy === "refresh" ? "Refreshing…" : "Refresh history"}</button></div>
{projects.length ? <ul className="mt-6 space-y-3">{projects.map((project) => <li key={project.id} className="rounded-xl border border-white/10 bg-black/25 p-4"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-medium">{project.sourceLanguage.toUpperCase()} → {project.targetLanguage.toUpperCase()}</p><p className="mt-1 text-sm text-white/45">{project.completedChapterCount}/{project.chapterCount} chapters · {project.billingMode === "quoted" ? "Usage-priced" : `${project.creditUnits} translation credits`}</p></div><div className="flex flex-wrap items-center gap-3"><span className={`rounded-full px-3 py-1 text-xs ${badge(project.status)}`}>{project.status}</span><button type="button" onClick={() => void preview(project.id, project.status === "succeeded")} disabled={Boolean(busy)} className={subtle}>{project.status === "succeeded" ? "Preview" : "Check progress"}</button></div></div>{project.adoptedBookId && <Link href={`/books/${project.adoptedBookId}`} className="mt-4 inline-block text-sm text-emerald-100 underline">Open translated draft</Link>}</li>)}</ul> : <p className="mt-6 text-sm text-white/45">No translations have been queued for this book.</p>}
    </section>

    {selected && <section className={`${panel} mt-6`} aria-labelledby="translation-preview"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="translation-preview" className="text-xl font-medium">{selected.sourceLanguage.toUpperCase()} → {selected.targetLanguage.toUpperCase()} review</h2><p className="mt-2 text-sm text-white/50">{selected.completedChapterCount}/{selected.chapterCount} completed chapters. Review text against your source before creating a new manuscript draft.</p></div><span className={`rounded-full px-3 py-1 text-xs ${badge(selected.status)}`}>{selected.status}</span></div>
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
    </section>}
  </main>;
}
