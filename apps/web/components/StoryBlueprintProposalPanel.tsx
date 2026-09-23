"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StoryBlueprint,
  StoryBlueprintCandidate,
  StoryBlueprintModelChoice,
  StoryBlueprintProposalResult,
  StoryBlueprintQuote,
  StoryBlueprintQuotePreparation,
  StoryBlueprintQuoteRequest,
} from "@bookworm/api-client";
import { apiClient } from "./api";

const button = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-white/85 outline-none transition duration-200 hover:border-white/45 hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-45";
const primary = "inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black outline-none transition duration-200 hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-45";
const input = "mt-2 min-h-11 w-full rounded-xl border border-white/15 bg-black/35 px-3.5 py-2.5 text-sm text-white outline-none transition duration-200 focus:border-white/50 focus:ring-2 focus:ring-white/15 disabled:cursor-not-allowed disabled:opacity-55";

type StoredQuote = { proposalId?: string; requestId?: string };

export function storyBlueprintProposalSessionKey(bookId: string) {
  return `story-blueprint-proposal:${bookId}`;
}

// The key intentionally contains only the book, saved revision, and model. It
// never carries planning text, price information, or a provider request body.
export function storyBlueprintQuoteIntentKey(bookId: string, revision: number, modelId: string) {
  return `story-blueprint-quote:${bookId}:${revision}:${modelId}`;
}

function readStoredQuote(bookId: string): StoredQuote | null {
  try {
    const value = window.sessionStorage.getItem(storyBlueprintProposalSessionKey(bookId));
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<StoredQuote>;
    if (typeof parsed.proposalId === "string" && parsed.proposalId.length > 0) return { proposalId: parsed.proposalId };
    return typeof parsed.requestId === "string" && parsed.requestId.length > 0 ? { requestId: parsed.requestId } : null;
  } catch { return null; }
}

function writeStoredProposal(bookId: string, proposalId: string) {
  try { window.sessionStorage.setItem(storyBlueprintProposalSessionKey(bookId), JSON.stringify({ proposalId })); }
  catch { /* Session recovery is optional; paid work remains server-owned. */ }
}

function writeStoredQuoteRequest(bookId: string, requestId: string) {
  try { window.sessionStorage.setItem(storyBlueprintProposalSessionKey(bookId), JSON.stringify({ requestId })); }
  catch { /* Session recovery is optional; paid work remains server-owned. */ }
}

