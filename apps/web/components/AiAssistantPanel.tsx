"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ApiClientError, type AiJobReview, type AiJobWithSuggestions, type AiReviewModelChoice, type AiReviewUsageQuote } from "@bookworm/api-client";
import type { AiSuggestion } from "@bookworm/types";
import { apiClient } from "./api";
import AiProofSheet from "./AiProofSheet";
import { canAcceptReviewQuote, canReplaceReviewQuote, readPendingReview, recoverReviewRequest, reviewBriefHash, reviewRecoveryKey, reviewTargetsChapter, verifiedReviewQuoteStatus, type PendingReview, type ReviewMode, type ReviewQuoteStatus } from "../lib/ai-review-recovery";
import { previewAiSuggestion, type SavedChapterPreview } from "../lib/ai-suggestion-preview";
import { readSuggestionDecision, recoverSuggestionDecision, suggestionDecisionKey, type SuggestionDecision, type RecoveredDecision } from "../lib/ai-suggestion-recovery";

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
  bookId, chapterId, savedChapter, initialJobId, initialDraftInstruction, dirty, editable, onApplied, onDecisionBusy,
}: { bookId: string; chapterId: string | null; savedChapter: SavedChapterPreview | null; initialJobId?: string; initialDraftInstruction?: string; dirty: boolean; editable: boolean; onApplied: () => Promise<void>; onDecisionBusy?: (busy: boolean) => void }) {
  const api = apiClient();
  const latest = useRef({ dirty, editable, onApplied, onDecisionBusy }); latest.current = { dirty, editable, onApplied, onDecisionBusy };
  const reviewScope = useRef({ bookId, chapterId });
  if (reviewScope.current.bookId !== bookId || reviewScope.current.chapterId !== chapterId) reviewScope.current = { bookId, chapterId };
  const [mode, setMode] = useState<Mode>("proofreader");
  const [instruction, setInstruction] = useState("");
  const [includeRelated, setIncludeRelated] = useState(true);
  const [includeBookBible, setIncludeBookBible] = useState(true);
  const [includeStyleGuide, setIncludeStyleGuide] = useState(true);
  const [contextBudget, setContextBudget] = useState(16000);
  const [job, setJob] = useState<AiJobWithSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<SuggestionDecision | null>(null);
  const [decisionCanRetry, setDecisionCanRetry] = useState(false);
  const decisionInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState<AiJobReview[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [restoreInitialReview, setRestoreInitialReview] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingReview | null>(null);
  const [models, setModels] = useState<AiReviewModelChoice[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [countingConsent, setCountingConsent] = useState(false);
  const [quote, setQuote] = useState<AiReviewUsageQuote | null>(null);
  const [quoteRequestId, setQuoteRequestId] = useState<string | null>(null);
  const [verifiedStatus, setVerifiedStatus] = useState<ReviewQuoteStatus | null>(null);
  const [quoteClock, setQuoteClock] = useState(Date.now);
  const [acceptanceUncertain, setAcceptanceUncertain] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [lastAppliedVersion, setLastAppliedVersion] = useState<number | null>(null);
  const requestInFlight = useRef(false);
  const suggestions = useMemo(() => job?.suggestions ?? [], [job]);
  const unconfirmed = job?.error_code === "ai_provider_outcome_unconfirmed";
  const processing = busy || !!reviewing || !!pendingDecision || job?.status === "queued" || job?.status === "running";

  const loadRecent = useCallback(async () => {
    const scope = reviewScope.current;
    try { const result = await api.listAiJobs(bookId); if (reviewScope.current === scope) setRecent(result.jobs); }
    catch { if (reviewScope.current === scope) setRecent([]); }
  }, [api, bookId, chapterId]);

  const remember = useCallback((next: AiJobReview) => {
    setRecent((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 8));
  }, []);

  const clearDecision = useCallback((decision: SuggestionDecision) => {
    try { window.sessionStorage.removeItem(suggestionDecisionKey(decision.userId, decision.bookId, decision.chapterId)); }
    catch { /* A retained checkpoint causes only another read on the next visit. */ }
    setPendingDecision(null); setDecisionCanRetry(false);
  }, []);

  const verifyDecisionAccount = useCallback(async (decision: SuggestionDecision) => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const session = await response.json();
    if (!response.ok || session?.user?.id !== decision.userId) throw new Error("Your account changed. Reload before recovering this decision.");
  }, []);

  const adoptDecision = useCallback(async (result: RecoveredDecision, decision: SuggestionDecision, scope: object) => {
    if (reviewScope.current !== scope) return;
    setJob(result.job); remember(result.job);
    if (result.status === "pending") {
      setDecisionCanRetry(true);
      setNotice("The saved suggestion is still pending. Retry only the original decision, or check its status again.");
      return;
    }
    if (result.status === "accepted" || result.status === "stale") {
      setLastAppliedVersion(result.version ?? decision.expectedVersion + 1);
      if (latest.current.dirty) {
        clearDecision(decision);
        setError(`${result.status === "stale" ? "The saved chapter changed." : "The suggestion is saved."} Your unsaved draft is still here. Back it up before reloading the saved chapter.`);
        return;
      }
      setNotice(result.status === "stale" ? "The saved chapter advanced. Refreshing it before another decision…" : result.version ? `Recovered manuscript version ${result.version}. Refreshing the saved chapter…` : "This suggestion was accepted by another author. Refreshing the saved chapter…");
      await latest.current.onApplied();
      if (reviewScope.current !== scope) return;
      setNotice(result.status === "stale" ? "The newer saved chapter has been refreshed. This original suggestion cannot apply to the newer version; review the current text before requesting another proposal." : result.version ? `Applied as manuscript version ${result.version}. Other suggestions from this review may now be stale.` : "The accepted suggestion and saved chapter have been refreshed.");
    } else setNotice("Recovered the saved rejection. The manuscript was not changed by Reject.");
    clearDecision(decision);
  }, [clearDecision, remember]);

  const readDecision = useCallback(async (decision: SuggestionDecision, scope: object) => {
    await verifyDecisionAccount(decision);
    const result = await recoverSuggestionDecision(api, decision);
    await verifyDecisionAccount(decision);
    if (reviewScope.current === scope) await adoptDecision(result, decision, scope);
    return result;
  }, [api, adoptDecision, verifyDecisionAccount]);

  const keepPending = useCallback((request: PendingReview) => {
    window.sessionStorage.setItem(reviewRecoveryKey(request.userId, request.bookId, request.chapterId), JSON.stringify(request));
    setPendingRequest(request);
  }, []);

  const adoptRecovery = useCallback((result: Awaited<ReturnType<typeof recoverReviewRequest>>, request: PendingReview) => {
    const storageKey = reviewRecoveryKey(request.userId, request.bookId, request.chapterId);
    if (result.job) {
      const next = result.job;
      if (["queued", "running"].includes(next.status) || next.error_code === "ai_provider_outcome_unconfirmed") {
        keepPending({ ...request, ...(result.status ? { quoteRequestId: result.status.quote.requestId } : {}), acceptAttempted: true, acceptanceRefused: undefined });
      } else {
        // Failure to clear only causes another safe server read on the next visit.
        try { window.sessionStorage.removeItem(storageKey); } catch { /* Server job remains authoritative. */ }
        setPendingRequest(null);
      }
      setJob(next); setLastAppliedVersion(null); remember(next);
      setQuote(null); setQuoteRequestId(null); setVerifiedStatus(null); setCountingConsent(false);
      setAcceptanceUncertain(next.error_code === "ai_provider_outcome_unconfirmed");
      setNotice("Recovered the saved AI review without starting another request.");
    } else if (result.status) {
      const status = result.status;
      // The server identity must be durable before its offer can be accepted.
      keepPending({ ...request, quoteRequestId: status.quote.requestId });
      setVerifiedStatus(status); setQuoteClock(Date.now());
      setQuote(status.quote.status === "ready" ? status.quote : null);
      setQuoteRequestId(status.quote.status === "counting" ? status.quote.requestId : null);
      setAcceptanceUncertain(false);
      setNotice(status.quote.status === "ready" ? "Recovered the exact saved quote. Accept only if you still want to start generation."
        : status.quote.status === "counting" ? "The saved quote is still being counted. This status check did not start another count or generation."
          : "The saved quote count failed. No generation was accepted; you may explicitly start a new quote.");
    }
  }, [keepPending, remember]);

  useEffect(() => { void loadRecent(); }, [loadRecent]);
  useEffect(() => {
    onDecisionBusy?.(!!reviewing || !!pendingDecision);
    return () => onDecisionBusy?.(false);
  }, [onDecisionBusy, reviewing, pendingDecision]);
  useEffect(() => () => { reviewScope.current = { ...reviewScope.current }; }, []);
  useEffect(() => { requestInFlight.current = false; decisionInFlight.current = false; setBusy(false); setReviewing(null); setPendingDecision(null); setDecisionCanRetry(false); setRecent([]); setJob(null); setLastAppliedVersion(null); setError(null); setNotice(null); setQuote(null); setQuoteRequestId(null); setVerifiedStatus(null); setCountingConsent(false); setAcceptanceUncertain(false); setInstruction(""); }, [bookId, chapterId]);
  useEffect(() => {
    let cancelled = false;
    setModels([]); setSelectedModelId(""); setPricingError(null);
    void api.listAiReviewModels(bookId).then((result) => {
      if (cancelled) return;
      setModels(result.models);
      setSelectedModelId((current) => current && result.models.some((item) => item.id === current) ? current : result.models[0]?.id ?? "");
    }).catch((reason) => { if (!cancelled) setPricingError(reason instanceof Error ? reason.message : "Usage-based AI pricing is unavailable."); });
    return () => { cancelled = true; };
  }, [api, bookId, modelRefresh]);
  useEffect(() => {
    if (!chapterId) return;
    let cancelled = false;
    setRecoveryReady(false); setRestoreInitialReview(false); setPendingRequest(null);
    void (async () => {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok) throw new Error("Sign in again before requesting AI review.");
      const { user } = await session.json();
      if (typeof user?.id !== "string") throw new Error("Your session could not be verified.");
      const storageKey = reviewRecoveryKey(user.id, bookId, chapterId);
      let raw: string | null, decisionRaw: string | null;
      try { raw = window.sessionStorage.getItem(storageKey); decisionRaw = window.sessionStorage.getItem(suggestionDecisionKey(user.id, bookId, chapterId)); }
      catch { throw new Error("Browser recovery storage is unavailable. AI review is paused to avoid duplicate charges."); }
      const saved = readPendingReview(raw, user.id, bookId, chapterId);
      const decision = readSuggestionDecision(decisionRaw, user.id, bookId, chapterId);
      if (decisionRaw && !decision) throw new Error("The saved suggestion decision could not be verified. Recover it before another manuscript decision.");
      if (raw && !saved) throw new Error("The saved AI recovery checkpoint is invalid or expired. No new request will be sent; contact support with this book and chapter.");
      if (cancelled) return;
      setUserId(user.id);
      if (decision) {
        setPendingDecision(decision);
        if (saved) setPendingRequest(saved);
        const scope = reviewScope.current;
        decisionInFlight.current = true; setReviewing(decision.suggestionId);
        try { await readDecision(decision, scope); }
        catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "The original decision is unconfirmed. Check saved review before retrying."); }
        finally { if (!cancelled) { decisionInFlight.current = false; setReviewing(null); } }
      } else if (saved) {
        setPendingRequest(saved); setMode(saved.mode); setIncludeRelated(saved.includeRelated); setContextBudget(saved.contextBudget);
        setIncludeBookBible(saved.includeBookBible ?? true); setIncludeStyleGuide(saved.includeStyleGuide ?? true);
        setCountingConsent(saved.allowProviderTokenCounting === true);
        if (saved.modelId) setSelectedModelId(saved.modelId);
        try {
          const recovered = await recoverReviewRequest(api, saved);
          if (cancelled) return;
          adoptRecovery(recovered, saved);
        } catch (reason) {
          if (cancelled) return;
          setAcceptanceUncertain(saved.acceptAttempted === true);
          if (reason instanceof ApiClientError && reason.status === 404 && !saved.quoteRequestId && !saved.acceptAttempted)
            setNotice("No original quote is visible yet. Retry its original brief and settings with the same request key; no new key will be used.");
          else setError(reason instanceof Error ? reason.message : "Could not verify the saved AI request. No new request was sent.");
        }
      }
      if (!cancelled) { setRestoreInitialReview(!saved && !decision); setRecoveryReady(true); }
    })().catch((reason) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : "AI request recovery is unavailable."); setRecoveryReady(false); } });
    return () => { cancelled = true; };
  }, [api, bookId, chapterId, adoptRecovery, readDecision]);
  useEffect(() => {
    if (!initialDraftInstruction || !recoveryReady || job || pendingDecision) return;
    if (pendingRequest && (pendingRequest.bookId !== bookId || pendingRequest.chapterId !== chapterId)) return;
    let cancelled = false;
    void reviewBriefHash("writer", initialDraftInstruction).then((digest) => {
      if (cancelled) return;
      if (pendingRequest) {
        if (pendingRequest.mode !== "writer") return;
        setMode("writer");
        if (pendingRequest.briefHash !== digest) {
          setNotice("This saved plan no longer matches the pending AI request. The original brief is not stored in browser recovery; re-enter it exactly before retrying. No new request key will be created.");
          return;
        }
        setNotice("Recovered the original drafting brief from the unchanged saved plan. Check the saved quote or request before continuing.");
      } else setNotice("Saved chapter plan loaded. Review or edit this brief, then request a price; no provider call or credits have started.");
      setMode("writer");
      setInstruction(initialDraftInstruction);
    }).catch(() => {
      if (!cancelled) setError("Could not verify the saved plan brief. No AI request was sent.");
    });
    return () => { cancelled = true; };
  }, [bookId, chapterId, initialDraftInstruction, job, pendingRequest, pendingDecision, recoveryReady]);
  useEffect(() => {
    if (!quoteRequestId || !pendingRequest) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await recoverReviewRequest(api, pendingRequest);
        if (cancelled) return;
        if (result.job || result.status?.quote.status !== "counting") adoptRecovery(result, pendingRequest);
      } catch { /* A transient status failure must not start another provider count. */ }
    };
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    void refresh();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, pendingRequest, quoteRequestId, adoptRecovery]);
  useEffect(() => {
    if (!quote || Date.parse(quote.expiresAt) <= quoteClock) return;
    const timer = window.setTimeout(() => setQuoteClock(Date.now()), Math.max(0, Math.min(2_147_483_647, Date.parse(quote.expiresAt) - Date.now() + 1)));
    return () => window.clearTimeout(timer);
  }, [quote, quoteClock]);
  useEffect(() => {
    // Each effect setup owns its fetch. Strict Mode may cancel and replay the
    // setup; a persistent "already opened" latch would discard both responses.
    // A URL-linked historical review must never replace a recovered paid request.
    if (!initialJobId || !chapterId || !recoveryReady || !restoreInitialReview) return;
    let cancelled = false;
    setBusy(true); setError(null); setNotice(null);
    void api.getAiJob(initialJobId).then((result) => {
      if (cancelled) return;
      if (result.id !== initialJobId || result.book_id !== bookId || !reviewTargetsChapter(result, chapterId)) { setError("This saved review belongs to a different chapter. Select that chapter before opening it."); return; }
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
  }, [api, bookId, chapterId, initialJobId, remember, recoveryReady, restoreInitialReview]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status) || unconfirmed) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.getAiJob(job.id);
        if (cancelled) return;
        if (next.id !== job.id || next.book_id !== bookId || !reviewTargetsChapter(next, chapterId)) throw new Error("Saved review scope changed.");
        if (pendingRequest && (!["queued", "running"].includes(next.status) || next.error_code === "ai_provider_outcome_unconfirmed")) {
          adoptRecovery({ status: verifiedStatus, job: next }, pendingRequest);
        }
        setJob(next); remember(next);
        if (next.error_code === "ai_provider_outcome_unconfirmed") setNotice(null);
        if (next.status === "succeeded") setNotice(next.suggestions.length ? "Review complete. Inspect each suggestion before applying it." : "Review completed with no suggestions.");
        if (next.status === "failed") setError(next.error_message ?? "This AI review did not finish. Start a fresh review.");
      } catch { /* A transient poll failure must not erase a durable queued job. */ }
    };
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    void refresh();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, bookId, chapterId, job?.id, job?.status, unconfirmed, remember, pendingRequest, verifiedStatus, adoptRecovery]);

  const run = async () => {
    if (!chapterId || !userId || !recoveryReady || !selectedModelId || !models.length || unconfirmed || acceptanceUncertain || quote || quoteRequestId || verifiedStatus || (!countingConsent && pendingRequest?.allowProviderTokenCounting !== true) || requestInFlight.current || processing || dirty || !editable || (mode === "writer" && !instruction.trim())) return;
    const scope = reviewScope.current;
    requestInFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    let request = pendingRequest;
    try {
      const digest = await reviewBriefHash(mode, instruction);
      if (reviewScope.current !== scope) return;
      if (request && request.briefHash !== digest) throw new Error("Re-enter the original drafting instruction exactly before retrying this request. No new request was sent.");
      if (!request) {
        request = { schema: 1, userId, bookId, chapterId, key: crypto.randomUUID(), modelId: selectedModelId, model: models.find(item => item.id === selectedModelId)?.model,
          allowProviderTokenCounting: true, mode, includeRelated,
          includeBookBible, includeStyleGuide,
          contextBudget: contextBudget as PendingReview["contextBudget"], briefHash: digest, savedAt: Date.now() };
        try { window.sessionStorage.setItem(reviewRecoveryKey(userId, bookId, chapterId), JSON.stringify(request)); }
        catch { throw new Error("Browser recovery storage is unavailable. No paid AI request was sent."); }
        setPendingRequest(request);
      } else {
        if (countingConsent && request.allowProviderTokenCounting !== true) {
          request = { ...request, allowProviderTokenCounting: true };
          try { window.sessionStorage.setItem(reviewRecoveryKey(userId, bookId, chapterId), JSON.stringify(request)); }
          catch { throw new Error("Browser recovery storage is unavailable. No provider token count was sent."); }
          setPendingRequest(request);
        }
        try {
          const existing = await recoverReviewRequest(api, request);
          if (reviewScope.current !== scope) return;
          adoptRecovery(existing, request);
          return;
        } catch (reason) { if (!(reason instanceof ApiClientError && reason.status === 404) || request.quoteRequestId || request.acceptAttempted) throw reason; }
      }
      if (reviewScope.current !== scope) return;
      setJob(null); setVerifiedStatus(null);
      const result = await api.createAiReviewQuote(bookId, {
        modelId: request.modelId ?? selectedModelId, agentType: request.mode, chapterIds: [request.chapterId],
        ...(request.mode === "writer" ? { userInstruction: instruction.trim() } : {}), idempotencyKey: request.key,
        contextPolicy: { includeBookBible: request.includeBookBible ?? true, includeStyleGuide: request.includeStyleGuide ?? true,
          includeRelatedContext: request.includeRelated,
          semanticTopK: 5, maxTokens: request.contextBudget },
        allowProviderTokenCounting: true,
      });
      if (reviewScope.current !== scope) return;
      if (result.quote && result.request || !result.quote && result.request?.status !== "counting") throw new Error("The quote request returned no verifiable status.");
      const status = verifiedReviewQuoteStatus({ quote: result.quote ?? { requestId: result.request!.id, status: "counting" } }, request);
      adoptRecovery({ status, job: null }, request);
      setNotice(status.quote.status === "ready" ? "Exact usage quote is ready. Review the credit total, then accept to start generation."
        : "Counting the selected saved text for an exact quote. No generation job or credit hold has started.");
    } catch (reason) {
      if (reviewScope.current !== scope) return;
      setError(reason instanceof Error ? reason.message : "AI review outcome is unknown. Recover the original request before trying again.");
    }
    finally { if (reviewScope.current === scope) { requestInFlight.current = false; setBusy(false); } }
  };

  const acceptQuote = async () => {
    if (!quote || !pendingRequest || requestInFlight.current || !canAcceptReviewQuote(quote, { pending: pendingRequest, bookId, chapterId, editable, dirty, recoveryReady, busy: processing, acceptanceUncertain })) return;
    const scope = reviewScope.current;
    let request = pendingRequest;
    let dispatched = false, acceptedReply = false;
    setAcceptanceUncertain(true);
    setVerifiedStatus(null);
    requestInFlight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const attempted = { ...pendingRequest, acceptAttempted: true as const };
      try { keepPending(attempted); request = attempted; }
      catch { throw new Error("Browser recovery storage is unavailable. No paid generation was requested."); }
      dispatched = true;
      const accepted = await api.acceptAiReviewQuote(bookId, quote.requestId, quote.reservedCredits);
      acceptedReply = true;
      if (reviewScope.current !== scope) return;
      const result = await recoverReviewRequest(api, request);
      if (reviewScope.current !== scope) return;
      if (!result.job || result.job.id !== accepted.jobId) throw new Error("The accepted review could not be confirmed. Recover this same request.");
      adoptRecovery(result, request); setCountingConsent(false);
      setNotice("Review accepted and queued. It will continue if you leave this page.");
    } catch (reason) {
      if (reviewScope.current !== scope) return;
      try {
        const result = await recoverReviewRequest(api, request);
        if (reviewScope.current !== scope) return;
        if (!result.job && dispatched && !acceptedReply && !pendingRequest.acceptAttempted
            && reason instanceof ApiClientError && [400, 401, 402, 403, 409, 422].includes(reason.status)) {
          // Only a definite first refusal may release this local attempt marker.
          request = { ...request, acceptAttempted: undefined, acceptanceRefused: true };
        }
        adoptRecovery(result, request);
        if (result.job) {
          setCountingConsent(false);
          setNotice("Recovered the accepted review after an uncertain reply. No second charge was made.");
        } else {
          setError(request.acceptanceRefused ? "Acceptance was refused and no job is currently recorded. Resolve credits, permissions or changed source, then start a new quote."
            : "No accepted job is currently recorded. Keep this original request; only an explicit retry of this same quote is allowed.");
        }
      } catch (recoveryError) {
        if (reviewScope.current === scope) setError(recoveryError instanceof Error ? `${recoveryError.message} Acceptance remains locked; recover saved status before any retry.` : "Acceptance and recovery are unconfirmed. Keep this quote and contact support; do not create another request.");
      }
    } finally { if (reviewScope.current === scope) { requestInFlight.current = false; setBusy(false); } }
  };

  const checkPending = async () => {
    if (!pendingRequest || busy || requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    const scope = reviewScope.current;
    setVerifiedStatus(null);
    try {
      const recovered = await recoverReviewRequest(api, pendingRequest);
      if (reviewScope.current !== scope) return;
      adoptRecovery(recovered, pendingRequest);
    } catch (reason) {
      if (reviewScope.current !== scope) return;
      setQuote(null); setQuoteRequestId(null); setAcceptanceUncertain(pendingRequest.acceptAttempted === true);
      if (reason instanceof ApiClientError && reason.status === 404 && !pendingRequest.quoteRequestId && !pendingRequest.acceptAttempted)
        setNotice("No original quote is visible yet. Retry the original request with the same settings and brief; do not start a new one.");
      else setError(reason instanceof Error ? reason.message : "Could not check the saved request. No new request was sent.");
    } finally { if (reviewScope.current === scope) { requestInFlight.current = false; setBusy(false); } }
  };

  const startNewQuote = async () => {
    if (!pendingRequest || processing || requestInFlight.current || !canReplaceReviewQuote(verifiedStatus, pendingRequest)
        || !window.confirm("Start a new quote? The old server request is retained. A new quote needs separate counting consent and price acceptance.")) return;
    const scope = reviewScope.current;
    requestInFlight.current = true; setBusy(true); setError(null);
    try {
      const recovered = await recoverReviewRequest(api, pendingRequest);
      if (reviewScope.current !== scope) return;
      adoptRecovery(recovered, pendingRequest);
      if (!canReplaceReviewQuote(recovered.status, pendingRequest)) return;
      window.sessionStorage.removeItem(reviewRecoveryKey(pendingRequest.userId, bookId, pendingRequest.chapterId));
      setPendingRequest(null); setVerifiedStatus(null); setQuote(null); setQuoteRequestId(null);
      setAcceptanceUncertain(false); setCountingConsent(false);
      setNotice("Ready for a new quote. No token count, credit hold or generation has started.");
    } catch (reason) {
      if (reviewScope.current === scope) setError(reason instanceof Error ? reason.message : "The original quote could not be resolved. Its recovery record was kept.");
    } finally { if (reviewScope.current === scope) { requestInFlight.current = false; setBusy(false); } }
  };

  const restore = async (review: AiJobReview) => {
    if (processing || reviewing || dirty || pendingRequest || !reviewTargetsChapter(review, chapterId)) return;
    const scope = reviewScope.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.getAiJob(review.id);
      if (reviewScope.current !== scope) return;
      if (!reviewTargetsChapter(result, chapterId)) {
        setError("This saved review belongs to a different chapter. Select that chapter before opening it.");
        return;
      }
      setJob(result); setLastAppliedVersion(null); remember(result);
      if (modes.some((item) => item.value === result.agent_type)) setMode(result.agent_type as Mode);
      if (result.status === "failed") setError(result.error_message ?? "This AI review did not finish. Start a new review with a fresh request.");
      else if (!result.suggestions.length) setNotice("Saved review opened. It had no suggestions.");
      else setNotice("Saved review opened. Apply each suggestion only after checking it against the current chapter.");
    } catch (reason) { if (reviewScope.current === scope) setError(reason instanceof Error ? reason.message : "Could not open saved AI review"); }
    finally { if (reviewScope.current === scope) setBusy(false); }
  };

  const decide = async (action: SuggestionDecision["action"], suggestion: AiSuggestion, retry = false) => {
    if (!job || !chapterId || !userId || !recoveryReady || decisionInFlight.current || reviewing || busy || !editable
      || (pendingDecision && (!retry || pendingDecision.action !== action || pendingDecision.suggestionId !== suggestion.id))
      || (action === "apply" && (dirty || !retry && previewAiSuggestion(suggestion, savedChapter).state !== "ready"
        || lastAppliedVersion !== null && (savedChapter?.version ?? 0) < lastAppliedVersion))) return;
    const operation = suggestion.operation_json;
    const version = operation && typeof operation === "object" && !Array.isArray(operation) ? operation.expectedVersion : null;
    if (!Number.isSafeInteger(version) || Number(version) < 0) { setError("The original suggestion version could not be verified."); return; }
    const decision: SuggestionDecision = pendingDecision ?? { schema: 1, userId, bookId, chapterId, jobId: job.id,
      suggestionId: suggestion.id, action, expectedVersion: Number(version) };
    const scope = reviewScope.current, earlierAttempt = !!pendingDecision;
    let dispatched = false;
    decisionInFlight.current = true; setReviewing(suggestion.id); latest.current.onDecisionBusy?.(true);
    setDecisionCanRetry(false); setError(null); setNotice(null);
    try {
      await verifyDecisionAccount(decision);
      if (reviewScope.current !== scope || !latest.current.editable || action === "apply" && latest.current.dirty) return;
      if (retry) {
        const current = await readDecision(decision, scope);
        if (reviewScope.current !== scope || current.status !== "pending") return;
      }
      if (!latest.current.editable || action === "apply" && latest.current.dirty) return;
      window.sessionStorage.setItem(suggestionDecisionKey(userId, bookId, chapterId), JSON.stringify(decision));
      setPendingDecision(decision);
      dispatched = true;
      let reviewed: AiSuggestion;
      let appliedVersion: number | null = null;
      if (action === "apply") {
        const result = await api.applySuggestion(suggestion.id);
        if (result.version !== decision.expectedVersion + 1 || result.suggestionId !== undefined && result.suggestionId !== suggestion.id)
          throw new Error("The Apply reply could not be verified. Checking the saved decision.");
        appliedVersion = result.version; reviewed = { ...suggestion, status: "accepted" };
      } else {
        const result = await api.rejectSuggestion(suggestion.id);
        if (result.suggestion?.id !== suggestion.id || result.suggestion.status !== "rejected") throw new Error("The Reject reply could not be verified. Checking the saved decision.");
        reviewed = { ...suggestion, ...result.suggestion };
      }
      if (reviewScope.current !== scope) return;
      await verifyDecisionAccount(decision);
      await adoptDecision({ job: { ...job, suggestions: job.suggestions.map(item => item.id === suggestion.id ? reviewed : item) },
        status: reviewed.status as "accepted" | "rejected", version: appliedVersion }, decision, scope);
    } catch (reason) {
      if (reviewScope.current !== scope) return;
      setError(reason instanceof Error ? reason.message : "The review decision could not be confirmed.");
      if (dispatched) {
        try {
          const recovered = await readDecision(decision, scope);
          if (reviewScope.current !== scope) return;
          if (recovered.status !== "pending") setError(null);
          else if (!earlierAttempt && reason instanceof ApiClientError && [400, 401, 403, 404, 409, 422].includes(reason.status)) {
            clearDecision(decision);
            setNotice("The action was refused. The saved suggestion is still pending.");
            if (action === "apply" && !latest.current.dirty) {
              try { await latest.current.onApplied(); }
              catch { if (reviewScope.current === scope) setError("The action was refused, but the saved chapter could not refresh. Reload it before another decision."); }
            }
          }
        } catch (recoveryError) {
          if (reviewScope.current === scope) setError(`${recoveryError instanceof Error ? recoveryError.message : "Recovery is unavailable."} The original decision is retained. Check saved review before another decision.`);
        }
      }
    } finally { if (reviewScope.current === scope) { decisionInFlight.current = false; setReviewing(null); } }
  };

  const checkDecision = async () => {
    if (!pendingDecision || decisionInFlight.current) return;
    const scope = reviewScope.current;
    decisionInFlight.current = true; setReviewing(pendingDecision.suggestionId); setDecisionCanRetry(false); setError(null);
    try { await readDecision(pendingDecision, scope); }
    catch (reason) { if (reviewScope.current === scope) setError(reason instanceof Error ? reason.message : "Could not check the saved review."); }
    finally { if (reviewScope.current === scope) { decisionInFlight.current = false; setReviewing(null); } }
  };

  const consentSources = ["the selected saved chapter", ...(mode === "writer" ? ["your drafting instruction"] : []),
    ...(includeBookBible ? ["saved Book Bible entries"] : []), ...(includeStyleGuide ? ["the saved style guide"] : []),
    ...(includeRelated ? ["related saved passages where supported"] : [])].join(", ");

  return <section aria-labelledby="ai-assistant-title" className="rounded-2xl border border-white/10 p-4">
    <h2 id="ai-assistant-title" className="text-sm font-medium">AI assistant</h2>
    <Link href={`/books/${bookId}/ai`} className="mt-2 inline-block text-xs underline underline-offset-4">Use your own AI connection ↗</Link>
    <p className="mt-1 text-xs leading-5 text-white/45">Saved Book Bible canon and style guide are optional quote sources. Every edit waits for your approval.</p>
    <label className="mt-4 block text-xs text-white/55" htmlFor="ai-mode">Task</label>
    <select id="ai-mode" value={mode} onChange={(event) => setMode(event.target.value as Mode)} disabled={processing || !!pendingRequest} className="mt-1 w-full rounded-lg border border-white/15 bg-black p-2 text-sm">
      {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
    <label className="mt-3 block text-xs text-white/55" htmlFor="ai-model">Usage-priced model</label>
    <select id="ai-model" value={selectedModelId} onChange={(event) => { setSelectedModelId(event.target.value); setQuote(null); }} disabled={processing || !!pendingRequest || !models.length} className="mt-1 w-full rounded-lg border border-white/15 bg-black p-2 text-sm">
      {models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>) : <option value="">No approved model available</option>}
    </select>
    {pricingError && <p role="status" className="mt-2 text-xs leading-5 text-amber-200">Paid AI review is unavailable: {pricingError} No free generation fallback is offered.</p>}
    {!pendingRequest && (pricingError || !models.length) && <button type="button" disabled={processing} onClick={() => setModelRefresh(value => value + 1)} className="mt-2 text-xs underline underline-offset-4">Reload approved models</button>}
    <label className="mt-3 block text-xs text-white/55" htmlFor="ai-context-budget">Source context budget</label>
    <select id="ai-context-budget" value={contextBudget} onChange={(event) => setContextBudget(Number(event.target.value))} disabled={processing || !!pendingRequest} className="mt-1 w-full rounded-lg border border-white/15 bg-black p-2 text-sm">
      <option value={4096}>Compact · about 4K tokens</option><option value={8192}>Balanced · about 8K tokens</option><option value={16000}>Extended · about 16K tokens</option>
    </select>
    <p className="mt-1 text-[11px] leading-5 text-white/40">Estimated input budget, not a charge estimate. Oversized chapters are rejected, never silently cut.</p>
    <fieldset disabled={processing || !!pendingRequest} className="mt-3 space-y-2 rounded-xl border border-white/10 p-3 disabled:opacity-60">
      <legend className="px-1 text-xs text-white/55">Optional saved context</legend>
      <label className="flex items-start gap-2 text-xs leading-5 text-white/60"><input type="checkbox" checked={includeBookBible} onChange={(event) => setIncludeBookBible(event.target.checked)} />Include saved Book Bible canon</label>
      <label className="flex items-start gap-2 text-xs leading-5 text-white/60"><input type="checkbox" checked={includeStyleGuide} onChange={(event) => setIncludeStyleGuide(event.target.checked)} />Include saved style guide</label>
    </fieldset>
    {["writer", "consistency"].includes(mode) && <label className="mt-3 flex items-start gap-2 text-xs text-white/60"><input type="checkbox" checked={includeRelated} onChange={(event) => setIncludeRelated(event.target.checked)} disabled={processing || !!pendingRequest} /> Include related saved passages</label>}
    <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-white/60"><input type="checkbox" checked={countingConsent || pendingRequest?.allowProviderTokenCounting === true} onChange={(event) => setCountingConsent(event.target.checked)} disabled={processing || pendingRequest?.allowProviderTokenCounting === true} /><span>I agree to send {consentSources} to OpenAI for token counting so Bookworm can calculate the exact quote. This does not generate content or reserve credits.</span></label>
    {mode === "writer" && <><label className="mt-3 block text-xs text-white/55" htmlFor="ai-instruction">Drafting instruction</label><textarea id="ai-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={processing || !!quote || !!quoteRequestId || acceptanceUncertain} maxLength={4000} rows={4} placeholder="Continue this scene with…" className="mt-1 w-full resize-y rounded-lg border border-white/15 bg-black p-2 text-sm disabled:opacity-60" /></>}
    <button type="button" onClick={() => void run()} disabled={!chapterId || !recoveryReady || !models.length || !selectedModelId || unconfirmed || acceptanceUncertain || (!countingConsent && pendingRequest?.allowProviderTokenCounting !== true) || processing || dirty || !editable || !!verifiedStatus || !!quoteRequestId || !!quote || (mode === "writer" && !instruction.trim())} className="mt-3 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-40">{busy ? "Preparing quote…" : quoteRequestId ? "Counting saved text…" : pendingRequest ? "Recover original quote" : "Prepare usage quote"}</button>
    {quote && pendingRequest && <div className="mt-3 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.06] p-3 text-xs leading-5 text-emerald-50"><p className="font-medium">Exact usage quote · {quote.model}</p><p className="mt-1 text-white/65">{quote.countedInputTokens.toLocaleString()} input tokens counted · up to {quote.maxOutputTokens.toLocaleString()} output tokens</p><p className="mt-2 text-lg font-semibold">{quote.reservedCredits.toLocaleString()} credits on acceptance</p><p className="text-[11px] text-white/45">Expires {new Date(quote.expiresAt).toLocaleString()}. Acceptance starts generation and reserves this exact maximum; results still require your review.</p><button type="button" disabled={!canAcceptReviewQuote(quote, { pending: pendingRequest, bookId, chapterId, editable, dirty, recoveryReady, busy: processing, acceptanceUncertain })} onClick={() => void acceptQuote()} className="mt-3 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-40">{busy ? "Accepting…" : `Accept · ${quote.reservedCredits.toLocaleString()} credits`}</button></div>}
    {acceptanceUncertain && <div className="mt-3 text-xs leading-5 text-amber-100"><p role="status">Acceptance is unconfirmed. Read saved status before another decision.</p><button type="button" disabled={busy} onClick={() => void checkPending()} className="mt-2 rounded-md border border-white/15 px-3 py-2">Recover acceptance status</button></div>}
    {pendingRequest && !acceptanceUncertain && <button type="button" disabled={busy} onClick={() => void checkPending()} className="mt-3 text-xs underline underline-offset-4 disabled:opacity-40">Check saved request · read only</button>}
    {pendingRequest && !quote && !quoteRequestId && <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100"><p>A previous request is saved for recovery. Only its ID, settings and instruction digest are stored in this tab; manuscript text is not. Check saved status without re-entering the brief or sending it to OpenAI. No new request key will be created.</p></div>}
    {quote && Date.parse(quote.expiresAt) <= quoteClock && <p role="status" className="mt-3 text-xs leading-5 text-amber-100">{pendingRequest?.acceptAttempted ? "This quote expired after an acceptance attempt. Keep its recovery record and check saved status; do not start a duplicate request." : "This quote has expired. Check its saved status before requesting a fresh price."}</p>}
    {canReplaceReviewQuote(verifiedStatus, pendingRequest, quoteClock) && <button type="button" disabled={processing} onClick={() => void startNewQuote()} className="mt-3 w-full rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40">Start a new quote</button>}
    {dirty && <p className="mt-2 text-xs text-amber-200">Save the chapter before running or applying AI suggestions.</p>}
    {pendingDecision && <div role="status" className="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-5 text-amber-100">
      <p>The original {pendingDecision.action === "apply" ? "Apply" : "Reject"} decision is saved for recovery. Editing is paused while its outcome is checked.</p>
      <button type="button" disabled={!!reviewing} onClick={() => void checkDecision()} className="mt-3 min-h-11 rounded-lg border border-white/20 px-3 py-2 disabled:opacity-40">Check saved review</button>
      {decisionCanRetry && <button type="button" disabled={!!reviewing || !editable || pendingDecision.action === "apply" && (dirty || suggestions.find(item => item.id === pendingDecision.suggestionId) == null)} onClick={() => {
        const suggestion = suggestions.find(item => item.id === pendingDecision.suggestionId);
        if (suggestion) void decide(pendingDecision.action, suggestion, true);
      }} className="mt-2 min-h-11 rounded-lg border border-white/20 px-3 py-2 disabled:opacity-40">Retry original {pendingDecision.action === "apply" ? "Apply" : "Reject"}</button>}
    </div>}
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
            {targetsCurrent ? <button type="button" disabled={processing || !!reviewing || dirty || !!pendingRequest} onClick={() => void restore(review)} className="shrink-0 rounded-md border border-white/15 px-2 py-1 text-[11px] disabled:opacity-40">Open</button> : <span className="shrink-0 text-[10px] text-white/30">Other chapter</span>}
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
          {suggestion.status === "pending" ? <div className="mt-3 flex gap-2"><button type="button" disabled={!recoveryReady || !!reviewing || !!pendingDecision || dirty || !editable || preview.state !== "ready" || awaitingRefresh} onClick={() => void decide("apply", suggestion)} className="rounded-md bg-white px-3 py-1.5 text-xs text-black disabled:opacity-40">Apply</button><button type="button" disabled={!recoveryReady || !!reviewing || !!pendingDecision || !editable} onClick={() => void decide("reject", suggestion)} className="rounded-md border border-white/15 px-3 py-1.5 text-xs disabled:opacity-40">Reject</button></div> : <p className="mt-3 text-xs capitalize text-white/45">{suggestion.status}</p>}
        </article>;
      })}
    </div>
  </section>;
}
