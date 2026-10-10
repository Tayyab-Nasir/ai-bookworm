import type { EpubReaderResource, EpubReaderResult, SavedEpubRender, SavedEpubSource } from "@bookworm/api-client";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const MiB = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const layouts = new Set(["reflowable", "pre-paginated"]);
const warnings = new Set(["active-content-removed", "unsupported-styles-ignored", "links-disabled", "unsupported-markup-removed"]);
const tags = new Set("section div p h1 h2 h3 h4 h5 h6 blockquote strong em b i u s del code pre br hr ul ol li table thead tbody tfoot tr td th caption figure figcaption aside span nav a img".split(" "));
const voidTags = new Set(["br", "hr", "img"]);
const encoder = new TextEncoder();
function fail(): never { throw new Error("The saved EPUB response could not be verified. Retry this saved export or download it for inspection."); }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

export const READER_IMAGE_BUDGET = 50 * MiB;
export const READER_DECODED_PIXEL_BUDGET = 40_000_000;
export const READER_RASTER_MARKUP_BUDGET = 96 * MiB;
export interface ReaderPreferences { font: "serif" | "sans"; size: number; leading: number }
export interface ReaderImageOccurrence { index: number; resourceIndex: number; alt: string; markupBytes: number }
interface RasterMarkupBudget { limit: number; used: number; selected: number; reserved: number; selectedRendered: boolean }
export interface RetainedReaderImage { url: string; sizeBytes: number; width: number; height: number }
export function retainReaderImage(current: ReadonlyMap<number, RetainedReaderImage>, index: number, url: string, sizeBytes: number, width: number, height: number): Map<number, RetainedReaderImage> {
  if (!integer(index, 0, 9999) || !integer(sizeBytes, 1, 25 * MiB) || !integer(width, 1, 7200) || !integer(height, 1, 7200) || width * height > READER_DECODED_PIXEL_BUDGET) fail();
  const next = new Map(current); next.delete(index);
  let retained = [...next.values()].reduce((sum, image) => sum + image.sizeBytes, 0);
  let pixels = [...next.values()].reduce((sum, image) => sum + image.width * image.height, 0);
  for (const [oldIndex, image] of next) {
    if (retained + sizeBytes <= READER_IMAGE_BUDGET && pixels + width * height <= READER_DECODED_PIXEL_BUDGET) break;
    next.delete(oldIndex); retained -= image.sizeBytes; pixels -= image.width * image.height;
  }
  next.set(index, { url, sizeBytes, width, height }); return next;
}

export function readerSourceKey(source: SavedEpubSource): string {
  return JSON.stringify([source.bookId, source.editionId, source.jobId, source.assetId, source.version, source.sha256, source.sizeBytes]);
}
export function assertReaderSource(value: unknown, expected?: SavedEpubSource): asserts value is SavedEpubSource {
  const source = object(value);
  if (!["bookId", "editionId", "jobId", "assetId"].every((key) => typeof source[key] === "string" && uuid.test(source[key] as string)) || source.version !== 1 || typeof source.sha256 !== "string" || !digest.test(source.sha256) || !integer(source.sizeBytes, 1, 150 * MiB)) fail();
  if (expected && readerSourceKey(value as SavedEpubSource) !== readerSourceKey(expected)) fail();
}
export function validateReaderHistory(value: unknown, bookId: string, editionId: string): SavedEpubRender[] {
  const result = object(value);
  if (!Array.isArray(result.renders) || result.renders.length > 2500) fail();
  const seen = new Set<string>();
  for (const entry of result.renders) {
    const render = object(entry); assertReaderSource(render.source);
    if (render.source.bookId !== bookId || render.source.editionId !== editionId || render.jobId !== render.source.jobId || seen.has(render.source.jobId) || !text(render.createdAt, 64) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(render.createdAt) || !Number.isFinite(Date.parse(render.createdAt))) fail();
    seen.add(render.source.jobId);
  }
  return result.renders as SavedEpubRender[];
}
function assertRaster(value: unknown): asserts value is EpubReaderResource {
  const resource = object(value);
  if (!integer(resource.index, 0, 9999) || !["image/png", "image/jpeg"].includes(resource.mimeType as string) || typeof resource.sha256 !== "string" || !digest.test(resource.sha256) || !integer(resource.sizeBytes, 1, 25 * MiB) || !integer(resource.width, 1, 7200) || !integer(resource.height, 1, 7200) || resource.width * resource.height > 40_000_000) fail();
}
function decoded(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) fail();
  const result = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isSafeInteger(code) || code > 0x10ffff || code === 0 || code >= 0xd800 && code <= 0xdfff) fail();
    return String.fromCodePoint(code);
  });
  if (!text(result, 12 * MiB)) fail();
  return result;
}
function validAttribute(tag: string, name: string, value: string): boolean {
  if (name === "lang") return /^[A-Za-z0-9-]{1,64}$/.test(value);
  if (name === "dir") return ["ltr", "rtl", "auto"].includes(value);
  if (name === "id") return /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value);
  if (name === "class") { const parts = value.split(" "); return parts.length > 0 && new Set(parts).size === parts.length && parts.every((part) => ["caption", "cover", "page-break"].includes(part)); }
  if (tag === "ol" && name === "start" || tag === "li" && name === "value") return /^-?\d{1,7}$/.test(value) && String(Number(value)) === value;
  if (["td", "th"].includes(tag) && ["colspan", "rowspan"].includes(name)) return /^\d+$/.test(value) && integer(Number(value), 1, 1000);
  if (tag === "th" && name === "scope") return ["row", "col", "rowgroup", "colgroup"].includes(value);
  if (tag === "img") {
    if (name === "alt") return encoder.encode(value).length <= MiB;
    if (name === "data-reader-resource") return /^(?:0|[1-9]\d*)$/.test(value) && integer(Number(value), 0, 9999);
    if (["width", "height"].includes(name)) return /^\d+$/.test(value) && integer(Number(value), 1, 7200);
    if (name === "data-reader-width-percent") return /^\d+$/.test(value) && integer(Number(value), 1, 100);
  }
  return false;
}

