import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";

export const MAX_SAVED_EPUB_BYTES = 150 * 1024 * 1024;
const MAX_DATABASE_BYTES = 4 * 1024 * 1024;
const MAX_SECTION_BYTES = 12 * 1024 * 1024;
const MAX_RESOURCE_RESPONSE_BYTES = 36 * 1024 * 1024;
const MAX_RASTER_BYTES = 25 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const layoutSchema = z.enum(["reflowable", "pre-paginated"]);
const artifactSchema = z.object({
  assetId: z.string().uuid(), storagePath: z.string().min(1).max(1000), filename: z.string().min(1).max(128),
  type: z.enum(["rendered_book", "rendered_cover"]), role: z.enum(["rendered_ebook", "rendered_print", "rendered_cover"]),
  name: z.string().min(1).max(256), mimeType: z.enum(["application/epub+zip", "application/pdf", "image/png"]),
  sizeBytes: z.number().int().min(1).max(MAX_SAVED_EPUB_BYTES), checksum: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict();
const renderSchema = z.object({ artifacts: z.array(artifactSchema).min(1).max(2), rendererVersion: z.string().min(1).max(200), usage: z.record(z.unknown()) }).strict();
const resourceSchema = z.object({
  index: z.number().int().min(0).max(9999), mimeType: z.enum(["image/png", "image/jpeg"]), sha256: digestSchema,
  sizeBytes: z.number().int().min(1).max(MAX_RASTER_BYTES), width: z.number().int().min(1).max(7200), height: z.number().int().min(1).max(7200),
}).strict().refine(resource => resource.width * resource.height <= 40_000_000);
const previewBase = { formatVersion: z.literal("epub-reader-1.0.0"), sourceSha256: digestSchema,
  sourceSizeBytes: z.number().int().min(1).max(MAX_SAVED_EPUB_BYTES), warnings: z.array(z.enum([
    "active-content-removed", "unsupported-styles-ignored", "links-disabled", "unsupported-markup-removed",
  ])).max(4) };
const documentSchema = z.object({
  index: z.number().int().min(0).max(2499), title: z.string().max(4096), layout: layoutSchema,
  direction: z.enum(["ltr", "rtl"]), html: z.string().max(MAX_SECTION_BYTES),
  width: z.number().int().min(1).max(7200).optional(), height: z.number().int().min(1).max(7200).optional(),
  resources: z.array(resourceSchema).max(10000),
}).strict();
const sectionSchema = z.object({ ...previewBase, layout: layoutSchema,
  spine: z.array(z.object({ index: z.number().int().min(0).max(2499), title: z.string().max(4096), layout: layoutSchema }).strict()).min(1).max(2500),
  document: documentSchema,
}).strict();
const rasterSchema = z.object({ ...previewBase, resource: z.object({
  index: z.number().int().min(0).max(9999), mimeType: z.enum(["image/png", "image/jpeg"]), sha256: digestSchema,
  sizeBytes: z.number().int().min(1).max(MAX_RASTER_BYTES), width: z.number().int().min(1).max(7200), height: z.number().int().min(1).max(7200),
  base64: z.string().min(4).max(Math.ceil(MAX_RASTER_BYTES / 3) * 4),
}).strict() }).strict();

export type SavedEpubSource = { bookId: string; editionId: string; jobId: string; assetId: string; version: 1; sha256: string; sizeBytes: number };
type Row = Record<string, unknown>;
const unavailable = () => new AppError(503, "The saved EPUB reader is temporarily unavailable. No new render was created.");
const invalidSource = () => new AppError(422, "This saved render has no readable, verified EPUB artifact.");
export type ReaderTasks = Set<Promise<unknown>>;
let activePreview: ReaderTasks | null = null;

function ownTask<T>(tasks: ReaderTasks | undefined, operation: () => PromiseLike<T>): Promise<T> {
  const task = Promise.resolve().then(operation);
  tasks?.add(task);
  void task.finally(() => tasks?.delete(task)).catch(() => {});
  return task;
}

/** ponytail: one byte-reading preview per process; use streaming and shared admission when scaling. */
export async function withPreviewAdmission<T>(signal: AbortSignal, operation: (tasks: ReaderTasks) => Promise<T>): Promise<T> {
  if (signal.aborted) throw unavailable();
  if (activePreview) throw new AppError(503, "The saved EPUB reader is busy. Try again shortly. No new render was created.");
  const tasks: ReaderTasks = new Set(); activePreview = tasks;
  const work = ownTask(tasks, () => operation(tasks));
  try { return await withinReaderDeadline(signal, () => work); }
  finally {
    const settle = async () => {
      await work.catch(() => {});
      while (tasks.size) await Promise.allSettled([...tasks]);
      if (activePreview === tasks) activePreview = null;
    };
    // Return an expired request promptly, but do not admit another reader while
    // an abort-ignoring dependency still owns bytes or a streamed body.
    const settled = settle();
    if (signal.aborted) void settled; else await withinReaderDeadline(signal, () => settled);
  }
}

/** One absolute deadline covers queries, private Storage, parsing, and streamed replies. */
export async function withinReaderDeadline<T>(signal: AbortSignal, operation: () => PromiseLike<T>): Promise<T> {
  if (signal.aborted) throw unavailable();
  let abort: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(operation), expired]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Preview-specific transport; the existing worker's 12 MiB Storage cap is unchanged. */
export function previewSupabaseFetch(signal: AbortSignal, fetcher: typeof fetch = fetch, tasks?: ReaderTasks): typeof fetch {
  return async (input, init) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const combined = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
    combined.throwIfAborted();
    const response = await withinReaderDeadline(combined, () => ownTask(tasks, async () => {
      const received = await fetcher(input, { ...init, signal: combined, redirect: "error" });
      if (combined.aborted) { if (received.body) await ownTask(tasks, () => received.body!.cancel()).catch(() => {}); throw unavailable(); }
      return received;
    }));
    const url = new URL(input instanceof Request ? input.url : String(input));
    const limit = url.pathname.startsWith("/storage/v1/object/") ? MAX_SAVED_EPUB_BYTES : MAX_DATABASE_BYTES;
    if (Number(response.headers.get("content-length")) > limit) { if (response.body) void ownTask(tasks, () => response.body!.cancel()).catch(() => {}); throw unavailable(); }
    if (!response.body) return response;
    let size = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { size += chunk.byteLength; if (size > limit) throw unavailable(); controller.enqueue(chunk); },
    });
    const pump = response.body.pipeTo(bounded.writable, { signal: combined });
    void ownTask(tasks, () => pump).catch(() => {});
    return new Response(bounded.readable, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal, tasks?: ReaderTasks) {
  if (!stream) throw unavailable();
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await withinReaderDeadline(signal, () => ownTask(tasks, () => reader.read()));
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw unavailable();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) { const cancellation = reader.cancel(); void ownTask(tasks, () => cancellation).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export async function savedEpubSource(sb: SupabaseClient, workspaceId: string, bookId: string, editionId: string, job: Row): Promise<SavedEpubSource> {
  if (job.book_id !== bookId || job.edition_id !== editionId) throw new AppError(404, "Saved render not found for this edition.");
  const request = job.request_json as Row | null;
  if (job.channel !== "render" || job.status !== "succeeded" || !request || request.action !== "render") throw invalidSource();
  const response = renderSchema.safeParse(job.response_json);
  if (!response.success) throw invalidSource();
  const primary = response.data.artifacts.filter(artifact => artifact.role === "rendered_ebook");
  if (primary.length !== 1 || response.data.artifacts.some(artifact => !["rendered_ebook", "rendered_cover"].includes(artifact.role))) throw invalidSource();
  const descriptor = primary[0];
  const canonicalPath = `workspaces/${workspaceId}/assets/${descriptor.assetId}/v1/book.epub`;
  if (descriptor.type !== "rendered_book" || descriptor.filename !== "book.epub" || descriptor.mimeType !== "application/epub+zip" || descriptor.storagePath !== canonicalPath) throw invalidSource();
  const [{ data: asset, error: assetError }, { data: version, error: versionError }] = await Promise.all([
    sb.from("assets").select("id,workspace_id,type,storage_path,mime_type,size_bytes,checksum,status,deleted_at")
      .eq("id", descriptor.assetId).eq("workspace_id", workspaceId).is("deleted_at", null).maybeSingle(),
    sb.from("asset_versions").select("asset_id,version_number,storage_path,mime_type,size_bytes,checksum,scan_status")
      .eq("asset_id", descriptor.assetId).eq("version_number", 1).maybeSingle(),
  ]);
  if (assetError || versionError) throw unavailable();
  const matches = (row: Row | null) => row && row.storage_path === canonicalPath && row.mime_type === descriptor.mimeType
    && Number(row.size_bytes) === descriptor.sizeBytes && String(row.checksum).toLowerCase() === descriptor.checksum.toLowerCase();
  if (!matches(asset) || asset?.id !== descriptor.assetId || asset.workspace_id !== workspaceId || asset.deleted_at !== null
    || asset.type !== "rendered_book" || !["draft", "in_review", "approved"].includes(String(asset.status))
    || !matches(version) || version?.asset_id !== descriptor.assetId || version.version_number !== 1
    || !["clean", "trusted_generated"].includes(String(version.scan_status))) throw invalidSource();
  return { bookId, editionId, jobId: String(job.id), assetId: descriptor.assetId, version: 1, sha256: descriptor.checksum.toLowerCase(), sizeBytes: descriptor.sizeBytes };
}

export async function savedEpubBytes(sb: SupabaseClient, workspaceId: string, source: SavedEpubSource, signal: AbortSignal, tasks?: ReaderTasks) {
  const path = `workspaces/${workspaceId}/assets/${source.assetId}/v1/book.epub`;
  const { data, error } = await withinReaderDeadline(signal, () => ownTask(tasks, () => sb.storage.from("book-assets").download(path)));
  if (error || !data) throw unavailable();
  if (data.size !== source.sizeBytes || data.size > MAX_SAVED_EPUB_BYTES) throw invalidSource();
  const bytes = await boundedBytes(data.stream(), MAX_SAVED_EPUB_BYTES, signal, tasks);
  if (bytes.length !== source.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256
    || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw invalidSource();
  return bytes;
}

const HTML_TAGS = new Set("section div p h1 h2 h3 h4 h5 h6 blockquote strong em b i u s del code pre br hr ul ol li table thead tbody tfoot tr td th caption figure figcaption aside span nav a img".split(" "));
const VOID_TAGS = new Set(["br", "hr", "img"]);
function safeHtml(html: string, resources: z.infer<typeof resourceSchema>[]) {
  const indices = new Set(resources.map(resource => resource.index));
  const stack: string[] = []; let end = 0; let nodes = 0;
  // Malformed private replies must not make a global regex repeatedly scan
  // unterminated suffixes. Advance over each token once before validation.
  while (end < html.length) {
    const start = html.indexOf("<", end);
    if (start === -1) break;
    const close = html.indexOf(">", start + 1);
    const nested = html.indexOf("<", start + 1);
    if (close === -1 || (nested !== -1 && nested < close)) return false;
    const token = html.slice(start, close + 1); end = close + 1;
    const tag = /^<(\/)?([a-z][a-z0-9]*)([^<>]*)>$/u.exec(token);
    if (!tag || !HTML_TAGS.has(tag[2])) return false;
    const selfClosing = tag[3].endsWith("/");
    const attributes = selfClosing ? tag[3].slice(0, -1) : tag[3];
    if (tag[1]) { if (attributes.trim() || selfClosing || stack.pop() !== tag[2]) return false; continue; }
    if (++nodes > 100_000) return false;
    const names = new Set<string>(); let rest = attributes; let resourceIndex: number | undefined;
    while (rest.trim()) {
      const attribute = /^\s+([a-z][a-z0-9-]*)="([^"<>]*)"/u.exec(rest);
      if (!attribute || names.has(attribute[1])) return false;
      const [, name, value] = attribute; names.add(name); rest = rest.slice(attribute[0].length);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return false;
      if (name === "lang" && /^[a-zA-Z0-9-]{1,64}$/u.test(value)) continue;
      if (name === "dir" && ["ltr", "rtl", "auto"].includes(value)) continue;
      if (name === "id" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)) continue;
      if (name === "class" && /^(?:caption|cover|page-break)(?: (?:caption|cover|page-break))*$/u.test(value)) continue;
      if (name === "data-reader-width-percent" && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) >= 1 && Number(value) <= 100) continue;
      if (((name === "start" && tag[2] === "ol") || (name === "value" && tag[2] === "li")) && /^-?\d{1,9}$/u.test(value)) continue;
      if (["td", "th"].includes(tag[2]) && ["rowspan", "colspan"].includes(name) && /^\d{1,4}$/u.test(value) && Number(value) >= 1 && Number(value) <= 1000) continue;
      if (tag[2] === "th" && name === "scope" && ["row", "col", "rowgroup", "colgroup"].includes(value)) continue;
      if (tag[2] === "img" && name === "alt" && value.length <= 6 * 1024 * 1024) continue;
      if (tag[2] === "img" && ["width", "height"].includes(name) && /^\d{1,4}$/u.test(value) && Number(value) >= 1 && Number(value) <= 7200) continue;
      if (tag[2] === "img" && name === "data-reader-resource" && /^\d{1,4}$/u.test(value) && indices.has(Number(value))) { resourceIndex = Number(value); continue; }
      return false;
    }
    if (tag[2] === "img" && resourceIndex === undefined) return false;
    if (!VOID_TAGS.has(tag[2])) { if (selfClosing) return false; stack.push(tag[2]); if (stack.length > 64) return false; }
  }
  return !stack.length && !html.slice(end).includes("<");
}

