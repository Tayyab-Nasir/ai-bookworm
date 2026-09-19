"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Book, BookBibleItem, BookMetadata } from "@bookworm/types";
import BookSearchPanel from "./BookSearchPanel";

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
const inputClass = "mt-2 w-full rounded-xl border border-white/15 bg-black px-3.5 py-3 text-sm text-white outline-none placeholder:text-[#737373] focus:border-white/50 focus:ring-2 focus:ring-white/15 disabled:opacity-60";
const primaryClass = "inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black outline-none transition hover:bg-[#dedede] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-50";
const secondaryClass = "inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-[#ddd] outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50";
const panelClass = "rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6";

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
  const [metadataTone, setMetadataTone] = useState("compelling");
  const [metadataAudience, setMetadataAudience] = useState("");
  const [metadataGenerationError, setMetadataGenerationError] = useState<string | null>(null);
  const [generatingMetadata, setGeneratingMetadata] = useState(false);
  const [metadataRequestKey, setMetadataRequestKey] = useState<string | null>(null);
  const [entryDirty, setEntryDirty] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const endpoint = `/books/${encodeURIComponent(bookId)}`;
  const dirty = identityDirty || metadataDirty || entryDirty;
  const busy = loading || !!saving || generatingMetadata;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await request<Memory>(`${endpoint}/memory`);
      setMemory(result); setDraft(null); setDeleting(null);
      setMetadataFields({
        description: result.metadata?.description ?? "",
        keywords: result.metadata?.keywords.join("\n") ?? "",
        categories: result.metadata?.categories.join("\n") ?? "",
      });
      setMetadataCandidate(null); setMetadataGenerationError(null); setMetadataRequestKey(null);
      setIdentityDirty(false); setMetadataDirty(false); setEntryDirty(false);
      setFormRevision((value) => value + 1);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);
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

  function chooseEntry(item?: BookBibleItem) {
    if (busy) return;
    if (entryDirty && !window.confirm("Discard the unsaved changes to this memory entry?")) return;
    setDraft(item ? entryDraft(item) : emptyDraft());
    setEntryDirty(false); setDeleting(null); setError(null); setNotice(null);
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

  async function generateMetadata() {
    if (!memory?.canEdit || busy) return;
    const idempotencyKey = metadataRequestKey ?? crypto.randomUUID();
    setMetadataRequestKey(idempotencyKey); setGeneratingMetadata(true); setMetadataGenerationError(null); setNotice(null);
    try {
      const result = await request<{ candidate: unknown; jobId?: string }>(`${endpoint}/metadata/generate`, "POST", {
        idempotencyKey,
        ...(metadataTone.trim() ? { tone: metadataTone.trim() } : {}),
        ...(metadataAudience.trim() ? { audience: metadataAudience.trim() } : {}),
      });
      if (!result.candidate) {
        throw new Error("The generation response is incomplete. Retry the same request to recover its draft.");
      }
      setMetadataCandidate(parseGeneratedMetadataCandidate(result.candidate));
      setMetadataRequestKey(null);
    } catch (reason) {
      if (metadataRequestCanRestart(reason)) setMetadataRequestKey(null);
      setMetadataGenerationError(messageOf(reason));
    }
    finally { setGeneratingMetadata(false); }
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
      <BookSearchPanel key={bookId} bookId={bookId} />
      {!memory.canEdit && <p className="mt-5 rounded-xl border border-white/15 p-4 text-sm text-[#ccc]">You have read-only access. An editor can update this book’s memory and metadata.</p>}
      <section className="mt-9" aria-labelledby="bible-title">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 id="bible-title" className="text-2xl font-medium tracking-tight">Book Bible</h2><p className="mt-2 text-sm text-[#999]">{memory.items.length} saved {memory.items.length === 1 ? "entry" : "entries"} · changes are saved only when you choose Save.</p></div>
          {memory.canEdit && <button type="button" disabled={!!saving} onClick={() => chooseEntry()} className={primaryClass}>Add memory entry</button>}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_180px]">
          <label className="text-xs text-[#aaa]">Search memory<input value={query} onChange={(event) => setQuery(event.target.value)} className={inputClass} placeholder="Name or description" type="search" /></label>
          <label className="text-xs text-[#aaa]">Entry type<select value={filter} onChange={(event) => setFilter(event.target.value)} className={inputClass}><option value="all">All types</option>{types.map((type) => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select></label>
        </div>
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(230px,0.8fr)_minmax(0,1.6fr)]">
          <div className="space-y-3">
            {!visibleItems.length && <div className={panelClass}><h3 className="font-medium">{memory.items.length ? "No matching entries" : "Start with a character or a fact"}</h3><p className="mt-2 text-sm leading-6 text-[#999]">{memory.items.length ? "Try a different name or type." : "Record appearance, personality, locations, and facts you want to keep consistent."}</p></div>}
            {visibleItems.map((item) => <button type="button" key={item.id} disabled={!!saving} onClick={() => chooseEntry(item)} aria-pressed={draft?.id === item.id} className={`block w-full rounded-2xl border p-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-white ${draft?.id === item.id ? "border-white/50 bg-white/[0.08]" : "border-white/10 bg-white/[0.025] hover:border-white/25"}`}>
              <span className="text-[10px] uppercase tracking-widest text-[#aaa]">{item.type}</span><h3 className="mt-2 break-words text-lg font-medium">{item.name}</h3><p className="mt-2 line-clamp-3 break-words text-sm leading-6 text-[#999]">{item.description || "No description yet."}</p>
            </button>)}
          </div>
          {draft ? <form onSubmit={saveEntry} className={panelClass}>
            <h3 className="text-xl font-medium">{draft.id ? "Memory details" : "New memory entry"}</h3>
            <fieldset disabled={!memory.canEdit || busy} className="mt-5 space-y-4">
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
              <div><h4 className="text-sm font-medium">Reference images</h4><p className="mt-1 text-xs leading-5 text-[#999]">Link completed image uploads from this workspace. Files stay in your asset library.</p>
                <div className="mt-3 max-h-44 space-y-2 overflow-y-auto">
                  {memory.imageAssets.map((asset) => <label key={asset.id} className="flex items-start gap-3 rounded-lg border border-white/10 p-3 text-sm text-[#bbb]"><input type="checkbox" checked={draft.imageAssetIds.includes(asset.id)} onChange={(event) => changeDraft({ imageAssetIds: event.target.checked ? [...draft.imageAssetIds, asset.id] : draft.imageAssetIds.filter((imageId) => imageId !== asset.id) })} className="mt-0.5 accent-white" /><span className="break-all">{asset.name}</span></label>)}
                  {!memory.imageAssets.length && <p className="text-sm text-[#888]">No completed image uploads yet.</p>}
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
            {deleting === selected?.id && selected && <div role="alert" className="mt-5 rounded-xl border border-red-400/30 p-4 text-sm text-red-100"><p>Delete “{selected.name}” from this book’s memory? This cannot be undone. Manuscript chapters and image files will remain.</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={!!saving} onClick={() => void deleteEntry(selected)} className="rounded-full bg-red-100 px-4 py-2 text-sm font-semibold text-red-950">{saving === "delete" ? "Deleting…" : "Confirm delete"}</button><button type="button" disabled={!!saving} onClick={() => setDeleting(null)} className={secondaryClass}>Keep entry</button></div></div>}
          </form> : <div className={`${panelClass} flex min-h-60 items-center justify-center text-center`}><div><h3 className="text-lg font-medium">Your story’s reference shelf</h3><p className="mt-3 max-w-sm text-sm leading-6 text-[#999]">Select an entry to review its details, or add a new character, location, or established fact.</p></div></div>}
        </div>
      </section>

      <section className="mt-12 grid items-start gap-5 lg:grid-cols-2" aria-label="Publishing metadata">
        <form key={`identity-${formRevision}`} onSubmit={saveIdentity} onChange={() => setIdentityDirty(true)} className={panelClass}>
          <h2 className="text-xl font-medium">Book details</h2><p className="mt-2 text-sm leading-6 text-[#999]">The title and author shown throughout your workspace.</p>
          <fieldset disabled={!memory.canEdit || busy} className="mt-5 space-y-4">
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
              <div><h3 id="metadata-draft-title" className="font-medium text-violet-50">AI metadata draft</h3><p id="metadata-draft-help" className="mt-1 max-w-xl text-xs leading-5 text-[#aaa]">Create a reviewed suggestion from this book’s saved manuscript and Book Bible. Generation uses AI credits. Nothing is added to the form or saved until you choose it.</p></div>
              <button type="button" onClick={() => void generateMetadata()} disabled={generatingMetadata || !!saving} aria-describedby="metadata-draft-help" className={secondaryClass}>{generatingMetadata ? "Generating draft…" : metadataGenerationError ? "Try generation again" : "Generate draft"}</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-[#bbb]">Description tone<select value={metadataTone} onChange={(event) => setMetadataTone(event.target.value)} disabled={generatingMetadata || Boolean(metadataRequestKey)} className={inputClass}><option value="compelling">Compelling</option><option value="warm">Warm</option><option value="literary">Literary</option><option value="direct">Direct</option><option value="playful">Playful</option></select></label>
              <label className="text-xs text-[#bbb]">Intended audience · optional<input value={metadataAudience} onChange={(event) => setMetadataAudience(event.target.value)} disabled={generatingMetadata || Boolean(metadataRequestKey)} maxLength={500} className={inputClass} placeholder="e.g. adult cozy-fantasy readers" /></label>
              {metadataRequestKey && !generatingMetadata && <p role="status" className="text-xs text-amber-100 sm:col-span-2">The previous request is not resolved yet. Retry to recover that draft using the same brief and request key, without starting another generation.</p>}
            </div>
            <div aria-live="polite" aria-atomic="true">
              {generatingMetadata && <p role="status" className="mt-4 text-sm text-violet-100">Reading saved book evidence and preparing a draft…</p>}
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
                return <li key={`${ref.chapterId}-${ref.nodeId ?? index}`} className="rounded-lg border border-white/10 p-3 text-xs leading-5 text-[#aaa]"><span className="font-medium text-[#ddd]">{chapter?.title ?? "Referenced chapter"}</span>{ref.note && <span> · {ref.note}</span>}<span className="block text-[#777]">{ref.documentVersionId ? "Pinned saved version" : "Chapter reference"}{ref.textHash ? ` · evidence ${ref.textHash.slice(0, 12)}…` : ""}</span></li>;
              })}</ul> : <p className="mt-2 text-xs leading-5 text-amber-100">No source references were returned. Review the wording carefully against your manuscript before using it.</p>}</div>
              <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" disabled={busy} onClick={useMetadataCandidate} className={primaryClass}>Use this draft</button><button type="button" disabled={busy} onClick={() => setMetadataCandidate(null)} className={secondaryClass}>Dismiss</button><span className="text-xs text-[#888]">Using a draft does not save it.</span></div>
            </article>}
          </div>}
          <fieldset disabled={!memory.canEdit || busy} onChange={() => setMetadataDirty(true)} className="mt-5 space-y-4">
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
