"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Book, BookBibleItem, BookMetadata } from "@bookworm/types";
import BookSearchPanel from "./BookSearchPanel";
import BibleSourcePassage from "./BibleSourcePassage";

type SourceRef = { chapterId: string; documentVersionId?: string; nodeId?: string; textHash?: string; note?: string };
type GeneratedSourceRef = SourceRef & { nodeId: string };
export type GeneratedMetadataCandidate = {
  description: string;
  keywords: string[];
  categories: string[];
  audience?: string;
  rationale?: string;
  confidence?: number;
  sourceRefs: GeneratedSourceRef[];
};
type MetadataFields = { description: string; keywords: string; categories: string };
type PendingMetadata = { id: string; createdAt: string; status: "queued" | "running" };
type MetadataHistoryResponse = { drafts: { id: string; createdAt: string; candidate: unknown }[]; pending: PendingMetadata[] };
type MetadataModel = { id: string; label: string; model: string; priceVersion: string; policyVersion: string };
type MetadataQuote = { id: string; model: string; reservedCredits: number; expiresAt: string; status: "ready" | "accepted" | "expired"; acceptedJobId: string | null };
type MetadataQuoteIntent = { idempotencyKey: string; requestId?: string; body: {
  modelId: string; idempotencyKey: string; allowProviderTokenCounting: true; chapterIds: string[];
  audience?: string; tone?: string; maxTokens: number;
} };
type MetadataQuoteStatus = { request: { id: string; status: "counting" | "ready" | "failed" };
  quote: MetadataQuote | null; job?: { id: string; status: string; errorCode?: string } | null; candidate?: unknown };
type BookBibleCandidate = {
  type: string; name: string; description: string; attributes: Record<string, unknown>;
  sourceRefs: { chapterId: string; documentVersionId: string; nodeId: string; textHash: string }[];
  confidence: number;
};
type BibleHistoryResponse = { drafts: { id: string; createdAt: string; candidates: unknown }[]; pending: PendingMetadata[] };
type BibleReadingPlan = { fingerprint: string; pages: { pageIndex: number; bytes: number; completedJobId: string | null }[] };
type BibleModel = { id: string; label: string; model: string; maxOutputTokens: number; priceVersion: string; policyVersion: string };
type BibleQuote = { requestId: string; status: "counting" | "failed"; errorCode?: string }
  | { requestId: string; status: "ready" | "accepted" | "expired"; model: string; countedInputTokens: number; maxOutputTokens: number; reservedCredits: number; expiresAt: string };
type BibleQuoteIntent = { idempotencyKey: string; requestId?: string; body: { modelId: string; idempotencyKey: string; chapterIds: string[]; maxTokens: number; reading?: { fingerprint: string; pageIndex: number }; allowProviderTokenCounting: true } };
type BibleQuoteStatus = { request?: { id: string; status: "counting" | "ready" | "failed" }; quote: BibleQuote | null; job?: { id: string; status: string; errorCode?: string } | null };
export const metadataGenerationBlocked = (pending: PendingMetadata[] | null) => pending === null || pending.length > 0;
export const bibleGenerationBlocked = metadataGenerationBlocked;
export const metadataQuoteIntentKey = (bookId: string) => `bookworm:metadata-quote:v1:${bookId}`;
export const bibleQuoteIntentKey = (bookId: string) => `bookworm:bible-quote:v1:${bookId}`;
export function persistPaidQuoteIntent(storage: Pick<Storage, "setItem" | "removeItem">, key: string, intent: object | null): void {
  try {
    if (intent) storage.setItem(key, JSON.stringify(intent));
    else storage.removeItem(key);
  } catch {
    if (intent) throw new Error("Browser session recovery is unavailable. No paid quote request was sent; enable session storage before continuing.");
  }
}
export function canAcceptMetadataQuote(quote: MetadataQuote | null, consent: boolean, now = Date.now()): boolean {
  return Boolean(quote?.status === "ready" && !quote.acceptedJobId && consent && Date.parse(quote.expiresAt) > now
    && Number.isSafeInteger(quote.reservedCredits) && quote.reservedCredits > 0);
}
export function metadataCancellationMessage(job: { status: string; errorCode?: string } | null | undefined): string | null {
  if (!job || !["failed", "cancelled"].includes(job.status)) return null;
  const reasons: Record<string, string> = {
    metadata_source_changed_before_dispatch: "Saved manuscript evidence changed",
    metadata_request_mismatch_before_dispatch: "The saved request no longer matched its quote",
    metadata_quote_expired_before_dispatch: "The quote expired",
    metadata_permission_revoked_before_dispatch: "Editing permission was revoked",
  };
  const reason = reasons[job.errorCode ?? ""];
  return reason ? `${reason} before generation. The worker cancelled before provider dispatch and released the reserved credits. Review the saved book and your permissions before requesting a fresh quote.` : null;
}
export function createBibleQuoteIntent(input: { modelId: string; idempotencyKey: string; chapterIds: string[]; maxTokens: number; reading?: { fingerprint: string; pageIndex: number } }): BibleQuoteIntent {
  return { idempotencyKey: input.idempotencyKey, body: { ...input, chapterIds: [...input.chapterIds], allowProviderTokenCounting: true } };
}
export function canAcceptBibleQuote(quote: BibleQuote | null, consent: boolean, now = Date.now()): boolean {
  return Boolean(quote && "expiresAt" in quote && quote.status === "ready" && consent && Date.parse(quote.expiresAt) > now
    && Number.isSafeInteger(quote.reservedCredits) && quote.reservedCredits > 0);
}
type BibleQuoteRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function requestMetadataQuoteResult(fetchRequest: BibleQuoteRequest, endpoint: string, intent: MetadataQuoteIntent, createOriginal = false): Promise<MetadataQuoteStatus> {
  if (intent.requestId) return fetchRequest(`${endpoint}/metadata/quote-requests/${encodeURIComponent(intent.requestId)}`);
  return createOriginal ? fetchRequest(`${endpoint}/metadata/quotes`, "POST", intent.body)
    : fetchRequest(`${endpoint}/metadata/quotes/recover`, "POST", { idempotencyKey: intent.idempotencyKey });
}
export function requestBibleQuoteResult(fetchRequest: BibleQuoteRequest, endpoint: string, intent: BibleQuoteIntent): Promise<BibleQuoteStatus> {
  return intent.requestId
    ? fetchRequest<BibleQuoteStatus>(`${endpoint}/bible/quotes/${encodeURIComponent(intent.requestId)}`)
    : fetchRequest<BibleQuoteStatus>(`${endpoint}/bible/quotes`, "POST", intent.body);
}
export function acceptBibleQuoteRequest(fetchRequest: BibleQuoteRequest, endpoint: string, requestId: string, expectedCredits: number): Promise<{ jobId: string; status: string }> {
  return fetchRequest(`${endpoint}/bible/quotes/${encodeURIComponent(requestId)}/accept`, "POST", { expectedCredits });
}
type Memory = {
  book: Book;
  metadata: BookMetadata | null;
  items: BookBibleItem[];
  chapters: { id: string; title: string; current_document_version_id: string | null }[];
  imageAssets: { id: string; name: string; mime_type: string }[];
  canEdit: boolean;
};
type EntryDraft = {
  id?: string;
  expectedUpdatedAt?: string;
  type: string;
  name: string;
  description: string;
  attributes: { key: string; value: string; original?: unknown; originalText?: string }[];
  imageAssetIds: string[];
  sourceRefs: SourceRef[];
};

const types = ["character", "location", "place", "organization", "fact", "object", "event", "term", "timeline", "style"];
const inputClass = "mt-2 min-w-0 w-full max-w-full rounded-xl border border-white/15 bg-black px-3.5 py-3 text-sm text-white outline-none placeholder:text-[#737373] focus:border-white/50 focus:ring-2 focus:ring-white/15 disabled:opacity-60";
const primaryClass = "inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black outline-none transition hover:bg-[#dedede] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-50";
const secondaryClass = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-[#ddd] outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50";
const panelClass = "min-w-0 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6";
const isPinnedSourceRef = (ref: SourceRef): ref is SourceRef & { documentVersionId: string; nodeId: string; textHash: string } =>
  Boolean(ref.chapterId) && typeof ref.documentVersionId === "string" && Boolean(ref.documentVersionId)
  && typeof ref.nodeId === "string" && Boolean(ref.nodeId)
  && typeof ref.textHash === "string" && /^[a-f0-9]{64}$/u.test(ref.textHash);

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/backend/v1${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session expired. Sign in again, then reload this page.");
    const firstIssue = data?.error?.details?.issues?.[0];
    const error = new Error(firstIssue ? `${firstIssue.path?.join(" → ") || "Field"}: ${firstIssue.message}` : data?.error?.message || `Request failed (${response.status}).`) as Error & { status?: number; details?: Record<string, unknown> };
    error.status = response.status;
    if (data?.error?.details && typeof data.error.details === "object") error.details = data.error.details;
    throw error;
  }
  return data as T;
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
export function metadataRequestCanRestart(error: unknown): boolean {
  const failure = error as { status?: number; details?: Record<string, unknown> } | null;
  // A network/5xx response may follow an accepted, billable job. Keep its key.
  return failure?.details?.status === "failed" || [400, 401, 403, 404, 422].includes(failure?.status ?? 0);
}
const emptyDraft = (): EntryDraft => ({ type: "character", name: "", description: "", attributes: [], imageAssetIds: [], sourceRefs: [] });

const stringList = (value: unknown, limit: number, maxLength: number) => Array.isArray(value)
  ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.slice(0, maxLength)))].slice(0, limit)
  : [];

export function parseGeneratedMetadataCandidate(value: unknown): GeneratedMetadataCandidate {
  if (!value || typeof value !== "object") throw new Error("The AI service returned an invalid metadata draft. Please try again.");
  const candidate = value as Record<string, unknown>;
  const description = typeof candidate.description === "string" ? candidate.description.trim().slice(0, 4000) : "";
  const keywords = stringList(candidate.keywords, 30, 100);
  const categories = stringList(candidate.categories, 20, 180);
  const sourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const ref = value as Record<string, unknown>;
    if (typeof ref.chapterId !== "string" || !ref.chapterId || typeof ref.nodeId !== "string" || !ref.nodeId) return [];
    return [{
      chapterId: ref.chapterId,
      ...(typeof ref.documentVersionId === "string" ? { documentVersionId: ref.documentVersionId } : {}),
      nodeId: ref.nodeId,
      ...(typeof ref.textHash === "string" ? { textHash: ref.textHash } : {}),
      ...(typeof ref.note === "string" ? { note: ref.note.slice(0, 500) } : {}),
    }];
  }).slice(0, 30) : [];
  if (description.length < 40 || !keywords.length || !categories.length || !sourceRefs.length) {
    throw new Error("The AI draft is incomplete. Generate it again before using it.");
  }
  const confidence = typeof candidate.confidence === "number" && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : undefined;
  return {
    description, keywords, categories, sourceRefs,
    ...(typeof candidate.audience === "string" && candidate.audience.trim() ? { audience: candidate.audience.trim().slice(0, 500) } : {}),
    ...(typeof candidate.rationale === "string" && candidate.rationale.trim() ? { rationale: candidate.rationale.trim().slice(0, 2000) } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

export function parseBookBibleCandidates(value: unknown): BookBibleCandidate[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error("The saved Book Bible draft is invalid.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("The saved Book Bible draft is invalid.");
    const entry = item as Record<string, unknown>;
    const attributes = entry.attributes;
    const refs = entry.sourceRefs;
    if (entry.suggestionKind !== "book_bible_candidate" || entry.status !== "pending"
      || typeof entry.type !== "string" || !types.includes(entry.type)
      || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 160
      || typeof entry.description !== "string" || entry.description.length > 12000
      || !attributes || typeof attributes !== "object" || Array.isArray(attributes)
      || Object.keys(attributes).length > 40 || JSON.stringify(attributes).length > 24000
      || typeof entry.confidence !== "number" || entry.confidence < 0 || entry.confidence > 1
      || !Array.isArray(refs) || !refs.length || refs.length > 30) {
      throw new Error("The saved Book Bible draft is invalid.");
    }
    const sourceRefs = refs.map((source) => {
      if (!source || typeof source !== "object") throw new Error("The Book Bible draft has an invalid citation.");
      const ref = source as Record<string, unknown>;
      if (typeof ref.chapterId !== "string" || typeof ref.documentVersionId !== "string"
        || typeof ref.nodeId !== "string" || typeof ref.textHash !== "string"
        || !/^[a-f0-9]{64}$/u.test(ref.textHash)) throw new Error("The Book Bible draft has an invalid citation.");
      return { chapterId: ref.chapterId, documentVersionId: ref.documentVersionId,
        nodeId: ref.nodeId, textHash: ref.textHash };
    });
    return { type: entry.type, name: entry.name, description: entry.description,
      attributes: attributes as Record<string, unknown>, sourceRefs, confidence: entry.confidence };
  });
}

function entryDraft(item: BookBibleItem): EntryDraft {
  const images = item.attributes_json?.imageAssetIds;
  return {
    id: item.id, expectedUpdatedAt: item.updated_at, type: item.type, name: item.name,
    description: item.description ?? "",
    attributes: Object.entries(item.attributes_json ?? {}).filter(([key]) => key !== "imageAssetIds").map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return { key, value: text, original: value, originalText: text };
    }),
    imageAssetIds: Array.isArray(images) ? images.filter((value): value is string => typeof value === "string") : [],
    sourceRefs: (item.source_refs_json ?? []).filter((ref): ref is SourceRef => !!ref && typeof ref === "object" && "chapterId" in ref && typeof ref.chapterId === "string"),
  };
}

