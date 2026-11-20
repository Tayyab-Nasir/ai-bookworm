"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StoryBlueprint,
  StoryBlueprintCandidate,
  StoryBlueprintModelChoice,
  StoryBlueprintProposalResult,
  StoryBlueprintQuote,
  StoryBlueprintQuoteHistoryCursor,
  StoryBlueprintQuoteHistoryEntry,
  StoryBlueprintQuotePreparation,
  StoryBlueprintQuoteRequest,
} from "@bookworm/api-client";
import { apiClient } from "./api";
import type { StoryBlueprintGuard } from "./StoryBlueprintClient";
import { clearBlueprintRecovery, readBlueprintRecovery, writeBlueprintRecovery, type BlueprintRecovery } from "../lib/story-blueprint-recovery";
export { storyBlueprintProposalSessionKey } from "../lib/story-blueprint-recovery";

const button = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-white/85 outline-none transition duration-200 hover:border-white/45 hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-45";
const primary = "inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black outline-none transition duration-200 hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-45";
const input = "mt-2 min-h-11 w-full rounded-xl border border-white/15 bg-black/35 px-3.5 py-2.5 text-sm text-white outline-none transition duration-200 focus:border-white/50 focus:ring-2 focus:ring-white/15 disabled:cursor-not-allowed disabled:opacity-55";

// The key intentionally contains only the book, saved revision, and model. It
// never carries planning text, price information, or a provider request body.
export function storyBlueprintQuoteIntentKey(bookId: string, revision: number, modelId: string) {
  return `story-blueprint-quote:${bookId}:${revision}:${modelId}`;
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString() : "Unavailable";
}

function verifiedHistory(value: { proposals: StoryBlueprintQuoteHistoryEntry[]; nextCursor: StoryBlueprintQuoteHistoryCursor | null }) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
  if (!value || !Array.isArray(value.proposals) || value.proposals.length > 20 || value.proposals.some(item =>
    !item || typeof item.id !== "string" || !uuid.test(item.id) || typeof item.model !== "string" || item.model.length > 200
    || !Number.isInteger(item.sourceRevision) || item.sourceRevision < 1 || !Number.isInteger(item.reservedCredits) || item.reservedCredits < 1
    || !["ready", "expired", "accepted"].includes(item.status) || !Number.isFinite(Date.parse(item.createdAt)))) {
    throw new Error("Saved Story Blueprint proposals could not be verified.");
  }
  if (new Set(value.proposals.map(item => item.id)).size !== value.proposals.length) throw new Error("Saved Story Blueprint proposals could not be verified.");
  if (value.nextCursor !== null && (!value.nextCursor || typeof value.nextCursor.id !== "string" || !uuid.test(value.nextCursor.id)
    || !Number.isFinite(Date.parse(value.nextCursor.createdAt)))) throw new Error("The proposal history cursor could not be verified.");
  return value;
}

export function isStoryBlueprintQuoteExpired(quote: StoryBlueprintQuote) {
  return quote.status !== "accepted" && (quote.status === "expired" || Date.parse(quote.expiresAt) <= Date.now());
}

const isExpired = isStoryBlueprintQuoteExpired;

function storyFields(story: StoryBlueprintCandidate["story"]) {
  return [
    ["Working title", story.workingTitle], ["Genre", story.genre], ["Tone", story.tone],
    ["Point of view", story.pointOfView], ["Tense", story.tense],
    ["Reader promise", story.readerPromise], ["Premise", story.premise], ["Synopsis", story.synopsis],
    ["Theme", story.theme], ["Planning notes", story.notes],
  ].filter(([, value]) => Boolean(value.trim()));
}

