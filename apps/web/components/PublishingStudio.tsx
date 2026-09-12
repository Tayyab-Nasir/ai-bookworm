"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EditionConfig, PreflightResult, PublishingPackageJob, RenderedEditionResult, RetailerChannel } from "@bookworm/api-client";
import type { Asset, Book, Edition } from "@bookworm/types";
import { apiClient } from "./api";

const EDIT_ROLES = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
const FONTS = ["Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"] as const;
type Kind = "ebook" | "print";
type Channel = PreflightResult["requestedChannel"];
const CHANNEL_FORMATS: Record<RetailerChannel, Kind[]> = { kdp: ["ebook", "print"], apple: ["ebook"], barnesnoble: ["ebook", "print"], lulu: ["print"] };
const RTL_LANGUAGES = new Set(["ar", "arc", "dv", "fa", "he", "iw", "nqo", "ps", "sd", "ug", "ur", "yi"]);
const RTL_SCRIPTS = new Set(["arab", "hebr", "nkoo", "thaa"]);

export function resolveEditionTextDirection(language: string, preference: "auto" | "ltr" | "rtl"): "ltr" | "rtl" {
  if (preference === "ltr" || preference === "rtl") return preference;
  const parts = language.replaceAll("_", "-").split("-").filter(Boolean).map((part) => part.toLowerCase());
  return RTL_LANGUAGES.has(parts[0] ?? "") || parts.slice(1).some((part) => RTL_SCRIPTS.has(part)) ? "rtl" : "ltr";
}

interface FormState {
  kind: Kind; language: string; textDirection: "auto" | "ltr" | "rtl"; flow: "reflowable" | "fixed"; navigation: "toc" | "toc+landmarks" | "none";
  trimSize: "5x8" | "5.5x8.5" | "6x9" | "7x10" | "8.5x11"; bleed: number;
  top: number; bottom: number; inner: number; outer: number;
  bodyFont: typeof FONTS[number]; bodySize: number; headingFont: typeof FONTS[number]; headingSize: number;
  leading: number; paragraphSpacing: number; firstLineIndent: number; textAlign: "left" | "justify";
  numbering: "arabic" | "roman" | "none"; numberPosition: "bottom-center" | "bottom-outer" | "top-center"; startAt: number;
  coverAssetId: string; titleOnCover: boolean; subtitleOnCover: boolean; authorOnCover: boolean;
  textColor: string; overlay: number; qrEnabled: boolean; qrUrl: string; qrLabel: string;
  qrPosition: "bottom-left" | "bottom-right"; qrSize: number;
}

