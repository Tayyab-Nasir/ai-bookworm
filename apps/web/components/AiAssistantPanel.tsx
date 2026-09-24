"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, type AiJobReview, type AiJobWithSuggestions } from "@bookworm/api-client";
import type { AiSuggestion } from "@bookworm/types";
import { apiClient } from "./api";
import AiProofSheet from "./AiProofSheet";
import { pendingReviewBody, readPendingReview, reviewBriefHash, reviewRecoveryKey, reviewTargetsChapter, type PendingReview, type ReviewMode } from "../lib/ai-review-recovery";
import { previewAiSuggestion, type SavedChapterPreview } from "../lib/ai-suggestion-preview";

type Mode = ReviewMode;
const modes: { value: Mode; label: string }[] = [
  { value: "writer", label: "Draft" },
  { value: "proofreader", label: "Proofread" },
  { value: "copyeditor", label: "Copy edit" },
  { value: "consistency", label: "Consistency" },
];

function modeLabel(agentType: string) {
  return modes.find((mode) => mode.value === agentType)?.label ?? agentType;
}

export default function AiAssistantPanel({
  bookId, chapterId, savedChapter, initialJobId, dirty, editable, onApplied,
}: { bookId: string; chapterId: string | null; savedChapter: SavedChapterPreview | null; initialJobId?: string; dirty: boolean; editable: boolean; onApplied: () => Promise<void> }) {
  const api = apiClient();
  const [mode, setMode] = useState<Mode>("proofreader");
  const [instruction, setInstruction] = useState("");
  const [includeRelated, setIncludeRelated] = useState(true);
  const [contextBudget, setContextBudget] = useState(16000);
  const [job, setJob] = useState<AiJobWithSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState<AiJobReview[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingReview | null>(null);
  const [lastAppliedVersion, setLastAppliedVersion] = useState<number | null>(null);
  const requestInFlight = useRef(false);
  const suggestions = useMemo(() => job?.suggestions ?? [], [job]);
  const unconfirmed = job?.error_code === "ai_provider_outcome_unconfirmed";
  const processing = busy || job?.status === "queued" || job?.status === "running";

  const loadRecent = useCallback(async () => {
    try { setRecent((await api.listAiJobs(bookId)).jobs); }
    catch { setRecent([]); }
  }, [api, bookId]);

  const remember = useCallback((next: AiJobReview) => {
    setRecent((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 8));
  }, []);

  useEffect(() => { void loadRecent(); }, [loadRecent]);
  useEffect(() => { setJob(null); setLastAppliedVersion(null); setError(null); setNotice(null); }, [bookId, chapterId]);
  useEffect(() => {
    if (!chapterId) return;
    let cancelled = false;
    setRecoveryReady(false); setPendingRequest(null);
    void (async () => {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok) throw new Error("Sign in again before requesting AI review.");
      const { user } = await session.json();
      if (typeof user?.id !== "string") throw new Error("Your session could not be verified.");
      const storageKey = reviewRecoveryKey(user.id, bookId, chapterId);
      let raw: string | null;
      try { raw = window.sessionStorage.getItem(storageKey); }
      catch { throw new Error("Browser recovery storage is unavailable. AI review is paused to avoid duplicate charges."); }
      const saved = readPendingReview(raw, user.id, bookId, chapterId);
      if (raw && !saved) throw new Error("The saved AI recovery checkpoint is invalid or expired. No new request will be sent; contact support with this book and chapter.");
      if (cancelled) return;
      setUserId(user.id);
      if (saved) {
        setPendingRequest(saved); setMode(saved.mode); setIncludeRelated(saved.includeRelated); setContextBudget(saved.contextBudget);
        try {
          const recovered = await api.getAiJobByRequest(bookId, saved.key);
          if (cancelled) return;
          if (!reviewTargetsChapter(recovered, chapterId)) throw new Error("The saved AI request targets another chapter. No new request was sent.");
          setJob(recovered); setLastAppliedVersion(null); remember(recovered); setPendingRequest(null);
          try { window.sessionStorage.removeItem(storageKey); } catch { /* A later reload can read the same server job. */ }
          setNotice("Recovered the saved AI review without starting another request.");
        } catch (reason) {
          if (cancelled) return;
          if (reason instanceof ApiClientError && reason.status === 404) {
            setNotice("The previous request is not queued. Retry its original brief and settings with the same request key; no new key will be used.");
          } else setError(reason instanceof Error ? reason.message : "Could not verify the saved AI request. No new request was sent.");
        }
      }
      if (!cancelled) setRecoveryReady(true);
    })().catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "AI request recovery is unavailable."); setRecoveryReady(false); } });
    return () => { cancelled = true; };
  }, [api, bookId, chapterId, remember]);
  useEffect(() => {
    // Each effect setup owns its fetch. Strict Mode may cancel and replay the
    // setup; a persistent "already opened" latch would discard both responses.
    if (!initialJobId || !chapterId) return;
    let cancelled = false;
    setBusy(true); setError(null); setNotice(null);
    void api.getAiJob(initialJobId).then((result) => {
      if (cancelled) return;
      if (!reviewTargetsChapter(result, chapterId)) { setError("This saved review belongs to a different chapter. Select that chapter before opening it."); return; }
      setJob(result); setLastAppliedVersion(null); remember(result);
      if (modes.some((item) => item.value === result.agent_type)) setMode(result.agent_type as Mode);
      if (result.status === "failed") { setError(result.error_message ?? "This AI review did not finish. Start a fresh review."); return; }
      const label = result.agent_type === "writer" ? "draft" : "review";
      setNotice(result.status === "queued" ? `Your ${label} is queued. It will continue if you leave this page.`
        : result.status === "running" ? `Your ${label} is running. It will continue if you leave this page.`
          : result.suggestions.length ? `Your ${label} is ready to review.` : `This ${label} completed with no proposal.`);
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not open the saved AI review."); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [api, chapterId, initialJobId, remember]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status) || unconfirmed) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.getAiJob(job.id);
        if (cancelled) return;
        setJob(next); remember(next);
        if (next.error_code === "ai_provider_outcome_unconfirmed") setNotice(null);
        if (next.status === "succeeded") setNotice(next.suggestions.length ? "Review complete. Inspect each suggestion before applying it." : "Review completed with no suggestions.");
        if (next.status === "failed") setError(next.error_message ?? "This AI review did not finish. Start a fresh review.");
      } catch { /* A transient poll failure must not erase a durable queued job. */ }
    };
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    void refresh();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, job?.id, job?.status, unconfirmed, remember]);

  const run = async () => {
    if (!chapterId || !userId || !recoveryReady || requestInFlight.current || processing || dirty || !editable || (mode === "writer" && !instruction.trim())) return;
    requestInFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    let request = pendingRequest;
    let dispatched = false;
    try {
      const digest = await reviewBriefHash(mode, instruction);
      if (request && request.briefHash !== digest) throw new Error("Re-enter the original drafting instruction exactly before retrying this request. No new request was sent.");
      if (!request) {
        request = { schema: 1, userId, bookId, chapterId, key: crypto.randomUUID(), mode, includeRelated,
          contextBudget: contextBudget as PendingReview["contextBudget"], briefHash: digest, savedAt: Date.now() };
        try { window.sessionStorage.setItem(reviewRecoveryKey(userId, bookId, chapterId), JSON.stringify(request)); }
        catch { throw new Error("Browser recovery storage is unavailable. No paid AI request was sent."); }
        setPendingRequest(request);
      } else {
        try {
          const existing = await api.getAiJobByRequest(bookId, request.key);
          if (!reviewTargetsChapter(existing, chapterId)) throw new Error("The saved request targets another chapter. No new request was sent.");
          setJob(existing); setLastAppliedVersion(null); remember(existing); setPendingRequest(null);
          try { window.sessionStorage.removeItem(reviewRecoveryKey(userId, bookId, chapterId)); } catch { /* Server job is durable. */ }
          setNotice("Recovered the saved AI review without starting another request.");
          return;
        } catch (reason) { if (!(reason instanceof ApiClientError && reason.status === 404)) throw reason; }
      }
      dispatched = true;
      const result = await api.createAiJob(pendingReviewBody(request, instruction));
      setJob(result); setLastAppliedVersion(null);
      remember(result);
      setPendingRequest(null);
      try { window.sessionStorage.removeItem(reviewRecoveryKey(userId, bookId, chapterId)); } catch { /* Server job is durable. */ }
      setNotice("Review queued. It will continue if you leave this page.");
    } catch (reason) {
      if (dispatched && reason instanceof ApiClientError && [400, 401, 403, 422].includes(reason.status)) {
        setPendingRequest(null);
        try { window.sessionStorage.removeItem(reviewRecoveryKey(userId, bookId, chapterId)); } catch { /* The server still rejected this request. */ }
      }
      setError(reason instanceof Error ? reason.message : "AI review outcome is unknown. Recover the original request before trying again.");
    }
    finally { requestInFlight.current = false; setBusy(false); }
  };

  const checkPending = async () => {
    if (!pendingRequest || busy || requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const recovered = await api.getAiJobByRequest(bookId, pendingRequest.key);
      if (!reviewTargetsChapter(recovered, chapterId)) throw new Error("The saved request targets another chapter. No new request was sent.");
      setJob(recovered); setLastAppliedVersion(null); remember(recovered); setPendingRequest(null);
      try { window.sessionStorage.removeItem(reviewRecoveryKey(pendingRequest.userId, bookId, pendingRequest.chapterId)); } catch { /* Server job is durable. */ }
      setNotice("Recovered the saved AI review without starting another request.");
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 404) setNotice("No saved job is visible yet. Retry the original request with the same settings and brief; do not start a new one.");
      else setError(reason instanceof Error ? reason.message : "Could not check the saved request. No new request was sent.");
    } finally { requestInFlight.current = false; setBusy(false); }
  };

  const restore = async (review: AiJobReview) => {
    if (processing || reviewing || dirty || !reviewTargetsChapter(review, chapterId)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.getAiJob(review.id);
      if (!reviewTargetsChapter(result, chapterId)) {
        setError("This saved review belongs to a different chapter. Select that chapter before opening it.");
        return;
      }
      setJob(result); setLastAppliedVersion(null); remember(result);
      if (modes.some((item) => item.value === result.agent_type)) setMode(result.agent_type as Mode);
      if (result.status === "failed") setError(result.error_message ?? "This AI review did not finish. Start a new review with a fresh request.");
      else if (!result.suggestions.length) setNotice("Saved review opened. It had no suggestions.");
      else setNotice("Saved review opened. Apply each suggestion only after checking it against the current chapter.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open saved AI review"); }
    finally { setBusy(false); }
  };

  const apply = async (suggestion: AiSuggestion) => {
    if (dirty || reviewing || !editable || previewAiSuggestion(suggestion, savedChapter).state !== "ready"
        || (lastAppliedVersion !== null && (savedChapter?.version ?? 0) < lastAppliedVersion)) return;
    setReviewing(suggestion.id); setError(null); setNotice(null);
    try {
      const result = await api.applySuggestion(suggestion.id);
      setJob((current) => current ? { ...current, suggestions: current.suggestions.map((item) => item.id === suggestion.id ? { ...item, status: "accepted" } : item) } : current);
      setLastAppliedVersion(result.version);
      setNotice(`Applied as manuscript version ${result.version}. Refreshing the saved chapter…`);
      try { await onApplied(); setNotice(`Applied as manuscript version ${result.version}. Other suggestions from this review may now be stale.`); }
      catch { setError(`Applied as manuscript version ${result.version}, but the editor could not refresh. Reload the chapter before another edit.`); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not apply suggestion"); }
    finally { setReviewing(null); }
  };

  const reject = async (suggestion: AiSuggestion) => {
    if (reviewing) return;
    setReviewing(suggestion.id); setError(null); setNotice(null);
    try {
      const result = await api.rejectSuggestion(suggestion.id);
      setJob((current) => current ? { ...current, suggestions: current.suggestions.map((item) => item.id === suggestion.id ? result.suggestion : item) } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not reject suggestion"); }
    finally { setReviewing(null); }
  };

  return <section aria-labelledby="ai-assistant-title" className="rounded-2xl border border-white/10 p-4">
    <h2 id="ai-assistant-title" className="text-sm font-medium">AI assistant</h2>
    <p className="mt-1 text-xs leading-5 text-white/45">Edits only the saved chapter. Drafting and consistency checks can reference matching passages and Book Bible facts. Every edit waits for your approval.</p>
    <label className="mt-4 block text-xs text-white/55" htmlFor="ai-mode">Task</label>
    <select id="ai-mode" value={mode} onChange={(event) => setMode(event.target.value as Mode)} disabled={processing || !!pendingRequest} className="mt-1 w-full rounded-lg border border-white/15 bg-black p-2 text-sm">
      {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
    <label className="mt-3 block text-xs text-white/55" htmlFor="ai-context-budget">Source context budget</label>
    <select id="ai-context-budget" value={contextBudget} onChange={(event) => setContextBudget(Number(event.target.value))} disabled={processing || !!pendingRequest} className="mt-1 w-full rounded-lg border border-white/15 bg-black p-2 text-sm">
      <option value={4096}>Compact · about 4K tokens</option><option value={8192}>Balanced · about 8K tokens</option><option value={16000}>Extended · about 16K tokens</option>
    </select>
    <p className="mt-1 text-[11px] leading-5 text-white/40">Estimated input budget, not a charge estimate. Oversized chapters are rejected, never silently cut.</p>
    {["writer", "consistency"].includes(mode) && <label className="mt-3 flex items-start gap-2 text-xs text-white/60"><input type="checkbox" checked={includeRelated} onChange={(event) => setIncludeRelated(event.target.checked)} disabled={processing || !!pendingRequest} /> Include related saved passages</label>}
    {mode === "writer" && <><label className="mt-3 block text-xs text-white/55" htmlFor="ai-instruction">Drafting instruction</label><textarea id="ai-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={4000} rows={4} placeholder="Continue this scene with…" className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-black p-2 text-sm" /></>}
    <button type="button" onClick={() => void run()} disabled={!chapterId || !recoveryReady || processing || dirty || !editable || (mode === "writer" && !instruction.trim())} className="mt-3 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-40">{processing ? job?.status === "queued" ? "Queued…" : "Running…" : pendingRequest ? "Retry original request" : "Run on saved chapter"}</button>
    {pendingRequest && <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100"><p>A previous paid request has an uncertain outcome. Its request key and settings are saved; no manuscript text is stored here. Check its server status or retry the exact original request. A new request key will not be created.</p><button type="button" disabled={busy} onClick={() => void checkPending()} className="mt-2 underline underline-offset-4 disabled:opacity-40">Check saved request · no credits</button></div>}
    {dirty && <p className="mt-2 text-xs text-amber-200">Save the chapter before running or applying AI suggestions.</p>}
    {error && <p role="alert" className="mt-3 text-xs leading-5 text-red-200">{error}</p>}
    {unconfirmed && <p role="alert" className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">The paid provider response for request {job?.id} is unconfirmed. No second generation will start automatically. Your credit remains reserved while support checks the provider result; do not start a new review for this book yet.</p>}
    {notice && <p role="status" className="mt-3 text-xs leading-5 text-emerald-200">{notice}</p>}
    {job && <p className="mt-3 text-[11px] text-white/35">{job.model ?? "provider"} · {Number((job.usage_json as { inputTokens?: number })?.inputTokens ?? 0) + Number((job.usage_json as { outputTokens?: number })?.outputTokens ?? 0)} tokens</p>}
    {recent.filter((review) => review.id !== job?.id).length > 0 && <details className="mt-4 rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <summary className="cursor-pointer text-xs font-medium text-white/75">Recent saved reviews</summary>
      <p className="mt-2 text-[11px] leading-5 text-white/40">Reviews stay with this book. Open only a review made for the chapter currently selected.</p>
      <div className="mt-3 space-y-2">
        {recent.filter((review) => review.id !== job?.id).map((review) => {
          const targetsCurrent = reviewTargetsChapter(review, chapterId);
          return <div key={review.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
            <div className="min-w-0"><p className="truncate text-xs text-white/75">{modeLabel(review.agent_type)} · {review.status}</p><p className="mt-0.5 text-[10px] text-white/35">{review.context_source_count} related saved source{review.context_source_count === 1 ? "" : "s"}</p></div>
            {targetsCurrent ? <button type="button" disabled={processing || !!reviewing || dirty} onClick={() => void restore(review)} className="shrink-0 rounded-md border border-white/15 px-2 py-1 text-[11px] disabled:opacity-40">Open</button> : <span className="shrink-0 text-[10px] text-white/30">Other chapter</span>}
          </div>;
        })}
      </div>
      {dirty && <p className="mt-3 text-[11px] text-amber-200">Save this chapter before opening a saved review.</p>}
    </details>}
    <div className="mt-4 space-y-3">
      {suggestions.map((suggestion) => {
        const preview = previewAiSuggestion(suggestion, savedChapter);
        const awaitingRefresh = lastAppliedVersion !== null && (savedChapter?.version ?? 0) < lastAppliedVersion;
        return <article key={suggestion.id} className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
          <p className="text-xs leading-5 text-white/70">{suggestion.rationale ?? "Suggested manuscript edit"}</p>
          {awaitingRefresh ? <p className="mt-3 text-xs leading-5 text-amber-200">The previous edit is saved, but this chapter has not refreshed. Reload it before reviewing another proposal.</p> : <AiProofSheet preview={preview} />}
          <p className="mt-2 text-[10px] text-white/40">{suggestion.confidence == null ? "Confidence not supplied" : `${Math.round(Number(suggestion.confidence) * 100)}% model confidence`} · Always review the wording yourself.</p>
          {suggestion.status === "pending" ? <div className="mt-3 flex gap-2"><button type="button" disabled={!!reviewing || dirty || !editable || preview.state !== "ready" || awaitingRefresh} onClick={() => void apply(suggestion)} className="rounded-md bg-white px-3 py-1.5 text-xs text-black disabled:opacity-40">Apply</button><button type="button" disabled={!!reviewing} onClick={() => void reject(suggestion)} className="rounded-md border border-white/15 px-3 py-1.5 text-xs disabled:opacity-40">Reject</button></div> : <p className="mt-3 text-xs capitalize text-white/45">{suggestion.status}</p>}
        </article>;
      })}
    </div>
  </section>;
}
