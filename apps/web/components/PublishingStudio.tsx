"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AudiobookProjectResult, AudiobookVoice, EditionConfig, PreflightResult, PublishingPackageJob, RenderedEditionResult, RetailerChannel } from "@bookworm/api-client";
import type { Asset, Book, Chapter, Edition } from "@bookworm/types";
import { apiClient } from "./api";
import ChapterAudioDownload from "./ChapterAudioDownload";

const EDIT_ROLES = new Set(["owner", "admin", "editor", "writer", "illustrator", "designer"]);
const FONTS = ["BookwormVera", "BookwormVera-Bold", "Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"] as const;
const fontLabel = (font: string) => font === "BookwormVera" ? "Bitstream Vera · embedded" : font === "BookwormVera-Bold" ? "Bitstream Vera Bold · embedded" : font;
type Kind = "ebook" | "print" | "audiobook";
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
  trimSize: "5x8" | "5.5x8.5" | "6x9" | "7x10" | "8.5x11"; bleed: number; bleedEdges: "all" | "outer";
  top: number; bottom: number; inner: number; outer: number;
  bodyFont: typeof FONTS[number]; bodySize: number; headingFont: typeof FONTS[number]; headingSize: number;
  leading: number; paragraphSpacing: number; firstLineIndent: number; textAlign: "left" | "justify";
  numbering: "arabic" | "roman" | "none"; numberPosition: "bottom-center" | "bottom-outer" | "top-center"; startAt: number;
  coverAssetId: string; titleOnCover: boolean; subtitleOnCover: boolean; authorOnCover: boolean;
  textColor: string; overlay: number; qrEnabled: boolean; qrUrl: string; qrLabel: string;
  qrPosition: "bottom-left" | "bottom-right"; qrSize: number;
  voice: AudiobookVoice; narrationInstructions: string; narrationSpeed: number;
  wrapEnabled: boolean; wrapProfile: "kdp-white" | "kdp-cream" | "kdp-standard-color" | "kdp-premium-color" | "custom";
  spineWidth: number; templatePages: number; backText: string; spineText: string; wrapBackground: string; wrapTextColor: string;
}

