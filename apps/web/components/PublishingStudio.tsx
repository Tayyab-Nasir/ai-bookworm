"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudiobookGooglePlayExportJob, AudiobookProjectResult, AudiobookVoice, PreflightResult, PublishingPackageJob, RenderedEditionResult, RetailerChannel } from "@bookworm/api-client";
import type { Asset, Book, Chapter, Edition } from "@bookworm/types";
import { apiClient } from "./api";
import ChapterAudioDownload from "./ChapterAudioDownload";
import NarrationQuoteStudio from "./NarrationQuoteStudio";
import SavedEpubReader from "./SavedEpubReader";

import { FONTS, fontLabel, DEFAULT_FORM, LAYOUT_PRESET_LABELS, isLayoutPresetId, applyLayoutPreset, resolveEditionRenderSafety, formFromEdition, toConfig, type FormState, type Kind, type LayoutPresetId } from "../lib/publishing-edition-form";
export { applyLayoutPreset, resolveEditionTextDirection, formFromEdition, toConfig } from "../lib/publishing-edition-form";

const EDIT_ROLES = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
type Channel = PreflightResult["requestedChannel"];
const CHANNEL_FORMATS: Record<RetailerChannel, Kind[]> = { kdp: ["ebook", "print"], apple: ["ebook"], barnesnoble: ["ebook", "print"], lulu: ["print"], googleplay: ["ebook"] };

const fieldClass = "mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-2.5 text-white outline-none focus:border-white/35";
const cardClass = "rounded-2xl border border-white/10 bg-white/[0.035] p-5";

