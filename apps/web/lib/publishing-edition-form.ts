import type { AudiobookVoice, EditionConfig } from "@bookworm/api-client";
import type { Book, Edition } from "@bookworm/types";

export const FONTS = ["BookwormVera", "BookwormVera-Bold", "Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"] as const;
export const fontLabel = (font: string) => font === "BookwormVera" ? "Bitstream Vera · embedded" : font === "BookwormVera-Bold" ? "Bitstream Vera Bold · embedded" : font;
export type Kind = "ebook" | "print" | "audiobook";
const RTL_LANGUAGES = new Set(["ar", "arc", "dv", "fa", "he", "iw", "nqo", "ps", "sd", "ug", "ur", "yi"]);
const RTL_SCRIPTS = new Set(["arab", "hebr", "nkoo", "thaa"]);

export function resolveEditionTextDirection(language: string, preference: "auto" | "ltr" | "rtl"): "ltr" | "rtl" {
  if (preference === "ltr" || preference === "rtl") return preference;
  const parts = language.replaceAll("_", "-").split("-").filter(Boolean).map((part) => part.toLowerCase());
  return RTL_LANGUAGES.has(parts[0] ?? "") || parts.slice(1).some((part) => RTL_SCRIPTS.has(part)) ? "rtl" : "ltr";
}

export interface FormState {
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
  copyrightNotice: string; publisher: string; ebookTitlePage: boolean; printContents: boolean;
}

export type LayoutPresetId = "trade-paperback" | "large-print" | "poetry";

type LayoutPresetFields = Pick<FormState,
  "trimSize" | "top" | "bottom" | "inner" | "outer" | "bodyFont" | "bodySize" | "headingFont" | "headingSize"
  | "leading" | "paragraphSpacing" | "firstLineIndent" | "textAlign"
>;

const LAYOUT_PRESETS: Record<LayoutPresetId, LayoutPresetFields> = {
  "trade-paperback": {
    trimSize: "6x9", top: 0.75, bottom: 0.75, inner: 0.8, outer: 0.6,
    bodyFont: "BookwormVera", bodySize: 11, headingFont: "BookwormVera-Bold", headingSize: 16,
    leading: 14.5, paragraphSpacing: 4, firstLineIndent: 0.25, textAlign: "justify",
  },
  "large-print": {
    trimSize: "6x9", top: 0.9, bottom: 0.9, inner: 0.9, outer: 0.7,
    bodyFont: "BookwormVera", bodySize: 16, headingFont: "BookwormVera-Bold", headingSize: 20,
    leading: 20, paragraphSpacing: 8, firstLineIndent: 0, textAlign: "left",
  },
  poetry: {
    trimSize: "6x9", top: 1, bottom: 1, inner: 0.9, outer: 0.65,
    bodyFont: "BookwormVera", bodySize: 12, headingFont: "BookwormVera-Bold", headingSize: 18,
    leading: 18, paragraphSpacing: 12, firstLineIndent: 0, textAlign: "left",
  },
};

export const LAYOUT_PRESET_LABELS: Record<LayoutPresetId, string> = {
  "trade-paperback": "Trade paperback",
  "large-print": "Large print (16 pt)",
  poetry: "Poetry (open spacing)",
};

export function isLayoutPresetId(value: string): value is LayoutPresetId {
  return Object.prototype.hasOwnProperty.call(LAYOUT_PRESETS, value);
}

export function applyLayoutPreset(form: FormState, presetId: LayoutPresetId): FormState {
  return { ...form, ...LAYOUT_PRESETS[presetId] };
}