export default function BookMemoryClient({ bookId }: { bookId: string }) {
  const bookScope = useRef({ bookId });
  if (bookScope.current.bookId !== bookId) bookScope.current = { bookId };
  const quoteInFlight = useRef(false);
  const [memory, setMemory] = useState<Memory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [identityDirty, setIdentityDirty] = useState(false);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [metadataFields, setMetadataFields] = useState<MetadataFields>({ description: "", keywords: "", categories: "" });
  const [metadataCandidate, setMetadataCandidate] = useState<GeneratedMetadataCandidate | null>(null);
  const [metadataHistory, setMetadataHistory] = useState<{ id: string; createdAt: string; candidate: GeneratedMetadataCandidate }[] | null>(null);
  const [pendingMetadata, setPendingMetadata] = useState<PendingMetadata[] | null>(null);
  const [metadataTone, setMetadataTone] = useState("compelling");
  const [metadataAudience, setMetadataAudience] = useState("");
  const [metadataModels, setMetadataModels] = useState<MetadataModel[] | null>(null);
  const [metadataModelId, setMetadataModelId] = useState("");
  const [metadataChapterIds, setMetadataChapterIds] = useState<string[]>([]);
  const [metadataCountConsent, setMetadataCountConsent] = useState(false);
  const [metadataAcceptConsent, setMetadataAcceptConsent] = useState(false);
  const [metadataQuoteIntent, setMetadataQuoteIntent] = useState<MetadataQuoteIntent | null>(null);
  const [metadataQuote, setMetadataQuote] = useState<MetadataQuote | null>(null);
  const [metadataAcceptanceUncertain, setMetadataAcceptanceUncertain] = useState(false);
  const [metadataRecoveryBlocked, setMetadataRecoveryBlocked] = useState(true);
  const [metadataRecoveryNotFound, setMetadataRecoveryNotFound] = useState(false);
  const [metadataQuoteStage, setMetadataQuoteStage] = useState<"idle" | "counting" | "ready" | "queued" | "running" | "review" | "failed" | "expired" | "complete">("idle");
  const [metadataGenerationError, setMetadataGenerationError] = useState<string | null>(null);
  const [generatingMetadata, setGeneratingMetadata] = useState(false);
  const [bibleCandidates, setBibleCandidates] = useState<BookBibleCandidate[] | null>(null);
  const [bibleHistory, setBibleHistory] = useState<{ id: string; createdAt: string; candidates: BookBibleCandidate[] }[] | null>(null);
  const [pendingBible, setPendingBible] = useState<PendingMetadata[] | null>(null);
  const [bibleModels, setBibleModels] = useState<BibleModel[] | null>(null);
  const [bibleModelId, setBibleModelId] = useState("");
  const [bibleCountConsent, setBibleCountConsent] = useState(false);
  const [bibleAcceptConsent, setBibleAcceptConsent] = useState(false);
  const [bibleQuoteIntent, setBibleQuoteIntent] = useState<BibleQuoteIntent | null>(null);
  const [bibleQuote, setBibleQuote] = useState<BibleQuote | null>(null);
  const [bibleAcceptanceUncertain, setBibleAcceptanceUncertain] = useState(false);
  const [bibleRecoveryBlocked, setBibleRecoveryBlocked] = useState(true);
  const [bibleQuoteJob, setBibleQuoteJob] = useState<{ id: string; status: string; errorCode?: string } | null>(null);
  const [bibleQuoteStage, setBibleQuoteStage] = useState<"idle" | "counting" | "ready" | "queued" | "running" | "review" | "failed" | "expired">("idle");
  const [bibleGenerationError, setBibleGenerationError] = useState<string | null>(null);
  const [generatingBible, setGeneratingBible] = useState(false);
  const [bibleChapterIds, setBibleChapterIds] = useState<string[]>([]);
  const [bibleReadingPlan, setBibleReadingPlan] = useState<BibleReadingPlan | null>(null);
  const [biblePageIndex, setBiblePageIndex] = useState(0);
  const [entryDirty, setEntryDirty] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const endpoint = `/books/${encodeURIComponent(bookId)}`;
  const dirty = identityDirty || metadataDirty || entryDirty;
  const busy = loading || !!saving || generatingMetadata || generatingBible;

  function saveBibleQuoteIntent(intent: BibleQuoteIntent | null) {
    persistPaidQuoteIntent(window.sessionStorage, bibleQuoteIntentKey(bookId), intent);
    setBibleQuoteIntent(intent);
  }

  function applyBibleQuoteStatus(result: BibleQuoteStatus, original: BibleQuoteIntent) {
    const requestId = result.request?.id ?? result.quote?.requestId ?? original.requestId;
    const intent = requestId ? { ...original, requestId } : original;
    saveBibleQuoteIntent(intent);
    setBibleQuote(result.quote);
    setBibleQuoteJob(result.job ?? null);
    setBibleAcceptConsent(false);
    setBibleAcceptanceUncertain(false);
    if (result.job) {
      if (result.job.status === "queued" || result.job.status === "running") {
        setPendingBible((current) => {
          const jobs = current ?? [];
          return jobs.some((job) => job.id === result.job!.id)
            ? jobs.map((job) => job.id === result.job!.id ? { ...job, status: result.job!.status as PendingMetadata["status"] } : job)
            : [...jobs, { id: result.job!.id, createdAt: new Date().toISOString(), status: result.job!.status as PendingMetadata["status"] }];
        });
      }
      if (result.job.status === "running") setBibleQuoteStage("running");
      else if (result.job.status === "queued") setBibleQuoteStage("queued");
      else if (result.job.status === "succeeded" || result.job.status === "failed") setBibleQuoteStage("review");
    } else if (result.request?.status === "counting" || result.quote?.status === "counting") setBibleQuoteStage("counting");
    else if (result.request?.status === "failed" || result.quote?.status === "failed") {
      setBibleQuoteStage("failed");
      setBibleGenerationError(`Input-token counting did not produce a quote${result.quote?.status === "failed" && result.quote.errorCode ? ` (${result.quote.errorCode})` : ""}. No generation was accepted; you may request a fresh quote.`);
    } else if (result.quote?.status === "expired" || (result.quote?.status === "ready" && Date.parse(result.quote.expiresAt) <= Date.now())) setBibleQuoteStage("expired");
    else if (result.quote?.status === "accepted") setBibleQuoteStage("queued");
    else if (result.quote?.status === "ready") setBibleQuoteStage("ready");
  }

  const load = useCallback(async () => {
    const scope = { bookId };
    bookScope.current = scope;
    quoteInFlight.current = false; setGeneratingMetadata(false); setGeneratingBible(false); setSaving(null);
    setMetadataRecoveryBlocked(true); setBibleRecoveryBlocked(true);
    // Revalidate access before retaining private content or editable permissions.
    // Session recovery pointers stay intact; this does not cancel accepted jobs.
    setMemory(null); setDraft(null); setDeleting(null); setNotice(null);
    setLoading(true); setError(null); setFilter("all"); setQuery("");
    setPendingMetadata(null);
    setPendingBible(null);
    setMetadataFields({ description: "", keywords: "", categories: "" });
    setMetadataCandidate(null); setMetadataGenerationError(null); setMetadataHistory(null);
    setMetadataModels(null); setMetadataModelId(""); setMetadataQuote(null); setMetadataQuoteIntent(null);
    setMetadataQuoteStage("idle"); setMetadataChapterIds([]); setMetadataTone("compelling"); setMetadataAudience("");
    setMetadataCountConsent(false); setMetadataAcceptConsent(false); setMetadataAcceptanceUncertain(false);
    setMetadataRecoveryNotFound(false);
    setBibleCandidates(null); setBibleHistory(null); setBibleQuoteIntent(null); setBibleQuote(null); setBibleQuoteJob(null);
    setBibleQuoteStage("idle"); setBibleGenerationError(null); setBibleModels(null); setBibleModelId("");
    setBibleCountConsent(false); setBibleAcceptConsent(false); setBibleAcceptanceUncertain(false);
    setBibleReadingPlan(null); setBiblePageIndex(0); setBibleChapterIds([]);
    setIdentityDirty(false); setMetadataDirty(false); setEntryDirty(false);
    try {
      const result = await request<Memory>(`${endpoint}/memory`);
      if (bookScope.current !== scope) return;
      setMemory(result); setDraft(null); setDeleting(null);
      setMetadataFields({
        description: result.metadata?.description ?? "",
        keywords: result.metadata?.keywords.join("\n") ?? "",
        categories: result.metadata?.categories.join("\n") ?? "",
      });
      setMetadataChapterIds(result.chapters.filter((chapter) => chapter.current_document_version_id).slice(0, 5).map((chapter) => chapter.id));
      setBibleChapterIds(result.chapters.filter((chapter) => chapter.current_document_version_id).slice(0, 3).map((chapter) => chapter.id));
      setFormRevision((value) => value + 1);
      if (result.canEdit) {
        try {
          const catalog = await request<{ models: MetadataModel[] }>(`${endpoint}/metadata/models`);
          if (bookScope.current !== scope) return;
          setMetadataModels(catalog.models);
          setMetadataModelId(catalog.models[0]?.id ?? "");
        } catch (reason) {
          if (bookScope.current !== scope) return;
          setMetadataModels([]);
          setMetadataGenerationError(messageOf(reason));
        }
        try {
          const stored = window.sessionStorage.getItem(metadataQuoteIntentKey(bookId));
          if (stored) {
            const intent = JSON.parse(stored) as MetadataQuoteIntent;
            if (intent?.idempotencyKey && intent.body?.idempotencyKey === intent.idempotencyKey
              && intent.body.allowProviderTokenCounting === true && typeof intent.body.modelId === "string"
              && Array.isArray(intent.body.chapterIds) && intent.body.chapterIds.length > 0) {
              setMetadataQuoteIntent(intent);
              setMetadataModelId(intent.body.modelId); setMetadataChapterIds(intent.body.chapterIds);
              setMetadataTone(intent.body.tone ?? "compelling"); setMetadataAudience(intent.body.audience ?? "");
              setMetadataCountConsent(true); setMetadataQuoteStage("counting");
            } else throw new Error("The saved metadata quote checkpoint is invalid. No new request will be sent; recover the original request before continuing.");
          }
          setMetadataRecoveryBlocked(false);
        } catch (reason) { setMetadataGenerationError(`${messageOf(reason)} Quote requests are paused until browser recovery is available.`); }
        try {
          const history = await request<MetadataHistoryResponse>(`${endpoint}/metadata/drafts`);
          if (bookScope.current !== scope) return;
          setMetadataHistory(history.drafts.map((draft) => ({ ...draft, candidate: parseGeneratedMetadataCandidate(draft.candidate) })));
          setPendingMetadata(history.pending);
        } catch (reason) { if (bookScope.current !== scope) return; setMetadataGenerationError(messageOf(reason)); }
        try {
          const history = await request<BibleHistoryResponse>(`${endpoint}/bible/drafts`);
          if (bookScope.current !== scope) return;
          setBibleHistory(history.drafts.map((item) => ({ ...item, candidates: parseBookBibleCandidates(item.candidates) })));
          setPendingBible(history.pending);
        } catch (reason) { if (bookScope.current !== scope) return; setBibleGenerationError(messageOf(reason)); }
        try {
          const catalog = await request<{ catalogVersion: string; models: BibleModel[] }>(`${endpoint}/bible/models`);
          if (bookScope.current !== scope) return;
          setBibleModels(catalog.models);
          setBibleModelId(catalog.models[0]?.id ?? "");
        } catch (reason) {
          if (bookScope.current !== scope) return;
          setBibleModels([]);
          setBibleGenerationError(messageOf(reason));
        }
        try {
          const stored = window.sessionStorage.getItem(bibleQuoteIntentKey(bookId));
          if (stored) {
            const intent = JSON.parse(stored) as BibleQuoteIntent;
            const valid = typeof intent?.idempotencyKey === "string" && intent.idempotencyKey.length >= 12
              && intent.body?.idempotencyKey === intent.idempotencyKey && intent.body.allowProviderTokenCounting === true
              && typeof intent.body.modelId === "string" && Array.isArray(intent.body.chapterIds)
              && intent.body.chapterIds.length > 0 && Number.isInteger(intent.body.maxTokens)
              && (!intent.requestId || typeof intent.requestId === "string");
            if (valid) {
              setBibleQuoteIntent(intent); setBibleModelId(intent.body.modelId);
              setBibleChapterIds(intent.body.chapterIds); setBibleCountConsent(true); setBibleQuoteStage("counting");
              if (intent.requestId) {
                const status = await request<BibleQuoteStatus>(`${endpoint}/bible/quotes/${encodeURIComponent(intent.requestId)}`);
                if (bookScope.current !== scope) return;
                applyBibleQuoteStatus(status, intent);
              }
            } else throw new Error("The saved Book Bible quote checkpoint is invalid. No new request will be sent; keep its original request key.");
          }
          setBibleRecoveryBlocked(false);
        } catch (reason) { if (bookScope.current !== scope) return; setBibleGenerationError(`${messageOf(reason)} The saved quote pointer is retained; reload saved data to check recovery again.`); }
      }
    } catch (reason) { if (bookScope.current === scope) setError(messageOf(reason)); }
    finally { if (bookScope.current === scope) setLoading(false); }
  }, [bookId, endpoint]);

  useEffect(() => {
    void load();
    return () => { if (bookScope.current.bookId === bookId) bookScope.current = { bookId }; };
  }, [bookId, load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function reload() {
    if (busy) return;
    if (dirty && !window.confirm("Reloading discards your unsaved changes. Continue?")) return;
    setNotice(null); void load();
  }

  function chooseEntry(item?: BookBibleItem): boolean {
    if (busy) return false;
    if (entryDirty && !window.confirm("Discard the unsaved changes to this memory entry?")) return false;
    setDraft(item ? entryDraft(item) : emptyDraft());
    setEntryDirty(false); setDeleting(null); setError(null); setNotice(null);
    return true;
  }

  function openBibleEntry(id: string) {
    const item = memory?.items.find((entry) => entry.id === id);
    if (!item) { setNotice("This entry is no longer in the loaded Book Bible. Reload saved data and search again."); return; }
    if (chooseEntry(item)) requestAnimationFrame(() => document.getElementById("bible-entry-details")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function changeDraft(change: Partial<EntryDraft>) {
    setDraft((current) => current ? { ...current, ...change } : current);
    setEntryDirty(true);
  }

  async function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !memory?.canEdit || busy) return;
    setSaving("entry"); setError(null); setNotice(null);
    try {
      const keys = draft.attributes.map((entry) => entry.key.trim());
      if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error("Each attribute needs a unique, nonempty name.");
      const attributes = Object.fromEntries(draft.attributes.map((entry) => [entry.key.trim(), entry.originalText === entry.value ? entry.original : entry.value]));
      const payload = {
        type: draft.type, name: draft.name, description: draft.description, attributes,
        imageAssetIds: draft.imageAssetIds, sourceRefs: draft.sourceRefs,
        ...(draft.id ? { expectedUpdatedAt: draft.expectedUpdatedAt } : {}),
      };
      const { item } = await request<{ item: BookBibleItem }>(`${endpoint}/bible${draft.id ? `/${draft.id}` : ""}`, draft.id ? "PUT" : "POST", payload);
      setMemory((current) => current ? { ...current, items: draft.id ? current.items.map((entry) => entry.id === item.id ? item : entry) : [...current.items, item] } : current);
      setDraft(entryDraft(item)); setEntryDirty(false); setNotice(`“${item.name}” saved to this book’s memory.`);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(null); }
  }

  async function deleteEntry(item: BookBibleItem) {
    if (!memory?.canEdit || busy) return;
    setSaving("delete"); setError(null); setNotice(null);
    try {
      await request(`${endpoint}/bible/${item.id}`, "DELETE", { expectedUpdatedAt: item.updated_at });
      setMemory((current) => current ? { ...current, items: current.items.filter((entry) => entry.id !== item.id) } : current);
      setDraft(null); setEntryDirty(false); setDeleting(null); setNotice("Memory entry deleted. Linked images and manuscript chapters were kept.");
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(null); }
  }

  async function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!memory?.canEdit || busy) return;
    const data = new FormData(event.currentTarget);
    setSaving("identity"); setError(null); setNotice(null);
    try {
      const { book } = await request<{ book: Book }>(endpoint, "PATCH", {
        expectedUpdatedAt: memory.book.updated_at,
        title: data.get("title"), subtitle: data.get("subtitle") || null,
        authorName: data.get("authorName"), language: data.get("language"), genre: data.get("genre") || null,
      });
      setMemory((current) => current ? { ...current, book } : current);
      setIdentityDirty(false); setNotice("Book details saved.");
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(null); }
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!memory?.canEdit || busy) return;
    const data = new FormData(event.currentTarget);
    const lines = (name: string) => String(data.get(name) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    setSaving("metadata"); setError(null); setNotice(null);
    try {
      const { metadata } = await request<{ metadata: BookMetadata }>(`${endpoint}/metadata`, "PUT", {
        expectedUpdatedAt: memory.metadata?.updated_at ?? null, description: metadataFields.description,
        keywords: lines("keywords"), categories: lines("categories"), isbn13: data.get("isbn13") || null,
        edition: data.get("edition") || null, publicationDate: data.get("publicationDate") || null,
      });
      setMemory((current) => current ? { ...current, metadata } : current);
      setMetadataFields({ description: metadata.description ?? "", keywords: metadata.keywords.join("\n"), categories: metadata.categories.join("\n") });
      setMetadataDirty(false); setNotice("Publishing metadata saved.");
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(null); }
  }

  async function loadMetadataHistory() {
    if (!memory?.canEdit || busy) return;
    const scope = bookScope.current;
    setSaving("metadata-history"); setMetadataGenerationError(null);
    setPendingMetadata(null);
    try {
      const result = await request<MetadataHistoryResponse>(`${endpoint}/metadata/drafts`);
      if (bookScope.current !== scope) return;
      setMetadataHistory(result.drafts.map((draft) => ({ ...draft, candidate: parseGeneratedMetadataCandidate(draft.candidate) })));
      setPendingMetadata(result.pending);
    } catch (reason) { if (bookScope.current === scope) setMetadataGenerationError(messageOf(reason)); }
    finally { if (bookScope.current === scope) setSaving(null); }
  }

  function saveMetadataQuoteIntent(intent: MetadataQuoteIntent | null) {
    persistPaidQuoteIntent(window.sessionStorage, metadataQuoteIntentKey(bookId), intent);
    setMetadataQuoteIntent(intent);
  }

  function applyMetadataQuoteStatus(result: MetadataQuoteStatus, intent: MetadataQuoteIntent) {
    const recovered = { ...intent, requestId: result.request.id };
    saveMetadataQuoteIntent(recovered);
    setMetadataQuote(result.quote);
    setMetadataAcceptConsent(false);
    setMetadataAcceptanceUncertain(false);
    setMetadataRecoveryNotFound(false);
    if (result.candidate) {
      setMetadataCandidate(parseGeneratedMetadataCandidate(result.candidate));
      setMetadataQuoteStage("complete"); saveMetadataQuoteIntent(null);
      setPendingMetadata((current) => current?.filter((job) => job.id !== result.job?.id) ?? current);
      setNotice("The paid metadata result is ready for review. It has not changed saved metadata.");
      return;
    }
    const cancellation = metadataCancellationMessage(result.job);
    if (cancellation) {
      setMetadataQuoteStage("failed"); setMetadataGenerationError(cancellation);
      saveMetadataQuoteIntent(null);
      setPendingMetadata((current) => current?.filter((job) => job.id !== result.job?.id) ?? current);
      return;
    }
    if (result.job?.status === "failed" || result.job?.errorCode === "metadata_generation_requires_review") {
      setMetadataQuoteStage("review"); setMetadataGenerationError("The provider outcome needs review. Reserved credits remain held; do not start another metadata request until this job is resolved.");
      return;
    }
    if (result.job?.status === "succeeded") {
      setMetadataQuoteStage("review"); setMetadataGenerationError("The saved result could not be verified. Credits remain protected while this request is reviewed.");
      return;
    }
    if (result.job?.status === "running") setMetadataQuoteStage("running");
    else if (result.job?.status === "queued" || result.quote?.status === "accepted") setMetadataQuoteStage("queued");
    else if (result.request.status === "counting") setMetadataQuoteStage("counting");
    else if (result.quote?.status === "expired") {
      setMetadataQuoteStage("expired"); saveMetadataQuoteIntent(null);
    }
    else if (result.quote?.status === "ready") setMetadataQuoteStage("ready");
    else if (result.request.status === "failed") {
      setMetadataQuoteStage("failed"); setMetadataGenerationError("Token counting did not produce a usable quote. No generation was started; request a fresh quote.");
      saveMetadataQuoteIntent(null);
    }
  }

  async function requestMetadataQuote(retryOriginal = false) {
    if (!memory?.canEdit || memory.book.id !== bookId || busy || quoteInFlight.current || metadataRecoveryBlocked || (dirty && !metadataQuoteIntent)) return;
    if (retryOriginal && (dirty || !metadataRecoveryNotFound || !metadataQuoteIntent || metadataQuoteIntent.requestId)) return;
    const scope = bookScope.current;
    setMetadataGenerationError(null); setNotice(null);
    let intent = metadataQuoteIntent;
    let createOriginal = retryOriginal;
    if (!intent || ["failed", "expired", "complete"].includes(metadataQuoteStage)) {
      if (metadataGenerationBlocked(pendingMetadata)) return;
      if (!metadataModelId || !metadataChapterIds.length || !metadataCountConsent) {
        setMetadataGenerationError("Choose a model and saved chapter, then consent to token counting before requesting a quote."); return;
      }
      const idempotencyKey = crypto.randomUUID();
      intent = { idempotencyKey, body: { modelId: metadataModelId, idempotencyKey, allowProviderTokenCounting: true,
        chapterIds: metadataChapterIds, maxTokens: 12_000,
        ...(metadataTone.trim() ? { tone: metadataTone.trim() } : {}),
        ...(metadataAudience.trim() ? { audience: metadataAudience.trim() } : {}) } };
      setMetadataQuote(null); setMetadataCandidate(null); setMetadataQuoteStage("counting");
      try { saveMetadataQuoteIntent(intent); }
      catch (reason) { setMetadataGenerationError(messageOf(reason)); return; }
      createOriginal = true;
    }
    if (metadataAcceptanceUncertain && !intent.requestId) return;
    quoteInFlight.current = true;
    setGeneratingMetadata(true);
    try {
      if (createOriginal) saveMetadataQuoteIntent(intent);
      const response = await requestMetadataQuoteResult(request, endpoint, intent, createOriginal);
      if (bookScope.current === scope) applyMetadataQuoteStatus(response, intent);
    } catch (reason) {
      if (bookScope.current === scope) {
        setMetadataRecoveryNotFound(!createOriginal && !intent.requestId && (reason as { status?: number })?.status === 404);
        setMetadataGenerationError(`${messageOf(reason)} No new generation will be sent. Resume this same quote request to safely recover its status.`);
      }
    } finally { if (bookScope.current === scope) { quoteInFlight.current = false; setGeneratingMetadata(false); } }
  }

  async function acceptMetadataQuote() {
    if (!memory?.canEdit || memory.book.id !== bookId || busy || dirty || quoteInFlight.current || metadataRecoveryBlocked || metadataAcceptanceUncertain || !metadataQuoteIntent?.requestId || !metadataQuote || !canAcceptMetadataQuote(metadataQuote, metadataAcceptConsent)) return;
    const scope = bookScope.current;
    quoteInFlight.current = true; setMetadataAcceptanceUncertain(true); setMetadataAcceptConsent(false);
    setGeneratingMetadata(true); setMetadataGenerationError(null);
    try {
      saveMetadataQuoteIntent(metadataQuoteIntent);
      const accepted = await request<{ jobId: string; status: "queued" | "running" | "succeeded" | "failed" }>(
        `${endpoint}/metadata/quotes/${encodeURIComponent(metadataQuoteIntent.requestId)}/accept`, "POST", { expectedCredits: metadataQuote.reservedCredits });
      const intent = metadataQuoteIntent;
      if (bookScope.current !== scope) return;
      setMetadataQuote({ ...metadataQuote, status: "accepted", acceptedJobId: accepted.jobId });
      setMetadataQuoteStage(accepted.status === "running" ? "running" : accepted.status === "queued" ? "queued" : "review");
      setMetadataAcceptConsent(false);
      if (accepted.status === "queued" || accepted.status === "running") {
        setPendingMetadata((current) => [...(current ?? []), { id: accepted.jobId, createdAt: new Date().toISOString(), status: accepted.status as "queued" | "running" }]);
      }
      const status = await request<MetadataQuoteStatus>(`${endpoint}/metadata/quote-requests/${encodeURIComponent(intent.requestId!)}`);
      if (bookScope.current === scope) applyMetadataQuoteStatus(status, intent);
    } catch (reason) {
      if (bookScope.current === scope) setMetadataGenerationError(`${messageOf(reason)} Check this same quote’s status before trying again. Acceptance remains locked until recovery confirms the outcome.`);
    } finally { if (bookScope.current === scope) { quoteInFlight.current = false; setGeneratingMetadata(false); } }
  }

  async function refreshMetadataJob(jobId: string) {
    if (!memory?.canEdit || busy) return;
    const scope = bookScope.current;
    setSaving("metadata-status"); setMetadataGenerationError(null);
    try {
      const result = await request<{ job: { id: string; status: string; billingMode?: string; errorCode?: string }; candidate: unknown | null }>(
        `${endpoint}/metadata/jobs/${encodeURIComponent(jobId)}/status`);
      if (bookScope.current !== scope) return;
      const cancellation = metadataCancellationMessage(result.job);
      if (result.candidate) {
        setMetadataCandidate(parseGeneratedMetadataCandidate(result.candidate));
        setPendingMetadata((current) => current?.filter((job) => job.id !== jobId) ?? null);
        setNotice("Existing paid result opened for review. No generation or credit change was made.");
      } else if (cancellation) {
        setMetadataGenerationError(cancellation); setMetadataQuoteStage("failed");
        saveMetadataQuoteIntent(null); setMetadataQuote(null); setMetadataAcceptConsent(false); setMetadataAcceptanceUncertain(false);
        setPendingMetadata((current) => current?.filter((job) => job.id !== jobId) ?? null);
      } else if (result.job.status === "succeeded") {
        setMetadataGenerationError("The completed result could not be verified. Its billing outcome is protected; contact support instead of starting another request.");
      } else if (result.job.status === "failed" || result.job.errorCode === "metadata_generation_requires_review") {
        setMetadataGenerationError("This paid request still needs operator review. Its reserved credits remain protected; do not submit another generation.");
      } else {
        setPendingMetadata((current) => current?.map((job) => job.id === jobId
          ? { ...job, status: result.job.status === "running" ? "running" : "queued" } : job) ?? null);
        setNotice(`Paid metadata request is ${result.job.status}. Refresh status later; this check does not generate or spend again.`);
      }
    } catch (reason) { if (bookScope.current === scope) setMetadataGenerationError(messageOf(reason)); }
    finally { if (bookScope.current === scope) setSaving(null); }
  }

  function useMetadataCandidate() {
    if (!metadataCandidate || !memory?.canEdit || busy) return;
    if (metadataDirty && !window.confirm("Replace your unsaved description, keywords, and categories with this AI draft?")) return;
    setMetadataFields({
      description: metadataCandidate.description,
      keywords: metadataCandidate.keywords.join("\n"),
      categories: metadataCandidate.categories.join("\n"),
    });
    setMetadataDirty(true); setMetadataCandidate(null); setMetadataGenerationError(null);
    setNotice("AI draft copied into the form. Review it, then choose Save metadata when you are ready.");
  }

  async function loadBibleHistory() {
    if (!memory?.canEdit || busy) return;
    const scope = bookScope.current;
    setSaving("bible-history"); setBibleGenerationError(null); setPendingBible(null);
    try {
      const history = await request<BibleHistoryResponse>(`${endpoint}/bible/drafts`);
      if (bookScope.current !== scope) return;
      setBibleHistory(history.drafts.map((item) => ({ ...item, candidates: parseBookBibleCandidates(item.candidates) })));
      setPendingBible(history.pending);
    } catch (reason) { if (bookScope.current === scope) setBibleGenerationError(messageOf(reason)); }
    finally { if (bookScope.current === scope) setSaving(null); }
  }

  async function recoverBible(jobId: string) {
    if (!memory?.canEdit || busy) return;
    const scope = bookScope.current;
    setSaving("bible-recovery"); setBibleGenerationError(null);
    try {
      const result = await request<{ candidates: unknown }>(`${endpoint}/bible/jobs/${encodeURIComponent(jobId)}/recover`, "POST", {});
      if (bookScope.current !== scope) return;
      setBibleCandidates(parseBookBibleCandidates(result.candidates));
      setPendingBible((current) => current?.filter((job) => job.id !== jobId) ?? null);
      saveBibleQuoteIntent(null); setBibleQuote(null); setBibleQuoteJob(null); setBibleQuoteStage("idle");
      setNotice("Existing Book Bible result recovered. No new generation was started.");
    } catch (reason) { if (bookScope.current === scope) setBibleGenerationError(messageOf(reason)); }
    finally { if (bookScope.current === scope) setSaving(null); }
  }

  async function requestBibleQuote() {
    if (!memory?.canEdit || memory.book.id !== bookId || busy || quoteInFlight.current || bibleRecoveryBlocked || (dirty && !bibleQuoteIntent)) return;
    const scope = bookScope.current;
    setBibleGenerationError(null); setNotice(null);
    let intent = bibleQuoteIntent;
    if (!intent || ["failed", "expired"].includes(bibleQuoteStage)) {
      if (bibleGenerationBlocked(pendingBible)) {
        setBibleGenerationError("Recover or resolve existing Book Bible jobs before requesting a new quote."); return;
      }
      const model = bibleModels?.find((entry) => entry.id === bibleModelId);
      if (!model || !bibleChapterIds.length || !bibleCountConsent) {
        setBibleGenerationError("Choose an approved model and saved chapters, then consent to input-token counting before requesting a quote."); return;
      }
      const idempotencyKey = crypto.randomUUID();
      intent = createBibleQuoteIntent({ modelId: model.id, idempotencyKey, chapterIds: bibleChapterIds,
        maxTokens: 12_000,
        ...(bibleReadingPlan ? { reading: { fingerprint: bibleReadingPlan.fingerprint, pageIndex: biblePageIndex } } : {}) });
      try { saveBibleQuoteIntent(intent); }
      catch (reason) { setBibleGenerationError(messageOf(reason)); return; }
      setBibleQuote(null); setBibleQuoteJob(null); setBibleQuoteStage("counting"); setBibleAcceptConsent(false);
    }
    if (bibleAcceptanceUncertain && !intent.requestId) return;
    quoteInFlight.current = true;
    setGeneratingBible(true);
    try {
      const status = await requestBibleQuoteResult(request, endpoint, intent);
      if (bookScope.current === scope) applyBibleQuoteStatus(status, intent);
    } catch (reason) {
      if (bookScope.current === scope) setBibleGenerationError(`${messageOf(reason)} No new quote key will be created; resume to retry the same request safely.`);
    } finally { if (bookScope.current === scope) { quoteInFlight.current = false; setGeneratingBible(false); } }
  }

  async function acceptBibleQuote() {
    const quote = bibleQuote;
    const intent = bibleQuoteIntent;
    if (!memory?.canEdit || memory.book.id !== bookId || busy || dirty || quoteInFlight.current || bibleRecoveryBlocked || bibleAcceptanceUncertain || !intent?.requestId || !quote || !canAcceptBibleQuote(quote, bibleAcceptConsent)) return;
    if (!("reservedCredits" in quote)) return;
    const scope = bookScope.current;
    quoteInFlight.current = true; setBibleAcceptanceUncertain(true); setBibleAcceptConsent(false);
    setGeneratingBible(true); setBibleGenerationError(null);
    try {
      saveBibleQuoteIntent(intent);
      await acceptBibleQuoteRequest(request, endpoint, intent.requestId, quote.reservedCredits);
      if (bookScope.current !== scope) return;
      const status = await request<BibleQuoteStatus>(`${endpoint}/bible/quotes/${encodeURIComponent(intent.requestId)}`);
      if (bookScope.current !== scope) return;
      applyBibleQuoteStatus(status, intent);
      setNotice("Funded Book Bible extraction was accepted. Status checks do not generate again; review and save extracted facts separately.");
    } catch (reason) {
      if (bookScope.current === scope) setBibleGenerationError(`${messageOf(reason)} Check this same quote's status before any retry. Acceptance remains locked until recovery confirms the outcome.`);
    } finally { if (bookScope.current === scope) { quoteInFlight.current = false; setGeneratingBible(false); } }
  }

  async function prepareBibleReading() {
    if (!memory?.canEdit || memory.book.id !== bookId || busy || bibleQuoteIntent || !bibleChapterIds.length) return;
    const scope = bookScope.current;
    setSaving("bible-reading"); setBibleGenerationError(null);
    try {
      const plan = await request<BibleReadingPlan>(`${endpoint}/bible/reading-plan`, "POST", { chapterIds: bibleChapterIds });
      if (bookScope.current !== scope) return;
      if (!Array.isArray(plan.pages) || !plan.pages.length || !/^[a-f0-9]{64}$/.test(plan.fingerprint)) throw new Error("The reading plan is unavailable.");
      setBibleReadingPlan(plan);
      setBiblePageIndex(plan.pages.find((page) => !page.completedJobId)?.pageIndex ?? 0);
      setNotice("Saved-version reading plan prepared. No generation or credit charge occurred.");
    } catch (reason) { if (bookScope.current === scope) setBibleGenerationError(messageOf(reason)); }
    finally { if (bookScope.current === scope) setSaving(null); }
  }

  function useBibleCandidate(item: BookBibleCandidate) {
    if (!memory?.canEdit || busy) return;
    if (!chooseEntry()) return;
    setDraft({ type: item.type, name: item.name, description: item.description,
      attributes: Object.entries(item.attributes).map(([key, value]) => {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        return { key, value: text, original: value, originalText: text };
      }), imageAssetIds: [], sourceRefs: item.sourceRefs });
    setEntryDirty(true);
    setNotice("Candidate copied into an unsaved memory entry. Review every fact and source, then choose Save.");
    requestAnimationFrame(() => document.getElementById("bible-entry-details")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const visibleItems = (memory?.items ?? []).filter((item) => (filter === "all" || item.type === filter) && `${item.name} ${item.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const selected = memory?.items.find((item) => item.id === draft?.id);

  return <main className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-7">
      <div>
        <Link href={`/books/${encodeURIComponent(bookId)}`} className="text-sm text-[#aaa] underline underline-offset-4 hover:text-white">← Back to manuscript</Link>
        <p className="mt-7 text-[11px] uppercase tracking-[0.18em] text-[#999]">Book Bible & publishing details</p>
        <h1 className="mt-3 text-4xl font-medium tracking-[-0.055em] sm:text-5xl">A memory for <span className="font-instrument italic text-[#bbb]">your world.</span></h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-[#aaa]">Keep characters, visual references, and established facts together. Saved entries stay with {memory ? `“${memory.book.title}”` : "your book"} across sessions.</p>
      </div>
      <button type="button" onClick={reload} disabled={busy} className={secondaryClass}>{loading ? "Loading…" : "Reload saved data"}</button>
    </div>

    {error && <div role="alert" className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-100">{error} <Link href="/login" className="ml-2 underline">Sign in</Link></div>}
    {notice && <p role="status" className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{notice}</p>}
    {loading && !memory && <p role="status" className="py-16 text-center text-[#aaa]">Loading saved book memory…</p>}
    {!loading && !memory && <div className={`${panelClass} mt-6`}><h2 className="text-lg font-medium">Book memory is unavailable</h2><p className="mt-2 text-sm text-[#aaa]">Check your session and workspace access, then reload. No sample book data is substituted.</p></div>}

    {memory && <>
      <BookSearchPanel key={bookId} bookId={bookId} onOpenBibleEntry={openBibleEntry} />
      {!memory.canEdit && <p className="mt-5 rounded-xl border border-white/15 p-4 text-sm text-[#ccc]">You have read-only access. An editor can update this book’s memory and metadata.</p>}
      <section className="mt-9" aria-labelledby="bible-title">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 id="bible-title" className="text-2xl font-medium tracking-tight">Book Bible</h2><p className="mt-2 text-sm text-[#999]">{memory.items.length} saved {memory.items.length === 1 ? "entry" : "entries"} · changes are saved only when you choose Save.</p></div>
          {memory.canEdit && <button type="button" disabled={!!saving} onClick={() => chooseEntry()} className={primaryClass}>Add memory entry</button>}
        </div>
        {memory.canEdit && <div className="mt-5 rounded-2xl border border-sky-300/20 bg-sky-300/[0.045] p-4 sm:p-5" aria-labelledby="bible-ai-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 id="bible-ai-title" className="font-medium text-sky-50">AI candidate shelf</h3><p id="bible-ai-help" className="mt-1 max-w-2xl text-xs leading-5 text-[#aaa]">Choose up to three saved chapters and prepare reading batches without generation credits. When approved pricing is available, consent to token counting, inspect the exact quote, then separately approve one paid extraction. Existing drafts remain reviewable; nothing is saved to your Book Bible until you choose Save.</p></div>
            <span className="rounded-full border border-sky-200/20 px-3 py-2 text-xs text-sky-100">Token-priced quote flow</span>
          </div>
          <fieldset disabled={busy || Boolean(bibleQuoteIntent) || bibleGenerationBlocked(pendingBible)} className="mt-4">
            <legend className="text-xs font-medium text-[#ccc]">Chapters to read · {bibleChapterIds.length} of 3 selected</legend>
            <div className="mt-2 max-h-52 space-y-2 overflow-y-auto rounded-xl border border-white/10 p-3">
              {memory.chapters.map((chapter) => <label key={chapter.id} className="flex items-start gap-3 text-sm text-[#bbb]">
                <input type="checkbox" className="mt-1 accent-white" checked={bibleChapterIds.includes(chapter.id)} disabled={!chapter.current_document_version_id || (!bibleChapterIds.includes(chapter.id) && bibleChapterIds.length >= 3)} onChange={(event) => { setBibleReadingPlan(null); setBiblePageIndex(0); setBibleChapterIds((current) => event.target.checked ? [...current, chapter.id] : current.filter((id) => id !== chapter.id)); }} />
                <span>{chapter.title}{!chapter.current_document_version_id && <span className="ml-2 text-xs text-[#888]">Save this chapter first</span>}</span>
              </label>)}
              {!memory.chapters.length && <p className="text-xs text-[#999]">Add a manuscript chapter to begin.</p>}
            </div>
          </fieldset>
          <div className="mt-4 space-y-3">
            <button type="button" disabled={busy || Boolean(bibleQuoteIntent) || !bibleChapterIds.length} onClick={() => void prepareBibleReading()} className={secondaryClass}>Prepare reading batches · no credits</button>
            <p className="text-xs leading-5 text-[#aaa]">Long chapters can be reviewed as bounded reading batches without changing your manuscript or using credits. Preparing the same selection again refreshes the saved-version plan.</p>
            {bibleReadingPlan && <label className="block text-xs text-[#bbb]">Reading batch · {bibleReadingPlan.pages.filter((page) => page.completedJobId).length} of {bibleReadingPlan.pages.length} completed
              <select value={biblePageIndex} disabled={busy || Boolean(bibleQuoteIntent) || bibleGenerationBlocked(pendingBible)} onChange={(event) => setBiblePageIndex(Number(event.target.value))} className={inputClass}>
                {bibleReadingPlan.pages.map((page) => <option key={page.pageIndex} value={page.pageIndex}>Batch {page.pageIndex + 1} · {page.completedJobId ? "saved — reopen without credits" : "ready for a token quote"}</option>)}
              </select>
              <span className="mt-2 block">Completed batches reopen their candidates without generating again. Editing a selected chapter creates a different reading plan.</span>
            </label>}
          </div>
          <div className="mt-4 border-t border-white/10 pt-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
              <label className="text-xs text-[#bbb]">Approved AI model
                <select value={bibleModelId} disabled={busy || Boolean(bibleQuoteIntent) || !bibleModels?.length} onChange={(event) => setBibleModelId(event.target.value)} className={inputClass}>
                  {!bibleModels?.length && <option value="">{bibleModels === null ? "Loading approved models…" : "No approved models available"}</option>}
                  {bibleModels?.map((model) => <option key={model.id} value={model.id}>{model.label} · max {model.maxOutputTokens.toLocaleString()} output tokens</option>)}
                </select>
              </label>
              {!bibleQuoteIntent && <label className="flex items-start gap-3 rounded-xl border border-white/10 p-3 text-xs leading-5 text-[#ccc]">
                <input type="checkbox" checked={bibleCountConsent} onChange={(event) => setBibleCountConsent(event.target.checked)} disabled={busy || bibleGenerationBlocked(pendingBible)} className="mt-1 size-4 shrink-0 accent-sky-200" />
                <span>I agree to send the selected saved manuscript batch to OpenAI for input-token counting. This only prepares a quote; it does not generate candidates or reserve credits.</span>
              </label>}
              {bibleQuoteIntent && <div className="rounded-xl border border-sky-200/15 p-3 text-xs leading-5 text-[#ccc]">
                <p className="font-medium text-sky-50">Quote request recovery</p>
                <p className="mt-1 break-all text-[#aaa]">Key {bibleQuoteIntent.idempotencyKey}{bibleQuoteIntent.requestId ? ` · request ${bibleQuoteIntent.requestId}` : " · request identity not yet confirmed"}</p>
                <p className="mt-1 text-[#aaa]">Only the request pointer and selected chapter IDs are held in this browser session; manuscript text is never stored here.</p>
              </div>}
            </div>
            <label className="mt-3 block text-xs text-[#aaa]">Output limit
              <span className="mt-1 block text-sm text-[#ddd]">{bibleModels?.find((model) => model.id === bibleModelId)?.maxOutputTokens.toLocaleString() ?? "—"} maximum output tokens for the selected approved model.</span>
            </label>
            <p className="mt-2 text-xs text-[#999]">Saved manuscript context is bounded to 12,000 tokens per quote preparation; the selected model controls the separately displayed output maximum.</p>
            {bibleQuote && "expiresAt" in bibleQuote && <section className="mt-4 rounded-2xl border border-emerald-200/20 bg-emerald-200/[0.04] p-4" aria-label="Book Bible token quote">
              <div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-medium text-emerald-50">Exact quote</h4><p className="mt-1 text-xs text-[#aaa]">Model: {bibleModels?.find((model) => model.model === bibleQuote.model || model.id === bibleQuote.model)?.label ?? bibleQuote.model}</p></div><span className="rounded-full border border-white/15 px-2.5 py-1 text-xs">{bibleQuote.status === "ready" && Date.parse(bibleQuote.expiresAt) <= Date.now() ? "expired" : bibleQuote.status}</span></div>
              <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-[#999]">Counted input</dt><dd className="mt-1 text-sm text-white">{bibleQuote.countedInputTokens.toLocaleString()} tokens</dd></div>
                <div><dt className="text-[#999]">Maximum output</dt><dd className="mt-1 text-sm text-white">{bibleQuote.maxOutputTokens.toLocaleString()} tokens</dd></div>
                <div><dt className="text-[#999]">Maximum charge</dt><dd className="mt-1 text-sm font-semibold text-white">{bibleQuote.reservedCredits.toLocaleString()} credits</dd></div>
                <div><dt className="text-[#999]">Quote expires</dt><dd className="mt-1 text-sm text-white">{new Date(bibleQuote.expiresAt).toLocaleString()}</dd></div>
              </dl>
              {bibleQuote.status === "ready" && <>
                {bibleAcceptanceUncertain && <p role="status" className="mt-3 text-xs text-amber-100">Acceptance is unconfirmed. Resume this quote to read its status before approving again.</p>}
                <label className="mt-4 flex gap-3 rounded-xl border border-white/10 p-3 text-xs leading-5 text-[#ccc]"><input type="checkbox" checked={bibleAcceptConsent} onChange={(event) => setBibleAcceptConsent(event.target.checked)} disabled={busy || dirty || !memory.canEdit || bibleRecoveryBlocked || bibleAcceptanceUncertain} className="mt-1 size-4 shrink-0 accent-emerald-200" /><span>I approve this quote and authorize one candidate extraction, reserving up to {bibleQuote.reservedCredits.toLocaleString()} credits. Results remain drafts until I review and save each entry.</span></label>
                <button type="button" disabled={busy || dirty || !memory.canEdit || bibleRecoveryBlocked || bibleAcceptanceUncertain || !canAcceptBibleQuote(bibleQuote, bibleAcceptConsent)} onClick={() => void acceptBibleQuote()} className={`${primaryClass} mt-3`}>Accept quote and start extraction</button>
              </>}
            </section>}
            {bibleQuote && !("expiresAt" in bibleQuote) && <p role="status" className="mt-4 rounded-xl border border-sky-200/15 p-3 text-xs text-sky-50">Quote request {bibleQuote.requestId} · {bibleQuote.status}{bibleQuote.errorCode ? ` · ${bibleQuote.errorCode}` : ""}. Refresh status to recover; candidate generation cannot start without a ready quote and separate acceptance.</p>}
            {bibleQuoteJob && <div role="status" className="mt-3 rounded-xl border border-sky-200/15 p-3 text-xs text-sky-50">
              <p>Accepted extraction · {bibleQuoteJob.status} · job {bibleQuoteJob.id}{bibleQuoteJob.errorCode ? ` · ${bibleQuoteJob.errorCode}` : ""}</p>
              <div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void requestBibleQuote()} className={secondaryClass}>Refresh status · read only</button>{bibleQuoteJob.status === "succeeded" && <button type="button" disabled={busy} onClick={() => void recoverBible(bibleQuoteJob.id)} className={secondaryClass}>Recover existing result</button>}</div>
              {(bibleQuoteJob.status === "failed" || bibleQuoteJob.status === "succeeded") && <p className="mt-2 text-[#aaa]">If the result is not available through recovery, do not submit a new quote until this job is resolved.</p>}
            </div>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={busy || bibleRecoveryBlocked || (!bibleQuoteIntent && (dirty || !bibleChapterIds.length || !bibleModelId || !bibleCountConsent || bibleGenerationBlocked(pendingBible)))} onClick={() => void requestBibleQuote()} className={secondaryClass}>
                {generatingBible ? "Checking…" : bibleQuoteIntent ? (bibleQuoteIntent.requestId ? "Check quote/job status" : "Retry same quote request") : "Count tokens and request quote"}
              </button>
              {bibleQuoteIntent && ["failed", "expired"].includes(bibleQuoteStage) && <button type="button" disabled={busy} onClick={() => { saveBibleQuoteIntent(null); setBibleQuote(null); setBibleQuoteJob(null); setBibleQuoteStage("idle"); setBibleCountConsent(false); }} className={secondaryClass}>Clear resolved quote and start fresh</button>}
            </div>
            {bibleQuoteStage === "counting" && <p role="status" className="mt-3 text-xs text-sky-100">OpenAI input-token counting is in progress or awaiting status recovery. No generation starts until a quote is accepted.</p>}
            {bibleQuoteStage === "queued" || bibleQuoteStage === "running" ? <p role="status" className="mt-3 text-xs text-sky-100">Accepted job is {bibleQuoteStage}. Refreshing status does not dispatch another generation.</p> : null}
          </div>
          {pendingBible === null && <p role="status" className="mt-3 text-xs text-amber-100">Check saved request status before starting another paid extraction.</p>}
          {pendingBible && pendingBible.length > 0 && <div role="status" className="mt-3 rounded-xl border border-amber-200/20 p-3 text-xs text-amber-100"><p>One extraction is still pending. Recovery reads its existing result without generating again.</p>{pendingBible.map((job) => <div key={job.id} className="mt-2"><span>{job.status} · {new Date(job.createdAt).toLocaleString()} · request {job.id}</span><button type="button" disabled={busy} onClick={() => void recoverBible(job.id)} className={`${secondaryClass} mt-2 block`}>Recover existing result</button></div>)}</div>}
          <div className="mt-4 border-t border-white/10 pt-4"><button type="button" disabled={busy} onClick={() => void loadBibleHistory()} className={secondaryClass}>{saving === "bible-history" ? "Loading drafts…" : "Load saved candidate drafts · no credits"}</button>
            {bibleHistory && <div className="mt-3 space-y-2"><p className="text-xs text-[#999]">Latest 20 successful extractions. Opening a draft does not save facts or use credits.</p>{!bibleHistory.length && <p className="text-sm text-[#aaa]">No saved candidate drafts yet.</p>}{bibleHistory.map((item) => <button type="button" key={item.id} disabled={busy} onClick={() => { setBibleCandidates(item.candidates); setNotice("Saved candidates opened for review. No generation credits used."); }} className="block w-full rounded-xl border border-white/15 p-3 text-left text-sm hover:bg-white/5 disabled:opacity-50"><span className="block text-xs text-[#999]">{new Date(item.createdAt).toLocaleString()}</span><span className="mt-1 block">{item.candidates.length} candidate{item.candidates.length === 1 ? "" : "s"}{item.candidates.length ? ` · ${item.candidates.map((candidate) => candidate.name).join(", ")}` : " · no supported entities"}</span></button>)}</div>}
          </div>
          {generatingBible && <p role="status" className="mt-4 text-sm text-sky-100">Preparing or checking this quote/job; no second generation is started by a status check…</p>}
          {bibleGenerationError && <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{bibleGenerationError} Your saved Book Bible was not changed.</p>}
          {bibleCandidates && <div className="mt-5 space-y-3" aria-label="Review AI Book Bible candidates"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-medium">Review generated candidates</h4><button type="button" disabled={busy} onClick={() => setBibleCandidates(null)} className="text-xs text-[#aaa] underline underline-offset-4 hover:text-white">Close preview</button></div>{!bibleCandidates.length && <p className="rounded-xl border border-white/10 p-4 text-sm text-[#aaa]">The selected manuscript supported no candidates. No entry was added to your Book Bible.</p>}{bibleCandidates.map((item, index) => <article key={`${item.type}-${item.name}-${index}`} className="rounded-xl border border-white/15 bg-black/30 p-4"><div className="flex flex-wrap items-center gap-2"><span className="text-[10px] uppercase tracking-widest text-[#aaa]">{item.type}</span><span className="text-xs text-[#999]">{Math.round(item.confidence * 100)}% model confidence · verify against the text</span></div><h5 className="mt-2 break-words text-lg font-medium">{item.name}</h5><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#ccc]">{item.description || "No description supplied."}</p>{Object.keys(item.attributes).length > 0 && <dl className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(item.attributes).map(([key, value]) => <div key={key} className="rounded-lg border border-white/10 p-2 text-xs"><dt className="text-[#999]">{key}</dt><dd className="mt-1 break-words text-[#ddd]">{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>}<div className="mt-4 border-t border-white/10 pt-3"><p className="text-[11px] uppercase tracking-widest text-[#999]">Saved manuscript citations</p><ul className="mt-2 space-y-2">{item.sourceRefs.map((ref) => <li key={`${bookId}-${ref.chapterId}-${ref.documentVersionId}-${ref.nodeId}-${ref.textHash}`} className="break-all text-xs leading-5 text-[#aaa]"><BibleSourcePassage bookId={bookId} citation={ref} title={memory.chapters.find((chapter) => chapter.id === ref.chapterId)?.title ?? "Referenced chapter"} /></li>)}</ul></div><button type="button" disabled={busy} onClick={() => useBibleCandidate(item)} className={`${primaryClass} mt-4`}>Open as unsaved entry</button></article>)}</div>}
        </div>}
        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_180px]">
          <label className="text-xs text-[#aaa]">Search memory<input value={query} onChange={(event) => setQuery(event.target.value)} className={inputClass} placeholder="Name or description" type="search" /></label>
          <label className="text-xs text-[#aaa]">Entry type<select value={filter} onChange={(event) => setFilter(event.target.value)} className={inputClass}><option value="all">All types</option>{types.map((type) => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select></label>
        </div>
        <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(230px,0.8fr)_minmax(0,1.6fr)]">
          <div className="space-y-3">
            {!visibleItems.length && <div className={panelClass}><h3 className="font-medium">{memory.items.length ? "No matching entries" : "Start with a character or a fact"}</h3><p className="mt-2 text-sm leading-6 text-[#999]">{memory.items.length ? "Try a different name or type." : "Record appearance, personality, locations, and facts you want to keep consistent."}</p></div>}
            {visibleItems.map((item) => <button type="button" key={item.id} disabled={!!saving} onClick={() => chooseEntry(item)} aria-pressed={draft?.id === item.id} className={`block w-full rounded-2xl border p-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-white ${draft?.id === item.id ? "border-white/50 bg-white/[0.08]" : "border-white/10 bg-white/[0.025] hover:border-white/25"}`}>
              <span className="text-[10px] uppercase tracking-widest text-[#aaa]">{item.type}</span><h3 className="mt-2 break-words text-lg font-medium">{item.name}</h3><p className="mt-2 line-clamp-3 break-words text-sm leading-6 text-[#999]">{item.description || "No description yet."}</p>
            </button>)}
          </div>
          {draft ? <form id="bible-entry-details" onSubmit={saveEntry} className={panelClass}>
            <h3 className="text-xl font-medium">{draft.id ? "Memory details" : "New memory entry"}</h3>
            <fieldset disabled={!memory.canEdit || busy} className="mt-5 min-w-0 space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
                <label className="text-xs text-[#bbb]">Name<input required maxLength={160} value={draft.name} onChange={(event) => changeDraft({ name: event.target.value })} className={inputClass} placeholder="e.g. Elara Vale" /></label>
                <label className="text-xs text-[#bbb]">Type<select value={draft.type} onChange={(event) => changeDraft({ type: event.target.value })} className={inputClass}>{!types.includes(draft.type) && <option value={draft.type}>{draft.type}</option>}{types.map((type) => <option key={type}>{type}</option>)}</select></label>
              </div>
              <label className="block text-xs text-[#bbb]">Description<textarea value={draft.description} onChange={(event) => changeDraft({ description: event.target.value })} maxLength={12000} rows={5} className={inputClass} placeholder="Who or what is this? What must remain consistent?" /></label>
              <div><h4 className="text-sm font-medium">Attributes</h4><p className="mt-1 text-xs leading-5 text-[#999]">Add details such as appearance, motivation, voice, or timeline. Unedited structured values are preserved.</p>
                {draft.attributes.map((attribute, index) => <div key={index} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
                  <input aria-label={`Attribute ${index + 1} name`} required maxLength={80} value={attribute.key} onChange={(event) => changeDraft({ attributes: draft.attributes.map((entry, i) => i === index ? { ...entry, key: event.target.value } : entry) })} className={inputClass} placeholder="Appearance" />
                  <input aria-label={`Attribute ${index + 1} value`} value={attribute.value} onChange={(event) => changeDraft({ attributes: draft.attributes.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry) })} className={inputClass} placeholder="Green eyes, silver hair" />
                  <button type="button" aria-label={`Remove attribute ${index + 1}`} onClick={() => changeDraft({ attributes: draft.attributes.filter((_, i) => i !== index) })} className="mt-2 rounded-xl border border-white/15 px-3 py-2 text-sm text-[#aaa] hover:text-white">Remove</button>
                </div>)}
                {memory.canEdit && <button type="button" disabled={draft.attributes.length >= 40} onClick={() => changeDraft({ attributes: [...draft.attributes, { key: "", value: "" }] })} className="mt-3 text-sm text-[#ddd] underline underline-offset-4">+ Add attribute</button>}
              </div>
              <div><h4 className="text-sm font-medium">Reference images</h4><p className="mt-1 text-xs leading-5 text-[#999]">Link scan-cleared images from this workspace. Pending or quarantined versions are unavailable. Files stay in your asset library.</p>
                <div className="mt-3 max-h-44 space-y-2 overflow-y-auto">
                  {memory.imageAssets.map((asset) => <label key={asset.id} className="flex items-start gap-3 rounded-lg border border-white/10 p-3 text-sm text-[#bbb]"><input type="checkbox" checked={draft.imageAssetIds.includes(asset.id)} onChange={(event) => changeDraft({ imageAssetIds: event.target.checked ? [...draft.imageAssetIds, asset.id] : draft.imageAssetIds.filter((imageId) => imageId !== asset.id) })} className="mt-0.5 accent-white" /><span className="break-all">{asset.name}</span></label>)}
                  {!memory.imageAssets.length && <p className="text-sm text-[#888]">No scan-cleared images available yet.</p>}
                  {draft.imageAssetIds.filter((assetId) => !memory.imageAssets.some((asset) => asset.id === assetId)).map((assetId) => <label key={assetId} className="flex gap-3 text-sm text-amber-200"><input type="checkbox" checked onChange={() => changeDraft({ imageAssetIds: draft.imageAssetIds.filter((value) => value !== assetId) })} />Unavailable image — uncheck to remove its link</label>)}
                </div>
              </div>
              <div><h4 className="text-sm font-medium">Manuscript sources</h4><p className="mt-1 text-xs leading-5 text-[#999]">Reference the chapter that establishes a fact. When available, the current document version is pinned.</p>
                {draft.sourceRefs.map((ref, index) => <div key={index} className="mt-3 rounded-xl border border-white/10 p-3">
                  <label className="text-xs text-[#aaa]">Source chapter<select required value={ref.chapterId} onChange={(event) => { const chapter = memory.chapters.find((value) => value.id === event.target.value); changeDraft({ sourceRefs: draft.sourceRefs.map((entry, i) => i === index ? { chapterId: event.target.value, ...(chapter?.current_document_version_id ? { documentVersionId: chapter.current_document_version_id } : {}), note: entry.note } : entry) }); }} className={inputClass}><option value="">Choose a chapter</option>{!memory.chapters.some((chapter) => chapter.id === ref.chapterId) && ref.chapterId && <option value={ref.chapterId}>Unavailable chapter</option>}{memory.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>
                  <label className="mt-3 block text-xs text-[#aaa]">Source note<input value={ref.note ?? ""} maxLength={500} onChange={(event) => changeDraft({ sourceRefs: draft.sourceRefs.map((entry, i) => i === index ? { ...entry, note: event.target.value } : entry) })} className={inputClass} placeholder="e.g. First appearance, opening scene" /></label>
                  {ref.documentVersionId && <p className="mt-2 text-xs text-[#888]">Pinned to a saved document version.</p>}
                  {memory.canEdit && <button type="button" onClick={() => changeDraft({ sourceRefs: draft.sourceRefs.filter((_, i) => i !== index) })} className="mt-3 text-xs text-[#aaa] underline underline-offset-4">Remove source</button>}
                </div>)}
                {memory.canEdit && <button type="button" disabled={!memory.chapters.length || draft.sourceRefs.length >= 30} onClick={() => changeDraft({ sourceRefs: [...draft.sourceRefs, { chapterId: "" }] })} className="mt-3 text-sm text-[#ddd] underline underline-offset-4 disabled:opacity-40">+ Add chapter source</button>}
                {!memory.chapters.length && <p className="mt-2 text-xs text-[#888]">Create a chapter in the manuscript first.</p>}
              </div>
              {memory.canEdit && <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-5"><button type="submit" className={primaryClass}>{saving === "entry" ? "Saving…" : "Save memory entry"}</button>{entryDirty && <span className="text-xs text-amber-200">Unsaved changes</span>}{selected && <button type="button" onClick={() => setDeleting(selected.id)} className="ml-auto text-sm text-red-200 underline underline-offset-4">Delete entry</button>}</div>}
            </fieldset>
            {draft.sourceRefs.length > 0 && <section aria-label="Saved manuscript evidence" className="mt-6 border-t border-white/10 pt-5">
              <h4 className="text-[11px] uppercase tracking-widest text-[#999]">Saved manuscript evidence</h4>
              <p className="mt-2 text-xs leading-5 text-[#aaa]">Read the exact passage behind an entry, including earlier versions. Reading evidence does not edit your book, generate content, or use credits.</p>
              <ul className="mt-3 space-y-3">{draft.sourceRefs.map((ref, index) => <li key={JSON.stringify([bookId, ref.chapterId, ref.documentVersionId, ref.nodeId, ref.textHash, index])}>
                {isPinnedSourceRef(ref) ? <BibleSourcePassage bookId={bookId} citation={ref} title={memory.chapters.find((chapter) => chapter.id === ref.chapterId)?.title ?? "Referenced chapter"} />
                  : <div className="rounded-lg border border-white/10 p-3 text-xs leading-5 text-[#aaa]"><p className="font-medium text-[#ddd]">{memory.chapters.find((chapter) => chapter.id === ref.chapterId)?.title ?? "Referenced chapter"}</p><p className="mt-1">Chapter reference only. No exact passage has been pinned.</p></div>}
              </li>)}</ul>
            </section>}
            {deleting === selected?.id && selected && <div role="alert" className="mt-5 rounded-xl border border-red-400/30 p-4 text-sm text-red-100"><p>Delete “{selected.name}” from this book’s memory? This cannot be undone. Manuscript chapters and image files will remain.</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!!saving} onClick={() => void deleteEntry(selected)} className="rounded-full bg-red-100 px-4 py-2 text-sm font-semibold text-red-950">{saving === "delete" ? "Deleting…" : "Confirm delete"}</button><button type="button" disabled={!!saving} onClick={() => setDeleting(null)} className={secondaryClass}>Keep entry</button></div></div>}
          </form> : <div className={`${panelClass} flex min-h-60 items-center justify-center text-center`}><div><h3 className="text-lg font-medium">Your story’s reference shelf</h3><p className="mt-3 max-w-sm text-sm leading-6 text-[#999]">Select an entry to review its details, or add a new character, location, or established fact.</p></div></div>}
        </div>
      </section>

      <section className="mt-12 grid grid-cols-1 items-start gap-5 lg:grid-cols-2" aria-label="Publishing metadata">
        <form key={`identity-${formRevision}`} onSubmit={saveIdentity} onChange={() => setIdentityDirty(true)} className={panelClass}>
          <h2 className="text-xl font-medium">Book details</h2><p className="mt-2 text-sm leading-6 text-[#999]">The title and author shown throughout your workspace.</p>
          <fieldset disabled={!memory.canEdit || busy} className="mt-5 min-w-0 space-y-4">
            <label className="block text-xs text-[#bbb]">Title<input name="title" defaultValue={memory.book.title} required maxLength={300} className={inputClass} /></label>
            <label className="block text-xs text-[#bbb]">Subtitle<input name="subtitle" defaultValue={memory.book.subtitle ?? ""} maxLength={300} className={inputClass} /></label>
            <label className="block text-xs text-[#bbb]">Author or pen name<input name="authorName" defaultValue={memory.book.author_name} required maxLength={160} className={inputClass} /></label>
            <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-[#bbb]">Language code<input name="language" defaultValue={memory.book.language} required maxLength={35} className={inputClass} placeholder="en" /></label><label className="text-xs text-[#bbb]">Genre<input name="genre" defaultValue={memory.book.genre ?? ""} maxLength={120} className={inputClass} /></label></div>
            {memory.canEdit && <div className="flex items-center gap-3 pt-2"><button type="submit" className={primaryClass}>{saving === "identity" ? "Saving…" : "Save book details"}</button>{identityDirty && <span className="text-xs text-amber-200">Unsaved changes</span>}</div>}
          </fieldset>
        </form>
        <form key={`metadata-${formRevision}`} onSubmit={saveMetadata} className={panelClass}>
          <h2 className="text-xl font-medium">Publishing metadata</h2><p className="mt-2 text-sm leading-6 text-[#999]">Store your description and discovery terms. Retailer-specific checks run when you prepare a publishing package; saving here does not publish your book.</p>
          {memory.canEdit && <div className="mt-5 rounded-2xl border border-violet-300/20 bg-violet-300/[0.05] p-4 sm:p-5" aria-labelledby="metadata-draft-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 id="metadata-draft-title" className="font-[family-name:var(--font-instrument-serif)] text-2xl text-violet-50">AI metadata desk</h3><p id="metadata-draft-help" className="mt-1 max-w-xl text-xs leading-5 text-[#aaa]">Build a retailer-neutral proof from saved manuscript evidence. Count first, inspect the exact credit quote, then decide whether to generate. Nothing enters your metadata form without your review.</p></div>
              {!metadataQuoteIntent && <button type="button" onClick={() => void requestMetadataQuote()} disabled={busy || dirty || metadataRecoveryBlocked || metadataGenerationBlocked(pendingMetadata) || !metadataModels?.length} aria-describedby="metadata-draft-help" className={secondaryClass}>{generatingMetadata ? "Counting exact input…" : metadataQuoteStage === "complete" ? "Request a new quote" : metadataGenerationError ? "Retry quote request" : "Request token quote"}</button>}
              {metadataQuoteIntent && !["ready", "queued", "running", "review", "complete"].includes(metadataQuoteStage) && <button type="button" onClick={() => void requestMetadataQuote()} disabled={generatingMetadata || !!saving} aria-describedby="metadata-draft-help" className={secondaryClass}>{generatingMetadata ? "Checking request…" : "Resume same quote request"}</button>}
              {metadataRecoveryNotFound && metadataQuoteIntent && !metadataQuoteIntent.requestId && <button type="button" onClick={() => void requestMetadataQuote(true)} disabled={busy || dirty || metadataRecoveryBlocked} className={secondaryClass}>Retry saving original quote request</button>}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-[#bbb]">Generation model<select value={metadataModelId} onChange={(event) => setMetadataModelId(event.target.value)} disabled={generatingMetadata || Boolean(metadataQuoteIntent) || !metadataModels?.length} className={inputClass}><option value="">{metadataModels === null ? "Loading approved models…" : metadataModels.length ? "Choose a model" : "No approved pricing configured"}</option>{metadataModels?.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.model}</option>)}</select></label>
              <label className="text-xs text-[#bbb]">Description tone<select value={metadataTone} onChange={(event) => setMetadataTone(event.target.value)} disabled={generatingMetadata || Boolean(metadataQuoteIntent)} className={inputClass}><option value="compelling">Compelling</option><option value="warm">Warm</option><option value="literary">Literary</option><option value="direct">Direct</option><option value="playful">Playful</option></select></label>
              <label className="text-xs text-[#bbb] sm:col-span-2">Intended audience · optional<input value={metadataAudience} onChange={(event) => setMetadataAudience(event.target.value)} disabled={generatingMetadata || Boolean(metadataQuoteIntent)} maxLength={500} className={inputClass} placeholder="e.g. adult cozy-fantasy readers" /></label>
            </div>
            <fieldset disabled={generatingMetadata || Boolean(metadataQuoteIntent)} className="mt-4 rounded-xl border border-white/10 p-3">
              <legend className="px-2 text-xs text-[#bbb]">Saved chapters to read · choose up to five</legend>
              {!memory.chapters.some((chapter) => chapter.current_document_version_id) && <p className="text-xs text-amber-100">Save manuscript text before requesting a metadata quote.</p>}
              <div className="grid gap-2 sm:grid-cols-2">{memory.chapters.filter((chapter) => chapter.current_document_version_id).map((chapter) => <label key={chapter.id} className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm text-[#ddd] hover:bg-white/5"><input type="checkbox" checked={metadataChapterIds.includes(chapter.id)} disabled={!metadataChapterIds.includes(chapter.id) && metadataChapterIds.length >= 5} onChange={(event) => setMetadataChapterIds((current) => event.target.checked ? [...current, chapter.id] : current.filter((id) => id !== chapter.id))} className="size-4 accent-violet-300" /><span className="truncate">{chapter.title}</span></label>)}</div>
              {memory.chapters.filter((chapter) => chapter.current_document_version_id).length > 5 && <p className="mt-2 text-[11px] text-[#888]">The selected passages, book details, style guide, and Book Bible form the bounded quote context.</p>}
            </fieldset>
            <label className="mt-4 flex gap-3 rounded-xl border border-white/10 p-3 text-xs leading-5 text-[#ccc]"><input type="checkbox" checked={metadataCountConsent} onChange={(event) => setMetadataCountConsent(event.target.checked)} disabled={generatingMetadata || Boolean(metadataQuoteIntent)} className="mt-1 size-4 shrink-0 accent-violet-300" /><span>I agree to send the selected saved chapters, book details, style guide, and Book Bible to OpenAI for input-token counting. This step does not generate metadata. The exact credit quote will be shown before any generation starts.</span></label>
            {metadataQuoteIntent && metadataQuoteStage === "counting" && <p role="status" className="mt-3 text-xs text-amber-100">Quote request saved. Resume or check the same request if the response was interrupted; this will not create another generation.</p>}
            {metadataQuote && metadataQuote.status === "ready" && <article className="mt-4 rounded-xl border border-[var(--bookworm-proof-edge)] bg-[var(--bookworm-proof-paper)] p-4 text-[var(--bookworm-proof-ink)]" aria-labelledby="metadata-quote-title">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--bookworm-proof-muted)]">Publisher proof · exact before dispatch</p><h4 id="metadata-quote-title" className="mt-1 font-[family-name:var(--font-instrument-serif)] text-2xl">Review your quote</h4>
              <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-y border-[var(--bookworm-proof-edge)] py-3"><div><p className="text-xs text-[var(--bookworm-proof-muted)]">Maximum reservation</p><p className="font-[family-name:var(--font-instrument-serif)] text-4xl leading-none">{metadataQuote.reservedCredits.toLocaleString()} <span className="text-base">credits</span></p></div><div className="text-right text-xs text-[var(--bookworm-proof-muted)]"><p>{metadataQuote.model}</p><p>Quote expires {new Date(metadataQuote.expiresAt).toLocaleString()}</p></div></div>
              <p className="mt-3 text-xs leading-5 text-[var(--bookworm-proof-copy)]">Accepting starts one generation and reserves this amount. Final billing reconciles measured input/output usage; if the provider result cannot be confirmed, reserved credits stay held for review. Your saved metadata is never overwritten.</p>
              {metadataAcceptanceUncertain && <p role="status" className="mt-3 text-xs">Acceptance is unconfirmed. Refresh saved quote status before approving again.</p>}
              <label className="mt-3 flex gap-2 text-xs leading-5"><input type="checkbox" checked={metadataAcceptConsent} onChange={(event) => setMetadataAcceptConsent(event.target.checked)} disabled={busy || dirty || !memory.canEdit || metadataRecoveryBlocked || metadataAcceptanceUncertain} className="mt-1 size-4 shrink-0 accent-[#6453a5]" /><span>I confirm: reserve up to <strong>{metadataQuote.reservedCredits.toLocaleString()} credits</strong> and start this metadata generation.</span></label>
              <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void acceptMetadataQuote()} disabled={busy || dirty || !memory.canEdit || metadataRecoveryBlocked || metadataAcceptanceUncertain || !canAcceptMetadataQuote(metadataQuote, metadataAcceptConsent)} className="inline-flex min-h-11 items-center justify-center rounded-full bg-[var(--bookworm-proof-action)] px-5 py-2.5 text-sm font-semibold text-[var(--bookworm-proof-paper)] outline-none hover:brightness-125 focus-visible:ring-2 focus-visible:ring-[#6453a5] disabled:cursor-not-allowed disabled:opacity-50">{generatingMetadata ? "Accepting…" : `Accept quote · ${metadataQuote.reservedCredits.toLocaleString()} credits`}</button><button type="button" onClick={() => void requestMetadataQuote()} disabled={busy} className="min-h-11 rounded-full px-4 py-2 text-xs font-medium text-[var(--bookworm-proof-ink)] underline decoration-[var(--bookworm-proof-muted)] underline-offset-4 focus-visible:ring-2 focus-visible:ring-[#6453a5] disabled:opacity-50">Refresh saved quote status</button></div>
            </article>}
            {metadataQuoteIntent && ["queued", "running"].includes(metadataQuoteStage) && <div role="status" className="mt-4 rounded-xl border border-amber-200/20 bg-amber-100/5 p-3 text-sm text-amber-50"><p>Generation is {metadataQuoteStage}. The accepted quote is saved; refreshing status never sends another provider request.</p><button type="button" onClick={() => void requestMetadataQuote()} disabled={generatingMetadata || !!saving} className={`${secondaryClass} mt-3`}>Refresh saved result status</button></div>}
            {metadataQuoteIntent && metadataQuoteStage === "review" && <div role="alert" className="mt-4 rounded-xl border border-amber-200/20 bg-amber-100/5 p-3 text-sm text-amber-50">This accepted request needs review. Credits remain protected; do not retry generation. Use the request ID when contacting support: {metadataQuoteIntent.requestId}</div>}
            <div className="mt-4 border-t border-white/10 pt-4">
              {pendingMetadata === null && <p role="status" className="mb-3 text-xs text-amber-100">Verify saved request status before starting another generation. Load saved drafts to retry the check.</p>}
              {pendingMetadata && pendingMetadata.length > 0 && <div role="status" className="mb-3 text-sm text-amber-100"><p>You have an unresolved metadata request. Status checks never dispatch another generation.</p><ul className="mt-2 space-y-3 text-xs">{pendingMetadata.map((job) => <li key={job.id}>{job.status} · {new Date(job.createdAt).toLocaleString()} · request {job.id}<button type="button" disabled={busy} onClick={() => void refreshMetadataJob(job.id)} className={`${secondaryClass} mt-2 block`}>Refresh existing result</button></li>)}</ul><p className="mt-2 text-xs">Unknown provider outcomes remain held for review; age alone does not prove a charge can be safely released.</p></div>}
              <button type="button" onClick={() => void loadMetadataHistory()} disabled={busy} className={secondaryClass}>{saving === "metadata-history" ? "Loading saved drafts…" : "Load saved drafts · no credits"}</button>
              {metadataHistory && <div className="mt-3 space-y-2">
                <p className="text-xs text-[#aaa]">Latest 20 successful generations. These may reference older manuscript versions. Opening does not change your form or start generation.</p>
                {!metadataHistory.length && <p className="text-sm text-[#aaa]">No saved drafts found.</p>}
                {metadataHistory.map((draft) => <button key={draft.id} type="button" disabled={busy} onClick={() => { setMetadataCandidate(draft.candidate); setNotice("Saved draft opened for review. No generation credits used."); }} className="block w-full rounded-xl border border-white/15 p-3 text-left text-sm hover:bg-white/5 disabled:opacity-50"><span className="block text-xs text-[#999]">{new Date(draft.createdAt).toLocaleString()}</span><span className="mt-1 block">{draft.candidate.description.slice(0, 140)}{draft.candidate.description.length > 140 ? "…" : ""}</span></button>)}
              </div>}
            </div>
            <div aria-live="polite" aria-atomic="true">
              {generatingMetadata && <p role="status" className="mt-4 text-sm text-violet-100">Checking the saved request…</p>}
              {metadataGenerationError && <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{metadataGenerationError} Your saved metadata was not changed.</p>}
            </div>
            {metadataCandidate && <article className="mt-5 rounded-xl border border-white/15 bg-black/35 p-4" aria-labelledby="metadata-preview-title">
              <div className="flex flex-wrap items-center justify-between gap-2"><h4 id="metadata-preview-title" className="font-medium">Review generated draft</h4>{metadataCandidate.confidence !== undefined && <span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-[#bbb]">{Math.round(metadataCandidate.confidence * 100)}% confidence</span>}</div>
              <div className="mt-4"><h5 className="text-[11px] uppercase tracking-widest text-[#888]">Description</h5><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#ddd]">{metadataCandidate.description}</p></div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div><h5 className="text-[11px] uppercase tracking-widest text-[#888]">Keywords</h5><ul className="mt-2 flex flex-wrap gap-2">{metadataCandidate.keywords.map((keyword) => <li key={keyword} className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-[#ddd]">{keyword}</li>)}</ul></div>
                <div><h5 className="text-[11px] uppercase tracking-widest text-[#888]">Categories</h5><ul className="mt-2 space-y-1 text-sm text-[#ccc]">{metadataCandidate.categories.map((category) => <li key={category}>• {category}</li>)}</ul></div>
              </div>
              {metadataCandidate.audience && <div className="mt-4"><h5 className="text-[11px] uppercase tracking-widest text-[#888]">Audience</h5><p className="mt-1 text-sm text-[#ccc]">{metadataCandidate.audience}</p></div>}
              {metadataCandidate.rationale && <div className="mt-4"><h5 className="text-[11px] uppercase tracking-widest text-[#888]">Why this draft</h5><p className="mt-1 text-sm leading-6 text-[#aaa]">{metadataCandidate.rationale}</p></div>}
              <div className="mt-4 border-t border-white/10 pt-4"><h5 className="text-[11px] uppercase tracking-widest text-[#888]">Manuscript evidence</h5>{metadataCandidate.sourceRefs.length ? <ul className="mt-2 space-y-2">{metadataCandidate.sourceRefs.map((ref, index) => {
                const chapter = memory.chapters.find((item) => item.id === ref.chapterId);
                return <li key={JSON.stringify([bookId, ref.chapterId, ref.documentVersionId, ref.nodeId, ref.textHash, index])} className="min-w-0 text-xs leading-5 text-[#aaa]">
                  {isPinnedSourceRef(ref) ? <BibleSourcePassage bookId={bookId} citation={ref} title={chapter?.title ?? "Referenced chapter"} />
                    : <div className="rounded-lg border border-white/10 p-3"><p className="font-medium text-[#ddd]">{chapter?.title ?? "Referenced chapter"}</p><p className="mt-1">Chapter reference only. No exact passage has been pinned.</p></div>}
                  {ref.note && <p className="mt-1 break-words px-3">{ref.note}</p>}
                </li>;
              })}</ul> : <p className="mt-2 text-xs leading-5 text-amber-100">No source references were returned. Review the wording carefully against your manuscript before using it.</p>}</div>
              <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" disabled={busy} onClick={useMetadataCandidate} className={primaryClass}>Use this draft</button><button type="button" disabled={busy} onClick={() => setMetadataCandidate(null)} className={secondaryClass}>Dismiss</button><span className="text-xs text-[#888]">Using a draft does not save it.</span></div>
            </article>}
          </div>}
          <fieldset disabled={!memory.canEdit || busy} onChange={() => setMetadataDirty(true)} className="mt-5 min-w-0 space-y-4">
            <label className="block text-xs text-[#bbb]">Book description<textarea name="description" value={metadataFields.description} onChange={(event) => setMetadataFields((current) => ({ ...current, description: event.target.value }))} maxLength={20000} rows={6} className={inputClass} placeholder="Introduce the book to a potential reader." /></label>
            <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-[#bbb]">Keywords · one per line<textarea name="keywords" value={metadataFields.keywords} onChange={(event) => setMetadataFields((current) => ({ ...current, keywords: event.target.value }))} rows={4} className={inputClass} placeholder={"cozy fantasy\nfound family"} /></label><label className="text-xs text-[#bbb]">Categories · one per line<textarea name="categories" value={metadataFields.categories} onChange={(event) => setMetadataFields((current) => ({ ...current, categories: event.target.value }))} rows={4} className={inputClass} placeholder="Fiction / Fantasy" /></label></div>
            <label className="block text-xs text-[#bbb]">ISBN-13 · optional<input name="isbn13" defaultValue={memory.metadata?.isbn13 ?? ""} inputMode="numeric" pattern="[0-9]{13}" maxLength={13} className={inputClass} placeholder="13 digits, without hyphens" /><span className="mt-2 block leading-5 text-[#888]">Enter an ISBN you are entitled to use. A checksum check does not establish ownership or registration.</span></label>
            <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-[#bbb]">Edition<input name="edition" defaultValue={memory.metadata?.edition ?? ""} maxLength={100} className={inputClass} placeholder="First edition" /></label><label className="text-xs text-[#bbb]">Planned publication date<input type="date" name="publicationDate" defaultValue={memory.metadata?.publication_date ?? ""} className={`${inputClass} [color-scheme:dark]`} /></label></div>
            {memory.canEdit && <div className="flex items-center gap-3 pt-2"><button type="submit" className={primaryClass}>{saving === "metadata" ? "Saving…" : "Save metadata"}</button>{metadataDirty && <span className="text-xs text-amber-200">Unsaved changes</span>}</div>}
          </fieldset>
        </form>
      </section>
    </>}
  </main>;
}
