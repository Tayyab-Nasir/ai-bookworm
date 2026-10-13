import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { artworkSnapshotSchema } from "./render-images.js";
import { withinReaderDeadline, type ReaderTasks } from "./rendered-epub.js";

export const MAX_SAVED_PRINT_BYTES = 150 * 1024 * 1024;
const MAX_COVER_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = MAX_SAVED_PRINT_BYTES + MAX_COVER_BYTES;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactSchema = z.object({
  assetId: z.string().uuid(), storagePath: z.string().min(1).max(1000), filename: z.enum(["book.pdf", "cover.pdf", "cover.png"]),
  type: z.enum(["rendered_book", "rendered_cover"]), role: z.enum(["rendered_print", "rendered_cover"]),
  name: z.string().min(1).max(256), mimeType: z.enum(["application/pdf", "image/png"]),
  sizeBytes: z.number().int().min(1).max(MAX_SAVED_PRINT_BYTES), checksum: z.string().regex(/^[a-f0-9]{64}$/iu),
}).strict();
const renderSchema = z.object({ artifacts: z.array(artifactSchema).min(1).max(2), rendererVersion: z.string().min(1).max(200), usage: z.record(z.unknown()) }).strict();
const requestSchema = z.object({ action: z.literal("render"), editionUpdatedAt: z.string().datetime({ offset: true }),
  bookModelSha256: digest, imageSha256: digest, artworkSnapshot: artworkSnapshotSchema }).strict();
type Row = Record<string, unknown>;
export type SavedPrintSource = { bookId: string; editionId: string; jobId: string; assetId: string; version: 1; sha256: string; sizeBytes: number };
export type SavedPrintRender = { jobId: string; createdAt: string; source: SavedPrintSource; fingerprint: string };
type ConfirmedArtifact = { descriptor: z.infer<typeof artifactSchema>; asset: Row };
export type ConfirmedPrintRender = { render: SavedPrintRender; artifacts: ConfirmedArtifact[] };
export const printUnavailable = () => new AppError(503, "The saved print export is temporarily unavailable. No new render was created.");
const invalidSource = () => new AppError(422, "This saved print export has no verified, available PDF artifacts.");

