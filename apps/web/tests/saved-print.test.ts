import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@bookworm/api-client";
import { validatePrintDownload, validatePrintHistory } from "../lib/saved-print";
import type { RenderedEditionResult, SavedPrintRender } from "@bookworm/api-client";
import type { Asset } from "@bookworm/types";

const bookId = "11111111-1111-4111-8111-111111111111";
const editionId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const coverId = "55555555-5555-4555-8555-555555555555";
const workspaceId = "66666666-6666-4666-8666-666666666666";
const sha256 = "a".repeat(64), fingerprint = "b".repeat(64);
const proof: SavedPrintRender = { jobId, createdAt: "2026-10-13T12:00:00Z", fingerprint,
  source: { bookId, editionId, jobId, assetId, version: 1, sha256, sizeBytes: 1500 } };
const artifact = (id = assetId, cover = false) => {
  const path = `workspaces/${workspaceId}/assets/${id}/v1/${cover ? "cover.png" : "book.pdf"}`;
  return { asset: { id, workspace_id: workspaceId, type: cover ? "rendered_cover" : "rendered_book", name: cover ? "Cover.png" : "Book.pdf",
    storage_path: path, mime_type: cover ? "image/png" : "application/pdf", size_bytes: 1500, checksum: sha256, deleted_at: null, status: "draft" } as Asset,
    role: cover ? "rendered_cover" as const : "rendered_print" as const,
    download: { url: `https://storage.example.test/storage/v1/object/sign/book-assets/${path}?token=synthetic`, expiresIn: 300 } };
};
const result = (): RenderedEditionResult => ({ jobId, status: "succeeded", artifacts: [artifact(), artifact(coverId, true)] });

test("print history pins exact book, edition, job, primary bytes and whole-proof fingerprint", () => {
  assert.deepEqual(validatePrintHistory({ renders: [proof] }, bookId, editionId), [proof]);
  for (const change of [{ jobId: "other" }, { fingerprint: "wrong" }, { createdAt: "invalid" },
    { source: { ...proof.source, bookId: editionId } }, { source: { ...proof.source, version: 2 } },
    { source: { ...proof.source, sizeBytes: 0 } }, { source: { ...proof.source, sha256: "wrong" } }]) {
    assert.throws(() => validatePrintHistory({ renders: [{ ...proof, ...change }] }, bookId, editionId));
  }
  assert.throws(() => validatePrintHistory({ renders: [proof, proof] }, bookId, editionId));
  assert.throws(() => validatePrintHistory({ renders: Array(26).fill(proof) }, bookId, editionId));
});

test("renewed print downloads require verified canonical PDF and exact cover links", () => {
  assert.deepEqual(validatePrintDownload(result(), proof, workspaceId), result());
  for (const mutate of [
    (r: RenderedEditionResult) => r.jobId = editionId,
    (r: RenderedEditionResult) => r.status = "running",
    (r: RenderedEditionResult) => r.artifacts[0].asset.id = coverId,
    (r: RenderedEditionResult) => r.artifacts[0].asset.workspace_id = bookId,
    (r: RenderedEditionResult) => r.artifacts[0].asset.checksum = fingerprint,
    (r: RenderedEditionResult) => r.artifacts[0].asset.size_bytes = 1501,
    (r: RenderedEditionResult) => r.artifacts[0].asset.deleted_at = "2026-10-13T12:00:00Z",
    (r: RenderedEditionResult) => r.artifacts[0].asset.storage_path = "other/book.pdf",
    (r: RenderedEditionResult) => r.artifacts[0].download.expiresIn = 301,
    (r: RenderedEditionResult) => r.artifacts[0].download.url = "javascript:alert(1)",
    (r: RenderedEditionResult) => r.artifacts[0].download.url = r.artifacts[0].download.url.replace("?token=synthetic", ""),
    (r: RenderedEditionResult) => r.artifacts[1].asset.mime_type = "text/html",
    (r: RenderedEditionResult) => r.artifacts.push(r.artifacts[0]),
    (r: RenderedEditionResult) => r.artifacts = [r.artifacts[1]],
  ]) { const value = result(); mutate(value); assert.throws(() => validatePrintDownload(value, proof, workspaceId)); }
});

test("typed print client reads exact proof by SHA and whole-source fingerprint, never posts or renders", async () => {
  const requests: { url: string; method: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(String(url).includes("/download?") ? result() : { renders: [proof] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const api = createClient({ baseUrl: "https://api.example.test" });
    await api.listPrintRenders(editionId);
    await api.downloadPrintRender(editionId, jobId, sha256, fingerprint);
    assert.equal(requests[0].url, `https://api.example.test/v1/editions/${editionId}/print-renders`);
    assert.equal(requests[1].url, `https://api.example.test/v1/editions/${editionId}/print-renders/${jobId}/download?sha256=${sha256}&fingerprint=${fingerprint}`);
    assert(requests.every(request => request.method === "GET"));
  } finally { globalThis.fetch = originalFetch; }
});