export default function PublishingStudio({ bookId }: { bookId: string }) {
  const api = apiClient();
  const [book, setBook] = useState<Book | null>(null);
  const [role, setRole] = useState("viewer");
  const [editions, setEditions] = useState<Edition[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [narrationChapterId, setNarrationChapterId] = useState("");
  const [audiobookProjects, setAudiobookProjects] = useState<AudiobookProjectResult[]>([]);
  const [googlePlayExports, setGooglePlayExports] = useState<AudiobookGooglePlayExportJob[]>([]);
  const exportRequestKey = useRef<string | null>(null);
  const [googlePlayIdentifier, setGooglePlayIdentifier] = useState("");
  const [googlePlayCoverId, setGooglePlayCoverId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "render" | "preflight" | "package" | "history" | "audiobook" | null>("load");
  const [channel, setChannel] = useState<Channel>("export");
  const [rendered, setRendered] = useState<RenderedEditionResult | null>(null);
  const [readerRefreshKey, setReaderRefreshKey] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [publishingJobs, setPublishingJobs] = useState<PublishingPackageJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const currentBook = useRef(bookId); currentBook.current = bookId;
  const currentEdition = useRef(activeId); currentEdition.current = activeId;
  const viewEpoch = useRef(0);

  const activeEdition = editions.find((edition) => edition.id === activeId) ?? null;
  const currentIdentity = book?.id === bookId;
  const editable = currentIdentity && EDIT_ROLES.has(role);
  // Navigation invalidates replies, not durable work already accepted by the server.
  const captureView = () => {
    const version = viewEpoch.current;
    return () => currentIdentity && currentBook.current === bookId && viewEpoch.current === version;
  };
  const coverAssets = useMemo(() => assets.filter((asset) => asset.mime_type.startsWith("image/") && asset.checksum !== "pending" && !asset.deleted_at), [assets]);
  const activePublishingJobs = useMemo(() => publishingJobs.filter((job) => !activeId || job.editionId === activeId), [publishingJobs, activeId]);
  const channelCompatible = form.kind !== "audiobook" && (channel === "export" || CHANNEL_FORMATS[channel].includes(form.kind));
  const { paginated, rtlPrintUnsupported, rtlCoverTextUnsupported, renderBlocked } = resolveEditionRenderSafety(form, book, activeEdition?.edition_metadata_json);

  const load = useCallback(async () => {
    const version = ++viewEpoch.current;
    const valid = () => viewEpoch.current === version && currentBook.current === bookId;
    setBusy("load");
    setBook(null); setRole("viewer"); setEditions([]); setAssets([]); setChapters([]); setPublishingJobs([]);
    currentEdition.current = null; setActiveId(null); setForm(DEFAULT_FORM); setDirty(false); setError(null);
    setAudiobookProjects([]); setGooglePlayExports([]); setNarrationChapterId("");
    setRendered(null); setPreflight(null); setNotice(null); exportRequestKey.current = null;
    setGooglePlayIdentifier(""); setGooglePlayCoverId("");
    try {
      const [identity, editionResult, packageHistory, chapterResult] = await Promise.all([api.getBook(bookId), api.listEditions(bookId), api.listPublishingJobs(bookId), api.listChapters(bookId)]);
      if (!valid()) return;
      const assetResult = await api.listAssets(identity.book.workspace_id);
      if (!valid()) return;
      setBook(identity.book); setRole(identity.role); setEditions(editionResult.editions); setAssets(assetResult.assets); setPublishingJobs(packageHistory.jobs); setChapters(chapterResult.chapters);
      setNarrationChapterId(chapterResult.chapters[0]?.id ?? "");
      if (editionResult.editions[0]) {
        currentEdition.current = editionResult.editions[0].id;
        setActiveId(editionResult.editions[0].id); setForm(formFromEdition(editionResult.editions[0], identity.book.language));
        if (editionResult.editions[0].type === "audiobook") {
          const [projects, exports] = await Promise.all([
            api.listAudiobookProjects(editionResult.editions[0].id), api.listAudiobookGooglePlayExports(editionResult.editions[0].id),
          ]);
          if (!valid()) return;
          setAudiobookProjects(projects.projects); setGooglePlayExports(exports.jobs);
        } else { setAudiobookProjects([]); setGooglePlayExports([]); }
      }
      else { currentEdition.current = null; setActiveId(null); setForm({ ...DEFAULT_FORM, language: identity.book.language }); setGooglePlayExports([]); }
      setDirty(false); setError(null);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not load publishing settings."); }
    finally { if (valid()) setBusy(null); }
  }, [api, bookId]);

  useEffect(() => { void load(); return () => { ++viewEpoch.current; }; }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const hasActiveGooglePlayExport = googlePlayExports.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!activeId || form.kind !== "audiobook" || !hasActiveGooglePlayExport) return;
    const valid = captureView();
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.listAudiobookGooglePlayExports(activeId);
        if (active && valid()) setGooglePlayExports(result.jobs);
      } catch { /* Keep the last known job state visible; manual refresh remains available. */ }
      finally { pending = false; }
    };
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [bookId, activeId, api, form.kind, hasActiveGooglePlayExport]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (!editable || busy) return;
    setForm((current) => ({ ...current, [key]: value })); setDirty(true); setRendered(null); setPreflight(null); setNotice(null);
  };

  const selectEdition = (edition: Edition) => {
    if (busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    const version = ++viewEpoch.current;
    currentEdition.current = edition.id;
    const valid = () => version === viewEpoch.current && currentBook.current === bookId && currentEdition.current === edition.id;
    exportRequestKey.current = null;
    setGooglePlayIdentifier(""); setGooglePlayCoverId(""); setNotice(null);
    setActiveId(edition.id); setForm(formFromEdition(edition, book?.language)); setDirty(false); setRendered(null); setPreflight(null); setError(null);
    setAudiobookProjects([]); setGooglePlayExports([]);
    if (edition.type === "audiobook") void Promise.all([api.listAudiobookProjects(edition.id), api.listAudiobookGooglePlayExports(edition.id)])
      .then(([projects, exports]) => { if (valid()) { setAudiobookProjects(projects.projects); setGooglePlayExports(exports.jobs); } })
      .catch(() => { if (valid()) setError("Could not load audiobook history."); });
    else { setAudiobookProjects([]); setGooglePlayExports([]); }
  };

  const newEdition = (kind: Kind) => {
    if (!editable || busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    ++viewEpoch.current; currentEdition.current = null;
    exportRequestKey.current = null;
    setGooglePlayIdentifier(""); setGooglePlayCoverId(""); setNotice(null);
    setActiveId(null); setForm({ ...DEFAULT_FORM, kind, language: book?.language ?? "en" }); setDirty(true); setRendered(null); setPreflight(null); setError(null); setAudiobookProjects([]); setGooglePlayExports([]);
  };

  const save = async () => {
    if (!editable || busy) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const saved = activeEdition
        ? await api.updateEdition(activeEdition.id, { config: toConfig(form, activeEdition.edition_metadata_json), language: form.language, expectedUpdatedAt: activeEdition.updated_at })
        : await api.createEdition(bookId, { config: toConfig(form), language: form.language });
      if (!valid()) return;
      currentEdition.current = saved.id;
      setEditions((current) => [saved, ...current.filter((edition) => edition.id !== saved.id)]);
      setActiveId(saved.id); setForm(formFromEdition(saved, book?.language)); setDirty(false); setNotice("Edition settings saved.");
      if (saved.type === "audiobook") {
        const [projects, exports] = await Promise.all([api.listAudiobookProjects(saved.id), api.listAudiobookGooglePlayExports(saved.id)]);
        if (!valid()) return;
        setAudiobookProjects(projects.projects); setGooglePlayExports(exports.jobs);
      }
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not save the edition."); }
    finally { if (valid()) setBusy(null); }
  };

  const render = async () => {
    if (!editable || !activeId || dirty || busy || renderBlocked) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("render"); setError(null); setNotice(null); setRendered(null);
    try { const result = await api.renderEdition(activeId, { idempotencyKey: crypto.randomUUID() }); if (valid()) { setRendered(result); setReaderRefreshKey(result.jobId); setNotice("Private render completed."); } }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Rendering failed."); }
    finally { if (valid()) setBusy(null); }
  };

  const validate = async () => {
    if (!editable || !activeId || dirty || busy || !channelCompatible) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("preflight"); setError(null); setNotice(null); setPreflight(null);
    try { const result = await api.runPreflight({ bookId, editionId: activeId, channel, idempotencyKey: crypto.randomUUID() }); if (valid()) setPreflight(result); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Preflight failed."); }
    finally { if (valid()) setBusy(null); }
  };

  const createPackage = async () => {
    if (!editable || !activeId || dirty || busy || channel === "export" || !rendered || !preflight
      || preflight.requestedChannel !== channel || preflight.errors > 0 || !channelCompatible) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("package"); setError(null); setNotice(null);
    try {
      const job = await api.createPublishingJob({
        bookId, editionId: activeId, channel, renderJobId: rendered.jobId,
        preflightJobId: preflight.jobId, idempotencyKey: crypto.randomUUID(),
      });
      if (!valid()) return;
      setPublishingJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setNotice(`${channel} package is ready for manual submission.`);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not create the retailer package."); }
    finally { if (valid()) setBusy(null); }
  };

  const refreshHistory = async () => {
    if (busy) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("history"); setError(null);
    try { const result = await api.listPublishingJobs(bookId); if (valid()) setPublishingJobs(result.jobs); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not refresh package history."); }
    finally { if (valid()) setBusy(null); }
  };

  const refreshAudiobooks = async () => {
    if (!activeId || busy) return;
    const editionId = activeId, valid = captureView(); if (!valid()) return;
    setBusy("audiobook"); setError(null);
    try { const result = await api.listAudiobookProjects(editionId); if (valid()) setAudiobookProjects(result.projects); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not refresh audiobook progress."); }
    finally { if (valid()) setBusy(null); }
  };

  const exportGooglePlayAudiobook = async () => {
    if (!editable || !activeId || form.kind !== "audiobook" || dirty || busy || !googlePlayIdentifier.trim() || !googlePlayCoverId) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("audiobook"); setError(null); setNotice(null);
    try {
      const { job } = await api.createAudiobookGooglePlayExport(activeId, {
        identifier: googlePlayIdentifier.trim(), coverAssetId: googlePlayCoverId,
        idempotencyKey: exportRequestKey.current ?? (exportRequestKey.current = crypto.randomUUID()),
      });
      if (!valid()) return;
      exportRequestKey.current = null;
      setGooglePlayExports((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setNotice("Export queued. You can leave this page; progress and the private download will remain in export history.");
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not create the Google Play audio archive."); }
    finally { if (valid()) setBusy(null); }
  };

  const cancelGooglePlayExport = async (jobId: string) => {
    if (!editable || busy) return;
    const valid = captureView(); if (!valid()) return;
    setBusy("audiobook"); setError(null);
    try {
      const { job } = await api.cancelAudiobookGooglePlayExport(jobId);
      if (!valid()) return;
      setGooglePlayExports((current) => current.map((item) => item.id === job.id ? job : item));
      setNotice(job.status === "cancelled" ? "Export cancelled." : "Cancellation requested. The worker will stop at its next safe checkpoint.");
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not cancel the export."); }
    finally { if (valid()) setBusy(null); }
  };

  const refreshGooglePlayExports = async () => {
    if (!activeId || form.kind !== "audiobook") return;
    const valid = captureView(); if (!valid()) return;
    setError(null);
    try { const result = await api.listAudiobookGooglePlayExports(activeId); if (valid()) setGooglePlayExports(result.jobs); }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "Could not refresh export history."); }
  };

  const leave = (event: React.MouseEvent<HTMLAnchorElement>) => { if (dirty && !window.confirm("Leave and discard unsaved edition settings?")) event.preventDefault(); };
  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div><Link href={`/books/${bookId}`} onClick={leave} className="text-sm text-white/50 hover:text-white">← Manuscript</Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Layout & publishing</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/55">Create EPUB, print-ready PDF, or AI-narrated audiobook editions, then prepare private deliverables for distribution.</p>
      </div>
      <Link href={book ? `/assets?ws=${book.workspace_id}` : "/assets"} onClick={leave} className="glass-ghost rounded-full px-4 py-2 text-sm">Manage artwork</Link>
    </div>
    {error && <div role="alert" className="mb-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}
      {!currentIdentity && <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className="mt-3 block rounded-lg border border-red-200/30 px-3 py-2 underline disabled:opacity-40">Retry loading this book</button>}
    </div>}
    {notice && <p role="status" className="mb-5 text-sm text-emerald-200">{notice}</p>}

    <fieldset disabled={Boolean(busy) || !currentIdentity} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className={`${cardClass} h-fit`}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">Editions</h2><span className="text-xs text-white/40">{editions.length}</span></div>
        <div className="mt-4 space-y-2">
          {editions.map((edition) => <button key={edition.id} type="button" onClick={() => selectEdition(edition)} className={`w-full rounded-xl border p-3 text-left text-sm ${activeId === edition.id ? "border-white/40 bg-white/10" : "border-white/10 hover:bg-white/5"}`}>
            <span className="block font-medium capitalize">{edition.type}</span><span className="text-xs text-white/45">{edition.language ?? "en"} · {edition.status}</span>
          </button>)}
          {!editions.length && busy !== "load" && <p className="py-3 text-sm text-white/45">No saved editions yet.</p>}
        </div>
        {editable && <div className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-5">
          <button type="button" onClick={() => newEdition("ebook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New EPUB</button>
          <button type="button" onClick={() => newEdition("print")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New print</button>
          <button type="button" onClick={() => newEdition("audiobook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New audio</button>
        </div>}
      </aside>

      <div className="min-w-0 space-y-6">
        <section className={cardClass} aria-labelledby="edition-settings">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="edition-settings" className="text-xl font-semibold">Edition settings</h2><p className="mt-1 text-sm text-white/45">Changes are saved before rendering or validation.</p></div>
            <button type="button" onClick={() => void save()} disabled={!editable || Boolean(busy) || (!dirty && Boolean(activeId))} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "save" ? "Saving…" : "Save edition"}</button>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65">Format<select value={form.kind} onChange={(event) => update("kind", event.target.value as Kind)} disabled={Boolean(activeId)} className={fieldClass}><option value="ebook">EPUB ebook</option><option value="print">Print PDF</option><option value="audiobook">AI-narrated audiobook</option></select></label>
            <label className="text-sm text-white/65">Language<input value={form.language} onChange={(event) => update("language", event.target.value)} maxLength={35} className={fieldClass} /></label>
            {form.kind !== "audiobook" && <label className="text-sm text-white/65">Text direction<select value={form.textDirection} onChange={(event) => update("textDirection", event.target.value as FormState["textDirection"])} className={fieldClass}><option value="auto">Auto from effective language</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>}
            {form.kind === "ebook" && <>
              <label className="text-sm text-white/65">Flow<select value={form.flow} onChange={(event) => update("flow", event.target.value as FormState["flow"])} className={fieldClass}><option value="reflowable">Reflowable</option><option value="fixed">Fixed layout</option></select></label>
              <label className="text-sm text-white/65">Navigation<select value={form.navigation} onChange={(event) => update("navigation", event.target.value as FormState["navigation"])} className={fieldClass}><option value="toc+landmarks">Contents page + section landmarks</option><option value="toc">Contents page</option><option value="none">Reader navigation only (no contents page)</option></select></label>
              {form.flow === "fixed" && <p className="text-sm leading-relaxed text-amber-100/80 sm:col-span-2">Fixed layout uses the page size, margins and typography below. Pages become images with text alternatives; text is not selectable and cannot resize in the reader. Poppler is required on the rendering worker. Choose reflowable for adjustable text, broader script support and accessibility. Reader and retailer preview checks are still required.</p>}
            </>}
            {paginated && <>
              <div className="sm:col-span-2"><label htmlFor="layout-preset" className="text-sm text-white/65">Layout starter</label><select id="layout-preset" value="" onChange={(event) => {
                const presetId = event.target.value;
                if (!isLayoutPresetId(presetId)) return;
                setForm((current) => applyLayoutPreset(current, presetId));
                setDirty(true); setRendered(null); setPreflight(null); setError(null);
                setNotice("Layout starter applied. Review settings, then save and render a new proof.");
              }} disabled={!editable || Boolean(busy)} aria-describedby="layout-preset-help" className={fieldClass}>
                <option value="">Choose a starting layout</option>
                {(Object.entries(LAYOUT_PRESET_LABELS) as [LayoutPresetId, string][]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select><p id="layout-preset-help" className="mt-2 text-xs leading-relaxed text-white/45">Adjustable starting points, not retailer certification. They change trim, margins and typography only; cover, QR, bleed, page numbering and front matter stay as set. Save, render a proof and run preflight with your chosen publisher.</p></div>
              <label className="text-sm text-white/65">Trim size<select value={form.trimSize} onChange={(event) => update("trimSize", event.target.value as FormState["trimSize"])} className={fieldClass}>{["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].map((size) => <option key={size}>{size}</option>)}</select></label>
              {form.kind === "print" && <><label className="text-sm text-white/65">Bleed<select value={form.bleed} onChange={(event) => update("bleed", Number(event.target.value))} className={fieldClass}><option value={0}>No bleed</option><option value={0.125}>0.125 in</option></select></label>
              {form.bleed > 0 && <label className="text-sm text-white/65">Interior bleed edges<select value={form.bleedEdges} onChange={(event) => update("bleedEdges", event.target.value as FormState["bleedEdges"])} className={fieldClass}><option value="outer">Top, bottom and outer edge · KDP</option><option value="all">All four edges · Lulu</option></select></label>}
              <p className="text-xs text-white/45 sm:col-span-2">Margins below are measured from the finished trim edge. Bleed changes PDF page dimensions; it does not extend in-flow illustrations to the edge. Choose the setting required by your printer and re-render before packaging.</p></>}
              <label className="text-sm text-white/65">Body font<select value={form.bodyFont} onChange={(event) => update("bodyFont", event.target.value as FormState["bodyFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font} value={font}>{fontLabel(font)}</option>)}</select></label>
              <label className="text-sm text-white/65">Heading font<select value={form.headingFont} onChange={(event) => update("headingFont", event.target.value as FormState["headingFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font} value={font}>{fontLabel(font)}</option>)}</select></label>
              <p className="text-xs text-white/45 sm:col-span-2">Choose Bitstream Vera for both body and headings to embed every used font, including page numbers and DejaVu Sans Mono for code. Legacy Times, Helvetica and Courier retain their original behavior. Embedded fonts do not add RTL shaping.</p>
              <label className="text-sm text-white/65">Body size (pt)<input type="number" min={7} max={24} step={0.5} value={form.bodySize} onChange={(event) => update("bodySize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Heading size (pt)<input type="number" min={10} max={48} value={form.headingSize} onChange={(event) => update("headingSize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Line spacing (pt)<input type="number" min={form.bodySize} max={36} step={0.5} value={form.leading} onChange={(event) => update("leading", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Paragraph spacing (pt)<input type="number" min={0} max={36} step={0.5} value={form.paragraphSpacing} onChange={(event) => update("paragraphSpacing", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">First-line indent (in)<input type="number" min={0} max={1} step={0.05} value={form.firstLineIndent} onChange={(event) => update("firstLineIndent", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Text alignment<select value={form.textAlign} onChange={(event) => update("textAlign", event.target.value as FormState["textAlign"])} className={fieldClass}><option value="justify">Justified</option><option value="left">Left</option></select></label>
              {form.kind === "print" && <><label className="text-sm text-white/65">Page numbers<select value={form.numbering} onChange={(event) => update("numbering", event.target.value as FormState["numbering"])} className={fieldClass}><option value="arabic">Arabic</option><option value="roman">Roman</option><option value="none">None</option></select></label>
              <label className="text-sm text-white/65">Starting page number<input type="number" min={1} max={10000} step={1} value={form.startAt} onChange={(event) => update("startAt", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Number position<select value={form.numberPosition} onChange={(event) => update("numberPosition", event.target.value as FormState["numberPosition"])} className={fieldClass}><option value="bottom-outer">Bottom outer</option><option value="bottom-center">Bottom center</option><option value="top-center">Top center</option></select></label></>}
            </>}
            {form.kind === "audiobook" && <>
              <label className="text-sm text-white/65">Narrator voice<select value={form.voice} disabled={!editable} onChange={(event) => update("voice", event.target.value as AudiobookVoice)} className={fieldClass}>{["marin", "cedar", "coral", "ballad", "verse", "alloy", "ash", "echo", "sage", "shimmer"].map((voice) => <option key={voice} value={voice}>{voice}</option>)}{["fable", "onyx", "nova"].includes(form.voice) && <option value={form.voice}>{form.voice} · saved legacy voice (choose a supported voice for new narration)</option>}</select></label>
              <label className="text-sm text-white/65">Narration speed ({form.narrationSpeed.toFixed(2)}×)<input type="number" min={0.25} max={1.5} step={0.01} value={form.narrationSpeed} disabled={!editable} onChange={(event) => update("narrationSpeed", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65 sm:col-span-2">Voice direction<textarea value={form.narrationInstructions} onChange={(event) => update("narrationInstructions", event.target.value)} maxLength={2000} rows={3} className={fieldClass} placeholder="Describe pacing, tone, and pronunciation." /></label>
            </>}
          </div>
          {paginated && <><div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-5 sm:grid-cols-4">{(["top", "bottom", "inner", "outer"] as const).map((key) => <label key={key} className="text-sm capitalize text-white/65">{key} margin (in)<input type="number" min={0.25} max={2} step={0.05} value={form[key]} onChange={(event) => update(key, Number(event.target.value))} className={fieldClass} /></label>)}</div>{form.kind === "print" && form.numbering !== "none" && <p className="mt-3 text-xs leading-relaxed text-white/50">Leave at least 0.75 inches at the {form.numberPosition === "top-center" ? "top" : "bottom"} for page numbers. They stay half an inch inside the trimmed page, with space between the number and manuscript text.</p>}</>}
          {rtlPrintUnsupported && <div role="status" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50"><p className="font-medium">RTL print PDF and fixed EPUB are not available with the current fonts.</p><p className="mt-1 text-amber-100/80">Use a reflowable EPUB for this edition, or run preflight to record the requirement while a shaping-capable font pipeline is added.</p></div>}
        </section>

        {form.kind === "print" && <p className="text-sm leading-relaxed text-white/50">Bitstream Vera embeds body and heading fonts in the PDF, including bold and italic text. It supports a limited Latin character set. Preflight identifies unsupported characters before export. Inline code and page numbers still use standard PDF fonts.</p>}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="front-matter-settings">
          <h2 id="front-matter-settings" className="text-xl font-semibold">Title & copyright pages</h2>
          <p className="mt-1 text-sm text-white/45">Print includes a title page; EPUB can include one below. It uses your saved book title, subtitle and author. Add your own notice or publisher to include a copyright page, with the saved ISBN when available. This does not register copyright or assign an ISBN.</p>
          <div className="mt-5 grid gap-4">
            {form.kind === "print" && <label className="inline-flex items-center gap-2 text-sm text-white/65"><input type="checkbox" checked={form.printContents} onChange={(event) => update("printContents", event.target.checked)} />Include chapter contents (page references follow your numbering settings; changes affect the final page count)</label>}
            {form.kind === "ebook" && <label className="inline-flex items-center gap-2 text-sm text-white/65"><input type="checkbox" checked={form.ebookTitlePage} onChange={(event) => update("ebookTitlePage", event.target.checked)} />Include EPUB title page (leave off if your manuscript already contains one)</label>}
            <label className="text-sm text-white/65">Publisher or imprint<input value={form.publisher} maxLength={200} onChange={(event) => update("publisher", event.target.value)} className={fieldClass} /></label>
            <label className="text-sm text-white/65">Copyright notice<textarea value={form.copyrightNotice} maxLength={3000} rows={5} onChange={(event) => update("copyrightNotice", event.target.value)} className={fieldClass} placeholder="Enter the exact notice and permissions text you want printed." /></label>
          </div>
        </section>}
        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="cover-settings">
          <h2 id="cover-settings" className="text-xl font-semibold">Cover composition</h2><p className="mt-1 text-sm text-white/45">Choose private artwork; title, author, overlay, and optional QR are composed during rendering.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65">Cover artwork<select value={form.coverAssetId} onChange={(event) => update("coverAssetId", event.target.value)} className={fieldClass}><option value="">No cover artwork</option>{coverAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
            <label className="text-sm text-white/65">Text color<input type="color" value={form.textColor} onChange={(event) => update("textColor", event.target.value)} className={`${fieldClass} h-11 p-1`} /></label>
            <label className="text-sm text-white/65">Dark overlay ({Math.round(form.overlay * 100)}%)<input type="range" min={0} max={0.9} step={0.01} value={form.overlay} onChange={(event) => update("overlay", Number(event.target.value))} className="mt-4 w-full" /></label>
            <div className="flex flex-wrap items-center gap-4 pt-6 text-sm text-white/65">{(["titleOnCover", "subtitleOnCover", "authorOnCover"] as const).map((key) => <label key={key} className="inline-flex items-center gap-2"><input type="checkbox" checked={form[key]} onChange={(event) => update(key, event.target.checked)} />{key === "titleOnCover" ? "Title" : key === "subtitleOnCover" ? "Subtitle" : "Author"}</label>)}</div>
          </div>
          <label className="mt-5 inline-flex items-center gap-2 text-sm text-white/65"><input type="checkbox" checked={form.qrEnabled} onChange={(event) => update("qrEnabled", event.target.checked)} />Add QR code</label>
          {form.qrEnabled && <div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm text-white/65">HTTPS destination<input type="url" value={form.qrUrl} onChange={(event) => update("qrUrl", event.target.value)} placeholder="https://author.example/book" className={fieldClass} /></label><label className="text-sm text-white/65">QR label<input value={form.qrLabel} onChange={(event) => update("qrLabel", event.target.value)} maxLength={120} placeholder="Read more" className={fieldClass} /></label></div>}
          {rtlCoverTextUnsupported && <div role="status" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50"><p className="font-medium">RTL cover text cannot be safely composed with the current cover renderer.</p><p className="mt-1 text-amber-100/80">Turn off the selected title, subtitle, and author overlays for artwork-only cover output, or use a shaping-capable cover workflow.</p></div>}
        </section>}

        {form.kind === "print" && <section className={cardClass} aria-labelledby="paperback-cover-title">
          <h2 id="paperback-cover-title" className="text-xl font-semibold">Full paperback cover</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/50">Create one PDF with back cover, spine and front artwork. The spine follows your rendered page count; KDP profiles round an odd count up to the next even page. A blank area is reserved for your printer’s ISBN barcode.</p>
          <label className="mt-5 inline-flex items-center gap-2 text-sm text-white/70"><input type="checkbox" checked={form.wrapEnabled} onChange={(event) => update("wrapEnabled", event.target.checked)} />Create full cover PDF</label>
          {form.wrapEnabled && <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65 sm:col-span-2">Paper and printer<select value={form.wrapProfile} onChange={(event) => update("wrapProfile", event.target.value as FormState["wrapProfile"])} className={fieldClass}><option value="kdp-white">KDP · black ink, white paper</option><option value="kdp-cream">KDP · black ink, cream paper</option><option value="kdp-standard-color">KDP · standard color</option><option value="kdp-premium-color">KDP · premium color</option><option value="custom">Other printer · use its paperback template</option></select></label>
            {form.wrapProfile === "custom" && <><label className="text-sm text-white/65">Template spine width (in)<input type="number" min={0.01} max={3} step={0.0001} value={form.spineWidth} onChange={(event) => update("spineWidth", Number(event.target.value))} className={fieldClass} /></label><label className="text-sm text-white/65">Template page count<input type="number" min={1} max={2000} value={form.templatePages || ""} onChange={(event) => update("templatePages", Number(event.target.value))} className={fieldClass} /></label></>}
            <label className="text-sm text-white/65 sm:col-span-2">Back cover text<textarea rows={6} maxLength={3000} value={form.backText} onChange={(event) => update("backText", event.target.value)} className={fieldClass} placeholder="Introduce the book and give readers a reason to open it." /></label>
            <label className="text-sm text-white/65 sm:col-span-2">Spine text (optional)<input maxLength={200} value={form.spineText} onChange={(event) => update("spineText", event.target.value)} className={fieldClass} placeholder="Book title · Author" /></label>
            <label className="text-sm text-white/65">Back and spine background<input type="color" value={form.wrapBackground} onChange={(event) => update("wrapBackground", event.target.value)} className={`${fieldClass} h-11 p-1`} /></label>
            <label className="text-sm text-white/65">Back and spine text color<input type="color" value={form.wrapTextColor} onChange={(event) => update("wrapTextColor", event.target.value)} className={`${fieldClass} h-11 p-1`} /></label>
            <p className="text-xs leading-relaxed text-white/45 sm:col-span-2">Choose front artwork above, then save and render. KDP profiles calculate spine width automatically. Other printers require a matching template page count and spine width, with 0.125-inch outer bleed. Spine text must fit at 7 pt or larger. Review the PDF and your printer’s template before ordering a proof; hardcover and RTL covers need a separate workflow.</p>
          </div>}
        </section>}

        {form.kind === "audiobook" && book && <NarrationQuoteStudio workspaceId={book.workspace_id} bookId={bookId} editionId={activeId ?? ""}
          chapterId={narrationChapterId} chapters={chapters} voice={form.voice} speed={form.narrationSpeed} instructions={form.narrationInstructions}
          onChapterChange={setNarrationChapterId}
          onAccepted={() => void refreshAudiobooks()}
          canEdit={["owner", "admin", "editor", "writer"].includes(role)} disabled={!activeId || dirty || Boolean(busy)} />}
        {form.kind === "audiobook" && <section className={cardClass} aria-labelledby="audiobook-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="audiobook-title" className="text-xl font-semibold">Saved audio & delivery</h2><p className="mt-1 max-w-2xl text-sm text-white/45">Existing private narration, listening review and export history remain available. Prepare new narration through the chapter price review above; unquoted creation is retired.</p></div><button type="button" onClick={() => void refreshAudiobooks()} disabled={!activeId || Boolean(busy)} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "audiobook" ? "Working…" : "Refresh progress"}</button></div>
          <div className="mt-7 border-t border-white/10 pt-5"><h3 className="font-medium">Narration history</h3>{audiobookProjects.length ? <ul className="mt-4 space-y-4">{audiobookProjects.map((project) => <li key={project.id} className="rounded-xl border border-white/10 bg-black/30 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium">{chapters.find((chapter) => chapter.id === project.chapterId)?.title ?? "Saved chapter"}</p><p className="mt-1 text-xs text-white/40">{project.segmentCount} segments · {project.billingMode === "quoted" ? `Maximum budget: ${project.creditUnits.toLocaleString()} token credits` : `${project.creditUnits.toLocaleString()} legacy audio units`} · {project.voice}</p></div><span className={`rounded-full px-3 py-1 text-xs ${project.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : project.status === "failed" ? "bg-red-400/15 text-red-100" : "bg-amber-300/10 text-amber-100"}`}>{project.status}</span></div><ChapterAudioDownload projectId={project.id} ready={project.status === "succeeded"} /><div className="mt-4 grid gap-3 md:grid-cols-2">{project.segments.map((segment) => <div key={segment.index} className="rounded-lg border border-white/10 p-3"><p className="text-xs text-white/45">Part {segment.index + 1} · {segment.status}</p>{segment.download ? <><audio controls preload="none" src={segment.download.url} className="mt-2 w-full" /><a href={segment.download.url} download className="mt-2 inline-block text-xs underline">Download private MP3</a></> : <p className="mt-2 text-xs text-white/35">Audio will appear after the worker completes this segment.</p>}</div>)}</div></li>)}</ul> : <p className="mt-3 text-sm text-white/45">No narration has been queued for this edition.</p>}
            <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4"><h3 className="font-medium">Google Play export · private download</h3><p className="mt-1 text-sm text-white/45">Queue a durable, ordered ZIP for manual Partner Center upload. You can leave this page while it builds. Every current chapter must have narration, a saved QC report, and an approver’s exact-audio listening sign-off.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-sm text-white/65">ISBN-13 or publisher book ID<input value={googlePlayIdentifier} onChange={(event) => { setGooglePlayIdentifier(event.target.value); exportRequestKey.current = null; }} maxLength={64} autoComplete="off" className={fieldClass} placeholder="978… or your Google book ID" /></label>
                <label className="text-sm text-white/65">Audiobook cover<select value={googlePlayCoverId} onChange={(event) => { setGooglePlayCoverId(event.target.value); exportRequestKey.current = null; }} className={fieldClass}><option value="">Choose JPEG or PNG artwork</option>{coverAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label></div>
              <p className="mt-3 text-xs leading-relaxed text-amber-100/75">Google Play requires AI-narrated uploads to be labeled “Synthesized voice.” The package does not submit, publish, register an ISBN, or guarantee Partner Center eligibility. Verify cover resolution and current account/territory rules before upload.</p>
              <button type="button" onClick={() => void exportGooglePlayAudiobook()} disabled={!editable || !activeId || dirty || Boolean(busy) || !googlePlayIdentifier.trim() || !googlePlayCoverId || chapters.length === 0} className="glass-solid mt-4 rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{busy === "audiobook" ? "Queuing export…" : "Queue Google Play archive"}</button>
              <div className="mt-6 border-t border-white/10 pt-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">Export history</h4><button type="button" onClick={() => void refreshGooglePlayExports()} disabled={!activeId || Boolean(busy)} className="text-xs text-white/55 underline disabled:opacity-40">Refresh</button></div>
                {googlePlayExports.length ? <ul className="mt-3 space-y-3">{googlePlayExports.map((job) => {
                  const progress = Math.round((job.progressChapters / Math.max(1, job.progressTotal)) * 100);
                  const running = job.status === "queued" || job.status === "running";
                  return <li key={job.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">Google Play · {job.progressTotal} chapters</p><p className="mt-1 text-xs text-white/40">{new Date(job.createdAt).toLocaleString()}{job.archiveSizeBytes ? ` · ${(job.archiveSizeBytes / (1024 * 1024)).toFixed(1)} MiB` : ""}</p></div>
                      <span className={`rounded-full px-3 py-1 text-xs ${job.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : job.status === "failed" ? "bg-red-400/15 text-red-100" : job.status === "cancelled" ? "bg-white/10 text-white/55" : "bg-amber-300/10 text-amber-100"}`}>{job.status}</span></div>
                    {running && <div className="mt-3"><div className="flex justify-between text-xs text-white/45"><span>{job.status === "queued" ? "Waiting for an export worker" : "Assembling and verifying private files"}</span><span>{job.progressChapters}/{job.progressTotal} chapters</span></div><div role="progressbar" aria-label="Audiobook export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-emerald-200 transition-[width]" style={{ width: `${progress}%` }} /></div></div>}
                    {job.status === "failed" && <p className="mt-3 text-xs text-red-100">Export failed ({job.errorCode ?? "unknown_error"}). Correct the source or cover and queue a new attempt.</p>}
                    {job.status === "cancelled" && <p className="mt-3 text-xs text-white/45">This export was cancelled before completion.</p>}
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">{job.downloadUrl && job.synthesizedVoiceDisclosureRequired && <a href={job.downloadUrl} download className="font-medium underline">Download private ZIP</a>}
                      {job.totalDurationSeconds && <span className="text-xs text-white/45">{Math.floor(job.totalDurationSeconds / 60)} min · disclose “Synthesized voice” on upload</span>}
                      {running && <button type="button" onClick={() => void cancelGooglePlayExport(job.id)} disabled={!editable || Boolean(busy)} className="text-xs text-white/55 underline disabled:opacity-40">Cancel export</button>}</div>
                  </li>;
                })}</ul> : <p className="mt-3 text-sm text-white/45">No audiobook archives have been queued.</p>}
              </div>
            </div></div>
        </section>}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="export-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="export-title" className="text-xl font-semibold">Render & preflight</h2><p className="mt-1 text-sm text-white/45">Files stay private and use five-minute download links. Retailer submission is manual in this release.</p></div>
            <button type="button" onClick={() => void render()} disabled={!editable || !activeId || dirty || Boolean(busy) || renderBlocked} aria-describedby={renderBlocked ? "rtl-render-guidance" : undefined} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "render" ? "Rendering…" : `Render ${form.kind === "ebook" ? "EPUB" : "PDF"}`}</button></div>
          {dirty && <p className="mt-3 text-xs text-amber-200">Save these settings before rendering or validating.</p>}
          {renderBlocked && <p id="rtl-render-guidance" className="mt-3 text-sm text-amber-100">Rendering is disabled until the RTL typography requirement above is resolved. Preflight is still available.</p>}
          {rendered && <div className="mt-5 grid gap-4 md:grid-cols-2">{rendered.artifacts.map((artifact) => <div key={artifact.asset.id} className="rounded-xl border border-white/10 bg-black/40 p-4"><p className="text-sm font-medium">{artifact.asset.name}</p><p className="mt-1 text-xs text-white/40">{artifact.role} · {(artifact.asset.size_bytes / 1024).toFixed(0)} KB</p>{artifact.asset.mime_type === "image/png" ? <img src={artifact.download.url} alt="Rendered book cover" className="mt-3 max-h-80 w-full rounded-lg object-contain" /> : artifact.asset.mime_type === "application/pdf" ? <iframe title="Rendered print edition preview" src={artifact.download.url} className="mt-3 h-96 w-full rounded-lg bg-white" /> : null}<a href={artifact.download.url} download className="mt-3 inline-block text-sm underline">Download private file</a></div>)}</div>}
          <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-white/10 pt-5"><label className="min-w-52 flex-1 text-sm text-white/65">Preflight target<select value={channel} onChange={(event) => { setChannel(event.target.value as Channel); setPreflight(null); }} className={fieldClass}><option value="export">Universal export</option><option value="kdp">Amazon KDP</option><option value="apple">Apple Books</option><option value="barnesnoble">Barnes & Noble Press</option><option value="lulu">Lulu</option><option value="googleplay">Google Play Books</option></select></label><button type="button" onClick={() => void validate()} disabled={!editable || !activeId || dirty || Boolean(busy) || !channelCompatible} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "preflight" ? "Checking…" : "Run preflight"}</button></div>
          {!channelCompatible && <p className="mt-3 text-sm text-amber-200">{channel === "lulu" ? "Lulu packages require a print PDF edition." : channel === "googleplay" ? "Google Play Books packages require an EPUB edition with an embedded front cover." : channel === "apple" ? "Apple Books packages require an EPUB edition." : "Choose an edition supported by this retailer."}</p>}
          {channel === "googleplay" && channelCompatible && <p className="mt-3 text-xs leading-5 text-white/45">Single-title Partner Center handoff only. Run EpubCheck and inspect Google’s processed preview, pricing, territories, and Review tab before publishing. This does not submit the book.</p>}
          {preflight && <div className="mt-5"><div className="flex flex-wrap gap-3 text-sm"><span className={`rounded-full px-3 py-1 ${preflight.errors ? "bg-red-400/15 text-red-100" : "bg-emerald-400/15 text-emerald-100"}`}>{preflight.errors} errors</span><span className="rounded-full bg-amber-300/10 px-3 py-1 text-amber-100">{preflight.warnings} warnings</span><span className="px-2 py-1 text-white/40">Rules {preflight.ruleVersion}</span></div>{preflight.findings.length ? <ul className="mt-4 space-y-2">{preflight.findings.map((finding, index) => <li key={`${finding.rule_id}:${finding.location}:${index}`} className="rounded-xl border border-white/10 p-3 text-sm"><span className="font-medium uppercase text-white/60">{finding.severity}</span> · {finding.message}<span className="mt-1 block text-xs text-white/35">{finding.rule_id}{finding.location ? ` · ${finding.location}` : ""}</span></li>)}</ul> : <p className="mt-4 text-sm text-emerald-200">No preflight findings for this target.</p>}</div>}
        </section>}

        {currentIdentity && activeId && form.kind === "ebook" && <SavedEpubReader key={`${bookId}:${activeId}`} bookId={bookId} editionId={activeId} dirty={dirty} refreshKey={readerRefreshKey} />}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="package-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="package-title" className="text-xl font-semibold">Retailer export packages</h2><p className="mt-1 max-w-2xl text-sm text-white/45">Create a private ZIP from the exact saved render after a zero-error retailer preflight. The package is downloaded and submitted manually; this does not publish or track retailer review status.</p></div>
            <button type="button" onClick={() => void createPackage()} disabled={!editable || !activeId || dirty || Boolean(busy) || channel === "export" || !channelCompatible || !rendered || !preflight || preflight.requestedChannel !== channel || preflight.errors > 0} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "package" ? "Packaging…" : "Create retailer package"}</button></div>
          <p className="mt-3 text-xs leading-relaxed text-white/50">New packages include metadata.json with your saved listing text and README.txt with manual handoff steps. These are for your review, not an automatic retailer import. Older packages remain unchanged.</p>
          {channel === "export" && <p className="mt-4 text-sm text-white/55">Choose a retailer above to create its versioned package. Universal exports are the rendered EPUB/PDF files shown in the render section.</p>}
          {channel !== "export" && (!rendered || !preflight) && <p className="mt-4 text-sm text-white/55">Render this saved edition and run a {channel} preflight to enable packaging.</p>}
          {preflight?.errors ? <p className="mt-4 text-sm text-red-100">Resolve every preflight error, save, render, and validate again before packaging.</p> : null}

          <div className="mt-7 flex items-center justify-between border-t border-white/10 pt-5"><h3 className="font-medium">Package history</h3><button type="button" onClick={() => void refreshHistory()} disabled={Boolean(busy)} className="text-sm text-white/55 underline disabled:opacity-40">{busy === "history" ? "Refreshing…" : "Refresh"}</button></div>
          {activePublishingJobs.length ? <ul className="mt-4 space-y-3">{activePublishingJobs.map((job) => <li key={job.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium capitalize">{job.channel === "barnesnoble" ? "Barnes & Noble" : job.channel === "googleplay" ? "Google Play Books" : job.channel} package</p><p className="mt-1 text-xs text-white/40">{new Date(job.createdAt).toLocaleString()} · {job.ruleVersion ?? "rules pending"}</p></div><span className={`rounded-full px-3 py-1 text-xs ${job.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : job.status === "failed" ? "bg-red-400/15 text-red-100" : "bg-amber-300/10 text-amber-100"}`}>{job.status === "succeeded" ? "ready" : job.status}</span></div>
            {job.package ? <div className="mt-3 flex flex-wrap items-center gap-4 text-sm"><span className="text-white/55">{(job.package.asset.size_bytes / 1024).toFixed(0)} KB · SHA-256 {job.package.asset.checksum.slice(0, 12)}…</span><a href={job.package.download.url} download className="underline">Download private ZIP</a></div> : <p className="mt-3 text-sm text-white/45">{job.failureCode ? `Package failed: ${job.failureCode}` : "No downloadable package is available for this job."}</p>}
          </li>)}</ul> : <p className="mt-4 text-sm text-white/45">No retailer packages for this edition yet.</p>}
        </section>}
      </div>
    </fieldset>
  </main>;
}
