"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, type DocumentVersionSummary } from "@bookworm/api-client";
import type { Book, Chapter } from "@bookworm/types";
import type { BookNode } from "@bookworm/book-model";
import { apiClient } from "./api";
import BookTree from "./BookTree";
import RichBookEditor, { type EditorDocument, type EditorValidationError } from "./RichBookEditor";
import VersionTimeline from "./VersionTimeline";
import AiAssistantPanel from "./AiAssistantPanel";
import { storyBlueprintWriterBrief } from "../lib/story-blueprint-draft";

const EDIT_ROLES = new Set(["owner","admin","editor","writer","illustrator","designer"]);

export default function BookEditorClient({ bookId, initialChapterId, initialAiJobId, initialDraftPlanItemId }: { bookId: string; initialChapterId?: string; initialAiJobId?: string; initialDraftPlanItemId?: string }) {
  const api = apiClient();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [draft, setDraft] = useState<BookNode[]>([]);
  const [versions, setVersions] = useState<DocumentVersionSummary[]>([]);
  const [role, setRole] = useState("viewer");
  const [dirty, setDirty] = useState(false);
  const [editorValidation, setEditorValidation] = useState<EditorValidationError | null>(null);
  const hasUnsavedChanges = dirty || editorValidation !== null;
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bookLoadAttempt, setBookLoadAttempt] = useState(0);
  const [requestedChapterId, setRequestedChapterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newChapterBrief, setNewChapterBrief] = useState("");
  const [initialDraftInstruction, setInitialDraftInstruction] = useState<string | undefined>();
  const [draftPlanTargetChapterId, setDraftPlanTargetChapterId] = useState<string | null>(null);
  const [draftPlanMessage, setDraftPlanMessage] = useState<string | null>(null);
  const [activeAiJobId, setActiveAiJobId] = useState<string | undefined>(initialAiJobId);
  const creatingChapter = useRef(false);
  const pendingCreation = useRef<{ bookId: string; title: string; brief: string; idempotencyKey: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [structureOpen, setStructureOpen] = useState(false);
  const loadSequence = useRef(0);
  const pendingSave = useRef<{ operationId: string; nodes: BookNode[]; expectedVersion: number } | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ chapterId: string; versionId: string; body: { operationId: string; expectedVersion: number } } | null>(null);
  const restoring = useRef(false);

  const loadChapter = useCallback(async (chapterId: string, reportFailure = false, preserveCurrentReview = false) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setRequestedChapterId(chapterId);
    // Keep a confirmed same-chapter AI review mounted during its refresh, never across targets or a failed revalidation.
    if (!preserveCurrentReview) { setDocument(null); setDraft([]); setVersions([]); setRole("viewer"); }
    setDirty(false); setEditorValidation(null); setConflict(false); setError(null); setNotice(null);
    setPendingRestore(null); pendingSave.current = null;
    try {
      const [content, history] = await Promise.all([api.getChapterDocument(chapterId), api.listDocumentVersions(chapterId)]);
      if (sequence !== loadSequence.current) return;
      setDocument(content.document); setDraft(content.document.nodes); setRole(content.role); setVersions(history.versions);
      setDirty(false); setEditorValidation(null); setConflict(false); setError(null); setPendingRestore(null); pendingSave.current = null; setReloadKey((v) => v + 1);
    } catch (reason) {
      if (sequence === loadSequence.current) { setDocument(null); setDraft([]); setVersions([]); setRole("viewer"); setError(reason instanceof Error ? reason.message : "Could not load manuscript"); }
      if (reportFailure) throw reason;
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    ++loadSequence.current;
    setBook(null); setChapters([]); setDocument(null); setDraft([]); setVersions([]); setRole("viewer");
    setDirty(false); setEditorValidation(null); setSaving(false); setLoading(true); setError(null); setNotice(null);
    setConflict(false); setPendingRestore(null); setRequestedChapterId(null);
    pendingSave.current = null; creatingChapter.current = false; restoring.current = false;
    if (pendingCreation.current?.bookId !== bookId) pendingCreation.current = null;
    setInitialDraftInstruction(undefined); setDraftPlanTargetChapterId(null); setDraftPlanMessage(null); setActiveAiJobId(initialAiJobId);
    void Promise.all([api.getBook(bookId), api.listChapters(bookId)]).then(async ([identity, result]) => {
      if (cancelled) return;
      setBook(identity.book); setRole(identity.role); setChapters(result.chapters);
      const selected = initialChapterId ? result.chapters.find((chapter) => chapter.id === initialChapterId) : result.chapters[0];
      if (initialChapterId && !selected) { setError("The requested chapter is not available in this book. Choose an available chapter to continue."); setLoading(false); return; }
      if (selected && initialDraftPlanItemId) {
        setInitialDraftInstruction(undefined);
        setDraftPlanTargetChapterId(null);
        setDraftPlanMessage(null);
        try {
          const { blueprint } = await api.getStoryBlueprint(bookId);
          if (cancelled) return;
          const brief = storyBlueprintWriterBrief(blueprint, initialDraftPlanItemId, selected.id);
          if (brief.ok) { setInitialDraftInstruction(brief.instruction); setDraftPlanTargetChapterId(selected.id); }
          else setDraftPlanMessage(brief.reason);
        } catch {
          if (!cancelled) setDraftPlanMessage("Could not load the saved story plan. No AI request was sent; reload the blueprint and try again.");
        }
      }
      if (cancelled) return;
      if (selected) void loadChapter(selected.id); else setLoading(false);
    }).catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "Could not load book"); setLoading(false); } });
    return () => { cancelled = true; loadSequence.current++; };
  }, [api, bookId, initialChapterId, initialAiJobId, initialDraftPlanItemId, bookLoadAttempt, loadChapter]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (hasUnsavedChanges || pendingRestore || pendingCreation.current) { event.preventDefault(); event.returnValue = ""; } };
    const guardNavigation = (event: globalThis.MouseEvent) => {
      if ((!hasUnsavedChanges && !pendingRestore && !pendingCreation.current) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm(pendingCreation.current ? "Leave the editor? Chapter creation is unconfirmed; keep this page to recover the original request." : "Leave the editor and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    window.document.addEventListener("click", guardNavigation, true);
    return () => { window.removeEventListener("beforeunload", warn); window.document.removeEventListener("click", guardNavigation, true); };
  }, [hasUnsavedChanges, pendingRestore]);

  const save = useCallback(async () => {
    if (!document || saving || loading || conflict || !dirty || pendingRestore || editorValidation || !EDIT_ROLES.has(role)) return;
    const sequence = loadSequence.current;
    setSaving(true); setError(null); setNotice(null);
    const request = pendingSave.current ?? { operationId: crypto.randomUUID(), nodes: draft, expectedVersion: document.version };
    pendingSave.current = request;
    try {
      const result = await api.saveChapterDocument(document.chapterId, request);
      if (sequence !== loadSequence.current) return;
      setDocument(result.document); setDirty(false); pendingSave.current = null;
      setNotice(`Saved version ${result.version}.`);
      const history = await api.listDocumentVersions(document.chapterId);
      if (sequence === loadSequence.current) setVersions(history.versions);
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      if (reason instanceof ApiClientError && reason.status === 409) setConflict(true);
      setError(reason instanceof Error ? reason.message : "Save failed. Your draft remains in this editor.");
    } finally { if (sequence === loadSequence.current) setSaving(false); }
  }, [api, document, draft, saving, loading, role, conflict, dirty, pendingRestore, editorValidation]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [save]);

  const selectChapter = (id: string) => {
    if (saving || loading || id === document?.chapterId) return;
    if ((hasUnsavedChanges || pendingRestore) && !window.confirm("This chapter has unsaved changes or an unresolved restore. Leave it and open another chapter?")) return;
    setActiveAiJobId(undefined);
    void loadChapter(id);
  };

  const createChapter = async () => {
    if (!newTitle.trim() || saving || loading || creatingChapter.current || pendingRestore || !EDIT_ROLES.has(role) || (hasUnsavedChanges && !window.confirm("Discard the unsaved chapter draft before adding a chapter?"))) return;
    creatingChapter.current = true;
    let sequence = loadSequence.current;
    setSaving(true); setError(null);
    const creation = pendingCreation.current ?? { bookId, title: newTitle.trim(), brief: newChapterBrief.trim(), idempotencyKey: crypto.randomUUID() };
    pendingCreation.current = creation;
    const chapterTitle = creation.title;
    let createdChapterId: string | null = null;
    const brief = creation.brief;
    try {
      const result = await api.createChapter(bookId, { title: chapterTitle, idempotencyKey: creation.idempotencyKey });
      if (sequence !== loadSequence.current) return;
      pendingCreation.current = null;
      createdChapterId = result.chapter.id;
      setChapters((rows) => rows.some(chapter => chapter.id === result.chapter.id) ? rows : [...rows, result.chapter]);
      setNewTitle(""); setActiveAiJobId(undefined);
      sequence = loadSequence.current + 1;
      await loadChapter(result.chapter.id, true);
      if (sequence !== loadSequence.current) return;
      if (!brief) { setNewChapterBrief(""); setNotice(`Created ${chapterTitle}.`); return; }
      setInitialDraftInstruction(brief);
      setDraftPlanTargetChapterId(result.chapter.id);
      setNewChapterBrief("");
      setNotice("Chapter created. Review the draft brief and request a price in the AI assistant. Nothing was generated or charged.");
    }
    catch (reason) {
      if (sequence !== loadSequence.current) return;
      const message = reason instanceof Error ? reason.message : "Could not create chapter";
      setError(createdChapterId ? `Your chapter is saved, but it could not be loaded: ${message} Open the chapter to continue. No AI request was sent; your brief remains in the form.` : `${message} Submit again to recover the original chapter request for “${chapterTitle}”.`);
    }
    finally { if (sequence === loadSequence.current) { creatingChapter.current = false; setSaving(false); } }
  };

  const reorder = async (orderedIds: string[]) => {
    if (saving || loading || pendingRestore || !EDIT_ROLES.has(role)) return;
    const sequence = loadSequence.current;
    setSaving(true); setError(null);
    try { const result = await api.reorderChapters(bookId, { orderedIds, expectedIds: chapters.map((c) => c.id) }); if (sequence === loadSequence.current) setChapters(result.chapters); }
    catch (reason) { if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "Could not reorder chapters"); }
    finally { if (sequence === loadSequence.current) setSaving(false); }
  };

  const restore = async (versionId: string) => {
    if (!document || saving || loading || restoring.current || !EDIT_ROLES.has(role)) return;
    if (pendingRestore && (pendingRestore.versionId !== versionId || pendingRestore.chapterId !== document.chapterId)) return;
    if (!pendingRestore && !window.confirm("Restore this version as a new saved version? Current saved history will remain available.")) return;
    if (!pendingRestore && hasUnsavedChanges && !window.confirm("Your unsaved draft will be replaced. Continue?")) return;
    const request = pendingRestore ?? { chapterId: document.chapterId, versionId, body: { expectedVersion: document.version, operationId: crypto.randomUUID() } };
    const sequence = loadSequence.current;
    restoring.current = true;
    setPendingRestore(request); setSaving(true); setError(null); setNotice(null);
    try {
      const result = await api.restoreDocumentVersion(request.chapterId, request.versionId, request.body);
      if (sequence !== loadSequence.current) return;
      // Adopt the confirmed receipt before refreshing history. A failed history
      // request must not leave the old draft marked as the restored manuscript.
      setDocument(result.document); setDraft(result.document.nodes); setDirty(false); setEditorValidation(null);
      setPendingRestore(null); setConflict(false); pendingSave.current = null; setReloadKey((v) => v + 1);
      setNotice(`Restored as version ${result.version}.`);
      try { const history = await api.listDocumentVersions(request.chapterId); if (sequence === loadSequence.current) setVersions(history.versions); }
      catch { if (sequence === loadSequence.current) setError("Restore succeeded, but version history could not refresh. Reload the chapter to refresh history."); }
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      if (reason instanceof ApiClientError && reason.status === 409) { setPendingRestore(null); setConflict(true); }
      setError(reason instanceof Error ? reason.message : "Could not confirm restore. Retry the original request or reload saved content.");
    }
    finally { if (sequence === loadSequence.current) { restoring.current = false; setSaving(false); } }
  };

  const downloadDraft = () => {
    const blob = new Blob([editorValidation?.draftText ?? draft.map((n) => n.text ?? "").join("\n\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = window.document.createElement("a"); link.href = url; link.download = "unsaved-manuscript.txt"; link.click(); URL.revokeObjectURL(url);
  };
  const editable = EDIT_ROLES.has(role) && !pendingRestore;
  const editorSequence = loadSequence.current;
  const wordCount = editorValidation ? (editorValidation.draftText.match(/\S+/gu)?.length ?? 0)
    : draft.reduce((count, node) => count + (node.text?.trim() ? node.text.trim().split(/\s+/u).length : 0), 0);
  return <main className="mx-auto min-h-[calc(100dvh-84px)] max-w-[1680px] bg-black p-4 text-white sm:p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div><Link href="/dashboard" className="text-xs text-white/50 hover:text-white">← Library</Link><h1 className="mt-2 text-2xl font-medium">{book?.title ?? "Manuscript"}</h1></div>
      <div className="flex flex-wrap items-center gap-3 text-sm"><Link href={`/books/${bookId}/plan`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Plan</Link><Link href={`/books/${bookId}/translate`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Translate</Link><Link href={`/books/${bookId}/publish`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Layout & publish</Link><span role="status" className="text-white/50">{editorValidation ? "Unsaved · correct numbering before saving" : saving ? "Saving…" : dirty ? "Unsaved changes" : document ? `Saved · v${document.version}` : ""}</span>
        {editable && document && <button type="button" onClick={() => void save()} disabled={!dirty || saving || conflict || loading || editorValidation !== null} className="rounded-full bg-white px-5 py-2 font-medium text-black disabled:opacity-40">Save chapter</button>}
        {editorValidation && <button type="button" onClick={downloadDraft} className="rounded-full border border-white/20 px-4 py-2">Download draft text</button>}
      </div>
    </div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}
      {!document && !loading && <button type="button" className="mt-3 block min-h-11 rounded-lg border border-red-200/30 px-3 py-2 underline focus-visible:ring-2 focus-visible:ring-white" onClick={() => requestedChapterId ? void loadChapter(requestedChapterId) : setBookLoadAttempt(attempt => attempt + 1)}>{requestedChapterId ? "Retry loading chapter" : "Retry loading book"}</button>}
    </div>}
    {draftPlanMessage && <p role="status" className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-sm leading-6 text-amber-100">{draftPlanMessage}</p>}
    {notice && <p role="status" className="mb-4 text-sm text-emerald-200">{notice}</p>}
    {pendingRestore && !saving && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Restore outcome is not confirmed. Your current draft remains here; editing is paused until you recover the request or reload saved content.</p><div className="mt-3 flex flex-wrap gap-4"><button type="button" disabled={loading} className="underline" onClick={() => void restore(pendingRestore.versionId)}>Retry original restore</button><button type="button" className="underline" onClick={downloadDraft}>Download my draft</button><button type="button" disabled={loading} className="underline" onClick={() => { if (window.confirm("Reload saved content and replace this draft? Download it first if needed.")) void loadChapter(pendingRestore.chapterId); }}>Reload saved content</button></div></div>}
    {conflict && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Another save changed this chapter. Your unsaved draft is still here. Download it before reloading if you need to merge changes.</p><button className="mr-4 mt-3 underline" onClick={downloadDraft}>Download my draft</button><button className="underline" onClick={() => { if (document && window.confirm("Reload saved content and replace this unsaved draft?")) void loadChapter(document.chapterId); }}>Reload saved version</button></div>}
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_260px]">
      <aside className="self-start rounded-2xl border border-white/10 p-2">
        <button type="button" className="flex min-h-11 w-full items-center justify-between px-3 text-sm text-white/75 lg:hidden" aria-expanded={structureOpen} aria-controls="chapter-structure" onClick={() => setStructureOpen((open) => !open)}><span>Chapters · {chapters.length}</span><span>{structureOpen ? "Hide" : "Show"}</span></button>
        <div id="chapter-structure" className={structureOpen ? "block" : "hidden lg:block"}>
        <BookTree chapters={chapters} activeId={document?.chapterId ?? null} onSelect={selectChapter} onReorder={(ids) => void reorder(ids)} disabled={saving || loading} readOnly={!editable} />
        {editable && <form className="mt-5 space-y-2 border-t border-white/10 p-2 pt-4" onSubmit={(event) => { event.preventDefault(); void createChapter(); }}>
          <fieldset disabled={saving || loading} className="min-w-0 space-y-2 disabled:opacity-50">
          <label className="block text-xs text-white/50" htmlFor="new-chapter-title">New chapter</label><input id="new-chapter-title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} disabled={!!pendingCreation.current} aria-describedby={pendingCreation.current ? "chapter-creation-recovery" : undefined} maxLength={500} required placeholder="Chapter title" className="w-full rounded-lg border border-white/15 bg-black p-2 text-sm" />
          <label className="block text-xs text-white/50" htmlFor="new-chapter-brief">Optional AI drafting brief</label><textarea id="new-chapter-brief" value={newChapterBrief} onChange={(e) => setNewChapterBrief(e.target.value)} disabled={!!pendingCreation.current} aria-describedby={pendingCreation.current ? "chapter-creation-recovery" : undefined} maxLength={4000} rows={3} placeholder="What happens in this chapter?" className="w-full resize-y rounded-lg border border-white/15 bg-black p-2 text-sm" />
          <p className="text-[11px] leading-4 text-white/40">A brief creates an empty chapter and opens separate AI price review. Nothing is generated or charged until you accept a quote.</p>
          {pendingCreation.current && <p id="chapter-creation-recovery" role="status" className="break-words text-xs leading-5 text-white/70">Creation of “{pendingCreation.current.title}” is not confirmed. Retry the original request; its title and brief stay locked until the outcome is confirmed.</p>}
          <button disabled={saving || !newTitle.trim()} className="min-h-11 w-full rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">{pendingCreation.current ? "Retry chapter creation" : newChapterBrief.trim() ? "Add & review AI brief" : "Add chapter"}</button>
          </fieldset>
        </form>}
        </div>
      </aside>
      <section className="min-w-0">
        {document && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1"><h2 className="text-sm text-white/75">{chapters.find((chapter) => chapter.id === document.chapterId)?.title ?? "Chapter"}</h2><span className="text-xs tabular-nums text-white/45">{wordCount.toLocaleString()} words</span></div>}
        {loading ? <p className="p-8 text-white/50" role="status">Loading manuscript…</p> : document && book ? <RichBookEditor key={`${document.chapterId}:${reloadKey}`} document={document} workspaceId={book.workspace_id} permissions={editable && !saving ? "editor" : "viewer"} onValidationChange={setEditorValidation} onChange={(nodes) => { setDraft(nodes); setDirty(true); pendingSave.current = null; setNotice(null); }} /> : <div className="rounded-2xl border border-dashed border-white/15 p-10 text-white/60">{error ? "Resolve the connection error to open this manuscript." : "Add your first chapter to start writing."}</div>}
      </section>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto lg:col-span-2 xl:col-span-1">
        <AiAssistantPanel key={document?.chapterId ?? "empty"} bookId={bookId} chapterId={document?.chapterId ?? null} savedChapter={document} initialJobId={activeAiJobId} initialDraftInstruction={document?.chapterId === draftPlanTargetChapterId ? initialDraftInstruction : undefined} dirty={hasUnsavedChanges} editable={editable && !saving && !loading} onApplied={async () => { if (document && editorSequence === loadSequence.current) await loadChapter(document.chapterId, true, true); }} />
        <div className="rounded-2xl border border-white/10 p-2"><VersionTimeline key={document?.chapterId ?? "empty"} versions={versions} onRestore={(id) => void restore(id)} readOnly={!editable || saving || loading} /></div>
      </div>
    </div>
  </main>;
}
