"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, type DocumentVersionSummary } from "@bookworm/api-client";
import type { Book, Chapter } from "@bookworm/types";
import type { BookNode } from "@bookworm/book-model";
import { apiClient } from "./api";
import BookTree from "./BookTree";
import RichBookEditor, { type EditorDocument } from "./RichBookEditor";
import VersionTimeline from "./VersionTimeline";
import AiAssistantPanel from "./AiAssistantPanel";
import { retryableAiDraft, chapterDraftIdempotencyKey } from "../lib/ai-draft-request";

const EDIT_ROLES = new Set(["owner","admin","editor","writer","illustrator","designer"]);

export default function BookEditorClient({ bookId, initialChapterId, initialAiJobId }: { bookId: string; initialChapterId?: string; initialAiJobId?: string }) {
  const api = apiClient();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [draft, setDraft] = useState<BookNode[]>([]);
  const [versions, setVersions] = useState<DocumentVersionSummary[]>([]);
  const [role, setRole] = useState("viewer");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newChapterBrief, setNewChapterBrief] = useState("");
  const [activeAiJobId, setActiveAiJobId] = useState<string | undefined>(initialAiJobId);
  const [pendingDraft, setPendingDraft] = useState<ReturnType<typeof retryableAiDraft> | null>(null);
  const creatingChapter = useRef(false);
  const pendingCreation = useRef<{ title: string; brief: string; idempotencyKey: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [structureOpen, setStructureOpen] = useState(false);
  const loadSequence = useRef(0);
  const pendingSave = useRef<{ operationId: string; nodes: BookNode[]; expectedVersion: number } | null>(null);

  const loadChapter = useCallback(async (chapterId: string) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const [content, history] = await Promise.all([api.getChapterDocument(chapterId), api.listDocumentVersions(chapterId)]);
      if (sequence !== loadSequence.current) return;
      setDocument(content.document); setDraft(content.document.nodes); setRole(content.role); setVersions(history.versions);
      setDirty(false); setConflict(false); setError(null); pendingSave.current = null; setReloadKey((v) => v + 1);
    } catch (reason) {
      if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "Could not load manuscript");
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getBook(bookId), api.listChapters(bookId)]).then(([identity, result]) => {
      if (cancelled) return;
      setBook(identity.book); setRole(identity.role); setChapters(result.chapters);
      const selected = result.chapters.find((chapter) => chapter.id === initialChapterId) ?? result.chapters[0];
      if (selected) void loadChapter(selected.id); else setLoading(false);
    }).catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "Could not load book"); setLoading(false); } });
    return () => { cancelled = true; loadSequence.current++; };
  }, [api, bookId, initialChapterId, loadChapter]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    const guardNavigation = (event: globalThis.MouseEvent) => {
      if (!dirty || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm("Leave the editor and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    window.document.addEventListener("click", guardNavigation, true);
    return () => { window.removeEventListener("beforeunload", warn); window.document.removeEventListener("click", guardNavigation, true); };
  }, [dirty]);

  const save = useCallback(async () => {
    if (!document || saving || conflict || !dirty) return;
    setSaving(true); setError(null); setNotice(null);
    const request = pendingSave.current ?? { operationId: crypto.randomUUID(), nodes: draft, expectedVersion: document.version };
    pendingSave.current = request;
    try {
      const result = await api.saveChapterDocument(document.chapterId, request);
      setDocument(result.document); setDirty(false); pendingSave.current = null;
      setNotice(`Saved version ${result.version}.`);
      const history = await api.listDocumentVersions(document.chapterId); setVersions(history.versions);
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 409) setConflict(true);
      setError(reason instanceof Error ? reason.message : "Save failed. Your draft remains in this editor.");
    } finally { setSaving(false); }
  }, [api, document, draft, saving, conflict, dirty]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [save]);

  const selectChapter = (id: string) => {
    if (saving || loading || id === document?.chapterId) return;
    if (dirty && !window.confirm("This chapter has unsaved changes. Discard them and open another chapter?")) return;
    setActiveAiJobId(undefined);
    void loadChapter(id);
  };

  const createChapter = async () => {
    if (!newTitle.trim() || saving || loading || creatingChapter.current || pendingDraft || !EDIT_ROLES.has(role) || (dirty && !window.confirm("Discard the unsaved chapter draft before adding a chapter?"))) return;
    creatingChapter.current = true;
    setSaving(true); setError(null);
    const creation = pendingCreation.current ?? { title: newTitle.trim(), brief: newChapterBrief.trim(), idempotencyKey: crypto.randomUUID() };
    pendingCreation.current = creation;
    const chapterTitle = creation.title;
    let createdChapterId: string | null = null;
    const brief = creation.brief;
    try {
      const result = await api.createChapter(bookId, { title: chapterTitle, idempotencyKey: creation.idempotencyKey });
      pendingCreation.current = null;
      createdChapterId = result.chapter.id;
      setChapters((rows) => [...rows, result.chapter]);
      setNewTitle(""); setActiveAiJobId(undefined);
      await loadChapter(result.chapter.id);
      if (!brief) { setNewChapterBrief(""); setNotice(`Created ${chapterTitle}.`); return; }
      const request = retryableAiDraft(api.createAiJob, {
        bookId, chapterIds: [result.chapter.id], agentType: "writer", userInstruction: brief,
        idempotencyKey: chapterDraftIdempotencyKey(bookId, result.chapter.id),
        contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: true, maxTokens: 16_000 },
      });
      setPendingDraft(request);
      const job = await request.run();
      setPendingDraft(null);
      setNewChapterBrief("");
      setActiveAiJobId(job.id);
      setNotice("Chapter created. Open its AI review to follow progress.");
    }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not create chapter";
      setError(createdChapterId ? `Your chapter is saved. We could not confirm the AI request: ${message} Retry the original request below to recover its review.` : `${message} Submit again to recover the original chapter request for “${chapterTitle}”.`);
    }
    finally { creatingChapter.current = false; setSaving(false); }
  };

  const retryDraft = async () => {
    if (!pendingDraft || saving || loading || dirty || !EDIT_ROLES.has(role)) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const job = await pendingDraft.run();
      await loadChapter(pendingDraft.chapterId);
      setActiveAiJobId(job.id); setPendingDraft(null); setNewChapterBrief("");
      setNotice("AI request recovered. Open its review to follow progress.");
    } catch (reason) {
      setError(`Could not confirm the AI request. Retry uses the same request. ${reason instanceof Error ? reason.message : "Please try again."}`);
    } finally { setSaving(false); }
  };

  const reorder = async (orderedIds: string[]) => {
    if (saving) return;
    setSaving(true); setError(null);
    try { const result = await api.reorderChapters(bookId, { orderedIds, expectedIds: chapters.map((c) => c.id) }); setChapters(result.chapters); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not reorder chapters"); }
    finally { setSaving(false); }
  };

  const restore = async (versionId: string) => {
    if (!document || saving || !EDIT_ROLES.has(role)) return;
    if (!window.confirm("Restore this version as a new saved version? Current saved history will remain available.")) return;
    if (dirty && !window.confirm("Your unsaved draft will be replaced. Continue?")) return;
    setSaving(true); setError(null);
    try {
      const result = await api.restoreDocumentVersion(document.chapterId, versionId, { expectedVersion: document.version, operationId: crypto.randomUUID() });
      await loadChapter(document.chapterId); setNotice(`Restored as version ${result.version}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not restore version"); }
    finally { setSaving(false); }
  };

  const downloadDraft = () => {
    const blob = new Blob([draft.map((n) => n.text ?? "").join("\n\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = window.document.createElement("a"); link.href = url; link.download = "unsaved-manuscript.txt"; link.click(); URL.revokeObjectURL(url);
  };
  const editable = EDIT_ROLES.has(role);
  return <main className="mx-auto min-h-[calc(100dvh-84px)] max-w-[1680px] bg-black p-4 text-white sm:p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div><Link href="/dashboard" className="text-xs text-white/50 hover:text-white">← Library</Link><h1 className="mt-2 text-2xl font-medium">{book?.title ?? "Manuscript"}</h1></div>
      <div className="flex flex-wrap items-center gap-3 text-sm"><Link href={`/books/${bookId}/plan`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Plan</Link><Link href={`/books/${bookId}/translate`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Translate</Link><Link href={`/books/${bookId}/publish`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Layout & publish</Link><span role="status" className="text-white/50">{saving ? "Saving…" : dirty ? "Unsaved changes" : document ? `Saved · v${document.version}` : ""}</span>
        {editable && <button type="button" onClick={() => void save()} disabled={!dirty || saving || conflict || loading} className="rounded-full bg-white px-5 py-2 font-medium text-black disabled:opacity-40">Save chapter</button>}
      </div>
    </div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <p role="status" className="mb-4 text-sm text-emerald-200">{notice}</p>}
    {pendingDraft && !saving && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Your chapter is saved. Resolve its pending AI request before adding another chapter. The original brief is retained in this tab.</p><button type="button" disabled={loading || dirty || !editable} onClick={() => void retryDraft()} className="mt-3 rounded-lg border border-white/25 px-4 py-2 disabled:opacity-40">Retry original AI request</button>{dirty && <p className="mt-2 text-xs">Save your current edits before recovering the review.</p>}</div>}
    {conflict && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Another save changed this chapter. Your unsaved draft is still here. Download it before reloading if you need to merge changes.</p><button className="mr-4 mt-3 underline" onClick={downloadDraft}>Download my draft</button><button className="underline" onClick={() => { if (document && window.confirm("Reload saved content and replace this unsaved draft?")) void loadChapter(document.chapterId); }}>Reload saved version</button></div>}
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_260px]">
      <aside className="self-start rounded-2xl border border-white/10 p-2">
        <button type="button" className="flex min-h-11 w-full items-center justify-between px-3 text-sm text-white/75 lg:hidden" aria-expanded={structureOpen} aria-controls="chapter-structure" onClick={() => setStructureOpen((open) => !open)}><span>Chapters · {chapters.length}</span><span>{structureOpen ? "Hide" : "Show"}</span></button>
        <div id="chapter-structure" className={structureOpen ? "block" : "hidden lg:block"}>
        <BookTree chapters={chapters} activeId={document?.chapterId ?? null} onSelect={selectChapter} onReorder={(ids) => void reorder(ids)} disabled={saving || loading} readOnly={!editable} />
        {editable && <form className="mt-5 space-y-2 border-t border-white/10 p-2 pt-4" onSubmit={(event) => { event.preventDefault(); void createChapter(); }}>
          <fieldset disabled={saving || loading || Boolean(pendingDraft)} className="min-w-0 space-y-2 disabled:opacity-50">
          <label className="block text-xs text-white/50" htmlFor="new-chapter-title">New chapter</label><input id="new-chapter-title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={500} required placeholder="Chapter title" className="w-full rounded-lg border border-white/15 bg-black p-2 text-sm" />
          <label className="block text-xs text-white/50" htmlFor="new-chapter-brief">Optional AI drafting brief</label><textarea id="new-chapter-brief" value={newChapterBrief} onChange={(e) => setNewChapterBrief(e.target.value)} maxLength={4000} rows={3} placeholder="What happens in this chapter?" className="w-full resize-y rounded-lg border border-white/15 bg-black p-2 text-sm" />
          <p className="text-[11px] leading-4 text-white/40">A brief creates an empty chapter and queues a draft for approval. It never writes directly into your manuscript.</p>
          <button disabled={saving || !newTitle.trim()} className="rounded-lg border border-white/20 px-3 py-2 text-xs disabled:opacity-40">{newChapterBrief.trim() ? "Add & queue AI draft" : "Add chapter"}</button>
          </fieldset>
        </form>}
        </div>
      </aside>
      <section className="min-w-0">
        {document && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1"><h2 className="text-sm text-white/75">{chapters.find((chapter) => chapter.id === document.chapterId)?.title ?? "Chapter"}</h2><span className="text-xs tabular-nums text-white/45">{draft.reduce((count, node) => count + (node.text?.trim() ? node.text.trim().split(/\s+/u).length : 0), 0).toLocaleString()} words</span></div>}
        {loading ? <p className="p-8 text-white/50" role="status">Loading manuscript…</p> : document && book ? <RichBookEditor key={`${document.chapterId}:${reloadKey}`} document={document} workspaceId={book.workspace_id} permissions={editable && !saving ? "editor" : "viewer"} onChange={(nodes) => { setDraft(nodes); setDirty(true); pendingSave.current = null; setNotice(null); }} /> : <div className="rounded-2xl border border-dashed border-white/15 p-10 text-white/60">{error ? "Resolve the connection error to open this manuscript." : "Add your first chapter to start writing."}</div>}
      </section>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto lg:col-span-2 xl:col-span-1">
        <AiAssistantPanel key={document?.chapterId ?? "empty"} bookId={bookId} chapterId={document?.chapterId ?? null} initialJobId={activeAiJobId} dirty={dirty} editable={editable && !saving && !loading && !pendingDraft} onApplied={async () => { if (document) await loadChapter(document.chapterId); }} />
        <div className="rounded-2xl border border-white/10 p-2"><VersionTimeline key={document?.chapterId ?? "empty"} versions={versions} onRestore={(id) => void restore(id)} readOnly={!editable || saving || loading} /></div>
      </div>
    </div>
  </main>;
}
