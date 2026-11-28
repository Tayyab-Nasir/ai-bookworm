import type { PdfProofPage, RenderedEditionResult, SavedPrintRender } from "@bookworm/api-client";
import { assertReaderSource, verifyReaderResource } from "./epub-reader";

export function verifyPdfProofPage(value: PdfProofPage, proof: SavedPrintRender,
  artifact: RenderedEditionResult["artifacts"][number], page: number, width: 720 | 1080 | 1440): string {
  const fail = (): never => { throw new Error("This saved PDF page could not be verified. Retry the page or download the original file."); };
  const expected = { ...proof.source, assetId: artifact.asset.id, sha256: artifact.asset.checksum, sizeBytes: artifact.asset.size_bytes };
  if (!value || value.formatVersion !== "pdf-proof-1.0.0" || value.fingerprint !== proof.fingerprint
    || value.source?.role !== artifact.role || value.sourceSha256 !== expected.sha256 || value.sourceSizeBytes !== expected.sizeBytes
    || value.pageNumber !== page || !Number.isSafeInteger(value.pageCount) || page < 1 || page > value.pageCount || value.pageCount > 20_000
    || value.requestedWidth !== width || ![value.pageWidthPoints, value.pageHeightPoints].every(n => Number.isFinite(n) && n >= 1 && n <= 14_400)
    || typeof value.text !== "string" || value.text.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.text)
    || typeof value.textTruncated !== "boolean" || !value.image || value.image.mimeType !== "image/png"
    || value.image.sizeBytes > 6 * 1024 * 1024 || value.image.width > width || value.image.height > 4096
    || value.image.width * value.image.height > 6_000_000) return fail();
  try {
    assertReaderSource(value.source, expected);
    const resource = { ...value.image, index: 0 };
    return verifyReaderResource({ source: expected, resource }, expected, resource);
  } catch { return fail(); }
}

/** Use request start rather than receipt time: a slow reply must never extend a signed URL. */
export function renderLinksDeadline(result: RenderedEditionResult, startedAt: number): number {
  const lifetimes = result.artifacts?.map(artifact => artifact.download?.expiresIn);
  if (!lifetimes?.length || lifetimes.some(seconds => !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300)) {
    throw new Error("Private download links could not be verified. Open the saved proof to renew them.");
  }
  const deadline = startedAt + Math.min(...lifetimes) * 1000;
  if (deadline <= Date.now()) throw new Error("Private links expired before they arrived. Open the saved proof to renew them; no new render is needed.");
  return deadline;
}