export const DEFAULT_FORM: FormState = {
  kind: "ebook", language: "en", textDirection: "auto", flow: "reflowable", navigation: "toc+landmarks",
  trimSize: "6x9", bleed: 0, bleedEdges: "outer", top: 0.75, bottom: 0.75, inner: 0.75, outer: 0.5,
  bodyFont: "BookwormVera", bodySize: 11, headingFont: "BookwormVera-Bold", headingSize: 16,
  leading: 14, paragraphSpacing: 6, firstLineIndent: 0.25, textAlign: "justify",
  numbering: "arabic", numberPosition: "bottom-outer", startAt: 1, coverAssetId: "", titleOnCover: true,
  subtitleOnCover: true, authorOnCover: true, textColor: "#ffffff", overlay: 0.28,
  qrEnabled: false, qrUrl: "", qrLabel: "", qrPosition: "bottom-right", qrSize: 180,
  voice: "marin", narrationInstructions: "Narrate naturally with clear chapter pacing and faithful pronunciation.", narrationSpeed: 1,
  wrapEnabled: false, wrapProfile: "kdp-white", spineWidth: 0.25, templatePages: 0,
  backText: "", spineText: "", wrapBackground: "#182528", wrapTextColor: "#ffffff",
  copyrightNotice: "", publisher: "", ebookTitlePage: false, printContents: false,
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveEditionRenderSafety(form: FormState, book: Pick<Book, "title" | "subtitle" | "author_name" | "language"> | null, savedConfig?: unknown) {
  const config = toConfig(form, savedConfig);
  const editionLanguage = form.language.trim();
  const metadata = {
    title: book?.title, subtitle: book?.subtitle, author: book?.author_name,
    language: editionLanguage.length >= 2 && editionLanguage.length <= 35 ? editionLanguage : book?.language,
    ...(config.kind === "ebook" ? config.metadata_overrides : {}),
  };
  // Direction preference cannot waive shaping required by the effective language.
  const requiresShaping = form.kind !== "audiobook" && (resolveEditionTextDirection(metadata.language ?? "", "auto") === "rtl" || form.textDirection === "rtl");
  const paginated = form.kind === "print" || (form.kind === "ebook" && form.flow === "fixed");
  const rtlPrintUnsupported = paginated && requiresShaping;
  const rtlCoverTextUnsupported = requiresShaping && Boolean(form.coverAssetId) && (
    (form.titleOnCover && Boolean(metadata.title))
    || (form.subtitleOnCover && Boolean(metadata.subtitle))
    || (form.authorOnCover && Boolean(metadata.author))
  );
  return { paginated, rtlPrintUnsupported, rtlCoverTextUnsupported, renderBlocked: rtlPrintUnsupported || rtlCoverTextUnsupported };
}

export function formFromEdition(edition: Edition, fallbackLanguage = "en"): FormState {
  const config = object(edition.edition_metadata_json);
  const cover = object(config.cover);
  const qr = object(cover.qr_code);
  const layout = edition.type === "ebook" ? object(config.fixed_layout) : config;
  const margins = object(layout.margins);
  const typography = object(layout.typography);
  const embeddedDefaults = edition.type === "ebook" && !layout.typography;
  const page = object(config.page_numbering);
  const wrap = object(config.wrap_cover);
  const front = object(config.front_matter);
  return {
    ...DEFAULT_FORM,
    copyrightNotice: typeof front.copyright_notice === "string" ? front.copyright_notice : "",
    ebookTitlePage: config.include_title_page === true,
    printContents: config.include_table_of_contents === true,
    publisher: typeof front.publisher === "string" ? front.publisher : "",
    kind: edition.type === "print" || edition.type === "audiobook" ? edition.type : "ebook",
    language: edition.language ?? fallbackLanguage,
    textDirection: config.text_direction === "ltr" || config.text_direction === "rtl" ? config.text_direction : "auto",
    flow: config.flow === "fixed" ? "fixed" : "reflowable",
    navigation: config.navigation === "none" || config.navigation === "toc" ? config.navigation : "toc+landmarks",
    trimSize: ["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"].includes(String(layout.trim_size)) ? layout.trim_size as FormState["trimSize"] : "6x9",
    bleed: number(config.bleed_in, 0),
    bleedEdges: config.bleed_edges === "outer" ? "outer" : "all",
    top: number(margins.top, 0.75), bottom: number(margins.bottom, 0.75), inner: number(margins.inner, 0.75), outer: number(margins.outer, 0.5),
    bodyFont: FONTS.includes(typography.body_font as FormState["bodyFont"]) ? typography.body_font as FormState["bodyFont"] : embeddedDefaults ? "BookwormVera" : "Times-Roman",
    bodySize: number(typography.body_size_pt, 11),
    headingFont: FONTS.includes(typography.heading_font as FormState["headingFont"]) ? typography.heading_font as FormState["headingFont"] : embeddedDefaults ? "BookwormVera-Bold" : "Helvetica-Bold",
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
  const front_matter = { copyright_notice: form.copyrightNotice, publisher: form.publisher };
  const layout = {
    trim_size: form.trimSize,
    margins: { top: form.top, bottom: form.bottom, inner: form.inner, outer: form.outer },
    typography: {
      body_font: form.bodyFont, body_size_pt: form.bodySize, heading_font: form.headingFont, heading_size_pt: form.headingSize,
      leading: form.leading, paragraph_spacing_pt: form.paragraphSpacing, first_line_indent_in: form.firstLineIndent, text_align: form.textAlign,
    },
  };
  const cover = {
    asset_id: form.coverAssetId || null,
    title_on_cover: form.titleOnCover, subtitle_on_cover: form.subtitleOnCover, author_on_cover: form.authorOnCover,
    text_color: form.textColor, overlay_opacity: form.overlay,
    qr_code: { enabled: form.qrEnabled, url: form.qrEnabled ? form.qrUrl : null, label: form.qrLabel || null, position: form.qrPosition, size_px: form.qrSize },
  };
  if (form.kind === "ebook") return {
    kind: "ebook", schema_version: "1.1.0", text_direction: form.textDirection, flow: form.flow, navigation: form.navigation, cover, front_matter,
    include_title_page: form.ebookTitlePage,
    fixed_layout: layout,
    image_policy: { max_width_px: 1600, max_bytes: 5 * 1024 * 1024, embed: true, allowed_formats: ["jpeg", "png", "gif"], ...(saved.kind === "ebook" ? object(saved.image_policy) : {}) },
    ...(saved.kind === "ebook" && saved.metadata_overrides ? { metadata_overrides: Object.fromEntries(Object.entries(object(saved.metadata_overrides)).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
  };
  if (form.kind === "audiobook") return {
    kind: "audiobook", schema_version: "1.0.0", voice: form.voice,
    instructions: form.narrationInstructions.trim() || null, speed: form.narrationSpeed,
  };
  return {
    kind: "print", schema_version: "1.1.0", text_direction: form.textDirection, ...layout, bleed_in: form.bleed, bleed_edges: form.bleedEdges,
    include_table_of_contents: form.printContents,
    front_matter,
    page_numbering: { style: form.numbering, start_at: form.startAt, position: form.numberPosition }, cover,
    wrap_cover: { enabled: form.wrapEnabled, profile: form.wrapProfile, spine_width_in: form.spineWidth,
      expected_page_count: form.templatePages || null, back_text: form.backText, spine_text: form.spineText,
      background_color: form.wrapBackground, text_color: form.wrapTextColor },
  };
}
