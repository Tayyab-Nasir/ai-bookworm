import { createHash } from "node:crypto";
import { z } from "zod";
import { BookModelSchema } from "@bookworm/book-model";
import { AppError } from "../errors.js";
import { loadBook, nodesSchema } from "./authoring.js";
import type { SupabaseClient } from "./supabase.js";
import type { AssetMalwareScanner } from "./asset-scanner.js";
import { embeddedImagesSchema, importManuscriptImages, readDocumentResponse, readImportReceipt } from "./manuscript-images.js";

export async function loadImportSource(sb: SupabaseClient, bookId: string, actorId: string, assetId: string) {
    const { book } = await loadBook(sb, bookId, actorId, true);
    const { data: asset, error: assetError } = await sb.from("assets").select("*").eq("id", assetId).eq("workspace_id", book.workspace_id).is("deleted_at", null).maybeSingle();
    if (assetError) throw new AppError(500, "Could not load source manuscript");
    if (!asset) throw new AppError(404, "source manuscript not found in this workspace");
    if (asset.checksum === "pending") throw new AppError(409, "Finish the original source upload before importing");
    const { data: sourceVersion, error: sourceVersionError } = await sb.from("asset_versions")
      .select("scan_status")
      .eq("asset_id", asset.id)
      .eq("storage_path", asset.storage_path)
      .maybeSingle();
    if (sourceVersionError) throw new AppError(500, "Could not verify source manuscript safety");
    if (!sourceVersion || sourceVersion.scan_status !== "clean") {
      throw new AppError(409, "Source manuscript remains quarantined and cannot be imported");
    }

    return { book, asset };
}

export async function executeManuscriptImport(input: {
  sb: SupabaseClient; service: SupabaseClient; scanner: AssetMalwareScanner;
  bookId: string; actorId: string; assetId: string; expectedChecksum?: string;
  lease?: { jobId: string; token: string }; signal?: AbortSignal; fetcher?: typeof fetch;
}) {
  const { sb, service, scanner, bookId, actorId, assetId, expectedChecksum, lease, signal, fetcher = fetch } = input;
  signal?.throwIfAborted();
  const { book, asset } = await loadImportSource(sb, bookId, actorId, assetId);
  if (expectedChecksum && asset.checksum !== expectedChecksum) throw new AppError(409, "Source changed since import was queued");
    const receipt = await readImportReceipt(sb, bookId, asset.id, asset.checksum);
    if (receipt) return receipt;
    const format = String(asset.name).split(".").pop()?.toLowerCase();
    if (!format || !["txt","docx","epub","pdf"].includes(format)) throw new AppError(422, "Supported manuscripts: TXT, DOCX, EPUB, PDF");
    if (asset.size_bytes > 20 * 1024 * 1024) throw new AppError(422, "Manuscript import currently accepts up to 20 MB. The original remains stored.");
    const serviceUrl = process.env.DOCUMENT_SERVICE_URL;
    const serviceToken = process.env.DOCUMENT_SERVICE_TOKEN ?? process.env.SERVICE_AUTH_TOKEN;
    if (!serviceUrl || !serviceToken) throw new AppError(503, "Document service URL and authentication are required. Your original manuscript remains safely stored; retry import after setup.");
    const { data: source, error: downloadError } = await sb.storage.from("book-assets").download(asset.storage_path);
    if (downloadError || !source) throw new AppError(422, "Original manuscript could not be read from storage");
    if (source.size !== asset.size_bytes || source.size > 20 * 1024 * 1024) throw new AppError(422, "Original manuscript size verification failed");
    const bytes = Buffer.from(await source.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum) throw new AppError(422, "Original manuscript checksum verification failed");
    let response: Response;
    try {
      response = await fetcher(`${serviceUrl.replace(/\/$/, "")}/parse`, {
        method: "POST", headers: { "content-type": "application/json", "x-service-token": serviceToken },
        body: JSON.stringify({ assetId: asset.id, format, contentBase64: bytes.toString("base64"), title: book.title }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), redirect: "error",
      });
    } catch { throw new AppError(503, "Document parser is unavailable. Your original is preserved; no chapters were imported."); }
    if (!response.ok) throw new AppError(response.status === 422 ? 422 : 503, "Document parser could not import this manuscript. Verify its format; the original remains intact.");
    const parsed = z.object({ bookModel: BookModelSchema, embeddedAssets: embeddedImagesSchema.default([]), report: z.object({ warnings: z.array(z.string()).default([]), confidence: z.string().optional() }).passthrough() }).safeParse(await readDocumentResponse(response));
    if (!parsed.success) throw new AppError(503, "Document parser returned an invalid document; no chapters were imported");
    const chapters = parsed.data.bookModel.chapters;
    if (!chapters.some((c) => c.nodes.some((n) => n.text?.trim()))) throw new AppError(422, "No readable manuscript text found. Scanned PDFs need OCR before import.");
    const warnings = [...parsed.data.report.warnings];
    if (parsed.data.embeddedAssets.length) {
      return importManuscriptImages({ service: service, scanner: scanner,
        actorId: actorId, bookId, workspaceId: book.workspace_id, sourceAssetId: asset.id, sourceChecksum: asset.checksum,
        chapters: chapters.map((chapter) => ({ title: chapter.title || "Untitled chapter", nodes: nodesSchema.parse(chapter.nodes) })),
        images: parsed.data.embeddedAssets, warnings, confidence: parsed.data.report.confidence, lease, signal });
    }
    // Older parsers may provide image references without transferable bytes.
    // Preserve those places explicitly without inventing usable assets.
    const normalized = chapters.map((chapter) => ({ title: chapter.title || "Untitled chapter", nodes: nodesSchema.parse(chapter.nodes.map((node) => {
      if (node.assetId) {
        warnings.push("An embedded illustration remains in the original source. Upload that illustration in Assets to attach it to the manuscript.");
        return { id: node.id, type: "caption" as const, text: "[Embedded illustration — retained in original manuscript]", attributes: { sourceAssetId: asset.id, importedNodeType: node.type } };
      }
      return node;
    })) }));
    return importManuscriptImages({ service: service, scanner: scanner,
      actorId: actorId, bookId, workspaceId: book.workspace_id, sourceAssetId: asset.id, sourceChecksum: asset.checksum,
      chapters: normalized, images: [], warnings, confidence: parsed.data.report.confidence, lease, signal });
}
