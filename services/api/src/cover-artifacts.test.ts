import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodeRenderedCover, editionConfigSchema, renderResponseSchema } from "./routes/editions.js";
import { loadRenderedPackageInputs } from "./routes/publishing.js";

const COVER = "ca000000-0000-4000-8000-000000000001";
const BOOK = "ca000000-0000-4000-8000-000000000002";
const WORKSPACE = "ca000000-0000-4000-8000-000000000003";
const bytes = Buffer.from("%PDF-1.4\nprivate-cover-fixture");
const sha = createHash("sha256").update(bytes).digest("hex");
const config = editionConfigSchema.parse({ kind: "print", cover: { asset_id: COVER }, wrap_cover: { enabled: true } });
const rendered = renderResponseSchema.parse({ format: "pdf", artifactBase64: bytes.toString("base64"), sha256: sha,
  rendererVersion: "fixture", coverArtifactBase64: bytes.toString("base64"), coverSha256: sha, coverFormat: "pdf" });

test("full cover transport requires PDF format, signature, checksum and selected artwork", () => {
  const cover = decodeRenderedCover(config, rendered)!;
  assert.equal(cover.filename, "cover.pdf");
  assert.equal(cover.mimeType, "application/pdf");
  assert.deepEqual(cover.bytes, bytes);
  assert.throws(() => decodeRenderedCover(config, { ...rendered, coverFormat: "png" }), /wrong cover format/);
  assert.throws(() => decodeRenderedCover(config, { ...rendered, coverSha256: "a".repeat(64) }), /checksum/);
  assert.throws(() => decodeRenderedCover(config, { ...rendered, coverArtifactBase64: null, coverSha256: null }), /omitted/);
  const invalid = Buffer.from("not-a-pdf");
  assert.throws(() => decodeRenderedCover(config, { ...rendered, coverArtifactBase64: invalid.toString("base64"), coverSha256: createHash("sha256").update(invalid).digest("hex") }), /invalid cover pdf/);
  assert.equal(editionConfigSchema.safeParse({ kind: "print", wrap_cover: { enabled: true } }).success, false);
  assert.equal(editionConfigSchema.safeParse({ kind: "print", cover: { asset_id: COVER }, wrap_cover: { enabled: true, profile: "custom" } }).success, false);
});

test("confirmed private cover PDF is packaged with its exact name and bytes", async () => {
  const artifacts = [
    { assetId: BOOK, role: "rendered_print", type: "rendered_book", filename: "book.pdf" },
    { assetId: COVER, role: "rendered_cover", type: "rendered_cover", filename: "cover.pdf" },
  ].map((artifact) => ({ ...artifact, storagePath: `workspaces/${WORKSPACE}/assets/${artifact.assetId}/v1/${artifact.filename}`,
    name: artifact.filename, mimeType: "application/pdf", sizeBytes: bytes.length, checksum: sha }));
  const assets = artifacts.map((artifact) => ({ id: artifact.assetId, storage_path: artifact.storagePath,
    mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, checksum: sha }));
  const reads: string[] = [];
  const builder = { select: () => builder, eq: () => builder, is: () => builder,
    in: async () => ({ data: assets, error: null }) };
  const sb = { from: () => builder, storage: { from: () => ({ download: async (path: string) => {
    reads.push(path); return { data: new Blob([bytes]), error: null };
  } }) } } as never;
  const job = { response_json: { artifacts, rendererVersion: "fixture", usage: {} } };
  const result = await loadRenderedPackageInputs(sb, WORKSPACE, "print", job);
  assert.deepEqual(Object.keys(result).sort(), ["book.pdf", "cover.pdf"]);
  assert.equal(result["cover.pdf"], bytes.toString("base64"));
  assert.equal(reads.length, 2);
  artifacts[1].filename = "cover.png";
  await assert.rejects(loadRenderedPackageInputs(sb, WORKSPACE, "print", job), /invalid format/);
});
