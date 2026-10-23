"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, type DocumentVersionSummary } from "@bookworm/api-client";
import type { Book, Chapter } from "@bookworm/types";
import { bookNodesPlainText, bookNodesWordCount } from "@bookworm/book-model/plain-text";
import type { BookNode } from "@bookworm/book-model";
import { apiClient } from "./api";
import BookTree from "./BookTree";
import ChapterTitleEditor, { type ChapterTitleEditorState } from "./ChapterTitleEditor";
import RichBookEditor, { type EditorDocument, type EditorValidationError } from "./RichBookEditor";
import VersionTimeline from "./VersionTimeline";
import AiAssistantPanel from "./AiAssistantPanel";
import { storyBlueprintWriterBrief } from "../lib/story-blueprint-draft";
import { chapterDraftBackup } from "../lib/chapter-draft";
import { chapterSaveDigest, chapterSaveKey, clearChapterSave, editorAccount, parseChapterSave, persistChapterSave,
  validateChapterSaveResult, validateCurrentChapter, validateSavedChapter, type ChapterSavePointer } from "../lib/manual-chapter-save";

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
  const [titleState, setTitleState] = useState<ChapterTitleEditorState>({ dirty: false, busy: false, pending: false });
  const titleBlocked = titleState.dirty || titleState.busy || titleState.pending;
  const hasUnsavedChanges = dirty || editorValidation !== null || titleState.dirty;
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [aiDecisionBusy, setAiDecisionBusy] = useState(false);
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
  const saveFlight = useRef<number | null>(null);
  const [saveAccount, setSaveAccount] = useState<string | null>(null);
  const [saveRecoveryReady, setSaveRecoveryReady] = useState(false);
  const [manualSave, setManualSave] = useState<ChapterSavePointer | null>(null);
  const [saveMissing, setSaveMissing] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ chapterId: string; versionId: string; body: { operationId: string; expectedVersion: number } } | null>(null);
  const restoring = useRef(false);
  const liveDraft = useRef(hasUnsavedChanges); liveDraft.current = hasUnsavedChanges;

  const loadChapter = useCallback(async (chapterId: string, reportFailure = false, preserveCurrentReview = false) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setRequestedChapterId(chapterId);
    // Keep a confirmed same-chapter AI review mounted during its refresh, never across targets or a failed revalidation.
    if (!preserveCurrentReview) { setDocument(null); setDraft([]); setVersions([]); setRole("viewer"); }
    setDirty(false); setEditorValidation(null); setConflict(false); setError(null); setNotice(null);
    setPendingRestore(null); pendingSave.current = null;
    setSaveRecoveryReady(false); setManualSave(null); setSaveMissing(false); setSaveAccount(null);
    try {
      const [content, history, userId] = await Promise.all([api.getChapterDocument(chapterId), api.listDocumentVersions(chapterId), editorAccount()]);
      await editorAccount(userId);
      if (sequence !== loadSequence.current) return;
      validateCurrentChapter(content.document, chapterId);
      setDocument(content.document); setDraft(content.document.nodes); setRole(content.role); setVersions(history.versions);
      setDirty(false); setEditorValidation(null); setConflict(false); setError(null); setPendingRestore(null); pendingSave.current = null; setReloadKey((v) => v + 1);
      setSaveAccount(userId);
      try {
        const scope = { userId, bookId, chapterId };
        setManualSave(parseChapterSave(window.sessionStorage.getItem(chapterSaveKey(scope)), scope));
        setSaveRecoveryReady(true);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Browser recovery could not be read. Saving is paused; the saved chapter remains available."); }
    } catch (reason) {
      if (sequence === loadSequence.current) { setDocument(null); setDraft([]); setVersions([]); setRole("viewer"); setError(reason instanceof Error ? reason.message : "Could not load manuscript"); }
      if (reportFailure) throw reason;
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [api, bookId]);

  useEffect(() => {
    let cancelled = false;
    ++loadSequence.current;
    setBook(null); setChapters([]); setDocument(null); setDraft([]); setVersions([]); setRole("viewer");
    setDirty(false); setEditorValidation(null); setSaving(false); setLoading(true); setError(null); setNotice(null);
    setConflict(false); setPendingRestore(null); setRequestedChapterId(null);
    pendingSave.current = null; creatingChapter.current = false; restoring.current = false;
    saveFlight.current = null; setManualSave(null); setSaveMissing(false); setSaveAccount(null); setSaveRecoveryReady(false);
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
    const warn = (event: BeforeUnloadEvent) => { if (hasUnsavedChanges || titleBlocked || manualSave || pendingRestore || pendingCreation.current) { event.preventDefault(); event.returnValue = ""; } };
    const guardNavigation = (event: globalThis.MouseEvent) => {
      if ((!hasUnsavedChanges && !titleBlocked && !manualSave && !pendingRestore && !pendingCreation.current) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm(manualSave ? "Leave with an unconfirmed save? Only its recovery ID is stored in this tab, not your draft text. Download your draft first if needed." : pendingCreation.current ? "Leave the editor? Chapter creation is unconfirmed; keep this page to recover the original request." : "Leave the editor and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    window.document.addEventListener("click", guardNavigation, true);
    return () => { window.removeEventListener("beforeunload", warn); window.document.removeEventListener("click", guardNavigation, true); };
  }, [hasUnsavedChanges, titleBlocked, manualSave, pendingRestore]);

  const save = useCallback(async (retry = false) => {
    if (!document || titleBlocked || saveFlight.current !== null || saving || loading || aiDecisionBusy || conflict || !dirty || pendingRestore || editorValidation || !EDIT_ROLES.has(role)
      || !saveAccount || !saveRecoveryReady || (manualSave && (!retry || !saveMissing || !pendingSave.current))) return;
    const sequence = loadSequence.current;
    saveFlight.current = sequence;
    setSaving(true); setError(null); setNotice(null);
    const request = pendingSave.current ?? { operationId: crypto.randomUUID(), nodes: structuredClone(draft), expectedVersion: document.version };
    pendingSave.current = request;
    try {
      await editorAccount(saveAccount);
      const pointer = manualSave ?? { schema: 1, userId: saveAccount, bookId, chapterId: document.chapterId,
        operationId: request.operationId, expectedVersion: request.expectedVersion, digest: await chapterSaveDigest(request.nodes) } as ChapterSavePointer;
      if (sequence !== loadSequence.current) return;
      if (request.operationId !== pointer.operationId || await chapterSaveDigest(request.nodes) !== pointer.digest) throw new Error("The original draft is unavailable. Check saved status; do not resend different text.");
      if (sequence !== loadSequence.current) return;
      setManualSave(pointer); setSaveMissing(false);
      persistChapterSave(window.sessionStorage, pointer);
      const result = await api.saveChapterDocument(document.chapterId, request, pointer.userId);
      await validateSavedChapter(result.document, pointer);
      if (result.version !== result.document.version) throw new Error("The saved revision could not be confirmed. Check its original status.");
      await editorAccount(pointer.userId);
      if (sequence !== loadSequence.current) return;
      clearChapterSave(window.sessionStorage, pointer);
      setManualSave(null); setDocument(result.document); setDraft(result.document.nodes); setDirty(false); pendingSave.current = null;
      setNotice(`Saved version ${result.version}.`);
      try { const history = await api.listDocumentVersions(document.chapterId); if (sequence === loadSequence.current) setVersions(history.versions); }
      catch { if (sequence === loadSequence.current) setError("The chapter was saved, but version history could not refresh. Reload history when the connection returns."); }
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : "Save outcome is unconfirmed. Your draft remains in this editor; check the original save status.");
    } finally { if (saveFlight.current === sequence) saveFlight.current = null; if (sequence === loadSequence.current) setSaving(false); }
  }, [api, bookId, document, draft, saving, loading, aiDecisionBusy, role, conflict, dirty, pendingRestore, editorValidation, manualSave, saveAccount, saveRecoveryReady, saveMissing, titleBlocked]);

  const recoverSave = async (close = false) => {
    const pointer = manualSave;
    if (!pointer || saveFlight.current !== null || saving || loading || aiDecisionBusy) return;
    if (close && (!saveMissing || !EDIT_ROLES.has(role) || !window.confirm("Close this unconfirmed save without resending the draft? If it has not committed, an unchanged saved revision will prevent a late arrival. History is retained; back up any unsaved draft first."))) return;
    const sequence = loadSequence.current;
    saveFlight.current = sequence; setSaving(true); setError(null); setNotice(null);
    try {
      await editorAccount(pointer.userId);
      const raw = close ? await api.closeManualChapterSave(pointer.chapterId, pointer.operationId, pointer.expectedVersion, pointer.userId)
        : await api.getManualChapterSaveStatus(pointer.chapterId, pointer.operationId, pointer.expectedVersion, pointer.userId);
      const result = await validateChapterSaveResult(raw, pointer);
      await editorAccount(pointer.userId);
      if (sequence !== loadSequence.current) return;
      if (result.status === "not_found") {
        setSaveMissing(true);
        setNotice("No saved receipt is visible yet. This does not cancel an in-flight save. Check again, retry only the unchanged original draft, or explicitly close this request.");
        return;
      }
      const [current, history] = await Promise.all([api.getChapterDocument(pointer.chapterId), api.listDocumentVersions(pointer.chapterId)]);
      await editorAccount(pointer.userId);
      if (sequence !== loadSequence.current) return;
      validateCurrentChapter(current.document, pointer.chapterId, result.currentVersion);
      if (result.receipt && current.document.version === result.receipt.document.version
        && await chapterSaveDigest(current.document.nodes) !== await chapterSaveDigest(result.receipt.document.nodes))
        throw new Error("The current chapter could not be verified against its immutable receipt. Keep this recovery record and check again.");
      const exactSavedDraft = result.status === "saved" && current.document.version === pointer.expectedVersion + 1 && await chapterSaveDigest(draft) === pointer.digest;
      if (sequence !== loadSequence.current) return;
      clearChapterSave(window.sessionStorage, pointer);
      setManualSave(null); setSaveMissing(false); pendingSave.current = null; setVersions(history.versions);
      if (hasUnsavedChanges && !exactSavedDraft) {
        setConflict(true);
        setNotice(`${result.status === "saved" ? `Your original save is confirmed at version ${pointer.expectedVersion + 1}.` : "The original request is safely closed or superseded."} Your local draft is still here. Back it up before loading the current saved chapter.`);
      } else {
        setDocument(current.document); setDraft(current.document.nodes); setRole(current.role); setDirty(false); setEditorValidation(null); setConflict(false); setReloadKey(v => v + 1);
        setNotice(`${result.status === "saved" ? "Original save confirmed." : "Original request closed or superseded."} Loaded saved version ${current.document.version}.`);
      }
    } catch (reason) { if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "Could not recover this save. Its original request remains retained."); }
    finally { if (saveFlight.current === sequence) saveFlight.current = null; if (sequence === loadSequence.current) setSaving(false); }
  };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [save]);

  const selectChapter = (id: string) => {
    if (saving || loading || aiDecisionBusy || manualSave || titleState.pending || titleState.busy || id === document?.chapterId) return;
    if ((hasUnsavedChanges || pendingRestore) && !window.confirm("This chapter has unsaved changes or an unresolved restore. Leave it and open another chapter?")) return;
    setActiveAiJobId(undefined);
    void loadChapter(id);
  };

  const createChapter = async () => {
    if (!newTitle.trim() || titleBlocked || saving || loading || aiDecisionBusy || manualSave || (document && !saveRecoveryReady) || creatingChapter.current || pendingRestore || !EDIT_ROLES.has(role) || (hasUnsavedChanges && !window.confirm("Discard the unsaved chapter draft before adding a chapter?"))) return;
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
    if (titleBlocked || saving || loading || aiDecisionBusy || manualSave || (document && !saveRecoveryReady) || pendingRestore || !EDIT_ROLES.has(role)) return;
    const sequence = loadSequence.current;
    setSaving(true); setError(null);
    try { const result = await api.reorderChapters(bookId, { orderedIds, expectedIds: chapters.map((c) => c.id) }); if (sequence === loadSequence.current) setChapters(result.chapters); }
    catch (reason) { if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "Could not reorder chapters"); }
    finally { if (sequence === loadSequence.current) setSaving(false); }
  };

  const restore = async (versionId: string) => {
    if (!document || titleBlocked || saving || loading || aiDecisionBusy || manualSave || !saveRecoveryReady || restoring.current || !EDIT_ROLES.has(role)) return;
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

  const downloadDraft = (format: "json" | "txt" = "json") => {
    if (!document || loading) return;
    const content = format === "txt" ? editorValidation?.draftText ?? bookNodesPlainText(draft)
      : JSON.stringify(chapterDraftBackup({ bookId, chapterId: document.chapterId, baseVersion: document.version,
        nodes: draft, capturedAt: new Date().toISOString(), validation: editorValidation }), null, 2);
    const blob = new Blob([content], { type: format === "txt" ? "text/plain;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = window.document.createElement("a");
    link.href = url; link.download = `bookworm-chapter-${document.chapterId}-draft.${format}`;
    window.document.body.append(link); link.click(); link.remove();
    // Let the browser consume the object URL before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const editable = EDIT_ROLES.has(role) && !titleBlocked && !pendingRestore && !manualSave && (!document || saveRecoveryReady);
  const editorSequence = loadSequence.current;
  const wordCount = editorValidation ? (editorValidation.draftText.match(/\S+/gu)?.length ?? 0)
    : bookNodesWordCount(draft);
  return <main className="mx-auto min-h-[calc(100dvh-84px)] max-w-[1680px] bg-black p-4 text-white sm:p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div><Link href="/dashboard" className="text-xs text-white/50 hover:text-white">← Library</Link><h1 className="mt-2 text-2xl font-medium">{book?.title ?? "Manuscript"}</h1></div>
      <div className="flex flex-wrap items-center gap-3 text-sm"><Link href={`/books/${bookId}/plan`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Plan</Link><Link href={`/books/${bookId}/translate`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Translate</Link><Link href={`/books/${bookId}/publish`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Layout & publish</Link><span role="status" className="text-white/50">{editorValidation ? "Unsaved · correct numbering before saving" : saving ? "Saving…" : manualSave ? "Save outcome unconfirmed" : dirty ? "Unsaved changes" : document ? `Saved · v${document.version}` : ""}</span>
        {EDIT_ROLES.has(role) && document && <button type="button" onClick={() => void save()} disabled={!editable || !dirty || saving || aiDecisionBusy || conflict || loading || editorValidation !== null} className="rounded-full bg-white px-5 py-2 font-medium text-black disabled:opacity-40">Save chapter</button>}
        {editorValidation && <button type="button" onClick={() => downloadDraft("txt")} className="min-h-11 rounded-full border border-white/20 px-4 py-2">Download draft text</button>}
{document && !loading && <details className="relative basis-full lg:basis-auto"><summary className="inline-flex min-h-11 cursor-pointer rounded-full border border-white/20 px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Back up chapter draft</summary><div className="absolute left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-white/15 bg-[#101010] p-4 shadow-xl lg:left-auto lg:right-0"><p className="text-xs leading-5 text-white/60">JSON preserves structure, formatting and artwork references. Image files are not embedded. Text export does not keep formatting. Neither action saves to the server.</p><button type="button" onClick={() => downloadDraft()} className="mt-3 block min-h-11 w-full rounded-xl border border-white/20 px-4 text-left text-sm focus-visible:ring-2 focus-visible:ring-white">Download JSON backup</button><button type="button" onClick={() => downloadDraft("txt")} className="mt-2 block min-h-11 w-full rounded-xl border border-white/15 px-4 text-left text-sm focus-visible:ring-2 focus-visible:ring-white">Download draft text</button></div></details>}
      </div>
    </div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}
      {!document && !loading && <button type="button" className="mt-3 block min-h-11 rounded-lg border border-red-200/30 px-3 py-2 underline focus-visible:ring-2 focus-visible:ring-white" onClick={() => requestedChapterId ? void loadChapter(requestedChapterId) : setBookLoadAttempt(attempt => attempt + 1)}>{requestedChapterId ? "Retry loading chapter" : "Retry loading book"}</button>}
    </div>}
    {draftPlanMessage && <p role="status" className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-sm leading-6 text-amber-100">{draftPlanMessage}</p>}
    {notice && <p role="status" className="mb-4 text-sm text-emerald-200">{notice}</p>}
    {manualSave && <section aria-label="Manual save recovery" className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-4 text-sm leading-6 text-amber-100">
      <h2 className="font-medium">Confirm your last save</h2>
      <p>Editing is paused until this exact save is confirmed. This tab stores only its account, chapter, revision and content fingerprint—not manuscript text. A reload cannot recover draft text that never reached the server.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={saving || loading} onClick={() => void recoverSave()} className="min-h-11 rounded-lg border border-amber-200/30 px-3 disabled:opacity-40">Check saved status</button>
        {saveMissing && pendingSave.current && EDIT_ROLES.has(role) && <button type="button" disabled={saving || loading} onClick={() => void save(true)} className="min-h-11 rounded-lg border border-amber-200/30 px-3 disabled:opacity-40">Retry original save</button>}
        {saveMissing && EDIT_ROLES.has(role) && <button type="button" disabled={saving || loading} onClick={() => void recoverSave(true)} className="min-h-11 rounded-lg border border-amber-200/30 px-3 disabled:opacity-40">Close unconfirmed save</button>}
        <button type="button" disabled={loading} onClick={() => downloadDraft()} className="min-h-11 px-3 underline">Download current draft</button>
      </div>
      {saveMissing && <p className="mt-2 text-xs text-amber-100/75">Closing keeps history and records an unchanged revision to block a late write. It will not undo a save that already committed.</p>}
    </section>}
    {pendingRestore && !saving && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Restore outcome is not confirmed. Your current draft remains here; editing is paused until you recover the request or reload saved content.</p><div className="mt-3 flex flex-wrap gap-4"><button type="button" disabled={loading} className="underline" onClick={() => void restore(pendingRestore.versionId)}>Retry original restore</button><button type="button" className="underline" onClick={() => downloadDraft()}>Download my draft</button><button type="button" disabled={loading} className="underline" onClick={() => { if (window.confirm("Reload saved content and replace this draft? Download it first if needed.")) void loadChapter(pendingRestore.chapterId); }}>Reload saved content</button></div></div>}
    {conflict && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Another save changed this chapter. Your unsaved draft is still here. Download the JSON backup before reloading if you need to merge changes. It preserves artwork references, not image files.</p><button className="mr-4 mt-3 underline" onClick={() => downloadDraft()}>Download my draft</button><button className="underline" onClick={() => { if (document && window.confirm("Reload saved content and replace this unsaved draft?")) void loadChapter(document.chapterId); }}>Reload saved version</button></div>}
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_260px]">
      <aside className="self-start rounded-2xl border border-white/10 p-2">
        <button type="button" className="flex min-h-11 w-full items-center justify-between px-3 text-sm text-white/75 lg:hidden" aria-expanded={structureOpen} aria-controls="chapter-structure" onClick={() => setStructureOpen((open) => !open)}><span>Chapters · {chapters.length}</span><span>{structureOpen ? "Hide" : "Show"}</span></button>
        <div id="chapter-structure" className={structureOpen ? "block" : "hidden lg:block"}>
        <BookTree chapters={chapters} activeId={document?.chapterId ?? null} onSelect={selectChapter} onReorder={(ids) => void reorder(ids)} disabled={saving || loading || aiDecisionBusy || !!manualSave || titleState.pending || titleState.busy} readOnly={!editable} />
        {EDIT_ROLES.has(role) && !pendingRestore && <form className="mt-5 space-y-2 border-t border-white/10 p-2 pt-4" onSubmit={(event) => { event.preventDefault(); void createChapter(); }}>
          <fieldset disabled={titleBlocked || saving || loading || aiDecisionBusy || !!manualSave || (!!document && !saveRecoveryReady)} className="min-w-0 space-y-2 disabled:opacity-50">
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
        {document && saveAccount && <ChapterTitleEditor key={`${bookId}:${document.chapterId}:${saveAccount}`} bookId={bookId} chapterId={document.chapterId} userId={saveAccount}
          initialTitle={chapters.find(chapter => chapter.id === document.chapterId)?.title ?? "Chapter"} canEdit={EDIT_ROLES.has(role)}
          disabled={saving || loading || aiDecisionBusy || !!manualSave || !!pendingRestore || !saveRecoveryReady || conflict}
          onState={setTitleState} onTitle={title => setChapters(items => items.map(chapter => chapter.id === document.chapterId ? { ...chapter, title } : chapter))} />}
        {document && <p className="mb-3 px-1 text-right text-xs tabular-nums text-white/45">{wordCount.toLocaleString()} words</p>}
        {loading ? <p className="p-8 text-white/50" role="status">Loading manuscript…</p> : document && book ? <RichBookEditor key={`${document.chapterId}:${reloadKey}`} document={document} workspaceId={book.workspace_id} permissions={editable && !saving && !aiDecisionBusy ? "editor" : "viewer"} onValidationChange={setEditorValidation} onChange={(nodes) => { if (aiDecisionBusy || manualSave || saveFlight.current !== null) return; setDraft(nodes); setDirty(true); pendingSave.current = null; setNotice(null); }} /> : <div className="rounded-2xl border-dashed border border-white/15 p-10 text-white/60">{error ? "Resolve the connection error to open this manuscript." : "Add your first chapter to start writing."}</div>}
      </section>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto lg:col-span-2 xl:col-span-1">
        <AiAssistantPanel key={document?.chapterId ?? "empty"} bookId={bookId} chapterId={document?.chapterId ?? null} savedChapter={document} initialJobId={activeAiJobId} initialDraftInstruction={document?.chapterId === draftPlanTargetChapterId ? initialDraftInstruction : undefined} dirty={hasUnsavedChanges} editable={editable && !saving && !loading} onDecisionBusy={setAiDecisionBusy} onApplied={async () => { if (liveDraft.current) throw new Error("Back up the unsaved draft before refreshing the saved chapter."); if (document && editorSequence === loadSequence.current) await loadChapter(document.chapterId, true, true); }} />
        <div className="rounded-2xl border border-white/10 p-2"><VersionTimeline key={document ? `${bookId}:${document.chapterId}` : "empty"}
          versions={versions} chapterId={document?.chapterId} loadVersion={document ? (id) => api.getDocumentVersion(document.chapterId, id) : undefined}
          onRestore={(id) => void restore(id)} readOnly={!editable || saving || loading || aiDecisionBusy} /></div>
      </div>
    </div>
  </main>;
}
