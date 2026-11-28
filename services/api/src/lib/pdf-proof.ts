import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { withinReaderDeadline, type ReaderTasks } from "./rendered-epub.js";
import { MAX_SAVED_PRINT_BYTES, printUnavailable, type ConfirmedPrintRender } from "./rendered-print.js";

export const MAX_PDF_PROOF_PNG_BYTES = 6 * 1024 * 1024;
const MAX_REPLY_BYTES = 10 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const servicePage = z.object({
  formatVersion: z.literal("pdf-proof-1.0.0"), sourceSha256: digest,
  sourceSizeBytes: z.number().int().min(9).max(MAX_SAVED_PRINT_BYTES),
  pageNumber: z.number().int().min(1).max(20_000), pageCount: z.number().int().min(1).max(20_000),
  requestedWidth: z.union([z.literal(720), z.literal(1080), z.literal(1440)]),
  pageWidthPoints: z.number().finite().min(1).max(14_400), pageHeightPoints: z.number().finite().min(1).max(14_400),
  text: z.string().max(6000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)),
  textTruncated: z.boolean(),
  image: z.object({ mimeType: z.literal("image/png"), width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096), sizeBytes: z.number().int().min(45).max(MAX_PDF_PROOF_PNG_BYTES),
    sha256: digest, base64: z.string().min(4).max(4 * Math.ceil(MAX_PDF_PROOF_PNG_BYTES / 3)),
  }).strict().refine(image => image.width * image.height <= 6_000_000),
}).strict();

function own<T>(tasks: ReaderTasks, promise: PromiseLike<T>): Promise<T> {
  const work = Promise.resolve(promise); tasks.add(work);
  void work.finally(() => tasks.delete(work)).catch(() => {});
  return work;
}

async function bytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal, tasks: ReaderTasks) {
  if (!stream) throw printUnavailable();
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await withinReaderDeadline(signal, () => own(tasks, reader.read()));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw printUnavailable();
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    void own(tasks, reader.cancel()).catch(() => {}); throw error;
  } finally { reader.releaseLock(); }
}

export async function readSavedPdfForProof(sb: SupabaseClient, saved: ConfirmedPrintRender,
  assetId: string, signal: AbortSignal, tasks: ReaderTasks) {
  const selected = saved.artifacts.find(artifact => artifact.descriptor.assetId === assetId);
  if (!selected || selected.descriptor.mimeType !== "application/pdf") {
    throw new AppError(422, "Choose a verified saved PDF from this print proof.");
  }
  const { descriptor } = selected;
  const limit = descriptor.role === "rendered_print" ? MAX_SAVED_PRINT_BYTES : 25 * 1024 * 1024;
  const { data, error } = await withinReaderDeadline(signal, () => own(tasks,
    Promise.resolve().then(() => sb.storage.from("book-assets").download(descriptor.storagePath))));
  if (error || !data) throw printUnavailable();
  if (data.size !== descriptor.sizeBytes || data.size > limit) throw printUnavailable();
  const content = await bytes(data.stream(), limit, signal, tasks);
  if (content.length !== descriptor.sizeBytes || createHash("sha256").update(content).digest("hex") !== descriptor.checksum
    || !content.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw printUnavailable();
  return { descriptor, content };
}

export async function requestSavedPdfPage(content: Buffer,
  selected: { checksum: string; sizeBytes: number }, pageNumber: number, width: 720 | 1080 | 1440,
  signal: AbortSignal, tasks: ReaderTasks, fetcher: typeof fetch = fetch) {
  const token = process.env.RENDERING_SERVICE_TOKEN;
  if (!token || token !== token.trim() || /[\r\n]/u.test(token)) throw printUnavailable();
  const url = new URL(process.env.RENDERING_SERVICE_URL ?? "http://127.0.0.1:8002");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw printUnavailable();
  url.pathname = url.pathname.replace(/\/$/u, "") + "/pdf/preview";
  url.search = new URLSearchParams({ page: String(pageNumber), width: String(width) }).toString();
  const response = await withinReaderDeadline(signal, () => own(tasks, Promise.resolve().then(() => fetcher(url, {
    method: "POST", headers: { "x-service-token": token, "content-type": "application/pdf", "x-content-sha256": selected.checksum },
    body: content, redirect: "error", signal,
  }))));
  if (signal.aborted) { if (response.body) void own(tasks, response.body.cancel()).catch(() => {}); throw printUnavailable(); }
  if (response.status === 422) { if (response.body) void own(tasks, response.body.cancel()).catch(() => {});
    throw new AppError(422, "This page is unavailable in the saved PDF. Choose another page or download the exact file."); }
  if (response.status !== 200 || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    || Number(response.headers.get("content-length")) > MAX_REPLY_BYTES) {
    if (response.body) void own(tasks, response.body.cancel()).catch(() => {});
    throw printUnavailable();
  }
  const reply = await bytes(response.body, MAX_REPLY_BYTES, signal, tasks);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply)); } catch { throw printUnavailable(); }
  const parsed = servicePage.safeParse(raw);
  if (!parsed.success) throw printUnavailable();
  const page = parsed.data;
  if (page.sourceSha256 !== selected.checksum || page.sourceSizeBytes !== selected.sizeBytes
    || page.pageNumber !== pageNumber || page.requestedWidth !== width || page.pageNumber > page.pageCount
    || page.image.width > width) throw printUnavailable();
  const image = Buffer.from(page.image.base64, "base64");
  if (image.length !== page.image.sizeBytes || image.toString("base64") !== page.image.base64
    || createHash("sha256").update(image).digest("hex") !== page.image.sha256
    || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || image.readUInt32BE(8) !== 13 || image.subarray(12, 16).toString("ascii") !== "IHDR"
    || image.readUInt32BE(16) !== page.image.width || image.readUInt32BE(20) !== page.image.height
    || !image.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) throw printUnavailable();
  return page;
}