function clearStoredProposal(bookId: string) {
  try { window.sessionStorage.removeItem(storyBlueprintProposalSessionKey(bookId)); }
  catch { /* A storage error must never affect server-side proposal state. */ }
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString() : "Unavailable";
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
  bookId, blueprint, editable, blocked, onApplied,
}: {
  bookId: string;
  blueprint: StoryBlueprint | null;
  editable: boolean;
  /** Parent edits, save conflicts, or loading block paid and apply actions. */
  blocked: boolean;
  onApplied: () => Promise<void> | void;
}) {
  const api = apiClient();
  const [models, setModels] = useState<StoryBlueprintModelChoice[]>([]);
  const [modelId, setModelId] = useState("");
  const [consent, setConsent] = useState(false);
  const [quote, setQuote] = useState<StoryBlueprintQuote | null>(null);
  const [quoteRequest, setQuoteRequest] = useState<StoryBlueprintQuoteRequest | null>(null);
  const [candidate, setCandidate] = useState<StoryBlueprintCandidate | null>(null);
  const [reviewStatus, setReviewStatus] = useState<NonNullable<StoryBlueprintProposalResult["reviewStatus"]>>("pending");
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const lastRevision = useRef<number | null>(null);
  const lock = useRef(false);

  const currentRevision = blueprint?.revision ?? null;
  const currentQuote = Boolean(quote && currentRevision !== null && quote.sourceRevision === currentRevision);
  const quotePreparing = quoteRequest?.status === "queued" || quoteRequest?.status === "counting";
  const quoteRequestId = quoteRequest?.id;
  const hasPendingAcceptedProposal = quote?.status === "accepted" && !candidate;
  const canRequestQuote = editable && Boolean(blueprint) && !blocked && !loadingModels
    && !quotePreparing && !hasPendingAcceptedProposal && (!currentQuote || (quote !== null && isExpired(quote)));
  const canApply = editable && Boolean(blueprint) && Boolean(quote) && Boolean(candidate)
    && currentQuote && !blocked;

  const setProposal = useCallback((next: StoryBlueprintProposalResult) => {
    setQuote(next.proposal);
    setQuoteRequest(null);
    setCandidate(next.candidate);
    setReviewStatus(next.reviewStatus ?? (next.candidate ? "ready" : "pending"));
    writeStoredProposal(bookId, next.proposal.id);
  }, [bookId]);

  const setQuotePreparation = useCallback((next: StoryBlueprintQuotePreparation) => {
    if (next.proposal) {
      setProposal({ proposal: next.proposal, candidate: null });
      return;
    }
    setQuote(null);
    setCandidate(null);
    if (next.request.status === "failed") {
      setQuoteRequest(null);
      intent.current = null;
      setConsent(false);
      clearStoredProposal(bookId);
      setError("The token count could not be confirmed. No credits were held. Consent again to prepare a new quote.");
      return;
    }
    setQuoteRequest(next.request);
    writeStoredQuoteRequest(bookId, next.request.id);
  }, [bookId, setProposal]);

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
      intent.current = null;
      setConsent(false);
    }
    lastRevision.current = currentRevision;
  }, [currentRevision]);

  useEffect(() => {
    let active = true;
    if (!blueprint) {
      setModels([]);
      setModelId("");
      return () => { active = false; };
    }
    setLoadingModels(true);
    setCatalogError(null);
    void api.listStoryBlueprintModels(bookId)
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
  }, [api, bookId, Boolean(blueprint)]);

  useEffect(() => {
    let active = true;
    if (!blueprint) return () => { active = false; };
    const stored = readStoredQuote(bookId);
    if (!stored) return () => { active = false; };
    const load = stored.proposalId
      ? api.getStoryBlueprintProposal(bookId, stored.proposalId)
      : api.getStoryBlueprintQuoteRequest(bookId, stored.requestId!);
    void load
      .then((result) => { if (active) {
        if ("candidate" in result) setProposal(result);
        else setQuotePreparation(result);
      } })
      .catch(() => {
        // Never reveal whether another account owns a proposal. Drop an invalid
        // local pointer and let the person refresh or request their own quote.
        if (active) clearStoredProposal(bookId);
      });
    return () => { active = false; };
  }, [api, bookId, Boolean(blueprint), setProposal, setQuotePreparation]);

  useEffect(() => {
    if (!quoteRequestId || !quotePreparing || !blueprint) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.getStoryBlueprintQuoteRequest(bookId, quoteRequestId);
        if (!active) return;
        if (result.proposal) setQuotePreparation(result);
        else if (result.request.status === "failed") {
          setQuoteRequest(null);
          intent.current = null;
          setConsent(false);
          clearStoredProposal(bookId);
          setError("The exact token count could not be confirmed. No AI proposal was generated and no credits were held. Prepare a new quote when ready.");
        } else setQuoteRequest(result.request);
      } catch {
        // Keep the durable pointer: a transient read failure must not create a
        // second token-count request or misrepresent its provider outcome.
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 7_500);
    return () => { active = false; window.clearInterval(interval); };
  }, [api, bookId, Boolean(blueprint), quotePreparing, quoteRequestId, setQuotePreparation]);

  useEffect(() => {
    if (!quote?.acceptedJobId || candidate || reviewStatus !== "pending" || !blueprint) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.getStoryBlueprintProposal(bookId, quote.id);
        if (active) setProposal(result);
      } catch {
        // Polling is advisory. Preserve the accepted job and retry on the next
        // interval instead of claiming that a paid generation failed.
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 7_500);
    return () => { active = false; window.clearInterval(interval); };
  }, [api, bookId, blueprint, candidate, quote?.acceptedJobId, quote?.id, reviewStatus, setProposal]);

  const refresh = () => void run(async () => {
    if (quote) {
      setProposal(await api.getStoryBlueprintProposal(bookId, quote.id));
      setNotice("Proposal status refreshed. AI output stays review-only until you explicitly apply it.");
    } else if (quoteRequest) {
      const result = await api.getStoryBlueprintQuoteRequest(bookId, quoteRequest.id);
      setQuotePreparation(result);
      setNotice(result.proposal ? "Quote ready. No AI proposal has been generated and no credits are held." : "Exact token count is still being prepared. No AI proposal has been generated and no credits are held.");
    }
  }, "Could not refresh this Story Blueprint proposal. Your saved plan was not changed.");

  const requestQuote = () => void run(async () => {
    if (!blueprint || !editable || blocked || !consent || !modelId) {
      throw new Error("Save the current Story Blueprint, choose a model, and explicitly consent to token counting before preparing a quote.");
    }
    if (hasPendingAcceptedProposal) {
      throw new Error("A paid Story Blueprint proposal is still being generated or settled. Refresh its status instead of starting another one.");
    }
    if (quotePreparing) {
      throw new Error("An exact token count is already being prepared for this saved Story Blueprint. Refresh its status instead of starting another one.");
    }
    if (currentQuote && quote && !isExpired(quote)) {
      throw new Error("Review the current quote before preparing another one. No additional token count was started.");
    }
    const signature = storyBlueprintQuoteIntentKey(bookId, blueprint.revision, modelId);
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() };
    const result = await api.requestStoryBlueprintQuote(bookId, {
      modelId,
      idempotencyKey: intent.current.key,
      allowProviderTokenCounting: true,
    });
    setQuotePreparation(result);
    setNotice(result.proposal
      ? "Quote ready. No AI proposal has been generated and no credits are held. Review the fixed maximum before confirming."
      : "Preparing an exact token-count quote. No AI proposal has been generated and no credits are held.");
  }, "Could not queue a Story Blueprint quote. No AI proposal was generated and no credits were held.");

  const accept = () => void run(async () => {
    if (!quote || !blueprint || !editable || blocked) return;
    if (!currentQuote) throw new Error("This quote was based on an older saved Story Blueprint. Reload or save a fresh plan before requesting a new quote.");
    if (isExpired(quote)) throw new Error("This quote expired. Prepare a fresh quote before confirming credits.");
    const confirmed = window.confirm(`Hold up to ${quote.reservedCredits} credits and generate one Story Blueprint proposal for review? This sends the saved blueprint to OpenAI. It will not overwrite your plan or manuscript automatically.`);
    if (!confirmed) return;
    const accepted = await api.acceptStoryBlueprintQuote(bookId, quote.id, quote.reservedCredits);
    setQuote({ ...quote, status: "accepted", acceptedJobId: accepted.jobId });
    setCandidate(null);
    setReviewStatus("pending");
    writeStoredProposal(bookId, quote.id);
    setNotice("Credit hold confirmed. The AI proposal is queued for review; it cannot change your saved Story Blueprint or manuscript by itself.");
  }, "Could not confirm the credit hold. Refresh the quote before trying again; no plan changes were made here.");

  const apply = () => void run(async () => {
    if (!quote || !candidate || !blueprint || !editable || blocked) return;
    if (!currentQuote) throw new Error("Your saved Story Blueprint changed after this proposal was created. It cannot be applied automatically.");
    const confirmed = window.confirm("Apply this reviewed AI proposal to the saved Story Blueprint? This replaces the story direction and chapter plan at the shown revision. It does not change any manuscript chapter.");
    if (!confirmed) return;
    const result = await api.applyStoryBlueprintProposal(bookId, quote.id, quote.sourceRevision);
    clearStoredProposal(bookId);
    setQuote(null);
    setQuoteRequest(null);
    setCandidate(null);
    intent.current = null;
    setConsent(false);
    setNotice(`Applied to the Story Blueprint at revision ${result.revision}. No manuscript chapter was changed.`);
    try {
      await onApplied();
    } catch {
      setNotice(`Applied to the Story Blueprint at revision ${result.revision}. No manuscript chapter was changed, but this page could not reload; use Reload to view the saved revision.`);
    }
  }, "Could not apply this proposal. The saved Story Blueprint was not changed; refresh before deciding what to do next.");

  const locked = busy || loadingModels || blocked;
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

    {!blueprint ? <p className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/55">Save a Story Blueprint before requesting an AI proposal. Draft text on this page is never sent for counting or generation.</p>
      : <fieldset disabled={!editable || locked || quotePreparing || !models.length || (currentQuote && !quoteExpired)} className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="block text-sm text-white/75">Proposal model
          <select className={input} value={modelId} onChange={(event) => { setModelId(event.target.value); intent.current = null; setConsent(false); }}>
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

    {quote && <div className="mt-6 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.05] p-5" aria-label="Review Story Blueprint quote">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm text-white/60">Saved revision {quote.sourceRevision} · {quote.model}</p><p className="mt-2 text-3xl font-medium tabular-nums">{quote.reservedCredits} <span className="text-base text-white/60">credits maximum hold</span></p></div><button type="button" className={button} disabled={busy} onClick={refresh}>Refresh status</button></div>
      <p className="mt-3 text-sm leading-6 text-white/65">The exact maximum covers this one review proposal. Measured usage settles after completion; usage that cannot be reconciled stays under review. The AI output remains private until the funded job is settled.</p>
      <p className="mt-2 text-xs text-white/55">Expires: {formatDate(quote.expiresAt)} · {quoteExpired ? "expired" : quote.status}</p>
      {!currentQuote && <p className="mt-4 rounded-lg border border-amber-300/25 bg-amber-300/[0.08] p-3 text-sm leading-6 text-amber-50">This quote was based on revision {quote.sourceRevision}; the current saved blueprint is revision {currentRevision}. It can be reviewed, but it cannot be accepted or applied to the newer source.</p>}
      {quote.status === "ready" && !quoteExpired && <button type="button" className={`${primary} mt-5`} disabled={locked || !editable || !currentQuote} onClick={accept}>Confirm {quote.reservedCredits}-credit hold &amp; generate proposal</button>}
      {quoteExpired && <p className="mt-4 text-sm text-amber-100">This quote expired without starting generation. Select a model and explicitly consent again to prepare a fresh quote.</p>}
      {quote.status === "accepted" && !candidate && reviewStatus === "pending" && <p className="mt-4 text-sm text-violet-100">Generation is queued or being settled. This page refreshes safely while the review candidate becomes available; your saved plan remains unchanged.</p>}
      {quote.status === "accepted" && !candidate && reviewStatus === "requires_review" && <p className="mt-4 rounded-lg border border-amber-300/25 bg-amber-300/[0.08] p-3 text-sm leading-6 text-amber-50">The provider usage needs financial review before this private proposal can be shown. Your credits remain protected under review; no plan or manuscript was changed.</p>}
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
