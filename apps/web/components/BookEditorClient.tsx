"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { chapterDraftBackup, chapterDraftReopenWarning, inspectChapterDraftBackup, MAX_CHAPTER_DRAFT_BACKUP_BYTES } from "../lib/chapter-draft";
import { chapterSaveDigest, chapterSaveKey, clearChapterSave, editorAccount, parseChapterSave, persistChapterSave,
  validateChapterSaveResult, validateCurrentChapter, validateSavedChapter, type ChapterSavePointer } from "../lib/manual-chapter-save";

const EDIT_ROLES = new Set(["owner","admin","editor","writer","illustrator","designer"]);

const canonicalUuid = (value: string | undefined) => value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : value;

export default function BookEditorClient({ bookId: requestedBookId, initialChapterId: propChapterId, initialAiJobId, initialDraftPlanItemId }: { bookId: string; initialChapterId?: string; initialAiJobId?: string; initialDraftPlanItemId?: string }) {
  const bookId = canonicalUuid(requestedBookId)!;
  const initialChapterId = canonicalUuid(propChapterId);
  const api = apiClient();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [draft, setDraftState] = useState<BookNode[]>([]);
  const latestDraft = useRef(draft);
  const setDraft = (nodes: BookNode[]) => { latestDraft.current = nodes; setDraftState(nodes); };
  const [editorSeed, setEditorSeed] = useState<BookNode[] | null>(null);
  const [versions, setVersions] = useState<DocumentVersionSummary[]>([]);
  const [role, setRole] = useState("viewer");
  const [dirty, setDirty] = useState(false);
  const [editorValidation, setEditorValidationState] = useState<EditorValidationError | null>(null);
  const latestValidation = useRef(editorValidation);
  const setEditorValidation = (value: EditorValidationError | null) => { latestValidation.current = value; setEditorValidationState(value); };
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
  const pendingCreation = useRef<{ owner: string; bookId: string; title: string; brief: string; idempotencyKey: string } | null>(null);
  const [pendingOrder, setPendingOrder] = useState<{ owner: string; bookId: string; expectedIds: string[]; orderedIds: string[]; observed: string | null } | null>(null);
  const structureFlight = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [structureOpen, setStructureOpen] = useState(false);
  const loadSequence = useRef(0);
  const loadTransition = useRef<number | null>(null);
  const editorOwner = useRef<string | null>(null);
  const chapterSetups = useRef(new Map<string, { title: string; brief: string }>());
  const setups = Array.from(chapterSetups.current.entries());
  const hasAnyChapterSetup = setups.some(([, value]) => Boolean(value.title.trim() || value.brief.trim()));
  const hasChapterSetup = setups.some(([key, value]) =>
    JSON.parse(key)[0] === editorOwner.current && Boolean(value.title.trim() || value.brief.trim()));
  const updateChapterSetup = (title: string, brief: string, confirmedCreation = false) => {
    const owner = editorOwner.current;
    if (!owner || passiveLocked.current || (!confirmedCreation && !editorInteractionAvailable.current) || book?.id !== bookId) return;
    const key = JSON.stringify([owner, bookId]);
    if ((title.trim() || brief.trim()) && !chapterSetups.current.has(key) &&
        (chapterSetups.current.size >= 128 || Array.from(chapterSetups.current.keys()).filter(savedKey => JSON.parse(savedKey)[0] === owner).length >= 32)) {
      setError("Too many unsaved chapter setups are open. Return to a previous book and create or clear its chapter before starting another.");
      return;
    }
    if (title.trim() || brief.trim()) chapterSetups.current.set(key, { title, brief });
    else chapterSetups.current.delete(key);
    setNewTitle(title); setNewChapterBrief(brief);
  };
  const pendingSave = useRef<{ operationId: string; nodes: BookNode[]; expectedVersion: number } | null>(null);
  const saveFlight = useRef<number | null>(null);
  const [saveAccount, setSaveAccount] = useState<string | null>(null);
  const [saveRecoveryReady, setSaveRecoveryReady] = useState(false);
  const [manualSave, setManualSave] = useState<ChapterSavePointer | null>(null);
  const [saveMissing, setSaveMissing] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{ owner: string; chapterId: string; versionId: string; draftRevision: number; body: { operationId: string; expectedVersion: number } } | null>(null);
  const [restoreHidden, setRestoreHidden] = useState<string | null>(null);
  const [accountVerifying, setAccountVerifying] = useState(false);
  const [passiveCheck, setPassiveCheck] = useState<"checking" | "blocked" | null>(null);
  const passiveLocked = useRef(false);
  const passiveEpoch = useRef(0);
  const editorInteractionAvailable = useRef(false);
  const recheckPassive = useRef<() => void>(() => {});
  const restoring = useRef(false);
  const liveDraft = useRef(hasUnsavedChanges); liveDraft.current = hasUnsavedChanges;
  const draftRevision = useRef(0);
  const backupRead = useRef(0);

  useLayoutEffect(() => {
    let live = true;
    passiveLocked.current = false; setPassiveCheck(null);
    const check = () => {
      const owner = editorOwner.current;
      if (!owner) return;
      const epoch = ++passiveEpoch.current;
      passiveLocked.current = true; setPassiveCheck("checking");
      // Never reveal a previous account's editor when a background tab returns.
      if (window.document.visibilityState === "hidden") return;
      void editorAccount(owner).then(() => {
        if (live && passiveEpoch.current === epoch && editorOwner.current === owner && window.document.visibilityState !== "hidden") {
          passiveLocked.current = false; setPassiveCheck(null);
        }
      }, () => {
        if (live && passiveEpoch.current === epoch && editorOwner.current === owner) setPassiveCheck("blocked");
      });
    };
    recheckPassive.current = check;
    window.addEventListener("focus", check);
    window.document.addEventListener("visibilitychange", check);
    return () => {
      live = false; ++passiveEpoch.current; passiveLocked.current = true;
      recheckPassive.current = () => {};
      window.removeEventListener("focus", check);
      window.document.removeEventListener("visibilitychange", check);
    };
  }, [bookId]);

  const loadChapter = useCallback(async (chapterId: string, reportFailure = false, preserveCurrentReview = false, expectedActor?: string) => {
    const sequence = ++loadSequence.current;
    loadTransition.current = sequence;
    const owner = expectedActor ?? editorOwner.current;
    const accountEpoch = passiveEpoch.current;
    setAccountVerifying(true);
    setRequestedChapterId(chapterId);
    try {
      if (!owner) throw new Error("Verify the original account before loading this manuscript.");
      const userId = await editorAccount(owner);
      if (sequence !== loadSequence.current) return;
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) throw new Error("Verify the original account before loading this manuscript.");
      setLoading(true);
      // Keep a confirmed same-chapter AI review mounted during its refresh, never across targets or a failed revalidation.
      if (!preserveCurrentReview) { setDocument(null); setDraft([]); setVersions([]); setRole("viewer"); }
      setEditorSeed(null); setDirty(false); setEditorValidation(null); setConflict(false); setError(null); setNotice(null);
      pendingSave.current = null;
      setSaveRecoveryReady(false); setManualSave(null); setSaveMissing(false); setSaveAccount(null);
      const [content, history] = await Promise.all([api.getChapterDocument(chapterId, userId), api.listDocumentVersions(chapterId, userId)]);
      await editorAccount(userId);
      if (sequence !== loadSequence.current) return;
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) throw new Error("Account verification interrupted manuscript loading. Try again.");
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
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) {
        if (sequence === loadSequence.current) setError("Account verification interrupted manuscript loading. Retry after verifying the original account.");
        if (reportFailure) throw reason;
        return;
      }
      let actorUnavailable = false;
      if (owner) { try { await editorAccount(owner); } catch { actorUnavailable = true; } }
      if (sequence === loadSequence.current) {
        if (actorUnavailable && owner) setRestoreHidden(owner);
        else { setDocument(null); setDraft([]); setVersions([]); setRole("viewer"); }
        setError(reason instanceof Error ? reason.message : "Could not load manuscript");
      }
      if (reportFailure) throw reason;
    } finally {
      if (loadTransition.current === sequence) loadTransition.current = null;
      if (sequence === loadSequence.current) { setAccountVerifying(false); setLoading(false); }
    }
  }, [api, bookId]);

  useEffect(() => {
    let cancelled = false;
    ++loadSequence.current;
    loadTransition.current = null;
    editorOwner.current = null;
    setNewTitle(""); setNewChapterBrief("");
    setAccountVerifying(false); setRestoreHidden(null);
    setBook(null); setChapters([]); setDocument(null); setDraft([]); setEditorSeed(null); setVersions([]); setRole("viewer");
    setDirty(false); setEditorValidation(null); setSaving(false); setLoading(true); setError(null); setNotice(null);
    setConflict(false); setPendingRestore(null); setRequestedChapterId(null);
    pendingSave.current = null; creatingChapter.current = false; restoring.current = false;
    structureFlight.current = false; setPendingOrder(null);
    saveFlight.current = null; setManualSave(null); setSaveMissing(false); setSaveAccount(null); setSaveRecoveryReady(false);
    if (pendingCreation.current?.bookId !== bookId) pendingCreation.current = null;
    setInitialDraftInstruction(undefined); setDraftPlanTargetChapterId(null); setDraftPlanMessage(null); setActiveAiJobId(initialAiJobId);
    void (async () => {
      const userId = await editorAccount();
      if (cancelled) return;
      const [identity, result] = await Promise.all([api.getBook(bookId, userId), api.listChapters(bookId, userId)]);
      await editorAccount(userId);
      if (cancelled) return;
      if (!identity?.book || identity.book.id !== bookId || typeof identity.book.workspace_id !== "string" || !identity.book.workspace_id
        || typeof identity.role !== "string" || !Array.isArray(result?.chapters)
        || result.chapters.some(chapter => !chapter || chapter.book_id !== bookId || typeof chapter.id !== "string" || !chapter.id || typeof chapter.title !== "string")
        || new Set(result.chapters.map(chapter => chapter.id)).size !== result.chapters.length) {
        throw new Error("The book or chapter list could not be verified. Try loading this book again.");
      }
      const selected = initialChapterId ? result.chapters.find((chapter) => chapter.id === initialChapterId) : result.chapters[0];
      let instruction: string | undefined, planTarget: string | null = null, planMessage: string | null = null;
      if (selected && initialDraftPlanItemId) {
        try {
          const { blueprint } = await api.getStoryBlueprint(bookId, userId);
          await editorAccount(userId);
          if (cancelled) return;
          const brief = storyBlueprintWriterBrief(blueprint, initialDraftPlanItemId, selected.id);
          if (brief.ok) { instruction = brief.instruction; planTarget = selected.id; }
          else planMessage = brief.reason;
        } catch {
          await editorAccount(userId);
          planMessage = "Could not load the saved story plan. No AI request was sent; reload the blueprint and try again.";
        }
      }
      await editorAccount(userId);
      if (cancelled) return;
      editorOwner.current = userId;
      const setup = chapterSetups.current.get(JSON.stringify([userId, bookId]));
      setNewTitle(setup?.title ?? ""); setNewChapterBrief(setup?.brief ?? "");
      setBook(identity.book); setRole(identity.role); setChapters(result.chapters);
      setInitialDraftInstruction(instruction); setDraftPlanTargetChapterId(planTarget); setDraftPlanMessage(planMessage);
      if (initialChapterId && !selected) { setError("The requested chapter is not available in this book. Choose an available chapter to continue."); setLoading(false); return; }
      if (selected) void loadChapter(selected.id, false, false, userId); else setLoading(false);
    })().catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "Could not load book"); setLoading(false); } });
    return () => { cancelled = true; loadSequence.current++; };
  }, [api, bookId, initialChapterId, initialAiJobId, initialDraftPlanItemId, bookLoadAttempt, loadChapter]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (hasUnsavedChanges || hasAnyChapterSetup || titleBlocked || manualSave || pendingRestore || pendingOrder || pendingCreation.current) { event.preventDefault(); event.returnValue = ""; } };
    const guardNavigation = (event: globalThis.MouseEvent) => {
      if ((!hasUnsavedChanges && !hasAnyChapterSetup && !titleBlocked && !manualSave && !pendingRestore && !pendingOrder && !pendingCreation.current) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm(manualSave ? "Leave with an unconfirmed save? Only its recovery ID is stored in this tab, not your draft text. Download your draft first if needed." : pendingCreation.current ? "Leave the editor? Chapter creation is unconfirmed; keep this page to recover the original request." : pendingOrder ? "Leave with an unconfirmed chapter reorder? Leaving does not cancel it, and this page cannot recover the request after it closes." : hasChapterSetup && !hasUnsavedChanges && !titleBlocked && !pendingRestore ? "Leave the editor and discard the new chapter title and brief?" : "Leave the editor and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    window.document.addEventListener("click", guardNavigation, true);
    return () => { window.removeEventListener("beforeunload", warn); window.document.removeEventListener("click", guardNavigation, true); };
  }, [hasUnsavedChanges, hasAnyChapterSetup, hasChapterSetup, titleBlocked, manualSave, pendingRestore, pendingOrder]);

  const save = useCallback(async (retry = false) => {
    if (!document || passiveLocked.current || !editorInteractionAvailable.current || loadTransition.current !== null || titleBlocked || saveFlight.current !== null || saving || loading || aiDecisionBusy || conflict || !liveDraft.current || pendingRestore || (latestValidation.current && !retry) || !EDIT_ROLES.has(role)
      || !saveAccount || !saveRecoveryReady || (manualSave && (!retry || !saveMissing || !pendingSave.current))) return;
    const sequence = loadSequence.current, accountEpoch = passiveEpoch.current;
    saveFlight.current = sequence;
    setSaving(true); setError(null); setNotice(null);
    const request = pendingSave.current ?? { operationId: crypto.randomUUID(), nodes: structuredClone(latestDraft.current), expectedVersion: document.version };
    pendingSave.current = request;
    try {
      await editorAccount(saveAccount);
      const pointer = manualSave ?? { schema: 1, userId: saveAccount, bookId, chapterId: document.chapterId,
        operationId: request.operationId, expectedVersion: request.expectedVersion, digest: await chapterSaveDigest(request.nodes) } as ChapterSavePointer;
      if (sequence !== loadSequence.current) return;
      if (request.operationId !== pointer.operationId || await chapterSaveDigest(request.nodes) !== pointer.digest) throw new Error("The original draft is unavailable. Check saved status; do not resend different text.");
      if (sequence !== loadSequence.current) return;
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) throw new Error("Account verification interrupted the save before it was sent. Your draft remains here.");
      setManualSave(pointer); setSaveMissing(false);
      persistChapterSave(window.sessionStorage, pointer);
      const result = await api.saveChapterDocument(document.chapterId, request, pointer.userId);
      await validateSavedChapter(result.document, pointer);
      if (result.version !== result.document.version) throw new Error("The saved revision could not be confirmed. Check its original status.");
      await editorAccount(pointer.userId);
      if (sequence !== loadSequence.current) return;
      const revision = draftRevision.current, currentDraft = structuredClone(latestDraft.current);
      const matchesReceipt = await chapterSaveDigest(currentDraft) === pointer.digest;
      if (sequence !== loadSequence.current) return;
      const hasLaterChanges = revision !== draftRevision.current || latestValidation.current !== null || !matchesReceipt;
      clearChapterSave(window.sessionStorage, pointer);
      setManualSave(null); setDocument(result.document); pendingSave.current = null;
      if (hasLaterChanges) { setDirty(true); setNotice(`Saved version ${result.version}; newer edits remain unsaved.`); }
      else { setDraft(result.document.nodes); setEditorSeed(null); setDirty(false); setNotice(`Saved version ${result.version}.`); }
      try { const history = await api.listDocumentVersions(document.chapterId, pointer.userId); await editorAccount(pointer.userId); if (sequence === loadSequence.current) setVersions(history.versions); }
      catch {
        try { await editorAccount(pointer.userId); } catch { if (sequence === loadSequence.current) setRestoreHidden(pointer.userId); }
        if (sequence === loadSequence.current) setError("The chapter was saved, but version history could not refresh. Reload history when the connection returns.");
      }
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      try { await editorAccount(saveAccount); } catch { if (sequence === loadSequence.current) setRestoreHidden(saveAccount); }
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : "Save outcome is unconfirmed. Your draft remains in this editor; check the original save status.");
    } finally { if (saveFlight.current === sequence) saveFlight.current = null; if (sequence === loadSequence.current) setSaving(false); }
  }, [api, bookId, document, draft, saving, loading, aiDecisionBusy, role, conflict, dirty, pendingRestore, editorValidation, manualSave, saveAccount, saveRecoveryReady, saveMissing, titleBlocked]);

  const recoverSave = async (close = false) => {
    const pointer = manualSave;
    if (!pointer || passiveLocked.current || !editorInteractionAvailable.current || loadTransition.current !== null || saveFlight.current !== null || saving || loading || aiDecisionBusy) return;
    if (close && (!saveMissing || !EDIT_ROLES.has(role) || !window.confirm("Close this unconfirmed save without resending the draft? If it has not committed, an unchanged saved revision will prevent a late arrival. History is retained; back up any unsaved draft first."))) return;
    const sequence = loadSequence.current, accountEpoch = passiveEpoch.current;
    saveFlight.current = sequence; setSaving(true); setError(null); setNotice(null);
    try {
      await editorAccount(pointer.userId);
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) throw new Error("Account verification interrupted recovery before it was sent.");
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
      const [current, history] = await Promise.all([api.getChapterDocument(pointer.chapterId, pointer.userId), api.listDocumentVersions(pointer.chapterId, pointer.userId)]);
      await editorAccount(pointer.userId);
      if (sequence !== loadSequence.current) return;
      validateCurrentChapter(current.document, pointer.chapterId, result.currentVersion);
      if (result.receipt && current.document.version === result.receipt.document.version
        && await chapterSaveDigest(current.document.nodes) !== await chapterSaveDigest(result.receipt.document.nodes))
        throw new Error("The current chapter could not be verified against its immutable receipt. Keep this recovery record and check again.");
      const revision = draftRevision.current, currentDraft = structuredClone(latestDraft.current);
      const exactSavedDraft = result.status === "saved" && current.document.version === pointer.expectedVersion + 1
        && await chapterSaveDigest(currentDraft) === pointer.digest;
      if (sequence !== loadSequence.current) return;
      const retainLocalDraft = revision !== draftRevision.current || latestValidation.current !== null || (liveDraft.current && !exactSavedDraft);
      clearChapterSave(window.sessionStorage, pointer);
      setManualSave(null); setSaveMissing(false); pendingSave.current = null; setVersions(history.versions);
      if (retainLocalDraft) {
        setDirty(true); setConflict(true);
        setNotice(`${result.status === "saved" ? `Your original save is confirmed at version ${pointer.expectedVersion + 1}.` : "The original request is safely closed or superseded."} Your local draft is still here. Back it up before loading the current saved chapter.`);
      } else {
        setDocument(current.document); setDraft(current.document.nodes); setEditorSeed(null); setRole(current.role); setDirty(false); setEditorValidation(null); setConflict(false); setReloadKey(v => v + 1);
        setNotice(`${result.status === "saved" ? "Original save confirmed." : "Original request closed or superseded."} Loaded saved version ${current.document.version}.`);
      }
    } catch (reason) {
      try { await editorAccount(pointer.userId); } catch { if (sequence === loadSequence.current) setRestoreHidden(pointer.userId); }
      if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : "Could not recover this save. Its original request remains retained.");
    }
    finally { if (saveFlight.current === sequence) saveFlight.current = null; if (sequence === loadSequence.current) setSaving(false); }
  };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [save]);

  const selectChapter = (id: string) => {
    if (passiveLocked.current || !editorInteractionAvailable.current || loadTransition.current !== null || saving || loading || aiDecisionBusy || manualSave || titleState.pending || titleState.busy || id === document?.chapterId) return;
    if ((hasUnsavedChanges || pendingRestore) && !window.confirm("This chapter has unsaved changes or an unresolved restore. Leave it and open another chapter?")) return;
    setActiveAiJobId(undefined);
    void loadChapter(id);
  };

  const createChapter = async () => {
    const owner = editorOwner.current;
    if (!owner || passiveLocked.current || !editorInteractionAvailable.current || book?.id !== bookId || !newTitle.trim() || pendingOrder || structureFlight.current || loadTransition.current !== null || titleBlocked || saving || loading || aiDecisionBusy || manualSave || (document && !saveRecoveryReady) || creatingChapter.current || pendingRestore || !EDIT_ROLES.has(role) || (hasUnsavedChanges && !window.confirm("Discard the unsaved chapter draft before adding a chapter?"))) return;
    creatingChapter.current = true;
    let sequence = loadSequence.current; const accountEpoch = passiveEpoch.current;
    setSaving(true); setError(null);
    const existingCreation = pendingCreation.current;
    const creation = existingCreation ?? { owner, bookId, title: newTitle.trim(), brief: newChapterBrief.trim(), idempotencyKey: crypto.randomUUID() };
    pendingCreation.current = creation;
    const chapterTitle = creation.title;
    let createdChapterId: string | null = null;
    const brief = creation.brief;
    try {
      if (creation.owner !== owner || creation.bookId !== bookId) throw new Error("The original account or book changed.");
      await editorAccount(creation.owner);
      if (sequence !== loadSequence.current) return;
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) {
        if (!existingCreation && pendingCreation.current === creation) pendingCreation.current = null;
        setError("Account verification interrupted chapter creation before it was sent."); return;
      }
      const result = await api.createChapter(bookId, { title: chapterTitle, idempotencyKey: creation.idempotencyKey }, creation.owner);
      await editorAccount(creation.owner);
      if (sequence !== loadSequence.current) return;
      if (!result.chapter || result.chapter.book_id !== bookId || typeof result.chapter.id !== "string" || !result.chapter.id)
        throw new Error("The original chapter result could not be verified.");
      const current = await api.listChapters(bookId, creation.owner);
      await editorAccount(creation.owner);
      if (sequence !== loadSequence.current) return;
      if (!Array.isArray(current.chapters) || !current.chapters.some(chapter => chapter.id === result.chapter.id && chapter.book_id === bookId)
        || current.chapters.some(chapter => chapter.book_id !== bookId || typeof chapter.id !== "string" || !chapter.id)
        || new Set(current.chapters.map(chapter => chapter.id)).size !== current.chapters.length)
        throw new Error("The saved chapter list could not be verified. Retry the original request.");
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) {
        setError("Account verification interrupted confirmation. The chapter may have been created; retry the original request to recover it."); return;
      }
      pendingCreation.current = null;
      createdChapterId = result.chapter.id;
      setChapters(current.chapters);
      updateChapterSetup("", newChapterBrief, true); setActiveAiJobId(undefined);
      sequence = loadSequence.current + 1;
      await loadChapter(result.chapter.id, true);
      if (sequence !== loadSequence.current) return;
      if (!brief) { updateChapterSetup("", "", true); setNotice(`Created ${chapterTitle}.`); return; }
      setInitialDraftInstruction(brief);
      setDraftPlanTargetChapterId(result.chapter.id);
      updateChapterSetup("", "", true);
      setNotice("Chapter created. Review the draft brief and request a price in the AI assistant. Nothing was generated or charged.");
    }
    catch (reason) {
      if (sequence !== loadSequence.current) return;
      try { await editorAccount(creation.owner); } catch { if (sequence === loadSequence.current) setRestoreHidden(creation.owner); }
      if (sequence !== loadSequence.current) return;
      const message = reason instanceof Error ? reason.message : "Could not create chapter";
      setError(createdChapterId ? `Your chapter is saved, but it could not be loaded: ${message} Open the chapter to continue. No AI request was sent; your brief remains in the form.` : `${message} Submit again to recover the original chapter request for “${chapterTitle}”.`);
    }
    finally { if (sequence === loadSequence.current) { creatingChapter.current = false; setSaving(false); } }
  };

  const reorder = async (orderedIds: string[]) => {
    const owner = editorOwner.current;
    if (!owner || passiveLocked.current || !editorInteractionAvailable.current || pendingOrder || pendingCreation.current || structureFlight.current || loadTransition.current !== null || titleBlocked || saving || loading || aiDecisionBusy || manualSave || (document && !saveRecoveryReady) || pendingRestore || !EDIT_ROLES.has(role)) return;
    const sequence = loadSequence.current, accountEpoch = passiveEpoch.current;
    const expectedIds = chapters.map(c => c.id);
    if (orderedIds.length !== expectedIds.length || new Set(orderedIds).size !== expectedIds.length || orderedIds.some(id => !expectedIds.includes(id))) return;
    structureFlight.current = true;
    setSaving(true); setError(null);
    let dispatched = false;
    try {
      await editorAccount(owner);
      if (sequence !== loadSequence.current) return;
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) throw new Error("Account check interrupted reorder before it was sent.");
      setPendingOrder({ owner, bookId, expectedIds, orderedIds: [...orderedIds], observed: null });
      dispatched = true;
      const result = await api.reorderChapters(bookId, { orderedIds, expectedIds }, owner);
      await editorAccount(owner);
      if (sequence !== loadSequence.current) return;
      if (!Array.isArray(result.chapters) || result.chapters.length !== orderedIds.length
        || result.chapters.some((chapter, index) => chapter.id !== orderedIds[index] || chapter.book_id !== bookId))
        throw new Error("The reorder response could not be verified.");
      const current = await api.listChapters(bookId, owner);
      await editorAccount(owner);
      if (sequence !== loadSequence.current) return;
      if (!Array.isArray(current.chapters) || current.chapters.length > 500
        || current.chapters.some(chapter => chapter.book_id !== bookId || typeof chapter.id !== "string" || !chapter.id)
        || new Set(current.chapters.map(chapter => chapter.id)).size !== current.chapters.length) throw new Error("The current chapter order could not be verified.");
      setChapters(current.chapters); setPendingOrder(null);
      setNotice("Chapter order was saved. The list shows the latest verified order.");
    } catch {
      try { await editorAccount(owner); } catch { if (sequence === loadSequence.current) setRestoreHidden(owner); }
      if (sequence === loadSequence.current) setError(dispatched
        ? "The reorder outcome is unconfirmed. Check the saved order; no retry or cancellation is implied."
        : "Could not verify your account. No chapter reorder was sent. Try again.");
    } finally { if (sequence === loadSequence.current) { structureFlight.current = false; setSaving(false); } }
  };

  const checkPendingOrder = async () => {
    const pending = pendingOrder;
    if (!pending || passiveLocked.current || !editorInteractionAvailable.current || structureFlight.current || loadTransition.current !== null || saving || loading) return;
    const sequence = loadSequence.current; structureFlight.current = true; setSaving(true); setError(null);
    try {
      await editorAccount(pending.owner);
      const current = await api.listChapters(pending.bookId, pending.owner);
      await editorAccount(pending.owner);
      if (sequence !== loadSequence.current) return;
      if (!Array.isArray(current.chapters) || current.chapters.length > 500
        || current.chapters.some(chapter => chapter.book_id !== pending.bookId || typeof chapter.id !== "string" || !chapter.id)
        || new Set(current.chapters.map(chapter => chapter.id)).size !== current.chapters.length) throw new Error();
      const ids = current.chapters.map(chapter => chapter.id);
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
      const observed = same(ids, pending.orderedIds) ? "The current order matches the requested order."
        : same(ids, pending.expectedIds) ? "The current order matches the previous order."
        : "The current order differs from both the previous and requested orders.";
      setChapters(current.chapters); setPendingOrder({ ...pending, observed });
    } catch {
      try { await editorAccount(pending.owner); } catch { if (sequence === loadSequence.current) setRestoreHidden(pending.owner); }
      if (sequence === loadSequence.current) setError("The saved chapter order could not be verified. Keep this page open.");
    } finally { if (sequence === loadSequence.current) { structureFlight.current = false; setSaving(false); } }
  };

  const restore = async (versionId: string) => {
    if (!document || !saveAccount || passiveLocked.current || !editorInteractionAvailable.current || loadTransition.current !== null || restoreHidden || titleBlocked || saving || loading || aiDecisionBusy || manualSave || !saveRecoveryReady || restoring.current || !EDIT_ROLES.has(role)) return;
    if (pendingRestore && (pendingRestore.versionId !== versionId || pendingRestore.chapterId !== document.chapterId)) return;
    if (!pendingRestore && !window.confirm("Restore this version as a new saved version? Current saved history will remain available.")) return;
    if (!pendingRestore && hasUnsavedChanges && !window.confirm("Your unsaved draft will be replaced. Continue?")) return;
    const request = pendingRestore ?? { owner: saveAccount, chapterId: document.chapterId, versionId, draftRevision: draftRevision.current, body: { expectedVersion: document.version, operationId: crypto.randomUUID() } };
    if (request.owner !== saveAccount) return;
    const sequence = loadSequence.current, accountEpoch = passiveEpoch.current;
    restoring.current = true;
    setPendingRestore(request); setSaving(true); setError(null); setNotice(null);
    try {
      await editorAccount(request.owner);
      if (sequence !== loadSequence.current) return;
      if (passiveLocked.current || accountEpoch !== passiveEpoch.current) {
        if (!pendingRestore) setPendingRestore(null);
        setError("Account verification interrupted restore before it was sent."); return;
      }
      const result = await api.restoreDocumentVersion(request.chapterId, request.versionId, request.body, request.owner);
      await editorAccount(request.owner);
      if (sequence !== loadSequence.current) return;
      validateCurrentChapter(result.document, request.chapterId, request.body.expectedVersion + 1);
      if (result.version !== request.body.expectedVersion + 1 || result.document.version !== result.version
        || typeof result.versionId !== "string" || !result.versionId.trim()) throw new Error("The restored revision could not be verified. Keep the original request for recovery.");
      const current = await api.getChapterDocument(request.chapterId, request.owner);
      await editorAccount(request.owner);
      if (sequence !== loadSequence.current) return;
      validateCurrentChapter(current.document, request.chapterId, result.version);
      if (current.document.version > result.version) {
        setConflict(true);
        setNotice(`The restore returned version ${result.version}, but the current chapter is already at version ${current.document.version}. Your local draft remains here; review saved history before choosing what to do.`);
        return;
      }
      if (await chapterSaveDigest(current.document.nodes) !== await chapterSaveDigest(result.document.nodes)) {
        throw new Error("Current chapter content does not match the restore receipt. Keep the original request for recovery.");
      }
      await editorAccount(request.owner);
      if (sequence !== loadSequence.current) return;
      // Adopt the confirmed receipt before refreshing history. A failed history
      // request must not leave the old draft marked as the restored manuscript.
      setRole(current.role); setPendingRestore(null); pendingSave.current = null;
      if (draftRevision.current !== request.draftRevision) {
        setDirty(true); setConflict(true); setNotice(`Restored as version ${result.version}. Your later edits still use the previous draft; back them up and review before replacing them with the restored version.`);
      } else {
        setDocument(current.document); setConflict(false); setDraft(current.document.nodes); setEditorSeed(null); setDirty(false); setEditorValidation(null); setReloadKey((v) => v + 1);
        setNotice(`Restored as version ${result.version}.`);
      }
      try { const history = await api.listDocumentVersions(request.chapterId, request.owner); await editorAccount(request.owner); if (sequence === loadSequence.current) setVersions(history.versions); }
      catch {
        try { await editorAccount(request.owner); }
        catch { if (sequence === loadSequence.current) setRestoreHidden(request.owner); }
        if (sequence === loadSequence.current) setError("Restore succeeded, but version history could not refresh. Reload the chapter to refresh history.");
      }
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      try { await editorAccount(request.owner); }
      catch { if (sequence === loadSequence.current) setRestoreHidden(request.owner); }
      if (sequence !== loadSequence.current) return;
      // A conflict response can follow an earlier lost reply. Retain the exact
      // operation rather than replacing an outcome that may already be saved.
      if (reason instanceof ApiClientError && reason.status === 409) setConflict(true);
      setError(reason instanceof Error ? reason.message : "Could not confirm restore. Retry the original request or reload saved content.");
    }
    finally { if (sequence === loadSequence.current) { restoring.current = false; setSaving(false); } }
  };

  const downloadDraft = (format: "json" | "txt" = "json") => {
    if (!document || passiveLocked.current || !editorInteractionAvailable.current || loading) return;
    const backupActor = saveAccount ?? editorOwner.current ?? "";
    const currentDraft = latestDraft.current, currentValidation = latestValidation.current;
    const content = format === "txt" ? currentValidation?.draftText ?? bookNodesPlainText(currentDraft)
      : JSON.stringify(chapterDraftBackup({ userId: backupActor, bookId, chapterId: document.chapterId, baseVersion: document.version,
        nodes: currentDraft, capturedAt: new Date().toISOString(), validation: currentValidation }), null, 2);
    const blob = new Blob([content], { type: format === "txt" ? "text/plain;charset=utf-8" : "application/json;charset=utf-8" });
    const warning = format === "json" ? chapterDraftReopenWarning(content, blob.size, Boolean(currentValidation), { userId: backupActor, bookId, chapterId: document.chapterId, baseVersion: document.version }) : null;
    if (warning) setNotice(warning);
    const url = URL.createObjectURL(blob); const link = window.document.createElement("a");
    link.href = url; link.download = `bookworm-chapter-${document.chapterId}-draft.${format}`;
    window.document.body.append(link); link.click(); link.remove();
    // Let the browser consume the object URL before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const loadVersionForComparison = async (chapterId: string, versionId: string) => {
    const owner = editorOwner.current, sequence = loadSequence.current;
    if (!owner || passiveLocked.current || !editorInteractionAvailable.current) throw new Error("The original account could not be verified.");
    try {
      await editorAccount(owner);
      if (sequence !== loadSequence.current) throw new Error();
      const snapshot = await api.getDocumentVersion(chapterId, versionId, owner);
      await editorAccount(owner);
      if (sequence !== loadSequence.current) throw new Error();
      return snapshot;
    } catch {
      try { await editorAccount(owner); } catch { if (sequence === loadSequence.current) setRestoreHidden(owner); }
      throw new Error("The saved revision could not be verified.");
    }
  };
  const editable = EDIT_ROLES.has(role) && !passiveCheck && !accountVerifying && !restoreHidden && !titleBlocked && !pendingRestore && !manualSave && (!document || saveRecoveryReady);
  editorInteractionAvailable.current = !passiveLocked.current && !passiveCheck && !accountVerifying && !restoreHidden
    && Boolean(editorOwner.current) && book?.id === bookId;
  const childActionsAvailable = useRef(false);
  childActionsAvailable.current = editorInteractionAvailable.current && editorOwner.current === saveAccount && Boolean(saveAccount);
  const backupScope = useRef({ document, saveAccount, allowed: false });
  backupScope.current = { document, saveAccount, allowed: Boolean(editable && !passiveLocked.current && !saving && !loading && !aiDecisionBusy && !conflict && !accountVerifying && !restoreHidden) };
  const openDraftBackup = async (file: File | undefined) => {
    if (!file || !document || !saveAccount || !backupScope.current.allowed || saveFlight.current !== null) return;
    const readId = ++backupRead.current, sequence = loadSequence.current, original = document, actor = saveAccount;
    const current = () => backupRead.current === readId && loadSequence.current === sequence && backupScope.current.document === original && backupScope.current.saveAccount === actor && backupScope.current.allowed && saveFlight.current === null;
    try {
      if (!file.name.toLowerCase().endsWith(".json") || !["", "application/json", "text/plain", "application/octet-stream"].includes(file.type) || file.size <= 0 || file.size > MAX_CHAPTER_DRAFT_BACKUP_BYTES) throw new Error("Choose a JSON backup no larger than 5 MB.");
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const { nodes, legacy } = inspectChapterDraftBackup(raw, { userId: actor, bookId, chapterId: original.chapterId, baseVersion: original.version });
      const verifyActor = async () => { try { await editorAccount(actor); } catch { if (current()) setRestoreHidden(actor); throw new Error("The original account could not be verified."); } };
      const verifyLatest = async () => {
        await verifyActor(); if (!current()) return false;
        const latest = await api.getChapterDocument(original.chapterId, actor);
        await verifyActor(); if (!current()) return false;
        validateCurrentChapter(latest.document, original.chapterId);
        if (!EDIT_ROLES.has(latest.role)) throw new Error("Editing access could not be confirmed. Your current draft is unchanged.");
        if (latest.document.version !== original.version) throw new Error("The saved chapter has changed since this backup. Review the backup separately before merging.");
        return true;
      };
      if (!await verifyLatest()) return;
      const confirmedRevision = draftRevision.current;
      if (legacy && !window.confirm("This older backup does not identify its original account, so its origin cannot be verified. Only open a file you trust. Continue?")) return;
      if (!window.confirm("Replace the current editor draft with this local backup? The backup will remain unsaved until you review and save it.")) return;
      if (!await verifyLatest() || !current()) return;
      if (draftRevision.current !== confirmedRevision) throw new Error("Your draft changed while the backup was being checked. Choose the file again to review the replacement.");
      draftRevision.current++; liveDraft.current = true; setEditorSeed(nodes); setDraft(nodes); setDirty(true); setEditorValidation(null); setError(null);
      pendingSave.current = null; setReloadKey(value => value + 1);
      setNotice("Local backup opened as an unsaved draft. Review it and save when ready. Artwork files are not included in the backup.");
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "The local backup could not be opened."); }
  };
  const editorSequence = loadSequence.current;
  const bookIdentityChanging = book !== null && book.id !== bookId;
  const wordCount = editorValidation ? (editorValidation.draftText.match(/\S+/gu)?.length ?? 0)
    : bookNodesWordCount(draft);
  return <>{bookIdentityChanging && !passiveCheck && <main className="mx-auto max-w-3xl p-8 text-white"><p role="status">Checking the selected book…</p></main>}
  {passiveCheck && <main className="mx-auto max-w-3xl p-8 text-white">
    {passiveCheck === "checking" ? <p role="status">Checking the original account…</p> : <><p role="alert">The original account could not be verified. This manuscript and its unsaved work are hidden; sign back in to the original account to continue.</p>
      <button type="button" onClick={() => recheckPassive.current()}>Recheck original account</button></>}
  </main>}
  {accountVerifying && !restoreHidden && !passiveCheck && <main className="mx-auto max-w-3xl p-8 text-white"><p role="status">Checking the original account…</p></main>}
  {restoreHidden && !passiveCheck && <main className="mx-auto max-w-3xl p-8 text-white">
    <p role="alert">The original account could not be verified. This manuscript is hidden; sign back in to the original account to continue.</p>
    <button type="button" onClick={() => void editorAccount(restoreHidden).then(() => setRestoreHidden(null)).catch(() => setError("Sign back in to the original account and recheck."))}>Recheck original account</button>
    {error && <p role="status">{error}</p>}
  </main>}
  <main hidden={!!restoreHidden || accountVerifying || !!passiveCheck || bookIdentityChanging} className="mx-auto min-h-[calc(100dvh-84px)] max-w-[1680px] bg-black p-4 text-white sm:p-6">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div>{book ? <Link href={`/dashboard?ws=${encodeURIComponent(book.workspace_id)}`} className="text-xs text-white/50 hover:text-white">← Library</Link> : <span className="text-xs text-white/50">← Library</span>}<h1 className="mt-2 text-2xl font-medium">{book?.title ?? "Manuscript"}</h1></div>
      <div className="flex flex-wrap items-center gap-3 text-sm"><Link href={`/books/${bookId}/plan`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Plan</Link><Link href={`/books/${bookId}/memory`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Book Bible</Link><Link href={`/books/${bookId}/translate`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Translate</Link><Link href={`/books/${bookId}/publish`} className="rounded-full border border-white/15 px-4 py-2 text-white/70 hover:border-white/30 hover:text-white">Layout & publish</Link><span role="status" className="text-white/50">{editorValidation ? "Unsaved · correct numbering before saving" : saving ? "Saving…" : manualSave ? "Save outcome unconfirmed" : dirty ? "Unsaved changes" : document ? `Saved · v${document.version}` : ""}</span>
        {EDIT_ROLES.has(role) && document && <button type="button" onClick={() => void save()} disabled={!editable || !dirty || saving || aiDecisionBusy || conflict || loading || editorValidation !== null} className="rounded-full bg-white px-5 py-2 font-medium text-black disabled:opacity-40">Save chapter</button>}
        {editorValidation && <button type="button" onClick={() => downloadDraft("txt")} className="min-h-11 rounded-full border border-white/20 px-4 py-2">Download draft text</button>}
{document && !loading && <details className="relative basis-full lg:basis-auto"><summary className="inline-flex min-h-11 cursor-pointer rounded-full border border-white/20 px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Back up chapter draft</summary><div className="absolute left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-white/15 bg-[#101010] p-4 shadow-xl lg:left-auto lg:right-0"><p className="text-xs leading-5 text-white/60">JSON includes your account and chapter identity, structure, formatting and artwork references. Keep it private; image files are not embedded. Text export does not keep formatting. Neither action saves to the server.</p><button type="button" onClick={() => downloadDraft()} className="mt-3 block min-h-11 w-full rounded-xl border border-white/20 px-4 text-left text-sm focus-visible:ring-2 focus-visible:ring-white">Download JSON backup</button><button type="button" onClick={() => downloadDraft("txt")} className="mt-2 block min-h-11 w-full rounded-xl border border-white/15 px-4 text-left text-sm focus-visible:ring-2 focus-visible:ring-white">Download draft text</button><label className="mt-4 block text-xs leading-5 text-white/65">Open a JSON backup for this chapter and saved version<input type="file" accept=".json,application/json" disabled={!backupScope.current.allowed} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void openDraftBackup(file); }} className="mt-2 block w-full text-xs text-white/70 file:mr-3 file:rounded-lg file:border file:border-white/20 file:bg-transparent file:px-3 file:py-2 file:text-white disabled:opacity-40" /></label></div></details>}
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
    {pendingRestore && !saving && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>Restore outcome is not confirmed. Your current draft remains here; editing is paused until you recover the request or reload saved content. Reloading cannot cancel a restore already in flight.</p><div className="mt-3 flex flex-wrap gap-4"><button type="button" disabled={loading} className="underline" onClick={() => void restore(pendingRestore.versionId)}>Retry original restore</button><button type="button" className="underline" onClick={() => downloadDraft()}>Download my draft</button><button type="button" disabled={loading} className="underline" onClick={() => { if (window.confirm("Reload saved content and replace this draft? The original restore may still arrive later; reloading does not cancel it. Download your draft first if needed.")) void loadChapter(pendingRestore.chapterId); }}>Reload saved content</button></div></div>}
    {pendingOrder && <section aria-label="Unconfirmed chapter order" className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm">
      <p>The reorder outcome is unconfirmed. Checking shows the current order but cannot prove who changed it or cancel a request still in flight. Further chapter structure changes are paused on this page. Reloading or closing the page loses this checkpoint and cannot cancel the original request; it could still arrive later even if the order changes back.</p>
      {pendingOrder.observed && <p role="status" className="mt-2">{pendingOrder.observed}</p>}
      <button type="button" disabled={saving || loading} className="mt-3 underline" onClick={() => void checkPendingOrder()}>Check saved chapter order</button>
    </section>}
    {conflict && <div className="mb-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm"><p>The saved chapter changed while you had unsaved edits. Your draft is still here. Download the JSON backup before reloading if you need to merge changes. It preserves artwork references, not image files.</p><button className="mr-4 mt-3 underline" onClick={() => downloadDraft()}>Download my draft</button><button className="underline" onClick={() => { if (document && window.confirm("Reload saved content and replace this unsaved draft?")) void loadChapter(document.chapterId); }}>Reload saved version</button></div>}
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_260px]">
      <aside className="self-start rounded-2xl border border-white/10 p-2">
        <button type="button" className="flex min-h-11 w-full items-center justify-between px-3 text-sm text-white/75 lg:hidden" aria-expanded={structureOpen} aria-controls="chapter-structure" onClick={() => setStructureOpen((open) => !open)}><span>Chapters · {chapters.length}</span><span>{structureOpen ? "Hide" : "Show"}</span></button>
        <div id="chapter-structure" className={structureOpen ? "block" : "hidden lg:block"}>
        <BookTree chapters={chapters} activeId={document?.chapterId ?? null} onSelect={selectChapter} onReorder={(ids) => void reorder(ids)} disabled={saving || loading || aiDecisionBusy || !!manualSave || !!pendingOrder || titleState.pending || titleState.busy} readOnly={!editable} />
        {EDIT_ROLES.has(role) && !pendingRestore && <form className="mt-5 space-y-2 border-t border-white/10 p-2 pt-4" onSubmit={(event) => { event.preventDefault(); void createChapter(); }}>
          <fieldset disabled={titleBlocked || saving || loading || aiDecisionBusy || !!manualSave || !!pendingOrder || (!!document && !saveRecoveryReady)} className="min-w-0 space-y-2 disabled:opacity-50">
          <label className="block text-xs text-white/50" htmlFor="new-chapter-title">New chapter</label><input id="new-chapter-title" value={book?.id === bookId ? newTitle : ""} onChange={(e) => updateChapterSetup(e.target.value, newChapterBrief)} disabled={!!pendingCreation.current} aria-describedby={pendingCreation.current ? "chapter-creation-recovery" : undefined} maxLength={500} required placeholder="Chapter title" className="w-full rounded-lg border border-white/15 bg-black p-2 text-sm" />
          <label className="block text-xs text-white/50" htmlFor="new-chapter-brief">Optional AI drafting brief</label><textarea id="new-chapter-brief" value={book?.id === bookId ? newChapterBrief : ""} onChange={(e) => updateChapterSetup(newTitle, e.target.value)} disabled={!!pendingCreation.current} aria-describedby={pendingCreation.current ? "chapter-creation-recovery" : undefined} maxLength={4000} rows={3} placeholder="What happens in this chapter?" className="w-full resize-y rounded-lg border border-white/15 bg-black p-2 text-sm" />
          <p className="text-[11px] leading-4 text-white/40">A brief creates an empty chapter and opens separate AI price review. Nothing is generated or charged until you accept a quote.</p>
          {pendingCreation.current && <p id="chapter-creation-recovery" role="status" className="break-words text-xs leading-5 text-white/70">Creation of “{pendingCreation.current.title}” is not confirmed. The original title and brief stay locked. Check the chapter list before retrying: if the created chapter was deleted, the same request can create it again.</p>}
          <button disabled={saving || book?.id !== bookId || !newTitle.trim()} className="min-h-11 w-full rounded-lg border border-white/20 px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">{pendingCreation.current ? "Retry chapter creation" : newChapterBrief.trim() ? "Add & review AI brief" : "Add chapter"}</button>
          </fieldset>
        </form>}
        </div>
      </aside>
      <section className="min-w-0">
        {document && saveAccount && <ChapterTitleEditor key={`${bookId}:${document.chapterId}:${saveAccount}`} bookId={bookId} chapterId={document.chapterId} userId={saveAccount}
          initialTitle={chapters.find(chapter => chapter.id === document.chapterId)?.title ?? "Chapter"} canEdit={EDIT_ROLES.has(role)}
          disabled={!!passiveCheck || accountVerifying || !!restoreHidden || saving || loading || aiDecisionBusy || !!manualSave || !!pendingRestore || !saveRecoveryReady || conflict}
          captureAccountEpoch={() => passiveEpoch.current} accountEpochCurrent={epoch => !passiveLocked.current && childActionsAvailable.current && passiveEpoch.current === epoch}
          onState={setTitleState} onTitle={title => setChapters(items => items.map(chapter => chapter.id === document.chapterId ? { ...chapter, title } : chapter))} />}
        {document && <p className="mb-3 px-1 text-right text-xs tabular-nums text-white/45">{wordCount.toLocaleString()} words</p>}
        {loading ? <p className="p-8 text-white/50" role="status">Loading manuscript…</p> : document && book ? <RichBookEditor key={`${document.chapterId}:${reloadKey}`} document={editorSeed ? { ...document, nodes: editorSeed } : document} workspaceId={book.workspace_id} actorId={saveAccount ?? ""} permissions={editable && !saving && !aiDecisionBusy ? "editor" : "viewer"} onValidationChange={(value) => { draftRevision.current++; latestValidation.current = value; if (value) liveDraft.current = true; setEditorValidation(value); }} onChange={(nodes) => { if (aiDecisionBusy) return; draftRevision.current++; latestDraft.current = nodes; liveDraft.current = true; setDraft(nodes); setDirty(true); if (!manualSave && saveFlight.current === null) pendingSave.current = null; setNotice(null); }} /> : <div className="rounded-2xl border-dashed border border-white/15 p-10 text-white/60">{error ? "Resolve the connection error to open this manuscript." : "Add your first chapter to start writing."}</div>}
      </section>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto lg:col-span-2 xl:col-span-1">
        {book?.id === bookId && editorOwner.current && <AiAssistantPanel key={`${editorOwner.current}:${document?.chapterId ?? "empty"}`} actorId={editorOwner.current} bookId={bookId} chapterId={document?.chapterId ?? null} savedChapter={document} initialJobId={activeAiJobId} initialDraftInstruction={document?.chapterId === draftPlanTargetChapterId ? initialDraftInstruction : undefined} dirty={hasUnsavedChanges} editable={editable && !saving && !loading} canDispatch={() => !passiveLocked.current && childActionsAvailable.current} onDecisionBusy={setAiDecisionBusy} onApplied={async () => { if (passiveLocked.current || !childActionsAvailable.current) throw new Error("Verify the original account before refreshing the saved chapter."); if (liveDraft.current) throw new Error("Back up the unsaved draft before refreshing the saved chapter."); if (document && editorSequence === loadSequence.current) await loadChapter(document.chapterId, true, true); }} />}
        <div className="rounded-2xl border border-white/10 p-2"><VersionTimeline key={document ? `${bookId}:${document.chapterId}` : "empty"}
          versions={versions} chapterId={document?.chapterId} loadVersion={document ? (id) => loadVersionForComparison(document.chapterId, id) : undefined}
          onRestore={(id) => void restore(id)} readOnly={!editable || saving || loading || aiDecisionBusy} /></div>
      </div>
    </div>
  </main></>;
}