// Parse the service's deliberately small inert grammar and regenerate it. This is
// not a permissive HTML sanitizer: unknown markup/attributes fail closed.
function inertMarkup(html: string, resources: EpubReaderResource[], urls?: ReadonlyMap<number, string>, viewport?: { width: number; height: number }, occurrences?: ReaderImageOccurrence[], budget?: RasterMarkupBudget): string {
  const descriptors = new Map(resources.map((entry) => [entry.index, entry]));
  const referenced = new Set<number>(); const stack: string[] = []; const output: string[] = [];
  let cursor = 0; let nodes = 0; let fixedRoots = 0; let fixedImages = 0; let occurrenceIndex = 0;
  while (cursor < html.length) {
    if (html[cursor] !== "<") {
      const next = html.indexOf("<", cursor); const end = next < 0 ? html.length : next;
      const value = decoded(html.slice(cursor, end)); if (viewport && value.trim()) fail();
      output.push(escapeText(value)); cursor = end; continue;
    }
    const end = html.indexOf(">", cursor); if (end < 0) fail();
    const token = html.slice(cursor, end + 1); cursor = end + 1;
    const closing = /^<\/([a-z][a-z0-9]*)>$/.exec(token);
    if (closing) { if (stack.pop() !== closing[1]) fail(); output.push(token); continue; }
    const opening = /^<([a-z][a-z0-9]*)([\s\S]*)>$/.exec(token);
    if (!opening || !tags.has(opening[1])) fail();
    if (++nodes > 100_000) fail();
    const tag = opening[1]; const attrs: Record<string, string> = {}; let rest = opening[2];
    if (viewport) {
      if (tag === "div" && stack.length === 0 && fixedRoots++ === 0) { /* The parser emits one inert body wrapper. */ }
      else if (tag === "img" && stack.length === 1 && stack[0] === "div" && fixedImages++ === 0) { /* One saved raster page. */ }
      else fail();
    }
    while (rest.length) {
      const match = /^ ([a-z][a-z0-9-]*)="([^"<>]*)"/.exec(rest);
      if (!match || Object.hasOwn(attrs, match[1])) fail();
      const value = decoded(match[2]); if (!validAttribute(tag, match[1], value)) fail();
      attrs[match[1]] = value; rest = rest.slice(match[0].length);
    }
    if (!voidTags.has(tag)) { stack.push(tag); if (stack.length > 64) fail(); }
    if (tag === "img") {
      if (!Object.hasOwn(attrs, "data-reader-resource")) fail();
      const index = Number(attrs["data-reader-resource"]); if (!descriptors.has(index)) fail(); referenced.add(index);
      if (viewport && (Number(attrs.width) !== viewport.width || Number(attrs.height) !== viewport.height)) fail();
      const position = occurrenceIndex++;
      attrs["data-reader-occurrence"] = String(position);
      if (!viewport && attrs["data-reader-width-percent"]) attrs.style = `width:${Number(attrs["data-reader-width-percent"])}%`;
      const markupBytes = encoder.encode(`<img${Object.entries(attrs).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")}>`).length;
      occurrences?.push({ index: position, resourceIndex: index, alt: attrs.alt ?? "", markupBytes });
      if (urls && !urls.has(index)) {
        output.push(`<span class="reader-placeholder">Illustration ${index + 1} is not loaded. Occurrence ${position + 1}. Use the illustration controls above to load it.${attrs.alt ? ` ${escapeText(attrs.alt)}` : ""}</span>`); continue;
      }
      if (urls && budget) {
        // Account before joining/copying the URI. Repeated saved references may
        // otherwise amplify one small descriptor into an enormous srcDoc.
        const bytes = markupBytes + urls.get(index)!.length + 7;
        const reserve = position === budget.selected || budget.selectedRendered ? 0 : budget.reserved;
        if (budget.used + bytes + reserve > budget.limit) {
          output.push(`<span class="reader-placeholder" data-reader-deferred="1" data-reader-occurrence="${position}">Occurrence ${position + 1} is deferred by the raster-markup budget. Select this occurrence above to inspect Illustration ${index + 1}.${attrs.alt ? ` ${escapeText(attrs.alt)}` : ""}</span>`); continue;
        }
        budget.used += bytes; if (position === budget.selected) budget.selectedRendered = true;
      }
      if (urls) attrs.src = urls.get(index)!;
    }
    output.push(`<${tag}${Object.entries(attrs).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")}>`);
  }
  if (stack.length || referenced.size !== descriptors.size || viewport && (fixedRoots !== 1 || fixedImages !== 1)) fail();
  return output.join("");
}
export function validateReaderSection(value: unknown, source: SavedEpubSource, index: number): EpubReaderResult {
  const result = object(value); assertReaderSource(result.source, source);
  if (result.formatVersion !== "epub-reader-1.0.0" || !layouts.has(result.layout as string) || !Array.isArray(result.spine) || result.spine.length < 1 || result.spine.length > 2500 || !integer(index, 0, result.spine.length - 1)) fail();
  result.spine.forEach((value, position) => { const item = object(value); if (item.index !== position || !text(item.title) || !layouts.has(item.layout as string)) fail(); });
  const document = object(result.document); const selected = object(result.spine[index]);
  if (document.index !== index || document.title !== selected.title || document.layout !== selected.layout || !["ltr", "rtl"].includes(document.direction as string) || !text(document.html, 12 * MiB) || encoder.encode(document.html).length > 12 * MiB || !Array.isArray(document.resources) || document.resources.length > 10_000 || !Array.isArray(result.warnings) || result.warnings.length > warnings.size || new Set(result.warnings).size !== result.warnings.length || !result.warnings.every((code) => warnings.has(code as string))) fail();
  const seen = new Set<number>();
  for (const entry of document.resources) { assertRaster(entry); if (seen.has(entry.index)) fail(); seen.add(entry.index); }
  if (document.layout === "pre-paginated") {
    if (!integer(document.width, 1, 7200) || !integer(document.height, 1, 7200) || document.resources.length !== 1) fail();
    const resource = document.resources[0] as EpubReaderResource;
    if (document.width !== resource.width || document.height !== resource.height) fail();
    inertMarkup(document.html, document.resources as EpubReaderResource[], undefined, { width: document.width, height: document.height });
  } else if (document.width !== undefined || document.height !== undefined) fail();
  else inertMarkup(document.html, document.resources as EpubReaderResource[]);
  return value as EpubReaderResult;
}
export function readerImageOccurrences(section: EpubReaderResult): ReaderImageOccurrence[] {
  validateReaderSection(section, section.source, section.document.index);
  const occurrences: ReaderImageOccurrence[] = [];
  inertMarkup(section.document.html, section.document.resources, undefined, section.document.layout === "pre-paginated" ? { width: section.document.width!, height: section.document.height! } : undefined, occurrences);
  return occurrences;
}
function rasterDimensions(bytes: Uint8Array, mimeType: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png") {
    if (bytes.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte) || view.getUint32(8) !== 13 || [73, 72, 68, 82].some((byte, index) => bytes[index + 12] !== byte)) fail();
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail();
  let cursor = 2;
  while (cursor < bytes.length) {
    if (bytes[cursor++] !== 0xff) fail();
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++]; if (marker === undefined || marker === 0xda || marker === 0xd9) fail();
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (cursor + 2 > bytes.length) fail(); const length = view.getUint16(cursor);
    if (length < 2 || cursor + length > bytes.length) fail();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) fail(); return [view.getUint16(cursor + 5), view.getUint16(cursor + 3)];
    }
    cursor += length;
  }
  return fail();
}
export function verifyReaderResource(value: unknown, source: SavedEpubSource, descriptor: EpubReaderResource): string {
  const result = object(value); assertReaderSource(result.source, source); assertRaster(descriptor); assertRaster(result.resource);
  const resource = object(result.resource);
  if (!["index", "mimeType", "sha256", "sizeBytes", "width", "height"].every((key) => resource[key] === object(descriptor)[key]) || typeof resource.base64 !== "string" || resource.base64.length !== Math.ceil(descriptor.sizeBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(resource.base64) || !/^[A-Za-z0-9+/]*={0,2}$/.test(resource.base64)) fail();
  let binary: string;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (resource.base64.endsWith("==") && (alphabet.indexOf(resource.base64.at(-3)!) & 15) !== 0 || resource.base64.endsWith("=") && !resource.base64.endsWith("==") && (alphabet.indexOf(resource.base64.at(-2)!) & 3) !== 0) fail();
  try { binary = atob(resource.base64); } catch { return fail(); }
  if (binary.length !== descriptor.sizeBytes) fail();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToHex(sha256(bytes)) !== descriptor.sha256) fail();
  const [width, height] = rasterDimensions(bytes, descriptor.mimeType);
  if (width !== descriptor.width || height !== descriptor.height) fail();
  return `data:${descriptor.mimeType};base64,${resource.base64}`;
}
export function buildReaderDocument(section: EpubReaderResult, urls: ReadonlyMap<number, string>, preferences: ReaderPreferences, preview: { selectedOccurrence?: number; rasterMarkupBudget?: number } = {}): string {
  validateReaderSection(section, section.source, section.document.index);
  if (!["serif", "sans"].includes(preferences.font) || !integer(preferences.size, 16, 28) || ![1.5, 1.7, 1.9].includes(preferences.leading)) fail();
  for (const [index, url] of urls) {
    const descriptor = section.document.resources.find((entry) => entry.index === index); if (!descriptor || typeof url !== "string") fail();
    const prefix = `data:${descriptor.mimeType};base64,`; if (!url.startsWith(prefix)) fail();
    verifyReaderResource({ source: section.source, resource: { ...descriptor, base64: url.slice(prefix.length) } }, section.source, descriptor);
  }
  const fixed = section.document.layout === "pre-paginated";
  const viewport = fixed ? { width: section.document.width!, height: section.document.height! } : undefined;
  const occurrences: ReaderImageOccurrence[] = []; inertMarkup(section.document.html, section.document.resources, undefined, viewport, occurrences);
  const selected = preview.selectedOccurrence ?? 0;
  const limit = preview.rasterMarkupBudget ?? READER_RASTER_MARKUP_BUDGET;
  if (!integer(limit, 1, READER_RASTER_MARKUP_BUDGET) || !integer(selected, 0, Math.max(0, occurrences.length - 1))) fail();
  const selectedImage = occurrences[selected]; const selectedUrl = selectedImage && urls.get(selectedImage.resourceIndex);
  const reserved = selectedUrl ? selectedImage.markupBytes + selectedUrl.length + 7 : 0;
  if (reserved > limit) fail();
  const body = inertMarkup(section.document.html, section.document.resources, urls, viewport, undefined, { limit, used: 0, selected, reserved, selectedRendered: false });
  const css = `:root{color-scheme:light}*{box-sizing:border-box}html,body{margin:0;background:#e8dfcc;color:#1d1a16}body{font-family:${preferences.font === "serif" ? "Georgia,serif" : "Arial,sans-serif"};font-size:${preferences.size}px;line-height:${preferences.leading};overflow-wrap:anywhere;padding:${fixed ? "0" : "clamp(20px,5vw,52px)"}}main{max-width:70ch;margin:auto}h1,h2,h3,h4,h5,h6{line-height:1.25;overflow-wrap:anywhere}h1{font-size:1.8em}p{margin-block:0 1em}img{display:block;max-width:100%;height:auto;margin-inline:auto}figure{margin:1em 0}.caption,figcaption{font-size:.85em;color:#665946}.reader-placeholder{display:block;margin:1em 0;border:1px dashed #b9a888;padding:16px;background:#f1eadc}.page-break{break-before:page}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid #b9a888;padding:6px}pre{white-space:pre-wrap}a{color:inherit}blockquote{border-inline-start:3px solid #b9a888;margin-inline:0;padding-inline-start:1em}${fixed ? "html,body,main,main>div,main>section{width:100%;height:100%;max-width:none}main img{width:100%;height:100%;object-fit:contain;margin:0}main .reader-placeholder{height:100%;margin:0;display:grid;place-items:center}" : ""}`;
  return `<!doctype html><html dir="${section.document.direction}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved EPUB — ${escapeText(section.document.title)}</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
}
export function createReaderFence(): { reset: (key: string) => () => boolean; clear: () => void } {
  let generation = 0; let identity = "";
  return { reset(key) { const captured = ++generation; identity = key; return () => generation === captured && identity === key; }, clear() { generation++; identity = ""; } };
}
export function validateReaderDownload(value: unknown): string {
  const download = object(value);
  if (typeof download.url !== "string" || download.url.length > 16_384 || !integer(download.expiresIn, 1, 3600)) fail();
  let url: URL; try { url = new URL(download.url); } catch { return fail(); }
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) fail();
  return download.url;
}
