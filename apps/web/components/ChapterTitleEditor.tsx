"use client";

import { useEffect, useRef, useState } from "react";
import type { ChapterTitleState } from "@bookworm/api-client";
import { apiClient } from "./api";
import { editorAccount } from "../lib/manual-chapter-save";
import { clearTitleChange, parseTitleChange, persistTitleChange, titleChangeKey, titleDigest, validateTitleResult, validateTitleState, validChapterTitle, type TitleChangePointer } from "../lib/chapter-title";

export type ChapterTitleEditorState = { dirty: boolean; busy: boolean; pending: boolean };
type Props = { bookId: string; chapterId: string; userId: string; initialTitle: string; canEdit: boolean; disabled: boolean;
  onTitle: (title: string) => void; onState: (state: ChapterTitleEditorState) => void };

export default function ChapterTitleEditor(props: Props) {
  const { bookId, chapterId, userId, initialTitle, canEdit, disabled } = props;
  const callbacks = useRef(props); callbacks.current = props;
  const api = apiClient();
  const [current, setCurrent] = useState<ChapterTitleState | null>(null);
  const [draft, setDraft] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<TitleChangePointer | null>(null);
  const retainedTitle = useRef<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0), flight = useRef(false);
  const dirty = editing && draft !== (current?.title ?? initialTitle);

  useEffect(() => { callbacks.current.onState({ dirty, busy, pending: pending !== null }); }, [dirty, busy, pending]);
  useEffect(() => {
    const sequence = ++epoch.current;
    setReady(false); setCurrent(null); setEditing(false); setPending(null); setMissing(false); setError(null); setNotice(null);
    retainedTitle.current = null;
    void (async () => {
      try {
        await editorAccount(userId);
        if (sequence !== epoch.current) return;
        const pointer = parseTitleChange(window.sessionStorage.getItem(titleChangeKey({ bookId, chapterId, userId })), { bookId, chapterId, userId });
        setPending(pointer);
        const saved = await api.getChapterTitle(chapterId, userId);
        await editorAccount(userId);
        if (sequence !== epoch.current) return;
        if (saved.bookId !== bookId || saved.chapterId !== chapterId) throw Error("The chapter title belongs to a different book.");
        validateTitleState(saved);
        setCurrent(saved); setDraft(saved.title); setReady(true); callbacks.current.onTitle(saved.title);
      } catch (reason) { if (sequence === epoch.current) setError(reason instanceof Error ? reason.message : "Could not verify the saved title."); }
    })();
    return () => { epoch.current++; callbacks.current.onState({ dirty: false, busy: false, pending: false }); };
  }, [api, bookId, chapterId, userId, attempt]);

  const apply = async (raw: unknown, p: TitleChangePointer, sequence: number) => {
    const result = await validateTitleResult(raw, p);
    await editorAccount(userId);
    if (sequence !== epoch.current) return;
    setCurrent(result.current); callbacks.current.onTitle(result.current.title);
    if (result.status === "not_found") { setMissing(true); setNotice("No outcome is recorded yet. This does not cancel an in-flight rename."); return; }
    clearTitleChange(window.sessionStorage, p);
    setPending(null); setMissing(false);
    if (result.status === "conflict") {
      setEditing(retainedTitle.current !== null);
      setDraft(retainedTitle.current ?? result.current.title);
      setNotice("Another edit changed this title. Your proposed title is still here if this page was kept open; review the current title before saving again.");
    } else {
      setDraft(result.current.title); setEditing(false);
      setNotice(result.status === "closed" ? "Unconfirmed rename closed. The saved title and manuscript are unchanged."
        : result.receipt!.revision < result.current.revision ? "Your rename is recorded. A newer title is now displayed." : "Chapter title saved. Manuscript text and saved history are unchanged.");
    }
    retainedTitle.current = null;
  };

  const run = async (mode: "save" | "retry" | "read" | "close") => {
    if (flight.current || disabled || !ready || (!canEdit && mode !== "read") || (mode !== "save" && !pending)) return;
    if (mode === "save" && (pending || !current || !validChapterTitle(draft.trim()) || draft.trim() === current.title)) return;
    if (mode === "retry" && retainedTitle.current === null) return;
    const sequence = epoch.current;
    flight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await editorAccount(userId);
      if (sequence !== epoch.current) return;
      let pointer = pending;
      if (mode === "save") {
        const value = draft.trim();
        pointer = { schema: 1, bookId, chapterId, userId, operationId: crypto.randomUUID(), expectedRevision: current!.revision, titleDigest: await titleDigest(value) };
        if (sequence !== epoch.current) return;
        persistTitleChange(window.sessionStorage, pointer);
        retainedTitle.current = value; setPending(pointer); setMissing(false);
      }
      if (!pointer) throw Error("The original title request is missing.");
      if (mode === "save" || mode === "retry") {
        if (retainedTitle.current === null || await titleDigest(retainedTitle.current) !== pointer.titleDigest) throw Error("The original title text is not available. Check the saved status instead.");
        if (sequence !== epoch.current) return;
        await apply(await api.changeChapterTitle(chapterId, pointer.operationId, { title: retainedTitle.current, expectedRevision: pointer.expectedRevision }, userId), pointer, sequence);
      } else {
        const method = mode === "read" ? api.getChapterTitleChange : api.closeChapterTitleChange;
        await apply(await method(chapterId, pointer.operationId, pointer.expectedRevision, pointer.titleDigest, userId), pointer, sequence);
      }
    } catch (reason) { if (sequence === epoch.current) setError(reason instanceof Error ? reason.message : "The rename outcome is unconfirmed. Check its saved status."); }
    finally { if (sequence === epoch.current) { flight.current = false; setBusy(false); } }
  };

  return <section aria-label="Chapter title" className="mb-3 min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><p className="text-[10px] uppercase tracking-[0.14em] text-white/40">Chapter title</p><h2 className="mt-1 break-words text-sm font-medium text-white/85">{current?.title ?? initialTitle}</h2></div>
      {canEdit && !editing && !pending && <button type="button" onClick={() => { setEditing(true); setDraft(current!.title); setNotice(null); }} disabled={!ready || disabled || busy} className="min-h-11 shrink-0 rounded-lg border border-white/15 px-3 text-xs text-white/70 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">Edit chapter title</button>}
    </div>
    {editing && !pending && <form className="mt-3" onSubmit={event => { event.preventDefault(); void run("save"); }}>
      <fieldset disabled={disabled || busy || !canEdit} className="min-w-0 space-y-3 disabled:opacity-50">
        <label className="block text-xs text-white/60" htmlFor={`chapter-title-${chapterId}`}>New chapter title</label>
        <input id={`chapter-title-${chapterId}`} autoFocus value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} required aria-describedby={`title-help-${chapterId}`} className="w-full min-w-0 rounded-lg border border-white/20 bg-black px-3 py-2 text-sm text-white focus-visible:ring-2 focus-visible:ring-white" />
        <p id={`title-help-${chapterId}`} className="text-xs leading-5 text-white/45">Updates the chapter list and future contents pages. It does not rewrite a heading inside your manuscript or change an older export.</p>
        <div className="flex flex-wrap gap-2"><button type="submit" disabled={!validChapterTitle(draft.trim()) || draft.trim() === current?.title} className="min-h-11 rounded-lg bg-white px-4 text-xs font-medium text-black disabled:opacity-40">Save title</button><button type="button" onClick={() => { setDraft(current!.title); setEditing(false); }} className="min-h-11 rounded-lg border border-white/15 px-4 text-xs">Cancel title edit</button></div>
      </fieldset>
    </form>}
    {pending && <div className="mt-3 rounded-lg border border-amber-200/20 bg-amber-200/[0.06] p-3 text-xs leading-5 text-amber-100">
      <p>A title change is unconfirmed. This tab keeps its recovery ID and fingerprint, not the proposed title text.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy || disabled || !ready} onClick={() => void run("read")} className="min-h-11 rounded-lg border border-amber-100/30 px-3 disabled:opacity-40">Check title status</button>
        {missing && canEdit && retainedTitle.current !== null && <button type="button" disabled={busy || disabled} onClick={() => void run("retry")} className="min-h-11 rounded-lg border border-amber-100/30 px-3 disabled:opacity-40">Retry original rename</button>}
        {missing && canEdit && <button type="button" disabled={busy || disabled} onClick={() => void run("close")} className="min-h-11 rounded-lg border border-amber-100/30 px-3 disabled:opacity-40">Close unconfirmed rename</button>}
      </div>
      {missing && <p className="mt-2 text-amber-100/70">Closing prevents this request from arriving late. It cannot undo a rename that already committed.</p>}
    </div>}
    {error && <p role="alert" className="mt-3 break-words text-xs leading-5 text-red-200">{error}</p>}
    {!ready && error && <button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-2 min-h-11 text-xs underline">Retry title verification</button>}
    {notice && <p role="status" className="mt-3 text-xs leading-5 text-white/65">{notice}</p>}
  </section>;
}
