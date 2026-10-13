import type { RenderedEditionResult, SavedPrintRender } from "@bookworm/api-client";
import { validateReaderDownload } from "./epub-reader";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const digest = /^[a-f0-9]{64}$/u;
const fail = (): never => { throw new Error("The saved print proof could not be verified. Refresh its history and try again."); };
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;

export function validatePrintHistory(value: unknown, bookId: string, editionId: string): SavedPrintRender[] {
  const renders = (value as { renders?: unknown } | null)?.renders;
  if (!Array.isArray(renders) || renders.length > 25) return fail();
  const ids = new Set<string>();
  for (const entry of renders) {
    const source = entry?.source;
    if (!source || !uuid.test(entry.jobId) || ids.has(entry.jobId) || source.jobId !== entry.jobId
      || source.bookId !== bookId || source.editionId !== editionId || !uuid.test(source.assetId) || source.version !== 1
      || !digest.test(source.sha256) || !digest.test(entry.fingerprint) || !integer(source.sizeBytes, 150 * 1024 * 1024)
      || typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt))) return fail();
    ids.add(entry.jobId);
  }
  return renders as SavedPrintRender[];
}

export function validatePrintDownload(value: RenderedEditionResult, selected: SavedPrintRender, workspaceId: string): RenderedEditionResult {
  if (!value || value.jobId !== selected.jobId || value.status !== "succeeded" || !Array.isArray(value.artifacts)
    || value.artifacts.length < 1 || value.artifacts.length > 2) return fail();
  let interiors = 0; let covers = 0; const ids = new Set<string>();
  for (const { asset, role, download } of value.artifacts) {
    if (!asset || !uuid.test(asset.id) || ids.has(asset.id) || asset.workspace_id !== workspaceId || asset.deleted_at !== null
      || !["draft", "in_review", "approved"].includes(asset.status) || typeof asset.name !== "string" || !asset.name.trim()
      || !digest.test(asset.checksum) || !integer(asset.size_bytes, role === "rendered_print" ? 150 * 1024 * 1024 : 25 * 1024 * 1024)) return fail();
    const filename = role === "rendered_print" ? "book.pdf" : asset.mime_type === "image/png" ? "cover.png" : "cover.pdf";
    const expectedPath = `workspaces/${workspaceId}/assets/${asset.id}/v1/${filename}`;
    if (asset.storage_path !== expectedPath) return fail();
    if (role === "rendered_print") {
      interiors++;
      if (asset.id !== selected.source.assetId || asset.type !== "rendered_book" || asset.mime_type !== "application/pdf"
        || asset.checksum !== selected.source.sha256 || asset.size_bytes !== selected.source.sizeBytes) return fail();
    } else if (role === "rendered_cover") {
      covers++;
      if (asset.type !== "rendered_cover" || !["application/pdf", "image/png"].includes(asset.mime_type)) return fail();
    } else return fail();
    const url = new URL(validateReaderDownload(download));
    if (!integer(download.expiresIn, 300) || decodeURIComponent(url.pathname) !== `/storage/v1/object/sign/book-assets/${expectedPath}`
      || !url.searchParams.get("token")) return fail();
    ids.add(asset.id);
  }
  if (interiors !== 1 || covers > 1) return fail();
  return value;
}
