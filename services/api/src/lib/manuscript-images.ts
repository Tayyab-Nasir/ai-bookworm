import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BookNode } from "@bookworm/book-model";
import type { SupabaseClient } from "./supabase.js";
import { AppError } from "../errors.js";
import { sniffAssetContent, type AssetMalwareScanner } from "./asset-scanner.js";

export const embeddedImagesSchema = z.array(z.object({
  id: z.string().uuid(), filename: z.string().min(1).max(256),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().min(4).max(Math.ceil(10 * 1024 * 1024 / 3) * 4),
}).strict()).max(100);

export async function readDocumentResponse(response: Response): Promise<unknown> {
  const limit = 80 * 1024 * 1024;
  if (!response.body || !response.headers.get("content-type")?.startsWith("application/json")
      || Number(response.headers.get("content-length") ?? 0) > limit) throw new AppError(503, "Invalid document parser response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("limit"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new AppError(503, "Document parser response was unreadable or exceeded its size limit"); }
}

const importReportSchema = z.object({ warnings: z.array(z.string().max(2000)).max(100), confidence: z.string().max(100).optional(),
  chapterCount: z.number().int().min(1).max(500).optional(), imageCount: z.number().int().min(0).max(100).optional() });
const importResultSchema = (sourceAssetId: string) => z.object({
  chapters: z.array(z.object({ id: z.string().uuid(), book_id: z.string().uuid().optional(), title: z.string().max(500).optional(),
    order_index: z.number().int().optional(), status: z.string().optional(), current_document_version_id: z.string().uuid().nullable().optional(),
    created_at: z.string().optional(), updated_at: z.string().optional() })).min(1).max(500),
  assetIds: z.array(z.string().uuid()).max(100), sourceAssetId: z.literal(sourceAssetId),
  report: importReportSchema,
}).transform((value) => ({ ...value, report: { ...value.report,
  chapterCount: value.chapters.length, imageCount: value.assetIds.length } }));

/** Call only after book authorization. Returned fields exclude private payloads. */
export async function readImportReceipt(service: SupabaseClient, bookId: string, sourceAssetId: string, sourceChecksum?: string) {
  const receipt = await service.from("book_import_receipts").select("result,source_checksum")
    .eq("book_id", bookId).eq("source_asset_id", sourceAssetId).maybeSingle();
  if (receipt.error) throw new AppError(503, "Import transaction storage is unavailable; the original remains stored");
  if (!receipt.data) return null;
  if (sourceChecksum !== undefined && receipt.data.source_checksum !== sourceChecksum) throw new AppError(409, "This manuscript source was already imported with different content");
  const saved = importResultSchema(sourceAssetId).safeParse(receipt.data.result);
  if (!saved.success) throw new AppError(503, "Saved import receipt needs verification; no files were changed");
  return saved.data;
}

/** Upload privately, then publish rows and chapters in one database transaction.
 * A lost commit reply is never permission to delete potentially referenced files. */
export async function importManuscriptImages(input: {
  service: SupabaseClient; scanner: AssetMalwareScanner; actorId: string;
  bookId: string; workspaceId: string; sourceAssetId: string; sourceChecksum: string;
  chapters: Array<{ title: string; nodes: BookNode[] }>;
  images: z.infer<typeof embeddedImagesSchema>; warnings: string[]; confidence?: string;
  lease?: { jobId: string; token: string }; signal?: AbortSignal;
}) {
  const { service } = input;
  const resultSchema = importResultSchema(input.sourceAssetId);
  const receipt = await readImportReceipt(service, input.bookId, input.sourceAssetId, input.sourceChecksum);
  if (receipt) return receipt;
  const report = importReportSchema.safeParse({ warnings: [...new Set(input.warnings)], confidence: input.confidence ?? "high",
    chapterCount: input.chapters.length, imageCount: input.images.length });
  if (!report.success || Buffer.byteLength(JSON.stringify(report.data), "utf8") > 65536) {
    throw new AppError(503, "Parser import report exceeds its validated limits; no chapters were imported");
  }

  const prepared = [];
  const ids = new Map<string, string>();
  let total = 0;
  for (const image of input.images) {
    input.signal?.throwIfAborted();
    if (ids.has(image.id)) throw new AppError(503, "Parser returned duplicate embedded-image identifiers");
    const bytes = Buffer.from(image.contentBase64, "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== image.contentBase64 || bytes.length !== image.sizeBytes || total > 40 * 1024 * 1024
        || createHash("sha256").update(bytes).digest("hex") !== image.checksumSha256) {
      throw new AppError(422, "Embedded image integrity verification failed; no chapters were imported");
    }
    let mime: string;
    try { mime = sniffAssetContent(bytes, image.filename, image.mimeType); }
    catch { throw new AppError(422, "An embedded image has invalid or unsupported content"); }
    const id = randomUUID();
    let scan;
    try {
      scan = await input.scanner.scan({ assetId: id, workspaceId: input.workspaceId, version: 1,
        filename: image.filename, bytes, checksumSha256: image.checksumSha256, detectedMimeType: image.mimeType });
      if (!scan || !["clean", "infected"].includes(scan.verdict) || !scan.signature?.trim()
          || scan.signature.length > 200 || /[\x00-\x1f]/.test(scan.signature)) throw new Error("invalid verdict");
    } catch { throw new AppError(503, "Embedded-image screening is unavailable; no chapters were imported"); }
    if (scan.verdict !== "clean") throw new AppError(422, "An embedded image was rejected by malware screening; no chapters were imported");
    const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[mime];
    ids.set(image.id, id);
    prepared.push({ bytes, id, name: image.filename, mimeType: mime, sizeBytes: bytes.length,
      checksum: image.checksumSha256, storagePath: `workspaces/${input.workspaceId}/assets/${id}/v1/imported.${ext}`,
      scanner: input.scanner.name.slice(0, 100), signature: scan.signature });
  }
  const chapters = input.chapters.map((chapter) => ({ ...chapter, nodes: chapter.nodes.map((node) => {
    if (!node.assetId) return node;
    const mapped = ids.get(node.assetId);
    if (!mapped) throw new AppError(503, "An embedded illustration has no verified image payload; no chapters were imported");
    return { ...node, assetId: mapped };
  }) }));
  const storage = service.storage.from("book-assets");
  const uploaded: string[] = [];
  let mayHaveCommitted = false;
  const cleanup = async (paths: string[]) => {
    if (!paths.length) return;
    const removed = await storage.remove(paths);
    if (removed.error) throw new AppError(503, "Import did not finish; private temporary-file cleanup needs retry");
  };
  try {
    for (const image of prepared) {
      input.signal?.throwIfAborted();
      const stored = await storage.upload(image.storagePath, image.bytes, { contentType: image.mimeType, upsert: false });
      if (stored.error) throw new AppError(503, "Embedded-image storage is unavailable; no chapters were imported");
      uploaded.push(image.storagePath);
      const checked = await storage.download(image.storagePath);
      if (checked.error || !checked.data || checked.data.size !== image.sizeBytes
          || createHash("sha256").update(Buffer.from(await checked.data.arrayBuffer())).digest("hex") !== image.checksum) {
        throw new AppError(503, "Stored embedded-image verification failed; no chapters were imported");
      }
    }
    input.signal?.throwIfAborted();
    mayHaveCommitted = true;
    const { data, error } = await service.rpc(input.lease ? "complete_leased_manuscript_import" : "complete_manuscript_import", {
      ...(input.lease ? { p_job_id: input.lease.jobId, p_lease_token: input.lease.token }
        : { p_actor_id: input.actorId, p_book_id: input.bookId, p_source_asset_id: input.sourceAssetId, p_source_checksum: input.sourceChecksum }),
      p_chapters: chapters,
      p_images: prepared.map(({ bytes: _privateBytes, ...metadata }) => metadata),
      p_report: report.data,
    });
    if (error || !data) {
      if (error && ["22023", "42501", "23505", "P0002", "40001"].includes(error.code)) mayHaveCommitted = false;
      throw new AppError(error?.code === "42501" ? 403 : error?.code === "23505" ? 409 : 503,
        "Import completion could not be confirmed. Your original is safe; retry to check the saved import.");
    }
    // A concurrent request may have won; its receipt identifies the files to retain.
    const completed = resultSchema.safeParse(data);
    if (!completed.success) throw new AppError(503, "Import receipt could not be verified; private files were retained safely");
    const retained = new Set<string>(completed.data.assetIds);
    await cleanup(prepared.filter((image) => !retained.has(image.id)).map((image) => image.storagePath));
    return completed.data;
  } catch (error) {
    if (!mayHaveCommitted) await cleanup(uploaded);
    throw error instanceof AppError ? error : new AppError(503, "Import completion is uncertain. The original and private image files were retained; retry to check the saved import.");
  }
}