export function validateEpubPreview(raw: unknown, source: SavedEpubSource, selected: { spineIndex: number } | { resourceIndex: number }) {
  const parsed = "spineIndex" in selected ? sectionSchema.safeParse(raw) : rasterSchema.safeParse(raw);
  if (!parsed.success || parsed.data.sourceSha256 !== source.sha256 || parsed.data.sourceSizeBytes !== source.sizeBytes) throw unavailable();
  const result = parsed.data;
  if (new Set(result.warnings).size !== result.warnings.length) throw unavailable();
  if ("document" in result && "spineIndex" in selected) {
    if (result.document.index !== selected.spineIndex || result.spine.some((entry, index) => entry.index !== index)
      || result.spine[selected.spineIndex]?.layout !== result.document.layout || result.spine[selected.spineIndex]?.title !== result.document.title
      || new Set(result.document.resources.map(resource => resource.index)).size !== result.document.resources.length
      || !safeHtml(result.document.html, result.document.resources)
      || (result.document.layout === "pre-paginated" && !fixedRasterDocument(result.document))) throw unavailable();
    return { source, formatVersion: result.formatVersion, layout: result.layout, spine: result.spine, document: result.document, warnings: result.warnings };
  }
  if ("resource" in result && "resourceIndex" in selected) {
    const resource = result.resource;
    if (resource.index !== selected.resourceIndex || resource.width * resource.height > 40_000_000
      || resource.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(resource.base64)) throw unavailable();
    const bytes = Buffer.from(resource.base64, "base64");
    const signature = resource.mimeType === "image/png" ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : Buffer.from([0xff, 0xd8, 0xff]);
    if (bytes.length !== resource.sizeBytes || bytes.length > MAX_RASTER_BYTES || bytes.toString("base64") !== resource.base64
      || createHash("sha256").update(bytes).digest("hex") !== resource.sha256 || !bytes.subarray(0, signature.length).equals(signature)
      || !rasterDimensionsMatch(bytes, resource.mimeType, resource.width, resource.height)) throw unavailable();
    return { source, resource };
  }
  throw unavailable();
}