export default function StoryBlueprintProposalPanel({
  bookId, actor, guard, available, blueprint, editable, blocked, onApplied,
}: {
  bookId: string;
  actor: string;
  guard: StoryBlueprintGuard;
  available: boolean;
  blueprint: StoryBlueprint | null;
  editable: boolean;
  /** Parent edits, save conflicts, or loading block paid and apply actions. */
  blocked: boolean;
  onApplied: () => Promise<void> | void;
}) {
  const api = apiClient(actor);
  const [models, setModels] = useState<StoryBlueprintModelChoice[]>([]);
  const [modelId, setModelId] = useState("");
  const [consent, setConsent] = useState(false);
  const [quote, setQuote] = useState<StoryBlueprintQuote | null>(null);
  const [quoteRequest, setQuoteRequest] = useState<StoryBlueprintQuoteRequest | null>(null);
  const [recoveryTarget, setRecoveryTarget] = useState<BlueprintRecovery | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [acceptanceUncertain, setAcceptanceUncertain] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<StoryBlueprintQuoteHistoryEntry[]>([]);
  const [historyCursor, setHistoryCursor] = useState<StoryBlueprintQuoteHistoryCursor | null>(null);
  const [candidate, setCandidate] = useState<StoryBlueprintCandidate | null>(null);
  const [reviewStatus, setReviewStatus] = useState<NonNullable<StoryBlueprintProposalResult["reviewStatus"]>>("pending");
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const lastRevision = useRef<number | null>(null);
  const lock = useRef(false);

  const currentRevision = blueprint?.revision ?? null;
  const currentQuote = Boolean(quote && currentRevision !== null && quote.sourceRevision === currentRevision);
  const quotePreparing = quoteRequest?.status === "queued" || quoteRequest?.status === "counting";
  const quoteRequestId = quoteRequest?.id;
  const recoveringSavedQuote = recoveryTarget !== null;
  const hasPendingAcceptedProposal = quote?.status === "accepted" && !candidate;
  const canRequestQuote = editable && Boolean(blueprint) && !blocked && !loadingModels
    && recoveryChecked && !acceptanceUncertain && !quotePreparing && !recoveringSavedQuote && !hasPendingAcceptedProposal && !quote;
  const canApply = editable && Boolean(blueprint) && Boolean(quote) && Boolean(candidate)
    && currentQuote && !blocked && available && recoveryChecked && !acceptanceUncertain;
  const canLeaveReview = Boolean(quote?.status === "accepted" && (candidate || reviewStatus === "failed"));
  const canOpenHistory = available && recoveryChecked && !acceptanceUncertain && !quotePreparing
    && !recoveringSavedQuote && (!quote || canLeaveReview);

  useEffect(() => {
    if (!quote || quote.status === "accepted") return;
    const remaining = Date.parse(quote.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(remaining + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [quote?.expiresAt, quote?.status]);

  const writePointer = useCallback((pointer: BlueprintRecovery) => {
    const saved = readBlueprintRecovery(bookId, actor);
    if (saved?.legacy) throw new Error("An older Story Blueprint request needs recovery first.");
    writeBlueprintRecovery(bookId, actor, pointer, saved?.raw ?? null);
  }, [actor, bookId]);

  const clearPointer = useCallback(() => {
    const saved = readBlueprintRecovery(bookId, actor);
    if (saved?.legacy) throw new Error("An older Story Blueprint request needs recovery first.");
    if (saved) clearBlueprintRecovery(bookId, actor, saved.raw);
  }, [actor, bookId]);

  const setProposal = useCallback((next: StoryBlueprintProposalResult) => {
    if (!next.proposal || !["ready", "expired", "accepted"].includes(next.proposal.status)) throw new Error("The saved Story Blueprint quote could not be verified.");
    const saved = readBlueprintRecovery(bookId, actor);
    const pending = Boolean(saved && "proposalId" in saved.pointer && saved.pointer.proposalId === next.proposal.id
      && saved.pointer.acceptancePending && next.proposal.status !== "accepted");
    writePointer({ proposalId: next.proposal.id, ...(pending ? { acceptancePending: true } : {}) });
    setQuote(next.proposal);
    setQuoteRequest(null);
    setRecoveryTarget(null);
    setCandidate(next.candidate);
    setReviewStatus(next.reviewStatus ?? (next.candidate ? "ready" : "pending"));
    setAcceptanceUncertain(pending);
  }, [actor, bookId, writePointer]);

  const setQuotePreparation = useCallback((next: StoryBlueprintQuotePreparation) => {
    if (!next.request || !["queued", "counting", "ready", "failed"].includes(next.request.status)
      || (next.proposal && next.proposal.requestId !== next.request.id)) {
      throw new Error("The saved Story Blueprint quote request could not be verified.");
    }
    if (next.proposal) {
      setProposal({ proposal: next.proposal, candidate: null });
      return;
    }
    if (next.request.status === "failed") {
      clearPointer();
      setQuote(null);
      setCandidate(null);
      setRecoveryTarget(null);
      setQuoteRequest(null);
      setConsent(false);
      setError("The token count could not be confirmed. No credits were held. Consent again to prepare a new quote.");
      return;
    }
    writePointer({ requestId: next.request.id });
    setQuote(null);
    setCandidate(null);
    if (next.request.status === "ready") {
      setQuoteRequest(null);
      setRecoveryTarget({ requestId: next.request.id });
      setError("The saved quote is not available yet. Refresh its status before starting another request.");
      return;
    }
    setRecoveryTarget(null);
    setQuoteRequest(next.request);
  }, [clearPointer, setProposal, writePointer]);

  const run = useCallback(async (action: () => Promise<void>, fallback: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (reason) { setError(messageOf(reason, fallback)); }
    finally { lock.current = false; setBusy(false); }
  }, []);

  useEffect(() => {
    if (lastRevision.current !== null && lastRevision.current !== currentRevision) {
      // New saved source needs fresh, visible consent before it can be counted.
      setConsent(false);
    }
    lastRevision.current = currentRevision;
  }, [currentRevision]);

  useEffect(() => {
    let active = true;
    if (!blueprint || !available) {
      setModels([]);
      setModelId("");
      setConsent(false);
      return () => { active = false; };
    }
    setLoadingModels(true);
    setCatalogError(null);
    void guard(() => api.listStoryBlueprintModels(bookId))
      .then((result) => {
        if (!active) return;
        setModels(result.models);
        setModelId((current) => result.models.some((model) => model.id === current) ? current : (result.models[0]?.id ?? ""));
      })
      .catch(() => {
        if (active) setCatalogError("Paid Story Blueprint proposals are not configured for purchase right now. No AI proposal can start from this page.");
      })
      .finally(() => { if (active) setLoadingModels(false); });
    return () => { active = false; };
  }, [api, available, bookId, Boolean(blueprint), guard]);

  const recoverSaved = useCallback(async () => {
    const saved = readBlueprintRecovery(bookId, actor);
    if (!saved) { setRecoveryTarget(null); setRecoveryChecked(true); return; }
    setRecoveryTarget(saved.pointer);
    if ("proposalId" in saved.pointer && saved.pointer.acceptancePending) setAcceptanceUncertain(true);
    const pointer = saved.pointer;
    const result = "proposalId" in pointer
      ? await guard(() => api.getStoryBlueprintProposal(bookId, pointer.proposalId))
      : "requestId" in pointer
        ? await guard(() => api.getStoryBlueprintQuoteRequest(bookId, pointer.requestId))
        : await guard(() => api.recoverStoryBlueprintQuoteRequest(bookId, pointer.idempotencyKey));
    if (!("candidate" in result) && !result.request) {
      // A delayed original POST may still arrive. Absence is not a cancellation.
      setRecoveryChecked(true);
      setNotice("The original quote request is not visible yet. Refresh its status; do not start another count while it may still arrive.");
      return;
    }
    if (saved.legacy) writeBlueprintRecovery(bookId, actor, pointer, null, saved.raw);
    if ("candidate" in result) setProposal(result);
    else setQuotePreparation(result as StoryBlueprintQuotePreparation);
    setRecoveryChecked(true);
  }, [actor, api, bookId, guard, setProposal, setQuotePreparation]);

  useEffect(() => {
    let active = true;
    if (!blueprint || !available) return () => { active = false; };
    setRecoveryChecked(false);
    void recoverSaved().catch(() => {
      if (active) setError("Could not verify the saved quote checkpoint. Refresh its status before preparing another; the previous request may still be active.");
    });
    return () => { active = false; };
  }, [available, Boolean(blueprint), recoverSaved]);

  useEffect(() => {
    if (!quoteRequestId || !quotePreparing || !blueprint || !available) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await guard(() => api.getStoryBlueprintQuoteRequest(bookId, quoteRequestId));
        if (!active) return;
        if (result.proposal) setQuotePreparation(result);
        else if (result.request.status === "failed") setQuotePreparation(result);
        else setQuoteRequest(result.request);
      } catch {
        // Keep the durable pointer: a transient read failure must not create a
        // second token-count request or misrepresent its provider outcome.
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 7_500);
    return () => { active = false; window.clearInterval(interval); };
  }, [api, available, bookId, Boolean(blueprint), guard, quotePreparing, quoteRequestId, setQuotePreparation]);

  useEffect(() => {
    if (!quote?.acceptedJobId || candidate || reviewStatus !== "pending" || !blueprint || !available) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await guard(() => api.getStoryBlueprintProposal(bookId, quote.id));
        if (active) setProposal(result);
      } catch {
        // Polling is advisory. Preserve the accepted job and retry on the next
        // interval instead of claiming that a paid generation failed.
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 7_500);
    return () => { active = false; window.clearInterval(interval); };
  }, [api, available, bookId, blueprint, candidate, guard, quote?.acceptedJobId, quote?.id, reviewStatus, setProposal]);

  const refresh = () => void run(async () => {
    await recoverSaved();
  }, "Could not refresh this Story Blueprint proposal. Your saved plan was not changed.");

  const closeOriginal = () => void run(async () => {
    if (!recoveryTarget || !("idempotencyKey" in recoveryTarget)) return;
    await guard(async () => undefined);
    if (!window.confirm("Close this original quote request only if it has not been queued? If it already exists, its status will be recovered instead.")) return;
    const saved = readBlueprintRecovery(bookId, actor);
    if (!saved || saved.legacy || !("idempotencyKey" in saved.pointer) || saved.pointer.idempotencyKey !== recoveryTarget.idempotencyKey) {
      throw new Error("The original quote checkpoint changed. Refresh its status first.");
    }
    const idempotencyKey = saved.pointer.idempotencyKey;
    const result = await guard(() => api.closeStoryBlueprintQuoteRequest(bookId, idempotencyKey));
    if (result.state === "exists") {
      setQuotePreparation(result);
      setRecoveryChecked(true);
      setNotice("The original request was already queued. Its status was recovered; no second count was started.");
      return;
    }
    if (result.state !== "closed" || result.request !== null || result.proposal !== null) throw new Error("The request closure could not be verified. Refresh its status.");
    clearBlueprintRecovery(bookId, actor, saved.raw);
    setRecoveryTarget(null);
    setRecoveryChecked(true);
    setConsent(false);
    setNotice("The unqueued original request was closed. A new quote requires fresh consent.");
  }, "Could not confirm closure. Keep this checkpoint and refresh or retry its original request.");

  const resolvePreviousQuote = () => void run(async () => {
    if (!quote) return;
    const saved = readBlueprintRecovery(bookId, actor);
    if (!saved || saved.legacy || !("proposalId" in saved.pointer) || saved.pointer.proposalId !== quote.id) {
      throw new Error("The previous quote checkpoint changed. Refresh its status first.");
    }
    const result = await guard(() => api.resolveStoryBlueprintQuote(bookId, quote.id));
    if (result.state === "accepted") {
      await recoverSaved();
      setNotice("The earlier quote was accepted. Its original job was recovered; no second credit hold was started.");
      return;
    }
    if (result.state === "open") {
      setNotice("The earlier quote can still be accepted. Keep this checkpoint and refresh its status before starting another request.");
      return;
    }
    if (result.state !== "unusable") throw new Error("The previous quote status could not be verified.");
    clearBlueprintRecovery(bookId, actor, saved.raw);
    setQuote(null);
    setQuoteRequest(null);
    setCandidate(null);
    setRecoveryTarget(null);
    setAcceptanceUncertain(false);
    setRecoveryChecked(true);
    setConsent(false);
    setNotice("The earlier quote cannot be accepted. Prepare a new quote with fresh consent when ready.");
  }, "Could not resolve the previous quote. Keep this checkpoint and refresh or retry.");

  const loadHistory = (more = false) => void run(async () => {
    const cursor = more ? historyCursor : null;
    if (more && !cursor) return;
    const result = verifiedHistory(await guard(() => api.listStoryBlueprintProposals(bookId, cursor ?? undefined)));
    if (cursor && result.nextCursor?.id === cursor.id && result.nextCursor.createdAt === cursor.createdAt) {
      throw new Error("The proposal history cursor did not advance.");
    }
    setHistory(current => more ? [...current, ...result.proposals.filter(item => !current.some(previous => previous.id === item.id))] : result.proposals);
    setHistoryCursor(result.nextCursor);
    setHistoryOpen(true);
  }, "Could not load saved Story Blueprint proposals. Try again.");

  const terminalReview = async (current: StoryBlueprintQuote) => {
    const result = await guard(() => api.getStoryBlueprintProposal(bookId, current.id));
    if (result.proposal.id !== current.id || result.proposal.status !== "accepted"
      || !((result.reviewStatus === "ready" && result.candidate) || result.reviewStatus === "failed")) {
      throw new Error("This proposal is still generating or under review. Refresh its status before leaving it.");
    }
    return result;
  };

  const finishReview = () => void run(async () => {
    if (!quote || !canLeaveReview || acceptanceUncertain || !recoveryChecked) return;
    const saved = readBlueprintRecovery(bookId, actor);
    if (!saved || saved.legacy || !("proposalId" in saved.pointer) || saved.pointer.proposalId !== quote.id || saved.pointer.acceptancePending) {
      throw new Error("The saved proposal checkpoint changed. Refresh its status first.");
    }
    await terminalReview(quote);
    clearBlueprintRecovery(bookId, actor, saved.raw);
    setQuote(null); setQuoteRequest(null); setCandidate(null); setRecoveryTarget(null);
    setConsent(false); setAcceptanceUncertain(false); setRecoveryChecked(true);
    setNotice("Review finished. This proposal remains available in saved proposals.");
  }, "Could not finish this proposal review. Refresh its status before continuing.");

  const openHistoryProposal = (proposalId: string) => void run(async () => {
    if (!canOpenHistory || !history.some(item => item.id === proposalId)) return;
    const saved = readBlueprintRecovery(bookId, actor);
    if (saved?.legacy || (saved && (!("proposalId" in saved.pointer) || saved.pointer.acceptancePending))) {
      throw new Error("Recover the current request before opening another proposal.");
    }
    if (quote) {
      if (!saved || !("proposalId" in saved.pointer) || saved.pointer.proposalId !== quote.id || !canLeaveReview) {
        throw new Error("Finish the current review before opening another proposal.");
      }
      await terminalReview(quote);
    } else if (saved) throw new Error("Recover the current request before opening another proposal.");
    const result = await guard(() => api.getStoryBlueprintProposal(bookId, proposalId));
    if (!result.proposal || result.proposal.id !== proposalId || !["ready", "expired", "accepted"].includes(result.proposal.status)) {
      throw new Error("The saved proposal identity could not be verified.");
    }
    setRecoveryChecked(false);
    writeBlueprintRecovery(bookId, actor, { proposalId }, saved?.raw ?? null);
    setRecoveryTarget({ proposalId });
    setProposal(result);
    setRecoveryChecked(true);
    setNotice("Saved proposal reopened. Your Story Blueprint remains unchanged until you apply a review.");
  }, "Could not open that saved proposal. The current review remains available.");

  const requestQuote = () => void run(async () => {
    if (!blueprint || !editable || blocked || !consent || !modelId || !recoveryChecked || acceptanceUncertain) {
      throw new Error("Save the current Story Blueprint, choose a model, and explicitly consent to token counting before preparing a quote.");
    }
    if (hasPendingAcceptedProposal) {
      throw new Error("A paid Story Blueprint proposal is still being generated or settled. Refresh its status instead of starting another one.");
    }
    if (quotePreparing) {
      throw new Error("An exact token count is already being prepared for this saved Story Blueprint. Refresh its status instead of starting another one.");
    }
    if (quote) throw new Error("Resolve the previous Story Blueprint quote before preparing another.");
    const saved = readBlueprintRecovery(bookId, actor);
    if (saved) throw new Error("Recover the previous Story Blueprint request before preparing another.");
    const pointer = { idempotencyKey: crypto.randomUUID() };
    const result = await guard(() => {
      // Keep the original identity before any network request, without author text.
      writeBlueprintRecovery(bookId, actor, pointer, null);
      setRecoveryTarget(pointer);
      return api.requestStoryBlueprintQuote(bookId, { modelId, idempotencyKey: pointer.idempotencyKey, allowProviderTokenCounting: true });
    });
    setQuotePreparation(result);
    setNotice(result.proposal
      ? "Quote ready. No AI proposal has been generated and no credits are held. Review the fixed maximum before confirming."
      : "Preparing an exact token-count quote. No AI proposal has been generated and no credits are held.");
  }, "Could not queue a Story Blueprint quote. No AI proposal was generated and no credits were held.");

  const accept = () => void run(async () => {
    if (!quote || !blueprint || !editable || blocked || acceptanceUncertain || !recoveryChecked) return;
    if (!currentQuote) throw new Error("This quote was based on an older saved Story Blueprint. Reload or save a fresh plan before requesting a new quote.");
    if (isExpired(quote)) throw new Error("This quote expired. Prepare a fresh quote before confirming credits.");
    await guard(async () => undefined);
    const confirmed = window.confirm(`Hold up to ${quote.reservedCredits} credits and generate one Story Blueprint proposal for review? This sends the saved blueprint to OpenAI. It will not overwrite your plan or manuscript automatically.`);
    if (!confirmed) return;
    const saved = readBlueprintRecovery(bookId, actor);
    if (!saved || saved.legacy || !("proposalId" in saved.pointer) || saved.pointer.proposalId !== quote.id || saved.pointer.acceptancePending) {
      throw new Error("Recover this proposal before confirming a credit hold.");
    }
    const accepted = await guard(() => {
      writeBlueprintRecovery(bookId, actor, { proposalId: quote.id, acceptancePending: true }, saved.raw);
      setAcceptanceUncertain(true);
      return api.acceptStoryBlueprintQuote(bookId, quote.id, quote.reservedCredits);
    });
    writePointer({ proposalId: quote.id });
    setAcceptanceUncertain(false);
    setQuote({ ...quote, status: "accepted", acceptedJobId: accepted.jobId });
    setCandidate(null);
    setReviewStatus("pending");
    setNotice("Credit hold confirmed. The AI proposal is queued for review; it cannot change your saved Story Blueprint or manuscript by itself.");
  }, "Could not confirm the credit hold. Refresh the quote before trying again; no plan changes were made here.");

  const apply = () => void run(async () => {
    if (!quote || !candidate || !blueprint || !editable || blocked || !available || !recoveryChecked || acceptanceUncertain) return;
    if (!currentQuote) throw new Error("Your saved Story Blueprint changed after this proposal was created. It cannot be applied automatically.");
    await guard(async () => undefined);
    const confirmed = window.confirm("Apply this reviewed AI proposal to the saved Story Blueprint? This replaces the story direction and chapter plan at the shown revision. It does not change any manuscript chapter.");
    if (!confirmed) return;
    const result = await guard(() => api.applyStoryBlueprintProposal(bookId, quote.id, quote.sourceRevision));
    let checkpointCleared = true;
    try { clearPointer(); } catch { checkpointCleared = false; setRecoveryChecked(false); setRecoveryTarget({ proposalId: quote.id }); }
    setQuote(null);
    setQuoteRequest(null);
    setCandidate(null);
    setConsent(false);
    setNotice(`Applied to the Story Blueprint at revision ${result.revision}. No manuscript chapter was changed.${checkpointCleared ? "" : " Refresh the saved proposal checkpoint before starting another request."}`);
    try {
      await onApplied();
    } catch {
      setNotice(`Applied to the Story Blueprint at revision ${result.revision}. No manuscript chapter was changed, but this page could not reload; use Reload to view the saved revision.`);
    }
  }, "Could not confirm whether the proposal was applied. Reload the saved Story Blueprint before deciding what to do next.");

  const locked = busy || loadingModels || blocked || !available;
  const quoteExpired = quote ? isExpired(quote) : false;

  return <section className="mt-6 rounded-2xl border border-violet-300/20 bg-gradient-to-br from-violet-300/[0.08] via-white/[0.025] to-transparent p-5 sm:p-6" aria-labelledby="story-blueprint-ai-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-violet-100/75">Paid AI review</p>
        <h2 id="story-blueprint-ai-heading" className="mt-2 text-xl font-medium">Generate a review-only blueprint proposal</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">Use the saved Story Blueprint as the source, see the maximum credit hold before generation, then decide whether to apply the result. AI never changes your manuscript or plan automatically.</p>
      </div>
      {quote
        ? <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/65">{quote.status === "accepted" ? "Queued for review" : quoteExpired ? "Quote expired" : "Quote ready"}</span>
      : quoteRequest && <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/65">{quoteRequest.status === "counting" ? "Counting tokens" : quoteRequest.status === "failed" ? "Quote unavailable" : "Quote queued"}</span>}
    </div>

    {catalogError && <p role="status" className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/[0.08] p-4 text-sm leading-6 text-amber-50">{catalogError}</p>}
    {error && <p role="alert" className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm leading-6 text-red-100">{error}</p>}
    {notice && <p role="status" className="mt-5 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.08] p-4 text-sm leading-6 text-emerald-50">{notice}</p>}

    <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4" aria-label="Saved Story Blueprint proposals">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium text-white">Saved proposals</p><p className="mt-1 text-xs text-white/55">Reopen your previous reviews without another AI request.</p></div><button type="button" className={button} disabled={busy || !available} onClick={() => loadHistory()}>{historyOpen ? "Refresh saved proposals" : "View saved proposals"}</button></div>
      {historyOpen && <div className="mt-4">
        {!history.length ? <p className="text-sm text-white/55">No saved proposals yet.</p> : <ul className="space-y-2">{history.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3"><div><p className="text-sm text-white/80">Revision {item.sourceRevision} · {item.model} · {item.status}</p><p className="mt-1 text-xs text-white/45">{formatDate(item.createdAt)} · {item.reservedCredits} credits maximum</p></div><button type="button" className={button} disabled={busy || !canOpenHistory || item.id === quote?.id} onClick={() => openHistoryProposal(item.id)}>{item.id === quote?.id ? "Currently open" : "Open proposal"}</button></li>)}</ul>}
        {!canOpenHistory && <p className="mt-3 text-xs text-amber-100">Recover or finish the current request before opening another proposal.</p>}
        {historyCursor && <button type="button" className={`${button} mt-3`} disabled={busy || !available} onClick={() => loadHistory(true)}>Load more proposals</button>}
      </div>}
    </div>

    {!blueprint ? <p className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/55">Save a Story Blueprint before requesting an AI proposal. Draft text on this page is never sent for counting or generation.</p>
      : <fieldset disabled={!editable || locked || quotePreparing || !models.length || Boolean(quote)} className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="block text-sm text-white/75">Proposal model
          <select className={input} value={modelId} onChange={(event) => { setModelId(event.target.value); setConsent(false); }}>
            <option value="" disabled>Select a model</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
        <div className="lg:pb-0.5"><button type="button" className={button} disabled={!canRequestQuote || !consent || !modelId} onClick={requestQuote}>{busy ? "Working…" : "Prepare fixed quote"}</button></div>
        <label className="lg:col-span-2 flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/70"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I agree to send this saved Story Blueprint, including private planning notes, to OpenAI solely to count input tokens for a quote. This does not generate an AI proposal, place a credit hold, alter my plan, or publish anything.</label>
      </fieldset>}

    {!editable && blueprint && <p className="mt-4 text-sm text-amber-100">Writing access is required to request, accept, or apply a paid AI proposal.</p>}
    {blocked && blueprint && <p className="mt-4 text-sm text-amber-100">Save or resolve the current Story Blueprint changes before purchasing or applying an AI proposal.</p>}
    {quoteRequest && quotePreparing && <div className="mt-6 rounded-xl border border-violet-300/25 bg-violet-300/[0.05] p-5" aria-label="Preparing Story Blueprint quote">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-medium text-white">Preparing exact token count</p><p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">The saved Story Blueprint is queued for one provider token count. No AI proposal has been generated and no credits are held.</p></div><button type="button" className={button} disabled={busy} onClick={refresh}>Refresh status</button></div>
      <p className="mt-3 text-xs text-white/50">If counting cannot be confirmed, this request fails safely and is never converted into a paid generation.</p>
    </div>}

    {!recoveryChecked && !recoveryTarget && blueprint && <div className="mt-6 rounded-xl border border-amber-300/25 bg-amber-300/[0.05] p-5" aria-label="Checking Story Blueprint recovery">
      <p className="text-sm text-white/65">A saved request must be checked before another quote can be prepared. If browser storage is unavailable, retry or contact support.</p>
      <button type="button" className={`${button} mt-3`} disabled={busy} onClick={refresh}>Refresh status</button>
    </div>}

    {recoveringSavedQuote && !quote && !quoteRequest && <div className="mt-6 rounded-xl border border-amber-300/25 bg-amber-300/[0.05] p-5" aria-label="Recovering saved Story Blueprint quote">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-medium text-white">Recover saved quote status</p><p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">A previous quote or paid proposal is still linked to this book. Refresh its status before preparing another request.</p></div><button type="button" className={button} disabled={busy} onClick={refresh}>Refresh status</button></div>
      {recoveryTarget && "idempotencyKey" in recoveryTarget && <div className="mt-4"><p className="text-sm text-white/60">You can close the original only if it has not been queued. If it already exists, its status will be recovered instead.</p><button type="button" className={`${button} mt-3`} disabled={busy} onClick={closeOriginal}>Close if not queued</button></div>}
    </div>}

    {quote && <div className="mt-6 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.05] p-5" aria-label="Review Story Blueprint quote">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm text-white/60">Saved revision {quote.sourceRevision} · {quote.model}</p><p className="mt-2 text-3xl font-medium tabular-nums">{quote.reservedCredits} <span className="text-base text-white/60">credits maximum hold</span></p></div><button type="button" className={button} disabled={busy} onClick={refresh}>Refresh status</button></div>
      <p className="mt-3 text-sm leading-6 text-white/65">The exact maximum covers this one review proposal. Measured usage settles after completion; usage that cannot be reconciled stays under review. The AI output remains private until the funded job is settled.</p>
      <p className="mt-2 text-xs text-white/55">Expires: {formatDate(quote.expiresAt)} · {quoteExpired ? "expired" : quote.status}</p>
      {!currentQuote && <p className="mt-4 rounded-lg border border-amber-300/25 bg-amber-300/[0.08] p-3 text-sm leading-6 text-amber-50">This quote was based on revision {quote.sourceRevision}; the current saved blueprint is revision {currentRevision}. It can be reviewed, but it cannot be accepted or applied to the newer source.</p>}
      {acceptanceUncertain && <p role="status" className="mt-4 text-sm text-amber-100">Acceptance is unconfirmed. Refresh status or resolve this quote before starting another request; an earlier acceptance may still finish.</p>}
      {quote.status === "ready" && !quoteExpired && <button type="button" className={`${primary} mt-5`} disabled={locked || !editable || !currentQuote || acceptanceUncertain || !recoveryChecked} onClick={accept}>Confirm {quote.reservedCredits}-credit hold &amp; generate proposal</button>}
      {quoteExpired && <p className="mt-4 text-sm text-amber-100">This offer has expired. Resolve its final status before preparing a new quote.</p>}
      {(acceptanceUncertain || quoteExpired || !currentQuote) && quote.status !== "accepted" && <button type="button" className={`${button} mt-4`} disabled={busy || !available} onClick={resolvePreviousQuote}>Resolve previous quote</button>}
      {canLeaveReview && <button type="button" className={`${button} mt-4`} disabled={busy || !available || !recoveryChecked || acceptanceUncertain} onClick={finishReview}>Finish review</button>}
      {quote.status === "accepted" && !candidate && reviewStatus === "pending" && <p className="mt-4 text-sm text-violet-100">Generation is queued or being settled. This page refreshes safely while the review candidate becomes available; your saved plan remains unchanged.</p>}
      {quote.status === "accepted" && !candidate && reviewStatus === "requires_review" && <p className="mt-4 rounded-lg border border-amber-300/25 bg-amber-300/[0.08] p-3 text-sm leading-6 text-amber-50">Generation or its credit settlement needs review before this proposal can be shown. Check your credit activity or contact support. Your saved plan has not been changed automatically.</p>}
      {quote.status === "accepted" && !candidate && reviewStatus === "failed" && <p className="mt-4 rounded-lg border border-red-300/25 bg-red-300/[0.08] p-3 text-sm leading-6 text-red-100">This proposal could not be completed safely. No AI output was applied; refresh later or contact support with the proposal ID.</p>}
    </div>}

    {candidate && quote && <div className="mt-6 rounded-xl border border-violet-300/25 bg-black/25 p-5" aria-label="Review AI Story Blueprint proposal">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-[0.16em] text-violet-100/75">Ready for author review</p><h3 className="mt-2 text-lg font-medium">AI proposal for saved revision {quote.sourceRevision}</h3></div><p className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">{Math.round(candidate.confidence * 100)}% confidence</p></div>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65">{candidate.rationale}</p>
      <details className="mt-5 rounded-xl border border-white/10 bg-white/[0.025] p-4"><summary className="cursor-pointer text-sm font-medium text-white">Review proposed story direction</summary><dl className="mt-4 grid gap-4 sm:grid-cols-2">{storyFields(candidate.story).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs uppercase tracking-[0.12em] text-white/40">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-white/75">{value}</dd></div>)}{candidate.story.targetWordCount !== null && <div><dt className="text-xs uppercase tracking-[0.12em] text-white/40">Target words</dt><dd className="mt-1 text-sm text-white/75">{candidate.story.targetWordCount.toLocaleString()}</dd></div>}</dl></details>
      <details className="mt-4 rounded-xl border border-white/10 bg-white/[0.025] p-4"><summary className="cursor-pointer text-sm font-medium text-white">Review proposed chapter plan · {candidate.chapterPlan.length} chapters</summary><ol className="mt-4 space-y-3">{candidate.chapterPlan.map((chapter, index) => <li key={chapter.id} className="rounded-lg border border-white/10 p-3"><p className="text-sm font-medium">{String(index + 1).padStart(2, "0")} · {chapter.title}</p>{chapter.purpose && <p className="mt-2 text-sm leading-6 text-white/65"><span className="text-white/40">Purpose:</span> {chapter.purpose}</p>}{chapter.summary && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/65"><span className="text-white/40">Summary:</span> {chapter.summary}</p>}{chapter.targetWords !== null && <p className="mt-2 text-xs text-white/45">Target: {chapter.targetWords.toLocaleString()} words</p>}</li>)}</ol></details>
      {!currentQuote && <p className="mt-5 rounded-lg border border-amber-300/25 bg-amber-300/[0.08] p-3 text-sm leading-6 text-amber-50">The source changed after this candidate was created. It is viewable for comparison only; reload the saved plan and request a new quote before applying anything.</p>}
      <button type="button" className={`${primary} mt-5`} disabled={!canApply || busy} onClick={apply}>Apply reviewed proposal to Story Blueprint</button>
      <p className="mt-2 text-xs leading-5 text-white/50">Applying is explicit and revision-checked. It replaces only the saved story direction and chapter plan; it never changes manuscript chapters automatically.</p>
    </div>}
  </section>;
}
