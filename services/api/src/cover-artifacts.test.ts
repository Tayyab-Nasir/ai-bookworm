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
  const result = await loadRenderedPackageInputs(sb, WORKSPACE, "print", job, config);
  assert.deepEqual(Object.keys(result).sort(), ["book.pdf", "cover.pdf"]);
  assert.equal(result["cover.pdf"], bytes.toString("base64"));
  assert.equal(reads.length, 2);
  artifacts[1].filename = "cover.png";
  await assert.rejects(loadRenderedPackageInputs(sb, WORKSPACE, "print", job, config), /invalid format/);
});

const coverPolicy = "effective-ebook-metadata-v1";
const coverVersion = "cover-1.4.0";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]);
const epub = Buffer.from("PK\u0003\u0004saved-ebook-fixture");
const checksum = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function ebookPackageFixture(selectedCover = true) {
  const artifacts = [{ assetId: BOOK, role: "rendered_ebook", type: "rendered_book", filename: "book.epub", mimeType: "application/epub+zip", bytes: epub },
    ...(selectedCover ? [{ assetId: COVER, role: "rendered_cover", type: "rendered_cover", filename: "cover.png", mimeType: "image/png", bytes: png }] : [])]
    .map(({ bytes: value, ...artifact }) => ({ ...artifact, storagePath: `workspaces/${WORKSPACE}/assets/${artifact.assetId}/v1/${artifact.filename}`,
      name: artifact.filename, sizeBytes: value.length, checksum: checksum(value) }));
  const assets = artifacts.map(artifact => ({ id: artifact.assetId, storage_path: artifact.storagePath,
    mime_type: artifact.mimeType, size_bytes: artifact.sizeBytes, checksum: artifact.checksum }));
  const reads: string[] = [];
  const builder = { select: () => builder, eq: () => builder, is: () => builder,
    in: async () => ({ data: assets, error: null }) };
  const sb = { from: () => { reads.push("assets"); return builder; }, storage: { from: () => ({ download: async (path: string) => {
    reads.push(path); return { data: new Blob([path.endsWith("cover.png") ? png : epub]), error: null };
  } }) } } as never;
  return { sb, reads, job: { response_json: { artifacts, rendererVersion: "epub-fixture", usage: {} as Record<string, unknown> } } };
}

test("affected ebook cover completion requires the reviewed renderer and retains its policy", () => {
  for (const metadata_overrides of [{ title: "" }, { subtitle: "" }, { author: "" }, { language: "fr" }]) {
    const selected = editionConfigSchema.parse({ kind: "ebook", cover: { asset_id: COVER }, metadata_overrides });
    const output = { ...rendered, coverFormat: "png" as const, coverArtifactBase64: png.toString("base64"), coverSha256: checksum(png) };
    for (const coverRendererVersion of [undefined, null, "cover-1.3.0", "cover-1.5.0"]) {
      assert.throws(() => decodeRenderedCover(selected, { ...output, coverRendererVersion }), /cover metadata.*render again/iu);
    }
    const decoded = decodeRenderedCover(selected, { ...output, coverRendererVersion: coverVersion })!;
    assert.deepEqual((decoded as typeof decoded & { usage: unknown }).usage, { coverRendererVersion: coverVersion, coverMetadataPolicy: coverPolicy });
    assert.deepEqual(decoded.bytes, png);
  }
  const legacy = editionConfigSchema.parse({ kind: "ebook", cover: { asset_id: COVER } });
  const decoded = decodeRenderedCover(legacy, { ...rendered, coverFormat: "png", coverArtifactBase64: png.toString("base64"), coverSha256: checksum(png), coverRendererVersion: "cover-1.3.0" })!;
  assert.deepEqual((decoded as typeof decoded & { usage: unknown }).usage, { coverRendererVersion: "cover-1.3.0" });
});

test("affected saved ebook covers reject missing or old policy before any private artifact reads", async () => {
  for (const metadata_overrides of [{ title: "" }, { subtitle: "" }, { author: "" }, { language: "fr" }]) {
    const selected = editionConfigSchema.parse({ kind: "ebook", cover: { asset_id: COVER }, metadata_overrides });
    for (const usage of [{}, { coverRendererVersion: coverVersion }, { coverMetadataPolicy: coverPolicy },
      { coverRendererVersion: "cover-1.3.0", coverMetadataPolicy: coverPolicy },
      { coverRendererVersion: coverVersion, coverMetadataPolicy: "old-policy" }]) {
      const fixture = ebookPackageFixture();
      fixture.job.response_json.usage = usage;
      const saved = structuredClone(fixture.job);
      await assert.rejects(loadRenderedPackageInputs(fixture.sb, WORKSPACE, "ebook", fixture.job, selected), /cover metadata.*render again/iu);
      assert.deepEqual(fixture.reads, []);
      assert.deepEqual(fixture.job, saved, "a rejected historical render must not be relabelled");
    }
  }
});

test("reviewed affected covers and unaffected historical ebook bytes remain unchanged", async () => {
  const cases = [
    { cover: { asset_id: COVER }, metadata_overrides: { title: "Edition title" }, usage: { coverRendererVersion: coverVersion, coverMetadataPolicy: coverPolicy } },
    { cover: { asset_id: COVER }, metadata_overrides: {}, usage: {} },
    { cover: { asset_id: COVER, title_on_cover: false }, metadata_overrides: { title: "" }, usage: {} },
    { cover: { asset_id: COVER, subtitle_on_cover: false }, metadata_overrides: { subtitle: "" }, usage: {} },
    { cover: { asset_id: COVER, author_on_cover: false }, metadata_overrides: { author: "" }, usage: {} },
    { cover: { asset_id: COVER, title_on_cover: false, subtitle_on_cover: false, author_on_cover: false }, metadata_overrides: { language: "ar" }, usage: {} },
    { cover: { asset_id: COVER }, metadata_overrides: { publisher: "Edition publisher" }, usage: {} },
    { cover: { asset_id: null }, metadata_overrides: { title: "Edition without cover" }, usage: {} },
  ];
  for (const value of cases) {
    const selected = editionConfigSchema.parse({ kind: "ebook", cover: value.cover, metadata_overrides: value.metadata_overrides });
    const fixture = ebookPackageFixture(Boolean(value.cover.asset_id));
    fixture.job.response_json.usage = value.usage;
    const saved = structuredClone(fixture.job);
    const encoded = await loadRenderedPackageInputs(fixture.sb, WORKSPACE, "ebook", fixture.job, selected);
    assert.equal(encoded["book.epub"], epub.toString("base64"));
    assert.equal(encoded["cover.png"], value.cover.asset_id ? png.toString("base64") : undefined);
    assert.deepEqual(fixture.job, saved);
  }
});

test("an affected saved cover cannot claim reviewed policy without a cover artifact", async () => {
  const fixture = ebookPackageFixture(false);
  fixture.job.response_json.usage = { coverRendererVersion: coverVersion, coverMetadataPolicy: coverPolicy };
  const selected = editionConfigSchema.parse({ kind: "ebook", cover: { asset_id: COVER }, metadata_overrides: { title: "Edition" } });
  await assert.rejects(loadRenderedPackageInputs(fixture.sb, WORKSPACE, "ebook", fixture.job, selected), /cover metadata.*render again/iu);
  assert.deepEqual(fixture.reads, []);
});