const DEFAULT_FORM: FormState = {
  kind: "ebook", language: "en", textDirection: "auto", flow: "reflowable", navigation: "toc+landmarks",
  trimSize: "6x9", bleed: 0, bleedEdges: "outer", top: 0.75, bottom: 0.75, inner: 0.75, outer: 0.5,
  bodyFont: "Times-Roman", bodySize: 11, headingFont: "Helvetica-Bold", headingSize: 16,
  leading: 14, paragraphSpacing: 6, firstLineIndent: 0.25, textAlign: "justify",
  numbering: "arabic", numberPosition: "bottom-outer", startAt: 1, coverAssetId: "", titleOnCover: true,
  subtitleOnCover: true, authorOnCover: true, textColor: "#ffffff", overlay: 0.28,
  qrEnabled: false, qrUrl: "", qrLabel: "", qrPosition: "bottom-right", qrSize: 180,
  voice: "marin", narrationInstructions: "Narrate naturally with clear chapter pacing and faithful pronunciation.", narrationSpeed: 1,
  wrapEnabled: false, wrapProfile: "kdp-white", spineWidth: 0.25, templatePages: 0,
  backText: "", spineText: "", wrapBackground: "#182528", wrapTextColor: "#ffffff",
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
  const wrap = object(config.wrap_cover);
  return {
    ...DEFAULT_FORM,
    kind: edition.type === "print" || edition.type === "audiobook" ? edition.type : "ebook",
    language: edition.language ?? "en",
    textDirection: config.text_direction === "ltr" || config.text_direction === "rtl" ? config.text_direction : "auto",
    flow: config.flow === "fixed" ? "fixed" : "reflowable",
    navigation: config.navigation === "none" || config.navigation === "toc" ? config.navigation : "toc+landmarks",
    trimSize: ["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].includes(String(config.trim_size)) ? config.trim_size as FormState["trimSize"] : "6x9",
    bleed: number(config.bleed_in, 0),
    bleedEdges: config.bleed_edges === "outer" ? "outer" : "all",
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
    voice: ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"].includes(String(config.voice)) ? config.voice as AudiobookVoice : "marin",
    narrationInstructions: typeof config.instructions === "string" ? config.instructions : DEFAULT_FORM.narrationInstructions,
    narrationSpeed: number(config.speed, 1),
    wrapEnabled: wrap.enabled === true,
    wrapProfile: ["kdp-white", "kdp-cream", "kdp-standard-color", "kdp-premium-color", "custom"].includes(String(wrap.profile)) ? wrap.profile as FormState["wrapProfile"] : "kdp-white",
    spineWidth: number(wrap.spine_width_in, 0.25), templatePages: number(wrap.expected_page_count, 0),
    backText: typeof wrap.back_text === "string" ? wrap.back_text : "", spineText: typeof wrap.spine_text === "string" ? wrap.spine_text : "",
    wrapBackground: typeof wrap.background_color === "string" ? wrap.background_color : "#182528",
    wrapTextColor: typeof wrap.text_color === "string" ? wrap.text_color : "#ffffff",
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
  if (form.kind === "audiobook") return {
    kind: "audiobook", schema_version: "1.0.0", voice: form.voice,
    instructions: form.narrationInstructions.trim() || null, speed: form.narrationSpeed,
  };
  return {
    kind: "print", schema_version: "1.1.0", text_direction: form.textDirection, trim_size: form.trimSize, bleed_in: form.bleed, bleed_edges: form.bleedEdges,
    margins: { top: form.top, bottom: form.bottom, inner: form.inner, outer: form.outer },
    typography: {
      body_font: form.bodyFont, body_size_pt: form.bodySize, heading_font: form.headingFont, heading_size_pt: form.headingSize,
      leading: form.leading, paragraph_spacing_pt: form.paragraphSpacing, first_line_indent_in: form.firstLineIndent, text_align: form.textAlign,
    },
    page_numbering: { style: form.numbering, start_at: form.startAt, position: form.numberPosition }, cover,
    wrap_cover: { enabled: form.wrapEnabled, profile: form.wrapProfile, spine_width_in: form.spineWidth,
      expected_page_count: form.templatePages || null, back_text: form.backText, spine_text: form.spineText,
      background_color: form.wrapBackground, text_color: form.wrapTextColor },
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
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [narrationChapterId, setNarrationChapterId] = useState("");
  const [audiobookProjects, setAudiobookProjects] = useState<AudiobookProjectResult[]>([]);
  const [aiDisclosureAccepted, setAiDisclosureAccepted] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "render" | "preflight" | "package" | "history" | "audiobook" | null>("load");
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
  const channelCompatible = form.kind !== "audiobook" && (channel === "export" || CHANNEL_FORMATS[channel].includes(form.kind));
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
      const [identity, editionResult, packageHistory, chapterResult] = await Promise.all([api.getBook(bookId), api.listEditions(bookId), api.listPublishingJobs(bookId), api.listChapters(bookId)]);
      const assetResult = await api.listAssets(identity.book.workspace_id);
      setBook(identity.book); setRole(identity.role); setEditions(editionResult.editions); setAssets(assetResult.assets); setPublishingJobs(packageHistory.jobs); setChapters(chapterResult.chapters);
      setNarrationChapterId(chapterResult.chapters[0]?.id ?? "");
      if (editionResult.editions[0]) {
        setActiveId(editionResult.editions[0].id); setForm(formFromEdition(editionResult.editions[0]));
        setAudiobookProjects(editionResult.editions[0].type === "audiobook" ? (await api.listAudiobookProjects(editionResult.editions[0].id)).projects : []);
      }
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
    setActiveId(edition.id); setForm(formFromEdition(edition)); setDirty(false); setRendered(null); setPreflight(null); setError(null); setAiDisclosureAccepted(false);
    if (edition.type === "audiobook") void api.listAudiobookProjects(edition.id).then((result) => setAudiobookProjects(result.projects)).catch(() => setError("Could not load audiobook history."));
    else setAudiobookProjects([]);
  };

  const newEdition = (kind: Kind) => {
    if (!editable || busy) return;
    if (dirty && !window.confirm("Discard unsaved edition settings?")) return;
    setActiveId(null); setForm({ ...DEFAULT_FORM, kind, language: book?.language ?? "en" }); setDirty(true); setRendered(null); setPreflight(null); setError(null); setAudiobookProjects([]); setAiDisclosureAccepted(false);
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
      if (saved.type === "audiobook") setAudiobookProjects((await api.listAudiobookProjects(saved.id)).projects);
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

  const generateAudiobook = async () => {
    if (!editable || !activeId || form.kind !== "audiobook" || dirty || busy || !narrationChapterId || !aiDisclosureAccepted) return;
    setBusy("audiobook"); setError(null); setNotice(null);
    try {
      const project = await api.createAudiobookProject(activeId, { chapterId: narrationChapterId, idempotencyKey: crypto.randomUUID(), aiDisclosureAccepted: true });
      setAudiobookProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setNotice(`Narration queued in ${project.segmentCount} private segment${project.segmentCount === 1 ? "" : "s"}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not queue audiobook narration."); }
    finally { setBusy(null); }
  };

  const refreshAudiobooks = async () => {
    if (!activeId || busy) return;
    setBusy("audiobook"); setError(null);
    try { setAudiobookProjects((await api.listAudiobookProjects(activeId)).projects); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh audiobook progress."); }
    finally { setBusy(null); }
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
        {editable && <div className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-5">
          <button type="button" onClick={() => newEdition("ebook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New EPUB</button>
          <button type="button" onClick={() => newEdition("print")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New print</button>
          <button type="button" onClick={() => newEdition("audiobook")} className="rounded-lg border border-white/15 px-3 py-2 text-xs">New audio</button>
        </div>}
      </aside>

      <div className="space-y-6">
        <section className={cardClass} aria-labelledby="edition-settings">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="edition-settings" className="text-xl font-semibold">Edition settings</h2><p className="mt-1 text-sm text-white/45">Changes are saved before rendering or validation.</p></div>
            <button type="button" onClick={() => void save()} disabled={!editable || Boolean(busy) || (!dirty && Boolean(activeId))} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "save" ? "Saving…" : "Save edition"}</button>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-white/65">Format<select value={form.kind} onChange={(event) => update("kind", event.target.value as Kind)} disabled={Boolean(activeId)} className={fieldClass}><option value="ebook">EPUB ebook</option><option value="print">Print PDF</option><option value="audiobook">AI-narrated audiobook</option></select></label>
            <label className="text-sm text-white/65">Language<input value={form.language} onChange={(event) => update("language", event.target.value)} maxLength={35} className={fieldClass} /></label>
            {form.kind !== "audiobook" && <label className="text-sm text-white/65">Text direction<select value={form.textDirection} onChange={(event) => update("textDirection", event.target.value as FormState["textDirection"])} className={fieldClass}><option value="auto">Auto from edition language</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>}
            {form.kind === "ebook" ? <>
              <label className="text-sm text-white/65">Flow<select value={form.flow} onChange={(event) => update("flow", event.target.value as FormState["flow"])} className={fieldClass}><option value="reflowable">Reflowable</option><option value="fixed">Fixed layout</option></select></label>
              <label className="text-sm text-white/65">Navigation<select value={form.navigation} onChange={(event) => update("navigation", event.target.value as FormState["navigation"])} className={fieldClass}><option value="toc+landmarks">TOC + landmarks</option><option value="toc">TOC</option><option value="none">None</option></select></label>
            </> : form.kind === "print" ? <>
              <label className="text-sm text-white/65">Trim size<select value={form.trimSize} onChange={(event) => update("trimSize", event.target.value as FormState["trimSize"])} className={fieldClass}>{["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].map((size) => <option key={size}>{size}</option>)}</select></label>
              <label className="text-sm text-white/65">Bleed<select value={form.bleed} onChange={(event) => update("bleed", Number(event.target.value))} className={fieldClass}><option value={0}>No bleed</option><option value={0.125}>0.125 in</option></select></label>
              {form.bleed > 0 && <label className="text-sm text-white/65">Interior bleed edges<select value={form.bleedEdges} onChange={(event) => update("bleedEdges", event.target.value as FormState["bleedEdges"])} className={fieldClass}><option value="outer">Top, bottom and outer edge · KDP</option><option value="all">All four edges · Lulu</option></select></label>}
              <p className="text-xs text-white/45 sm:col-span-2">Margins below are measured from the finished trim edge. Bleed changes PDF page dimensions; it does not extend in-flow illustrations to the edge. Choose the setting required by your printer and re-render before packaging.</p>
              <label className="text-sm text-white/65">Body font<select value={form.bodyFont} onChange={(event) => update("bodyFont", event.target.value as FormState["bodyFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font} value={font}>{fontLabel(font)}</option>)}</select></label>
              <label className="text-sm text-white/65">Heading font<select value={form.headingFont} onChange={(event) => update("headingFont", event.target.value as FormState["headingFont"])} className={fieldClass}>{FONTS.map((font) => <option key={font} value={font}>{fontLabel(font)}</option>)}</select></label>
              <p className="text-xs text-white/45 sm:col-span-2">Choose Bitstream Vera for both body and headings to embed every used font, including page numbers and DejaVu Sans Mono for code. Legacy Times, Helvetica and Courier retain their original behavior. Embedded fonts do not add RTL shaping.</p>
              <label className="text-sm text-white/65">Body size (pt)<input type="number" min={7} max={24} step={0.5} value={form.bodySize} onChange={(event) => update("bodySize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Heading size (pt)<input type="number" min={10} max={48} value={form.headingSize} onChange={(event) => update("headingSize", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Line spacing (pt)<input type="number" min={form.bodySize} max={36} step={0.5} value={form.leading} onChange={(event) => update("leading", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Paragraph spacing (pt)<input type="number" min={0} max={36} step={0.5} value={form.paragraphSpacing} onChange={(event) => update("paragraphSpacing", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">First-line indent (in)<input type="number" min={0} max={1} step={0.05} value={form.firstLineIndent} onChange={(event) => update("firstLineIndent", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Text alignment<select value={form.textAlign} onChange={(event) => update("textAlign", event.target.value as FormState["textAlign"])} className={fieldClass}><option value="justify">Justified</option><option value="left">Left</option></select></label>
              <label className="text-sm text-white/65">Page numbers<select value={form.numbering} onChange={(event) => update("numbering", event.target.value as FormState["numbering"])} className={fieldClass}><option value="arabic">Arabic</option><option value="roman">Roman</option><option value="none">None</option></select></label>
              <label className="text-sm text-white/65">Starting page number<input type="number" min={1} max={10000} step={1} value={form.startAt} onChange={(event) => update("startAt", Number(event.target.value))} className={fieldClass} /></label>
              <label className="text-sm text-white/65">Number position<select value={form.numberPosition} onChange={(event) => update("numberPosition", event.target.value as FormState["numberPosition"])} className={fieldClass}><option value="bottom-outer">Bottom outer</option><option value="bottom-center">Bottom center</option><option value="top-center">Top center</option></select></label>
            </> : <>
              <label className="text-sm text-white/65">Narrator voice<select value={form.voice} onChange={(event) => update("voice", event.target.value as AudiobookVoice)} className={fieldClass}>{["marin", "cedar", "coral", "ballad", "verse", "alloy", "ash", "echo", "fable", "onyx", "nova", "sage", "shimmer"].map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></label>
              <label className="text-sm text-white/65">Narration speed ({form.narrationSpeed.toFixed(2)}×)<input type="range" min={0.25} max={4} step={0.05} value={form.narrationSpeed} onChange={(event) => update("narrationSpeed", Number(event.target.value))} className="mt-4 w-full" /></label>
              <label className="text-sm text-white/65 sm:col-span-2">Voice direction<textarea value={form.narrationInstructions} onChange={(event) => update("narrationInstructions", event.target.value)} maxLength={2000} rows={3} className={fieldClass} placeholder="Describe pacing, tone, and pronunciation." /></label>
            </>}
          </div>
          {form.kind === "print" && <div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-5 sm:grid-cols-4">{(["top", "bottom", "inner", "outer"] as const).map((key) => <label key={key} className="text-sm capitalize text-white/65">{key} margin (in)<input type="number" min={0.25} max={2} step={0.05} value={form[key]} onChange={(event) => update(key, Number(event.target.value))} className={fieldClass} /></label>)}</div>}
          {rtlPrintUnsupported && <div role="status" className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50"><p className="font-medium">RTL print PDF is not available with the current embedded fonts.</p><p className="mt-1 text-amber-100/80">Use an EPUB for this edition, or run preflight to record the requirement while a shaping-capable print font pipeline is added.</p></div>}
        </section>

        {form.kind === "print" && <p className="text-sm leading-relaxed text-white/50">Bitstream Vera embeds body and heading fonts in the PDF, including bold and italic text. It supports a limited Latin character set. Preflight identifies unsupported characters before export. Inline code and page numbers still use standard PDF fonts.</p>}

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
          <p className="mt-2 text-sm leading-relaxed text-white/50">Create one PDF with back cover, spine and front artwork. The spine is sized against the actual rendered interior. A blank area is reserved for your printer’s ISBN barcode.</p>
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

        {form.kind === "audiobook" && <section className={cardClass} aria-labelledby="audiobook-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="audiobook-title" className="text-xl font-semibold">Chapter narration</h2><p className="mt-1 max-w-2xl text-sm text-white/45">Narration uses the exact saved chapter version, splits it into provider-safe segments, and stores every MP3 privately. One audio credit covers up to 1,000 source characters.</p></div><button type="button" onClick={() => void refreshAudiobooks()} disabled={!activeId || Boolean(busy)} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "audiobook" ? "Working…" : "Refresh progress"}</button></div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2"><label className="text-sm text-white/65">Saved chapter<select value={narrationChapterId} onChange={(event) => setNarrationChapterId(event.target.value)} className={fieldClass}><option value="">Choose a chapter</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.order_index + 1}. {chapter.title}</option>)}</select></label><div className="rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/55"><p>Voice: <span className="capitalize text-white">{form.voice}</span> · {form.narrationSpeed.toFixed(2)}×</p><p className="mt-1">Model: gpt-4o-mini-tts</p></div></div>
          <label className="mt-5 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] p-4 text-sm text-amber-50"><input type="checkbox" checked={aiDisclosureAccepted} onChange={(event) => setAiDisclosureAccepted(event.target.checked)} className="mt-1" /><span>I understand this is an AI-generated voice and will disclose that to listeners wherever required. Generation consumes paid audio credits and starts only after the server reserves enough capacity.</span></label>
          <button type="button" onClick={() => void generateAudiobook()} disabled={!editable || !activeId || dirty || Boolean(busy) || !narrationChapterId || !aiDisclosureAccepted} className="glass-solid mt-5 rounded-full px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{busy === "audiobook" ? "Queuing…" : "Generate chapter narration"}</button>
          {dirty && <p className="mt-3 text-xs text-amber-200">Save the voice settings before generating narration.</p>}
          <div className="mt-7 border-t border-white/10 pt-5"><h3 className="font-medium">Narration history</h3>{audiobookProjects.length ? <ul className="mt-4 space-y-4">{audiobookProjects.map((project) => <li key={project.id} className="rounded-xl border border-white/10 bg-black/30 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium">{chapters.find((chapter) => chapter.id === project.chapterId)?.title ?? "Saved chapter"}</p><p className="mt-1 text-xs text-white/40">{project.segmentCount} segments · {project.creditUnits} audio credits · {project.voice}</p></div><span className={`rounded-full px-3 py-1 text-xs ${project.status === "succeeded" ? "bg-emerald-400/15 text-emerald-100" : project.status === "failed" ? "bg-red-400/15 text-red-100" : "bg-amber-300/10 text-amber-100"}`}>{project.status}</span></div><ChapterAudioDownload projectId={project.id} ready={project.status === "succeeded"} /><div className="mt-4 grid gap-3 md:grid-cols-2">{project.segments.map((segment) => <div key={segment.index} className="rounded-lg border border-white/10 p-3"><p className="text-xs text-white/45">Part {segment.index + 1} · {segment.status}</p>{segment.download ? <><audio controls preload="none" src={segment.download.url} className="mt-2 w-full" /><a href={segment.download.url} download className="mt-2 inline-block text-xs underline">Download private MP3</a></> : <p className="mt-2 text-xs text-white/35">Audio will appear after the worker completes this segment.</p>}</div>)}</div></li>)}</ul> : <p className="mt-3 text-sm text-white/45">No narration has been queued for this edition.</p>}</div>
        </section>}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="export-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 id="export-title" className="text-xl font-semibold">Render & preflight</h2><p className="mt-1 text-sm text-white/45">Files stay private and use five-minute download links. Retailer submission is manual in this release.</p></div>
            <button type="button" onClick={() => void render()} disabled={!editable || !activeId || dirty || Boolean(busy) || renderBlocked} aria-describedby={renderBlocked ? "rtl-render-guidance" : undefined} className="glass-solid rounded-full px-5 py-2 text-sm font-semibold text-black disabled:opacity-40">{busy === "render" ? "Rendering…" : `Render ${form.kind === "ebook" ? "EPUB" : "PDF"}`}</button></div>
          {dirty && <p className="mt-3 text-xs text-amber-200">Save these settings before rendering or validating.</p>}
          {renderBlocked && <p id="rtl-render-guidance" className="mt-3 text-sm text-amber-100">Rendering is disabled until the RTL typography requirement above is resolved. Preflight is still available.</p>}
          {rendered && <div className="mt-5 grid gap-4 md:grid-cols-2">{rendered.artifacts.map((artifact) => <div key={artifact.asset.id} className="rounded-xl border border-white/10 bg-black/40 p-4"><p className="text-sm font-medium">{artifact.asset.name}</p><p className="mt-1 text-xs text-white/40">{artifact.role} · {(artifact.asset.size_bytes / 1024).toFixed(0)} KB</p>{artifact.asset.mime_type === "image/png" ? <img src={artifact.download.url} alt="Rendered book cover" className="mt-3 max-h-80 w-full rounded-lg object-contain" /> : artifact.asset.mime_type === "application/pdf" ? <iframe title="Rendered print edition preview" src={artifact.download.url} className="mt-3 h-96 w-full rounded-lg bg-white" /> : null}<a href={artifact.download.url} download className="mt-3 inline-block text-sm underline">Download private file</a></div>)}</div>}
          <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-white/10 pt-5"><label className="min-w-52 flex-1 text-sm text-white/65">Preflight target<select value={channel} onChange={(event) => { setChannel(event.target.value as Channel); setPreflight(null); }} className={fieldClass}><option value="export">Universal export</option><option value="kdp">Amazon KDP</option><option value="apple">Apple Books</option><option value="barnesnoble">Barnes & Noble Press</option><option value="lulu">Lulu</option></select></label><button type="button" onClick={() => void validate()} disabled={!editable || !activeId || dirty || Boolean(busy) || !channelCompatible} className="glass-ghost rounded-full px-5 py-2.5 text-sm disabled:opacity-40">{busy === "preflight" ? "Checking…" : "Run preflight"}</button></div>
          {!channelCompatible && <p className="mt-3 text-sm text-amber-200">{channel === "apple" ? "Apple Books packages require an EPUB edition." : "Lulu packages require a print PDF edition."}</p>}
          {preflight && <div className="mt-5"><div className="flex flex-wrap gap-3 text-sm"><span className={`rounded-full px-3 py-1 ${preflight.errors ? "bg-red-400/15 text-red-100" : "bg-emerald-400/15 text-emerald-100"}`}>{preflight.errors} errors</span><span className="rounded-full bg-amber-300/10 px-3 py-1 text-amber-100">{preflight.warnings} warnings</span><span className="px-2 py-1 text-white/40">Rules {preflight.ruleVersion}</span></div>{preflight.findings.length ? <ul className="mt-4 space-y-2">{preflight.findings.map((finding, index) => <li key={`${finding.rule_id}:${finding.location}:${index}`} className="rounded-xl border border-white/10 p-3 text-sm"><span className="font-medium uppercase text-white/60">{finding.severity}</span> · {finding.message}<span className="mt-1 block text-xs text-white/35">{finding.rule_id}{finding.location ? ` · ${finding.location}` : ""}</span></li>)}</ul> : <p className="mt-4 text-sm text-emerald-200">No preflight findings for this target.</p>}</div>}
        </section>}

        {form.kind !== "audiobook" && <section className={cardClass} aria-labelledby="package-title">
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
        </section>}
      </div>
    </fieldset>
  </main>;
}
