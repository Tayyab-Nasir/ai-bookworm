"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClientError, type AiReviewModelChoice, type AiReviewUsageQuote, type ManuscriptImportJob, type ManuscriptImportResult } from "@bookworm/api-client";
import { apiClient } from "./api";
import { readSetupCheckpoint, recoverManuscriptReport, runManuscriptSetup, setupKey, type SetupCheckpoint, type SetupStage } from "../lib/manuscript-setup";

type SetupMode = "blank" | "import" | "ai";
const stageLabels: Record<SetupStage, string> = { creating: "Creating book...", uploading: "Uploading source...", scanning: "Checking source...", importing: "Importing chapters...", drafting: "Queuing first draft..." };

export default function BookSetupClient() {
  const router = useRouter();
  const api = apiClient();
  const [workspaceId, setWorkspaceId] = useState("");
  const [userId, setUserId] = useState("");
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SetupMode>("blank");
  const [title, setTitle] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("en");
  const [storyBrief, setStoryBrief] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStage, setSaveStage] = useState<SetupStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<SetupCheckpoint | null>(null);
  const current = useRef<SetupCheckpoint | null>(null);
  const busy = useRef(false);
  const [report, setReport] = useState<ManuscriptImportResult["report"] | null>(null);
  const [importJob, setImportJob] = useState<ManuscriptImportJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [aiModels, setAiModels] = useState<AiReviewModelChoice[]>([]);
  const [aiModelId, setAiModelId] = useState("");
  const [countingConsent, setCountingConsent] = useState(false);
  const [aiQuote, setAiQuote] = useState<AiReviewUsageQuote | null>(null);
  const [quoteCounting, setQuoteCounting] = useState(false);
  const reportHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok) throw new Error("Sign in again before creating a book.");
      const { user } = await session.json();
      if (typeof user?.id !== "string") throw new Error("Session verification failed. Sign in again.");
      let workspace = new URLSearchParams(window.location.search).get("ws");
      if (!workspace) { try { workspace = window.localStorage.getItem("bookworm:workspaceId"); } catch { /* The URL can still select a workspace. */ } }
      if (!workspace || !/^[0-9a-f-]{36}$/i.test(workspace)) throw new Error("Choose a workspace from your library before creating a book.");
      let saved = null;
      try { saved = readSetupCheckpoint(window.sessionStorage.getItem(setupKey(user.id, workspace)), user.id, workspace); }
      catch { if (!cancelled) setNotice("Browser recovery storage is unavailable. Keep this tab open until import finishes."); }
      if (saved) {
        let book = null;
        try { ({ book } = await api.getBook(saved.bookId)); }
        catch (reason) { if (!(saved.bookCreated === false && reason instanceof ApiClientError && reason.status === 404)) throw reason; }
        if (book && book.workspace_id !== workspace) throw new Error("The saved setup belongs to a different workspace.");
        if (book && saved.bookCreated === false) {
          saved = { ...saved, bookCreated: true, savedAt: Date.now() };
          try { window.sessionStorage.setItem(setupKey(user.id, workspace), JSON.stringify(saved)); } catch { /* The server book remains available. */ }
        }
        let savedReport = null;
        let reportError = false;
        if (book) { try { savedReport = await recoverManuscriptReport(api, saved); } catch { reportError = true; } }
        if (cancelled) return;
        if (savedReport) {
          saved = { ...saved, completed: true }; setReport(savedReport);
          try { window.sessionStorage.setItem(setupKey(user.id, workspace), JSON.stringify(saved)); } catch { /* The report remains durable on the server. */ }
        }
        if (reportError) setError("The saved import report is temporarily unavailable. Your book is preserved; reload to check again.");
        if (book) { setTitle(book.title); setAuthorName(book.author_name); setGenre(book.genre ?? ""); setLanguage(book.language); }
        setMode(saved.setupMode ?? (saved.importing ? "import" : "blank")); setCheckpoint(saved); current.current = saved;
        setNotice(!book ? "Book creation was interrupted. Re-enter the same details, then retry; Bookworm will reuse this request ID."
          : saved.completed ? "This setup already finished. Open the editor to review your manuscript."
          : saved.setupMode === "ai" && saved.starter && !saved.starter.jobId
            ? "Chapter 1 is ready. Your brief was not saved in browser recovery; open the editor and use Draft to enter it again."
            : "Your existing book is ready to resume. We will reuse its uploaded source when available.");
      }
      if (!cancelled) { setWorkspaceId(workspace); setUserId(user.id); setReady(true); }
    })().catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not restore book setup."); });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => { if (checkpoint?.completed) reportHeading.current?.focus(); }, [checkpoint?.completed]);

  useEffect(() => {
    if (!ready || mode !== "ai" || !checkpoint?.bookCreated || checkpoint.completed) return;
    let cancelled = false;
    void api.listAiReviewModels(checkpoint.bookId).then(({ models }) => {
      if (!cancelled) { setAiModels(models); setAiModelId((checkpoint.starter?.modelId && models.some((item) => item.id === checkpoint.starter?.modelId) ? checkpoint.starter.modelId : models[0]?.id) ?? ""); }
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load available AI models."); });
    return () => { cancelled = true; };
  }, [api, checkpoint?.bookId, checkpoint?.bookCreated, checkpoint?.completed, checkpoint?.starter?.modelId, mode, ready]);

  useEffect(() => {
    const starter = checkpoint?.starter;
    if (!starter?.quoteRequestId || !checkpoint?.bookId || checkpoint.completed) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await api.getAiReviewQuote(checkpoint.bookId, starter.quoteRequestId!);
        if (cancelled) return;
        if (status.job) {
          const saved = { ...checkpoint, completed: true, starter: { ...starter, jobId: status.job.id }, savedAt: Date.now() };
          saveCheckpoint(saved); setAiQuote(null); setQuoteCounting(false);
          setNotice("Your first draft is queued. Open Chapter 1 to review it; nothing is applied automatically.");
        } else if (status.quote.status === "ready") { setAiQuote(status.quote); setQuoteCounting(false); }
        else if (status.quote.status === "failed") {
          const retryable = { ...checkpoint, starter: { chapterId: starter.chapterId, modelId: starter.modelId, allowProviderTokenCounting: starter.allowProviderTokenCounting }, savedAt: Date.now() };
          saveCheckpoint(retryable); setQuoteCounting(false); setError("Token counting failed. No generation job or credit hold was created. Re-enter your brief to request a fresh quote.");
        }
        else setQuoteCounting(true);
      } catch { /* Read-only polling cannot create another quote or job. */ }
    };
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, checkpoint?.bookId, checkpoint?.completed, checkpoint?.starter?.quoteRequestId]);

  useEffect(() => {
    if (!ready || saving || checkpoint?.completed || !checkpoint?.source || checkpoint.source.uploaded === false) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const bookId = checkpoint.bookId;
    const sourceId = checkpoint.source.assetId;
    const poll = async () => {
      try {
        const { jobs } = await api.listManuscriptImports(bookId);
        if (cancelled) return;
        const job = jobs.find((item) => item.source_asset_id === sourceId) ?? null;
        setImportJob(job); setJobError(null);
        if (job?.status === "succeeded") {
          const result = await api.getManuscriptImport(bookId, sourceId);
          if (cancelled) return;
          if (!result.import) throw new Error("The finished import report is not available yet. Checking again.");
          const saved = current.current;
          if (!saved || saved.bookId !== bookId || saved.source?.assetId !== sourceId) return;
          const finished = { ...saved, completed: true, savedAt: Date.now() };
          current.current = finished; setCheckpoint(finished); setReport(result.import.report);
          setError(null); setNotice("Your background import finished. Review the results before editing.");
          try { window.sessionStorage.setItem(setupKey(userId, workspaceId), JSON.stringify(finished)); } catch { /* Server receipt remains durable. */ }
          return;
        }
        if (job?.status === "failed") { setNotice(null); return; } // Author must deliberately request another retry batch.
      } catch (reason) {
        if (!cancelled) setJobError(reason instanceof Error ? reason.message : "Could not check import status. Checking again.");
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, ready, saving, checkpoint?.bookId, checkpoint?.source?.assetId, checkpoint?.completed, importJob?.status, userId, workspaceId]);

  const continueToEditor = (bookId: string, bookTitle: string, chapterId?: string, jobId?: string) => {
    const query = new URLSearchParams({ title: bookTitle });
    if (chapterId) query.set("chapter", chapterId);
    if (jobId) query.set("aiJob", jobId);
    router.push(`/books/${bookId}?${query.toString()}`);
  };

  const saveCheckpoint = (saved: SetupCheckpoint) => {
    current.current = saved; setCheckpoint(saved);
    try { window.sessionStorage.setItem(setupKey(userId, workspaceId), JSON.stringify(saved)); }
    catch {
      if (saved.bookCreated === false || saved.source?.uploaded === false) {
        throw new Error("Browser recovery storage is unavailable. Enable session storage before creating a book or allocating its source; no new request was sent.");
      }
      setNotice("Your server changes are saved, but browser recovery storage is unavailable. Keep this tab open.");
    }
  };

  const startAnother = () => {
    if (busy.current) return;
    try { window.sessionStorage.removeItem(setupKey(userId, workspaceId)); } catch { /* Server content is unchanged. */ }
    current.current = null; setCheckpoint(null); setReport(null); setError(null); setNotice(null);
    setImportJob(null); setJobError(null);
    setTitle(""); setAuthorName(""); setGenre(""); setStoryBrief(""); setSourceFile(null);
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || !ready || !title.trim() || checkpoint?.completed || (mode === "ai" && checkpoint?.starter && !checkpoint.starter.jobId) || (importJob && importJob.status !== "failed")) return;
    busy.current = true;
    setSaving(true);
    setSaveStage("creating");
    setError(null);
    setNotice(null);
    try {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok || (await session.json()).user?.id !== userId) throw new Error("Your session changed. Reload and sign in before continuing.");
      if (importJob?.status === "failed" && checkpoint) {
        const { job } = await api.retryManuscriptImport(checkpoint.bookId, importJob.id);
        setImportJob(job); setNotice("Import queued for another attempt. Your original and existing book are preserved.");
        return;
      }
      const result = await runManuscriptSetup({ api, userId,
        details: { workspaceId, title: title.trim(), authorName: authorName.trim() || "Untitled author", language, genre: genre.trim() || undefined },
        importing: mode === "import", file: sourceFile, checkpoint: current.current, save: saveCheckpoint, stage: setSaveStage,
        setupMode: mode, finishWhenBookCreated: mode !== "ai",
        queueImport: api.queueManuscriptImport });
      if (mode === "blank") continueToEditor(result.bookId, title);
      else if (mode === "ai") {
        let saved = current.current;
        if (!saved) throw new Error("Book recovery state was not saved. Check your library before retrying.");
        let starter = saved.starter;
        if (!starter) {
          setSaveStage("drafting");
          const { chapter } = await api.createChapter(result.bookId, { title: "Chapter 1", idempotencyKey: `story-starter-chapter:${result.bookId}` });
          starter = { chapterId: chapter.id };
          saved = { ...saved, starter, savedAt: Date.now() };
          saveCheckpoint(saved);
        }
        setNotice("Chapter 1 is ready. Choose a model, consent to token counting, and review the exact credit quote before generation.");
      }
      else if (result.job) { setImportJob(result.job); setNotice("Import queued. Processing continues on the server if you leave this page."); }
      else { setReport(result.report); setNotice(result.report ? "Your manuscript is imported. Review the results before editing." : "This source is already imported. Open the editor to review the saved chapters."); }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not finish book setup.";
      setError(current.current?.bookCreated === false
        ? `${message} Creation may have reached the server. Retry uses the same book request; do not start a second book.`
        : current.current ? `${message} Your existing book is preserved; retry continues the same setup.`
          : `${message} Check your library before trying again.`);
    } finally {
      setSaving(false);
      setSaveStage(null);
      busy.current = false;
    }
  };

  const prepareFirstDraftQuote = async () => {
    const saved = current.current;
    if (!saved?.starter || !aiModelId || !storyBrief.trim() || !countingConsent || busy.current) return;
    busy.current = true; setSaving(true); setError(null); setNotice(null); setAiQuote(null);
    try {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok || (await session.json()).user?.id !== userId) throw new Error("Your session changed. Reload before continuing.");
      const starter = { ...saved.starter, quoteKey: saved.starter.quoteKey ?? `story-starter:${saved.bookId}:${saved.starter.chapterId}`, modelId: aiModelId, allowProviderTokenCounting: true as const };
      const pending = { ...saved, starter, savedAt: Date.now() };
      saveCheckpoint(pending); // Persist stable quote identity and consent before sending the selected brief for counting.
      const result = await api.createAiReviewQuote(saved.bookId, { modelId: aiModelId, agentType: "writer", chapterIds: [starter.chapterId], userInstruction: storyBrief.trim(),
        idempotencyKey: starter.quoteKey!, contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: true, semanticTopK: 5, maxTokens: 16_000 }, allowProviderTokenCounting: true });
      if (result.quote) {
        const next = { ...pending, starter: { ...starter, quoteRequestId: result.quote.requestId }, savedAt: Date.now() };
        saveCheckpoint(next); setAiQuote(result.quote); setQuoteCounting(false);
      }
      else if (result.request) {
        const next = { ...pending, starter: { ...starter, quoteRequestId: result.request.id }, savedAt: Date.now() };
        saveCheckpoint(next); setQuoteCounting(true); setNotice("Counting the selected saved chapter and brief. This does not reserve credits or start generation.");
      } else throw new Error("The quote service returned no quote status. Check the saved request before retrying.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not prepare a usage quote."); }
    finally { setSaving(false); busy.current = false; }
  };

  const acceptFirstDraftQuote = async () => {
    const saved = current.current; const quote = aiQuote;
    if (!saved?.starter || !quote || busy.current) return;
    busy.current = true; setSaving(true); setError(null);
    try {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok || (await session.json()).user?.id !== userId) throw new Error("Your session changed. Reload before accepting this quote.");
      const accepted = await api.acceptAiReviewQuote(saved.bookId, quote.requestId, quote.reservedCredits);
      const next = { ...saved, completed: true, starter: { ...saved.starter, jobId: accepted.jobId }, savedAt: Date.now() };
      saveCheckpoint(next); setAiQuote(null); setNotice("Draft accepted and queued. Nothing is applied until you review it in Chapter 1.");
      continueToEditor(saved.bookId, title, saved.starter.chapterId, accepted.jobId);
    } catch (reason) {
      // Recover only through quote status; never issue a second acceptance with a new quote.
      const requestId = quote.requestId;
      try {
        const status = await api.getAiReviewQuote(saved.bookId, requestId);
        if (status.job) {
          const next = { ...saved, completed: true, starter: { ...saved.starter, quoteRequestId: requestId, jobId: status.job.id }, savedAt: Date.now() };
          saveCheckpoint(next); setAiQuote(null); setNotice("Recovered the accepted first draft without another charge.");
          continueToEditor(saved.bookId, title, saved.starter.chapterId, status.job.id);
        } else { setError(reason instanceof Error ? `${reason.message} The quote remains available; check its status before retrying.` : "Acceptance could not be confirmed. Check quote status before retrying."); }
      } catch { setError("Acceptance could not be confirmed. Check the saved quote status before retrying; do not create a new quote yet."); }
    } finally { setSaving(false); busy.current = false; }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 pb-16 pt-8 sm:px-6 lg:px-8 lg:pt-12">
      <Link href="/dashboard" className="text-sm font-medium text-[#b8b8b8] underline decoration-white/25 underline-offset-4 hover:text-white">← Back to library</Link>
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_250px]">
        <section>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#8f8f8f]">New project</p>
          <h1 className="mt-3 text-4xl font-medium leading-[0.94] tracking-[-0.06em] sm:text-5xl">
            Bring a book to <span className="font-instrument instrument-italic font-normal italic text-[#bdbdbd]">life.</span>
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-6 text-[#969696]">Start blank, import a manuscript, or turn a story brief into a reviewable first chapter.</p>

          <div className="mt-8 inline-flex rounded-full border border-white/[0.1] bg-white/[0.035] p-1">
            {[
              ["blank", "Start blank"],
              ["import", "Import manuscript"],
              ["ai", "Start with AI"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={saving || Boolean(checkpoint)}
                aria-pressed={mode === value}
                onClick={() => { setMode(value as SetupMode); setError(null); setNotice(null); }}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default ${mode === value ? "bg-white text-black" : "text-[#a2a2a2] hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} aria-busy={saving} className="mt-5 rounded-[26px] border border-white/[0.1] bg-white/[0.025] p-5 sm:p-7">
            <fieldset disabled={!ready || saving || Boolean(checkpoint && checkpoint.bookCreated !== false)} className="grid min-w-0 gap-5 sm:grid-cols-2 disabled:opacity-70">
              <legend className="sr-only">Book details</legend>
              <label className="sm:col-span-2">
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">Book title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={500} placeholder="The title on the cover" className="h-12 w-full rounded-xl border border-white/[0.1] bg-black/20 px-4 text-[15px] text-white outline-none transition focus:border-white/35" />
              </label>
              <label>
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">Author name</span>
                <input value={authorName} onChange={(event) => setAuthorName(event.target.value)} maxLength={300} placeholder="Name shown in metadata" className="h-12 w-full rounded-xl border border-white/[0.1] bg-black/20 px-4 text-[15px] text-white outline-none transition focus:border-white/35" />
              </label>
              <label>
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">Genre</span>
                <input value={genre} onChange={(event) => setGenre(event.target.value)} maxLength={200} placeholder="Optional" className="h-12 w-full rounded-xl border border-white/[0.1] bg-black/20 px-4 text-[15px] text-white outline-none transition focus:border-white/35" />
              </label>
              <label>
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">Manuscript language</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)} className="h-12 w-full rounded-xl border border-white/[0.1] bg-black/20 px-4 text-[15px] text-white outline-none transition focus:border-white/35">
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="ar">Arabic</option>
                </select>
              </label>
            </fieldset>

            {mode === "import" && (!checkpoint?.source || checkpoint.source.uploaded === false) && !checkpoint?.completed && (
              <label className="mt-5 block rounded-2xl border border-dashed border-white/[0.18] bg-black/20 p-5 transition hover:border-white/[0.32]">
                <span className="text-sm font-medium text-white">Source manuscript</span>
                <span className="mt-1 block text-[13px] leading-5 text-[#909090]">{checkpoint?.source?.uploaded === false ? "If the original upload did not finish, choose the same file to resume. Bookworm will first check whether it already arrived." : "TXT, DOCX, EPUB and text-based PDF, up to 20 MB. Scanned PDFs need OCR first. Uploads remain quarantined until screening passes."}</span>
                <input type="file" disabled={!ready || saving} accept=".txt,.docx,.pdf,.epub,text/plain,application/pdf,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)} className="mt-4 block w-full text-sm text-[#bdbdbd] file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-3 file:py-2 file:text-xs file:font-semibold file:text-black hover:file:bg-[#dedede]" />
                {sourceFile && <span className="mt-3 block text-sm text-[#d6d6d6]">Selected: {sourceFile.name} · {(sourceFile.size / 1024 / 1024).toFixed(1)} MB</span>}
              </label>
            )}

            {mode === "ai" && !checkpoint?.completed && !checkpoint?.starter?.jobId && (
              <label className="mt-5 block">
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">Story brief</span>
                <textarea value={storyBrief} onChange={(event) => setStoryBrief(event.target.value)} required maxLength={4000} rows={6} placeholder="A quiet historical mystery set on the coast. Write a tense opening scene from Mara's point of view…" className="w-full resize-y rounded-xl border border-white/[0.1] bg-black/20 px-4 py-3 text-[15px] leading-6 text-white outline-none transition focus:border-white/35" />
                <span className="mt-2 block text-[13px] leading-5 text-[#909090]">Your brief stays in this page memory, not browser recovery storage. You will consent to token counting, review the exact credit quote, and accept it before generation begins.</span>
              </label>
            )}

            {mode === "ai" && checkpoint?.starter && !checkpoint.completed && !checkpoint.starter.jobId && <section aria-label="First draft usage quote" className="mt-5 rounded-2xl border border-white/[0.1] bg-black/20 p-4 sm:p-5">
              <label className="block"><span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">Generation model</span>
                <select value={aiModelId} disabled={saving || quoteCounting || !!aiQuote} onChange={(event) => setAiModelId(event.target.value)} className="h-11 w-full rounded-xl border border-white/[0.1] bg-[#151515] px-3 text-sm text-white outline-none focus:border-white/35">
                  {aiModels.length ? aiModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>) : <option value="">No approved model available</option>}
                </select>
              </label>
              <label className="mt-4 flex items-start gap-2 text-xs leading-5 text-[#bdbdbd]"><input type="checkbox" checked={countingConsent || checkpoint.starter.allowProviderTokenCounting === true} disabled={saving || quoteCounting || !!aiQuote || checkpoint.starter.allowProviderTokenCounting === true} onChange={(event) => setCountingConsent(event.target.checked)} />
                <span>I agree to send the selected saved Chapter 1 context and this brief to OpenAI for token counting. This calculates the quote; it does not generate content or reserve credits.</span></label>
              {quoteCounting && <p role="status" className="mt-4 text-sm text-[#d0d0d0]">Counting usage. No generation job or credit hold has been created.</p>}
              {aiQuote && <div className="mt-4 rounded-xl border border-emerald-200/20 bg-emerald-200/[0.06] p-4" role="status"><p className="text-sm font-medium text-white">Exact quote · {aiQuote.reservedCredits} credits</p><p className="mt-1 text-xs leading-5 text-[#bdbdbd]">{aiQuote.countedInputTokens.toLocaleString()} counted input tokens · up to {aiQuote.maxOutputTokens.toLocaleString()} output tokens · expires {new Date(aiQuote.expiresAt).toLocaleString()}</p></div>}
              {!aiQuote && <button type="button" disabled={!ready || saving || !aiModelId || !storyBrief.trim() || !(countingConsent || checkpoint.starter.allowProviderTokenCounting === true) || quoteCounting} onClick={() => void prepareFirstDraftQuote()} className="mt-4 inline-flex h-11 items-center rounded-full bg-white px-4 text-sm font-semibold text-black disabled:opacity-40">{quoteCounting ? "Counting tokens…" : checkpoint.starter.quoteRequestId ? "Retry same quote request" : "Prepare exact credit quote"}</button>}
              {aiQuote && <button type="button" disabled={saving} onClick={() => void acceptFirstDraftQuote()} className="mt-4 inline-flex h-11 items-center rounded-full bg-white px-4 text-sm font-semibold text-black disabled:opacity-40">{saving ? "Accepting…" : `Accept · ${aiQuote.reservedCredits} credits and generate`}</button>}
              <p className="mt-3 text-[11px] leading-5 text-[#858585]">Quote and acceptance use the same saved request identity for safe recovery. Your brief is never stored in browser session recovery.</p>
            </section>}

            {checkpoint?.source?.uploaded !== false && checkpoint?.source && !checkpoint.completed && <p className="mt-5 text-sm leading-6 text-[#bdbdbd]">Your original upload is saved. Import uses this existing book and source. Background processing requires the document worker to be running.</p>}
            {importJob && !checkpoint?.completed && <div role="status" className="mt-5 rounded-xl border border-white/15 px-4 py-3 text-sm leading-6 text-[#bdbdbd]">
              <p className="font-medium text-white">Import {importJob.status} · Attempt {importJob.attempts} of 5</p>
              <p>{importJob.status === "failed" ? "Import stopped. Your original is preserved. Check the source or service configuration, then retry."
                : importJob.status === "queued" ? "Waiting for a worker or scheduled retry. You can leave this page; processing does not depend on this tab."
                  : "Checking and importing your manuscript. Chapters and images will appear together when finished."}</p>
              {importJob.error_code && <p className="mt-2 break-words">Reference: {importJob.error_code}</p>}
            </div>}
            {checkpoint?.starter?.jobId && <div role="status" className="mt-5 rounded-xl border border-white/15 px-4 py-3 text-sm leading-6 text-[#bdbdbd]"><p className="font-medium text-white">First draft queued</p><p>Open Chapter 1 to follow progress and accept, reject, or revise the AI proposal. Your story brief is not kept in browser recovery storage.</p></div>}
            {jobError && <p role="alert" className="mt-3 text-sm text-amber-100">Status temporarily unavailable. {jobError}</p>}
            {error && <p role="alert" className="mt-5 rounded-xl border border-red-400/20 bg-red-400/[0.08] px-4 py-3 text-sm text-red-100">{error}</p>}
            {notice && <p role="status" className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/[0.08] px-4 py-3 text-sm leading-6 text-amber-50">{notice}</p>}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {!checkpoint?.completed && (!importJob || importJob.status === "failed") && !(mode === "ai" && checkpoint?.starter) && <button type="submit" disabled={!ready || saving} className="glass-solid metal-shine inline-flex h-12 items-center rounded-full px-5 text-sm font-semibold text-black disabled:cursor-wait disabled:opacity-60">
                <span className="relative z-10">{saveStage ? stageLabels[saveStage] : checkpoint?.bookCreated === false ? "Retry book creation" : checkpoint ? mode === "ai" ? "Prepare Chapter 1" : mode === "import" ? "Retry import" : "Continue setup" : mode === "import" ? "Create and import" : mode === "ai" ? "Create book & Chapter 1" : "Create book"}</span>
              </button>}
              {checkpoint && checkpoint.bookCreated !== false && (
                <button type="button" disabled={saving} onClick={() => continueToEditor(checkpoint.bookId, title, checkpoint.starter?.chapterId, checkpoint.starter?.jobId)} className="glass-ghost inline-flex h-12 items-center rounded-full px-5 text-sm font-medium text-white disabled:opacity-60">
                  Continue to editor
                </button>
              )}
              {checkpoint && checkpoint.bookCreated !== false && !saving && <button type="button" onClick={startAnother} className="text-sm text-[#bdbdbd] underline underline-offset-4">Start another book</button>}
            </div>
            {checkpoint?.bookCreated !== false && checkpoint && !saving && <p className="mt-3 text-xs leading-5 text-[#969696]">Starting another book leaves this book and its original in your library and Assets. Recovery is saved in this browser tab for 24 hours.</p>}
          </form>

          {checkpoint?.completed && mode === "import" && <section aria-labelledby="import-results" className="mt-6 rounded-[26px] border border-white/20 bg-white/[0.04] p-5 sm:p-7">
            <p className="text-[11px] uppercase tracking-[0.18em] text-[#bdbdbd]">Ready for your review</p>
            <h2 id="import-results" ref={reportHeading} tabIndex={-1} className="mt-2 font-instrument text-3xl italic outline-offset-4">Your manuscript, brought in.</h2>
            {report ? <>
              <dl className="mt-5 flex flex-wrap gap-8 border-y border-white/10 py-4">
                <div><dt className="text-xs text-[#bdbdbd]">Chapters imported</dt><dd className="mt-1 text-2xl">{report.chapterCount}</dd></div>
                {report.imageCount !== undefined && <div><dt className="text-xs text-[#bdbdbd]">Images imported</dt><dd className="mt-1 text-2xl">{report.imageCount}</dd></div>}
              </dl>
              <h3 className="mt-5 text-sm font-semibold">{report.warnings.length ? "Items to review" : "No parser warnings reported"}</h3>
              {report.warnings.length > 0 && <ul className="mt-3 max-h-64 list-disc space-y-2 overflow-auto break-words pl-5 text-sm leading-6 text-[#bdbdbd]">{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            </> : <p className="mt-4 text-sm leading-6 text-[#bdbdbd]">This import already finished. Its original report is not available in this tab; review the saved chapters in the editor.</p>}
            <p className="mt-5 text-sm leading-6 text-[#bdbdbd]">Check chapter order, formatting, tables and image descriptions. Import is not a print or retailer approval.</p>
          </section>}
        </section>

        <aside className="h-fit rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 text-sm leading-6 text-[#9b9b9b]">
          <h2 className="text-base font-medium text-white">{mode === "import" ? "Your import" : mode === "ai" ? "Your first draft" : "What happens next"}</h2>
          {mode === "import" && <ol aria-label="Import progress" className="mt-4 space-y-3 border-b border-white/10 pb-5">
            {(["creating", "uploading", "scanning", "importing"] as SetupStage[]).map((stage, index) => <li key={stage} aria-current={saveStage === stage ? "step" : undefined} className="flex items-center gap-3 text-sm aria-[current=step]:text-white">
              <span className="font-instrument text-xl italic">0{index + 1}</span><span>{["Create book", "Store original", "Screen file", "Import chapters & images"][index]}</span>
            </li>)}
          </ol>}
          <p role="status" className="mt-3 text-sm text-white">{saveStage ? stageLabels[saveStage] : checkpoint?.completed ? "Setup complete" : ""}</p>
          <ol className="mt-4 space-y-3 pl-5 marker:text-white">
            <li>{mode === "ai" ? "Review the generated Chapter 1 proposal in the editor." : "Build the manuscript in the chapter editor."}</li>
            <li>Add cover art and illustrations in Assets.</li>
            <li>Prepare an ebook or print edition, then run a preflight review.</li>
          </ol>
          <p className="mt-5 border-t border-white/[0.08] pt-5 text-[13px] leading-5 text-[#969696]">Bookworm prepares export packages. You review and submit them through the retailer’s supported workflow; this does not publish your book automatically.</p>
        </aside>
      </div>
    </main>
  );
}
