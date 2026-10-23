import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient, type PdfProofPage, type RenderedEditionResult, type SavedPrintRender } from "@bookworm/api-client";
import { verifyPdfProofPage, renderLinksDeadline } from "../lib/pdf-proof";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const proof: SavedPrintRender = { jobId: id(3), createdAt: "2026-10-24T00:00:00Z", fingerprint: "b".repeat(64),
  source: { bookId: id(1), editionId: id(2), jobId: id(3), assetId: id(4), version: 1, sha256: "a".repeat(64), sizeBytes: 1000 } };
const artifact = { asset: { id: id(4), checksum: "a".repeat(64), size_bytes: 1000 }, role: "rendered_print", download: { expiresIn: 300 } } as RenderedEditionResult["artifacts"][number];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
const page = (): PdfProofPage => ({ formatVersion: "pdf-proof-1.0.0", source: { ...proof.source, role: "rendered_print" }, fingerprint: proof.fingerprint,
  sourceSha256: proof.source.sha256, sourceSizeBytes: 1000, pageNumber: 1, pageCount: 4, requestedWidth: 1080,
  pageWidthPoints: 432, pageHeightPoints: 648, text: "<script>inert text</script>", textTruncated: false,
  image: { mimeType: "image/png", width: 1, height: 1, sizeBytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), base64: png.toString("base64") } });

test("PDF proof reuses the bounded, verified inert raster reader", () => {
  assert.equal(verifyPdfProofPage(page(), proof, artifact, 1, 1080), `data:image/png;base64,${png.toString("base64")}`);
  for (const mutate of [
    (r: PdfProofPage) => { r.source.bookId = id(9); }, (r: PdfProofPage) => { r.source.role = "rendered_cover"; },
    (r: PdfProofPage) => { r.fingerprint = "c".repeat(64); }, (r: PdfProofPage) => { r.sourceSha256 = "c".repeat(64); },
    (r: PdfProofPage) => { r.pageNumber = 2; }, (r: PdfProofPage) => { r.pageCount = 0; }, (r: PdfProofPage) => { r.pageCount = 20_001; },
    (r: PdfProofPage) => { r.requestedWidth = 720; }, (r: PdfProofPage) => { r.pageWidthPoints = NaN; },
    (r: PdfProofPage) => { r.image.sha256 = "c".repeat(64); }, (r: PdfProofPage) => { r.image.width = 2; },
    (r: PdfProofPage) => { r.image.sizeBytes = 7 * 1024 * 1024; }, (r: PdfProofPage) => { r.image.base64 += "\n"; },
    (r: PdfProofPage) => { r.text = "text\u0000hidden"; }, (r: PdfProofPage) => { r.text = "x".repeat(6001); },
  ]) { const reply = page(); mutate(reply); assert.throws(() => verifyPdfProofPage(reply, proof, artifact, 1, 1080), /could not be verified/); }
});

test("fresh proof links expire relative to request start, never after their signed lifetime", () => {
  const now = Date.now(); const render = { artifacts: [artifact] } as RenderedEditionResult;
  assert.equal(renderLinksDeadline(render, now - 10_000), now + 290_000);
  for (const seconds of [0, 301, NaN, 1.5]) assert.throws(() => renderLinksDeadline({ artifacts: [{ ...artifact, download: { url: "unused", expiresIn: seconds } }] } as RenderedEditionResult, now));
  assert.throws(() => renderLinksDeadline(render, now - 301_000), /expired/);
});

test("PDF client pins source and forwards cancellation without posting or signing", async () => {
  const previous = globalThis.fetch; const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init?.signal, controller.signal); assert.equal(init?.body, undefined);
    const parsed = new URL(String(url)); assert.equal(parsed.pathname, `/v1/editions/${id(2)}/print-renders/${id(3)}/pages/4`);
    assert.equal(parsed.searchParams.get("sha256"), proof.source.sha256); assert.equal(parsed.searchParams.get("fingerprint"), proof.fingerprint);
    assert.equal(parsed.searchParams.get("assetId"), id(4)); assert.equal(parsed.searchParams.get("width"), "720"); return Response.json(page());
  };
  try { await createClient({ baseUrl: "https://api.example.test" }).readPrintPage(id(2), id(3), 4,
    { sha256: proof.source.sha256, fingerprint: proof.fingerprint, assetId: id(4), width: 720 }, controller.signal); }
  finally { globalThis.fetch = previous; }
});