function fixedRasterDocument(document: z.infer<typeof documentSchema>) {
  if (document.resources.length !== 1 || document.width !== document.resources[0].width || document.height !== document.resources[0].height) return false;
  const image = /^<div\b[^>]*>\s*<img\b([^>]*)>\s*<\/div>$/u.exec(document.html);
  return image !== null && new RegExp(`(?:^|\\s)data-reader-resource="${document.resources[0].index}"(?:\\s|$)`, "u").test(image[1])
    && new RegExp(`(?:^|\\s)width="${document.width}"(?:\\s|$)`, "u").test(image[1])
    && new RegExp(`(?:^|\\s)height="${document.height}"(?:\\s|$)`, "u").test(image[1]);
}

function rasterDimensionsMatch(bytes: Buffer, mime: "image/png" | "image/jpeg", width: number, height: number) {
  if (mime === "image/png") return bytes.length >= 33 && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR"
    && bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if ([0xd8, 0xd9, 0xda, 0x00].includes(marker)) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return length >= 8 && bytes.readUInt16BE(offset + 3) === height && bytes.readUInt16BE(offset + 5) === width;
    }
    offset += length;
  }
  return false;
}

export async function requestEpubPreview(fetcher: typeof fetch, bytes: Buffer, source: SavedEpubSource,
  selected: { spineIndex: number } | { resourceIndex: number }, signal: AbortSignal, tasks?: ReaderTasks) {
  const baseUrl = (process.env.RENDERING_SERVICE_URL ?? `http://127.0.0.1:${process.env.RENDERING_SERVICE_PORT ?? "8002"}`).replace(/\/$/u, "");
  const token = process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN;
  if (!token) throw unavailable();
  const responseLimit = "spineIndex" in selected ? MAX_SECTION_BYTES : MAX_RESOURCE_RESPONSE_BYTES;
  const selectionHeader = "spineIndex" in selected
    ? { "x-epub-spine-index": String(selected.spineIndex) }
    : { "x-epub-resource-index": String(selected.resourceIndex) };
  const response = await withinReaderDeadline(signal, () => ownTask(tasks, async () => {
    const received = await fetcher(`${baseUrl}/epub/preview`, {
      method: "POST", headers: { "content-type": "application/epub+zip", "x-service-token": token, "x-epub-sha256": source.sha256, ...selectionHeader },
      // Preserve the verified immutable bytes without allocating a base64 JSON copy.
      body: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), signal, redirect: "error",
    });
    if (signal.aborted) { if (received.body) await ownTask(tasks, () => received.body!.cancel()).catch(() => {}); throw unavailable(); }
    return received;
  }));
  if (!response.ok) { if (response.body) void ownTask(tasks, () => response.body!.cancel()).catch(() => {}); throw unavailable(); }
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
    || Number(response.headers.get("content-length")) > responseLimit) { if (response.body) void ownTask(tasks, () => response.body!.cancel()).catch(() => {}); throw unavailable(); }
  const responseBytes = await boundedBytes(response.body, responseLimit, signal, tasks);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)); } catch { throw unavailable(); }
  return validateEpubPreview(raw, source, selected);
}