const DEFAULT_FORM: FormState = {
  kind: "ebook", language: "en", textDirection: "auto", flow: "reflowable", navigation: "toc+landmarks",
  trimSize: "6x9", bleed: 0, top: 0.75, bottom: 0.75, inner: 0.75, outer: 0.5,
  bodyFont: "Times-Roman", bodySize: 11, headingFont: "Helvetica-Bold", headingSize: 16,
  leading: 14, paragraphSpacing: 6, firstLineIndent: 0.25, textAlign: "justify",
  numbering: "arabic", numberPosition: "bottom-outer", startAt: 1, coverAssetId: "", titleOnCover: true,
  subtitleOnCover: true, authorOnCover: true, textColor: "#ffffff", overlay: 0.28,
  qrEnabled: false, qrUrl: "", qrLabel: "", qrPosition: "bottom-right", qrSize: 180,
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function formFromEdition(edition: Edition): FormState {
  const config = object(edition.edition_metadata_json);
  const cover = object(config.cover);
  const qr = object(cover.qr_code);
  const margins = object(config.margins);
  const typography = object(config.typography);
  const page = object(config.page_numbering);
  return {
    ...DEFAULT_FORM,
    kind: edition.type === "print" ? "print" : "ebook",
    language: edition.language ?? "en",
    textDirection: config.text_direction === "ltr" || config.text_direction === "rtl" ? config.text_direction : "auto",
    flow: config.flow === "fixed" ? "fixed" : "reflowable",
    navigation: config.navigation === "none" || config.navigation === "toc" ? config.navigation : "toc+landmarks",
    trimSize: ["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].includes(String(config.trim_size)) ? config.trim_size as FormState["trimSize"] : "6x9",
    bleed: number(config.bleed_in, 0),
    top: number(margins.top, 0.75), bottom: number(margins.bottom, 0.75), inner: number(margins.inner, 0.75), outer: number(margins.outer, 0.5),
    bodyFont: FONTS.includes(typography.body_font as FormState["bodyFont"]) ? typography.body_font as FormState["bodyFont"] : "Times-Roman",
    bodySize: number(typography.body_size_pt, 11),
    headingFont: FONTS.includes(typography.heading_font as FormState["headingFont"]) ? typography.heading_font as FormState["headingFont"] : "Helvetica-Bold",
    headingSize: number(typography.heading_size_pt, 16), leading: number(typography.leading, 14),
    paragraphSpacing: number(typography.paragraph_spacing_pt, 6), firstLineIndent: number(typography.first_line_indent_in, 0.25),
    textAlign: typography.text_align === "left" ? "left" : "justify",
    numbering: page.style === "roman" || page.style === "none" ? page.style : "arabic",
    startAt: number(page.start_at, 1),
    numberPosition: page.position === "bottom-center" || page.position === "top-center" ? page.position : "bottom-outer",
    coverAssetId: typeof cover.asset_id === "string" ? cover.asset_id : "",
    titleOnCover: cover.title_on_cover !== false, subtitleOnCover: cover.subtitle_on_cover !== false, authorOnCover: cover.author_on_cover !== false,
    textColor: typeof cover.text_color === "string" ? cover.text_color : "#ffffff", overlay: number(cover.overlay_opacity, 0.28),
    qrEnabled: qr.enabled === true, qrUrl: typeof qr.url === "string" ? qr.url : "", qrLabel: typeof qr.label === "string" ? qr.label : "",
    qrPosition: qr.position === "bottom-left" ? "bottom-left" : "bottom-right", qrSize: number(qr.size_px, 180),
  };
}

export function toConfig(form: FormState, savedConfig?: unknown): EditionConfig {
  const saved = object(savedConfig);
  const cover = {
    asset_id: form.coverAssetId || null,
    title_on_cover: form.titleOnCover, subtitle_on_cover: form.subtitleOnCover, author_on_cover: form.authorOnCover,
    text_color: form.textColor, overlay_opacity: form.overlay,
    qr_code: { enabled: form.qrEnabled, url: form.qrEnabled ? form.qrUrl : null, label: form.qrLabel || null, position: form.qrPosition, size_px: form.qrSize },
  };
  if (form.kind === "ebook") return {
    kind: "ebook", schema_version: "1.1.0", text_direction: form.textDirection, flow: form.flow, navigation: form.navigation, cover,
    image_policy: { max_width_px: 1600, max_bytes: 5 * 1024 * 1024, embed: true, allowed_formats: ["jpeg", "png", "gif"], ...(saved.kind === "ebook" ? object(saved.image_policy) : {}) },
    ...(saved.kind === "ebook" && saved.metadata_overrides ? { metadata_overrides: Object.fromEntries(Object.entries(object(saved.metadata_overrides)).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
  };
  return {
    kind: "print", schema_version: "1.1.0", text_direction: form.textDirection, trim_size: form.trimSize, bleed_in: form.bleed,
    margins: { top: form.top, bottom: form.bottom, inner: form.inner, outer: form.outer },
    typography: {
      body_font: form.bodyFont, body_size_pt: form.bodySize, heading_font: form.headingFont, heading_size_pt: form.headingSize,
      leading: form.leading, paragraph_spacing_pt: form.paragraphSpacing, first_line_indent_in: form.firstLineIndent, text_align: form.textAlign,
    },
    page_numbering: { style: form.numbering, start_at: form.startAt, position: form.numberPosition }, cover,
  };
}

const fieldClass = "mt-2 block w-full rounded-xl border border-white/10 bg-black/60 px-3 py-2.5 text-white outline-none focus:border-white/35";
const cardClass = "rounded-2xl border border-white/10 bg-white/[0.035] p-5";

export default function PublishingStudio({ bookId }: { bookId: string }) {
  const api = apiClient();
  const [book, setBook] = useState<Book | null>(null);
  const [role, setRole] = useState("viewer");
  const [editions, setEditions] = useState<Edition[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "render" | "preflight" | "package" | "history" | null>("load");
  const [channel, setChannel] = useState<Channel>("export");
  const [rendered, setRendered] = useState<RenderedEditionResult | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [publishingJobs, setPublishingJobs] = useState<PublishingPackageJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeEdition = editions.find((edition) => edition.id === activeId) ?? null;
  const editable = EDIT_ROLES.has(role);
  const coverAssets = useMemo(() => assets.filter((asset) => asset.mime_type.startsWith("image/") && asset.checksum !== "pending" && !asset.deleted_at), [assets]);
  const activePublishingJobs = useMemo(() => publishingJobs.filter((job) => !activeId || job.editionId === activeId), [publishingJobs, activeId]);
  const channelCompatible = channel === "export" || CHANNEL_FORMATS[channel].includes(form.kind);
  const resolvedDirection = resolveEditionTextDirection(form.language, form.textDirection);
  const rtlPrintUnsupported = form.kind === "print" && resolvedDirection === "rtl";
  const rtlCoverTextUnsupported = resolvedDirection === "rtl" && Boolean(form.coverAssetId) && (
    (form.titleOnCover && Boolean(book?.title))
    || (form.subtitleOnCover && Boolean(book?.subtitle))
    || (form.authorOnCover && Boolean(book?.author_name))
  );
  const renderBlocked = rtlPrintUnsupported || rtlCoverTextUnsupported;

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const [identity, editionResult, packageHistory] = await Promise.all([api.getBook(bookId), api.listEditions(bookId), api.listPublishingJobs(bookId)]);
      const assetResult = await api.listAssets(identity.book.workspace_id);
      setBook(identity.book); setRole(identity.role); setEditions(editionResult.editions); setAssets(assetResult.assets); setPublishingJobs(packageHistory.jobs);
      if (editionResult.editions[0]) { setActiveId(editionResult.editions[0].id); setForm(formFromEdition(editionResult.editions[0])); }
      else { setActiveId(null); setForm({ ...DEFAULT_FORM, language: identity.book.language }); }
      setDirty(false); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load publishing settings."); }
    finally { setBusy(null); }
  }, [api, bookId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    if (!editable || busy) return;
    setForm((current) => ({ ...current, [key]: value })); setDirty(true); setRendered(null); setPreflight(null); setNotice(null);
  };

  const selectEdition = (edition: Edition) => {
    if (busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    setActiveId(edition.id); setForm(formFromEdition(edition)); setDirty(false); setRendered(null); setPreflight(null); setError(null);
  };

  const newEdition = (kind: Kind) => {
    if (!editable || busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    setActiveId(null); setForm({ ...DEFAULT_FORM, kind, language: book?.language ?? "en" }); setDirty(true); setRendered(null); setPreflight(null); setError(null);
  };

  const save = async () => {
    if (!editable || busy) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const saved = activeEdition
        ? await api.updateEdition(activeEdition.id, { config: toConfig(form, activeEdition.edition_metadata_json), language: form.language, expectedUpdatedAt: activeEdition.updated_at })
        : await api.createEdition(bookId, { config: toConfig(form), language: form.language });
      setEditions((current) => [saved, ...current.filter((edition) => edition.id !== saved.id)]);
      setActiveId(saved.id); setForm(formFromEdition(saved)); setDirty(false); setNotice("Edition settings saved.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the edition."); }
    finally { setBusy(null); }
  };

  const render = async () => {
    if (!editable || !activeId || dirty || busy || renderBlocked) return;
    setBusy("render"); setError(null); setNotice(null); setRendered(null);
    try { const result = await api.renderEdition(activeId, { idempotencyKey: crypto.randomUUID() }); setRendered(result); setNotice("Private render completed."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Rendering failed."); }
    finally { setBusy(null); }
  };

  const validate = async () => {
    if (!editable || !activeId || dirty || busy || !channelCompatible) return;
    setBusy("preflight"); setError(null); setNotice(null); setPreflight(null);
    try { setPreflight(await api.runPreflight({ bookId, editionId: activeId, channel, idempotencyKey: crypto.randomUUID() })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Preflight failed."); }
    finally { setBusy(null); }
  };

  const createPackage = async () => {
    if (!editable || !activeId || dirty || busy || channel === "export" || !rendered || !preflight
      || preflight.requestedChannel !== channel || preflight.errors > 0 || !channelCompatible) return;
    setBusy("package"); setError(null); setNotice(null);
    try {
      const job = await api.createPublishingJob({
        bookId, editionId: activeId, channel, renderJobId: rendered.jobId,
        preflightJobId: preflight.jobId, idempotencyKey: crypto.randomUUID(),
      });
      setPublishingJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setNotice(`${channel} package is ready for manual submission.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create the retailer package."); }
    finally { setBusy(null); }
  };

  const refreshHistory = async () => {
    if (busy) return;
    setBusy("history"); setError(null);
    try { setPublishingJobs((await api.listPublishingJobs(bookId)).jobs); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh package history."); }
    finally { setBusy(null); }
  };

  const leave = (event: React.MouseEvent<HTMLAnchorElement>) => { if (dirty && !window.confirm("Leave and discard unsaved edition settings?")) event.preventDefault(); };
  return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div><Link href={`/books/${bookId}`} onClick={leave} className="text-sm text-white/50 hover:text-white">← Manuscript</Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Layout & publishing</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/55">Create EPUB or print-ready PDF editions, compose cover typography, and run retailer-specific preflight before manual submission.</p>
      </div>
      <Link href={book ? `/assets?ws=${book.workspace_id}` : "/assets"} onClick={leave} className="glass-ghost rounded-full px-4 py-2 text-sm">Manage artwork</Link>
    </div>
    {error && <div role="alert" className="mb-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-100">{error}</div>}
    {notice && <p role="status" className="mb-5 text-sm text-emerald-200">{notice}</p>}

    <fieldset disabled={Boolean(busy)} className="grid min-w-0 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className={`${cardClass} h-fit`}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">Editions</h2><span className="text-xs text-white/40">{editions.length}</span></div>
        <div className="mt-4 space-y-2">
          {editions.map((edition) => <button key={edition.id} type="button" onClick={() => selectEdition(edition)} className={`w-full rounded-xl border p-3 text-left text-sm ${activeId === edition.id ? "border-white/40 bg-white/10" : "border-white/10 hover:bg-white/5"}`}>
            <span className="block font-medium capitalize">{edition.type}</span><span className="text-xs text-white/45">{edition.language ?? "en"} · {edition.status}</span>
          </button>)}
          {!editions.length && busy !== "load" && <p className="py-3 text-sm text-white/45">No saved editions yet.</p>}
        </div>
        {editable && <div className="mt-5 grid grid-cols-2 gap-2 border-t border-white/10 pt-5">
          <button type="button" onClick={() => newEdition("ebook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New EPUB</button>
          <button type="button" onClick={() => newEdition("print")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New print</button>
        </div>}
      </aside>

      <div className="space-y-6">
        <section className={cardClass} aria-labelledby="edition-settings">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="edition-settings" className="text-xl font-semibold">Edition settings</h2><p className="mt-1 text-sm text-white/45">Changes are saved before rendering or validation.</p></div>
            <button type="button" onClick={() => void save()} disabled={!editable || Boolean(busy) || (!dirty && Boolean(activeId))} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "save" ? "Saving…" : "Save edition"}</button>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65">Format<select value={form.kind} onChange={(event) => update("kind", event.target.value as Kind)} disabled={Boolean(activeId)} className={fieldClass}><option value="ebook">EPUB ebook</option><option value="print">Print PDF</option></select></label>
            <label className="text-sm text-white/65">Language<input value={form.language} onChange={(event) => update("language", event.target.value)} maxLength={35} className={fieldClass} /></label>
            <label className="text-sm text-white/65">Text direction<select value={form.textDirection} onChange={(event) => update("textDirection", event.target.value as FormState["textDirection"])} className={fieldClass}><option value="auto">Auto from edition language</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>
            {form.kind === "ebook" ? <>
              <label className="text-sm text-white/65">Flow<select value={form.flow} onChange={(event) => update("flow", event.target.value as FormState["flow"])} className={fieldClass}><option value="reflowable">Reflowable</option><option value="fixed">Fixed layout</option></select></label>
              <label className="text-sm text-white/65">Navigation<select value={form.navigation} onChange={(event) => update("navigation", event.target.value as FormState["navigation"])} className={fieldClass}><option value="toc+landmarks">TOC + landmarks</option><option value="toc">TOC</option><option value="none">None</option></select></label>
            </> : <>
              <label className="text-sm text-white/65">Trim size<select value={form.trimSize} onChange={(event) => update("trimSize", event.target.value as FormState["trimSize"])} className={fieldClass}>{["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].map((size) => <option key={size}>{size}</option>)}</select></label>
              <label className="text-sm text-white/65">Bleed<select value={form.bleed} onChange={(event) => update("bleed", Number(event.target.value))} className={fieldClass}><option value={0}>No bleed</option><option value={0.125}>0.125 in</option></select></label>
              <label className="text-sm text-white/65">Body font<select value={form.bodyFont} onChange={(event) => update("bodyFont", event.target.value as FormState["bodyFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font}>{font}</option>)}</select></label>
              <label className="text-sm text-white/65">Heading font<select value={form.headingFont} onChange={(event) => update("headingFont", event.target.value as FormState["headingFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font}>{font}</option>)}</select></label>
              <label className="text-sm text-white/65">Body size (pt)<input type="number" min={7} max={24} step={0.5} value={form.bodySize} onChange={(event) => update("bodySize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Heading size (pt)<input type="number" min={10} max={48} value={form.headingSize} onChange={(event) => update("headingSize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Line spacing (pt)<input type="number" min={form.bodySize} max={36} step={0.5} value={form.leading} onChange={(event) => update("leading", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Paragraph spacing (pt)<input type="number" min={0} max={36} step={0.5} value={form.paragraphSpacing} onChange={(event) => update("paragraphSpacing", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">First-line indent (in)<input type="number" min={0} max={1} step={0.05} value={form.firstLineIndent} onChange={(event) => update("firstLineIndent", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Text alignment<select value={form.textAlign} onChange={(event) => update("textAlign", event.target.value as FormState["textAlign"])} className={fieldClass}><option value="justify">Justified</option><option value="left">Left</option></select></label>
              <label className="text-sm text-white/65">Page numbers<select value={form.numbering} onChange={(event) => update("numbering", event.target.value as FormState["numbering"])} className={fieldClass}><option value="arabic">Arabic</option><option value="roman">Roman</option><option value="none">None</option></select></label>
              <label className="text-sm text-white/65">Starting page number<input type="number" min={1} max={10000} step={1} value={form.startAt} onChange={(event) => update("startAt", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Number position<select value={form.numberPosition} onChange={(event) => update("numberPosition", event.target.value as FormState["numberPosition"])} className={fieldClass}><option value="bottom-outer">Bottom outer</option><option value="bottom-center">Bottom center</option><option value="top-center">Top center</option></select></label>
            </>}
          </div>
          {form.kind === "print" && <div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-5 sm:grid-cols-4">{(["top", "bottom", "inner", "outer"] as const).map((key) => <label key={key} className="text-sm capitalize text-white/65">{key} margin (in)<input type="number" min={0.25} max={2} step={0.05} value={form[key]} onChange={(event) => update(key, Number(event.target.value))} className={fieldClass} /></label>)}</div>}
          {rtlPrintUnsupported && <div role="status" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50"><p className="font-medium">RTL print PDF is not available with the current embedded fonts.</p><p className="mt-1 text-amber-100/80">Use an EPUB for this edition, or run preflight to record the requirement while a shaping-capable print font pipeline is added.</p></div>}
        </section>

        <section className={cardClass} aria-labelledby="cover-settings">
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
        </section>

        <section className={cardClass} aria-labelledby="export-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="export-title" className="text-xl font-semibold">Render & preflight</h2><p className="mt-1 text-sm text-white/45">Files stay private and use five-minute download links. Retailer submission is manual in this release.</p></div>
            <button type="button" onClick={() => void render()} disabled={!editable || !activeId || dirty || Boolean(busy) || renderBlocked} aria-describedby={renderBlocked ? "rtl-render-guidance" : undefined} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "render" ? "Rendering…" : `Render ${form.kind === "ebook" ? "EPUB" : "PDF"}`}</button></div>
          {dirty && <p className="mt-3 text-xs text-amber-200">Save these settings before rendering or validating.</p>}
          {renderBlocked && <p id="rtl-render-guidance" className="mt-3 text-sm text-amber-100">Rendering is disabled until the RTL typography requirement above is resolved. Preflight is still available.</p>}
          {rendered && <div className="mt-5 grid gap-4 md:grid-cols-2">{rendered.artifacts.map((artifact) => <div key={artifact.asset.id} className="rounded-xl border border-white/10 bg-black/40 p-4"><p className="text-sm font-medium">{artifact.asset.name}</p><p className="mt-1 text-xs text-white/40">{artifact.role} · {(artifact.asset.size_bytes / 1024).toFixed(0)} KB</p>{artifact.asset.mime_type === "image/png" ? <img src={artifact.download.url} alt="Rendered book cover" className="mt-3 max-h-80 w-full rounded-lg object-contain" /> : artifact.asset.mime_type === "application/pdf" ? <iframe title="Rendered print edition preview" src={artifact.download.url} className="mt-3 h-96 w-full rounded-lg bg-white" /> : null}<a href={artifact.download.url} download className="mt-3 inline-block text-sm underline">Download private file</a></div>)}</div>}
          <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-white/10 pt-5"><label className="min-w-52 flex-1 text-sm text-white/65">Preflight target<select value={channel} onChange={(event) => { setChannel(event.target.value as Channel); setPreflight(null); }} className={fieldClass}><option value="export">Universal export</option><option value="kdp">Amazon KDP</option><option value="apple">Apple Books</option><option value="barnesnoble">Barnes & Noble Press</option><option value="lulu">Lulu</option></select></label><button type="button" onClick={() => void validate()} disabled={!editable || !activeId || dirty || Boolean(busy) || !channelCompatible} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "preflight" ? "Checking…" : "Run preflight"}</button></div>
          {!channelCompatible && <p className="mt-3 text-sm text-amber-200">{channel === "apple" ? "Apple Books packages require an EPUB edition." : "Lulu packages require a print PDF edition."}</p>}
          {preflight && <div className="mt-5"><div className="flex flex-wrap gap-3 text-sm"><span className={`rounded-full px-3 py-1 ${preflight.errors ? "bg-red-400/15 text-red-100" : "bg-emerald-400/15 text-emerald-100"}`}>{preflight.errors} errors</span><span className="rounded-full bg-amber-300/10 px-3 py-1 text-amber-100">{preflight.warnings} warnings</span><span className="px-2 py-1 text-white/40">Rules {preflight.ruleVersion}</span></div>{preflight.findings.length ? <ul className="mt-4 space-y-2">{preflight.findings.map((finding, index) => <li key={`${finding.rule_id}:${finding.location}:${index}`} className="rounded-xl border border-white/10 p-3 text-sm"><span className="font-medium uppercase text-white/60">{finding.severity}</span> · {finding.message}<span className="mt-1 block text-xs text-white/35">{finding.rule_id}{finding.location ? ` · ${finding.location}` : ""}</span></li>)}</ul> : <p className="mt-4 text-sm text-emerald-200">No preflight findings for this target.</p>}</div>}
        </section>

        <section className={cardClass} aria-labelledby="package-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="package-title" className="text-xl font-semibold">Retailer export packages</h2><p className="mt-1 max-w-2xl text-sm text-white/45">Create a private ZIP from the exact saved render after a zero-error retailer preflight. The package is downloaded and submitted manually; this does not publish or track retailer review status.</p></div>
            <button type="button" onClick={() => void createPackage()} disabled={!editable || !activeId || dirty || Boolean(busy) || channel === "export" || !channelCompatible || !rendered || !preflight || preflight.requestedChannel !== channel || preflight.errors > 0} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "package" ? "Packaging…" : "Create retailer package"}</button></div>
          {channel === "export" && <p className="mt-4 text-sm text-white/55">Choose a retailer above to create its versioned package. Universal exports are the rendered EPUB/PDF files shown in the render section.</p>}
          {channel !== "export" && (!rendered || !preflight) && <p className="mt-4 text-sm text-white/55">Render this saved edition and run a {channel} preflight to enable packaging.</p>}
          {preflight?.errors ? <p className="mt-4 text-sm text-red-100">Resolve every preflight error, save, render, and validate again before packaging.</p> : null}

          <div className="mt-7 flex items-center justify-between border-t border-white/10 pt-5"><h3 className="font-medium">Package history</h3><button type="button" onClick={() => void refreshHistory()} disabled={Boolean(busy)} className="text-sm text-white/55 underline disabled:opacity-40">{busy === "history" ? "Refreshing…" : "Refresh"}</button></div>
          {activePublishingJobs.length ? <ul className="mt-4 space-y-3">{activePublishingJobs.map((job) => <li key={job.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium capitalize">{job.channel === "barnesnoble" ? "Barnes & Noble" : job.channel} package</p><p className="mt-1 text-xs text-white/40">{new Date(job.createdAt).toLocaleString()} · {job.ruleVersion ?? "rules pending"}</p></div><span className={`rounded-full px-3 py-1 text-xs ${job.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : job.status === "failed" ? "bg-red-400/15 text-red-100" : "bg-amber-300/10 text-amber-100"}`}>{job.status === "succeeded" ? "ready" : job.status}</span></div>
            {job.package ? <div className="mt-3 flex flex-wrap items-center gap-4 text-sm"><span className="text-white/55">{(job.package.asset.size_bytes / 1024).toFixed(0)} KB · SHA-256 {job.package.asset.checksum.slice(0, 12)}…</span><a href={job.package.download.url} download className="underline">Download private ZIP</a></div> : <p className="mt-3 text-sm text-white/45">{job.failureCode ? `Package failed: ${job.failureCode}` : "No downloadable package is available for this job."}</p>}
          </li>)}</ul> : <p className="mt-4 text-sm text-white/45">No retailer packages for this edition yet.</p>}
        </section>
      </div>
    </fieldset>
  </main>;
}