/** Validate the immutable job and every exact version; never substitute newer artwork or exports. */
export async function savedPrintRender(sb: SupabaseClient, workspaceId: string, bookId: string, editionId: string, job: Row): Promise<ConfirmedPrintRender> {
  if (job.book_id !== bookId || job.edition_id !== editionId) throw new AppError(404, "Saved print export not found for this edition.");
  if (!z.string().uuid().safeParse(job.id).success || !z.string().datetime({ offset: true }).safeParse(job.created_at).success
    || job.channel !== "render" || job.status !== "succeeded") throw invalidSource();
  const request = requestSchema.safeParse(job.request_json);
  const response = renderSchema.safeParse(job.response_json);
  if (!request.success || !response.success) throw invalidSource();
  const descriptors = response.data.artifacts;
  const primary = descriptors.filter(artifact => artifact.role === "rendered_print");
  const covers = descriptors.filter(artifact => artifact.role === "rendered_cover");
  if (primary.length !== 1 || covers.length > 1 || new Set(descriptors.map(artifact => artifact.assetId)).size !== descriptors.length
    || (request.data.artworkSnapshot.coverAssetId !== null) !== (covers.length === 1)
    || descriptors.reduce((total, artifact) => total + artifact.sizeBytes, 0) > MAX_TOTAL_BYTES) throw invalidSource();
  const artifacts: ConfirmedArtifact[] = [];
  for (const descriptor of [...primary, ...covers]) {
    const isPrimary = descriptor.role === "rendered_print";
    const canonicalPath = `workspaces/${workspaceId}/assets/${descriptor.assetId}/v1/${descriptor.filename}`;
    if (descriptor.storagePath !== canonicalPath || (isPrimary
      ? descriptor.filename !== "book.pdf" || descriptor.mimeType !== "application/pdf" || descriptor.type !== "rendered_book"
      : descriptor.type !== "rendered_cover" || descriptor.sizeBytes > MAX_COVER_BYTES
        || !((descriptor.filename === "cover.pdf" && descriptor.mimeType === "application/pdf")
          || (descriptor.filename === "cover.png" && descriptor.mimeType === "image/png")))) throw invalidSource();
    const [{ data: asset, error: assetError }, { data: version, error: versionError }] = await Promise.all([
      sb.from("assets").select("*").eq("id", descriptor.assetId).eq("workspace_id", workspaceId).is("deleted_at", null).maybeSingle(),
      sb.from("asset_versions").select("asset_id,version_number,storage_path,mime_type,size_bytes,checksum,scan_status")
        .eq("asset_id", descriptor.assetId).eq("version_number", 1).maybeSingle(),
    ]);
    if (assetError || versionError) throw printUnavailable();
    const matches = (row: Row | null) => row && row.storage_path === canonicalPath && row.mime_type === descriptor.mimeType
      && Number(row.size_bytes) === descriptor.sizeBytes && String(row.checksum).toLowerCase() === descriptor.checksum.toLowerCase();
    if (!matches(asset) || asset?.id !== descriptor.assetId || asset.workspace_id !== workspaceId || asset.deleted_at !== null
      || asset.type !== descriptor.type || !["draft", "in_review", "approved"].includes(String(asset.status))
      || !matches(version) || version?.asset_id !== descriptor.assetId || version.version_number !== 1
      || !["clean", "trusted_generated"].includes(String(version.scan_status))) throw invalidSource();
    artifacts.push({ descriptor: { ...descriptor, checksum: descriptor.checksum.toLowerCase() }, asset });
  }
  // JSONB key order and descriptor order are not provenance changes.
  const snapshot = request.data.artworkSnapshot;
  snapshot.illustrationAssetIds.sort(); snapshot.assets.sort((a, b) => a.assetId.localeCompare(b.assetId));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    bookId, editionId, jobId: job.id, createdAt: job.created_at, request: request.data,
    artifacts: artifacts.map(artifact => artifact.descriptor), rendererVersion: response.data.rendererVersion,
  })).digest("hex");
  return { render: { jobId: String(job.id), createdAt: String(job.created_at),
    source: { bookId, editionId, jobId: String(job.id), assetId: primary[0].assetId, version: 1,
      sha256: primary[0].checksum.toLowerCase(), sizeBytes: primary[0].sizeBytes }, fingerprint }, artifacts };
}

/** Read bounded private bytes before issuing any link. These reads never render or call providers. */
export async function verifySavedPrintBytes(sb: SupabaseClient, saved: ConfirmedPrintRender, signal: AbortSignal, tasks: ReaderTasks) {
  for (const { descriptor } of saved.artifacts) {
    signal.throwIfAborted();
    const operation = Promise.resolve().then(() => sb.storage.from("book-assets").download(descriptor.storagePath));
    tasks.add(operation); void operation.finally(() => tasks.delete(operation)).catch(() => {});
    const { data, error } = await withinReaderDeadline(signal, () => operation);
    if (error || !data) throw printUnavailable();
    const limit = descriptor.role === "rendered_print" ? MAX_SAVED_PRINT_BYTES : MAX_COVER_BYTES;
    if (data.size !== descriptor.sizeBytes || data.size > limit) throw invalidSource();
    const reader = data.stream().getReader(); const hash = createHash("sha256");
    let size = 0; let signature = Buffer.alloc(0);
    try {
      while (true) {
        const read = reader.read(); tasks.add(read); void read.finally(() => tasks.delete(read)).catch(() => {});
        const next = await withinReaderDeadline(signal, () => read);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit || size > descriptor.sizeBytes) throw invalidSource();
        if (signature.length < 8) signature = Buffer.concat([signature, Buffer.from(next.value.subarray(0, 8 - signature.length))]);
        hash.update(next.value);
      }
    } catch (error) {
      const cancellation = reader.cancel(); tasks.add(cancellation); void cancellation.finally(() => tasks.delete(cancellation)).catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const expected = descriptor.mimeType === "application/pdf" ? Buffer.from("%PDF-") : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (size !== descriptor.sizeBytes || hash.digest("hex") !== descriptor.checksum || !signature.subarray(0, expected.length).equals(expected)) throw invalidSource();
  }
}
