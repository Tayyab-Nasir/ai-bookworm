import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadRenderImages } from "./routes/editions.js";
import { checkAssetReferences } from "./lib/authoring.js";
import { assertRenderImagesCurrent, renderImagesFingerprint } from "./lib/render-images.js";
import type { SupabaseClient } from "./lib/supabase.js";

const workspace = "workspace", assetId = "f7400000-0000-4000-8000-000000000001";
const approvalId = "07400000-0000-4000-8000-000000000001";
const bytes = Buffer.from("approved version four");
const checksum = createHash("sha256").update(bytes).digest("hex");
const path = "workspaces/workspace/assets/art/v4/art.png";
type Row = Record<string, unknown>;
function fixture() {
  const asset: Row = { id: assetId, workspace_id: workspace, storage_path: path, mime_type: "image/png",
    size_bytes: bytes.length, checksum, status: "approved", requires_approval: true, deleted_at: null };
  const version: Row = { asset_id: assetId, version_number: 4, storage_path: path, mime_type: "image/png",
    size_bytes: bytes.length, checksum, scan_status: "clean" };
  const approval: Row = { id: approvalId, workspace_id: workspace, entity_type: "asset", entity_id: assetId,
    entity_version_number: 4, status: "approved", superseded_at: null };
  const tables: Record<string, Row[]> = { assets: [asset], asset_versions: [version], approvals: [approval] };
  const downloads: string[] = [];
  const sb = {
    from: (table: string) => {
      const filters: ((row: Row) => boolean)[] = [];
      const result = () => tables[table].filter(row => filters.every(f => f(row)));
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        is: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
        maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
        then: (resolve: (data: unknown) => unknown) => resolve({ data: result(), error: null }),
      };
      return query;
    },
    storage: { from: () => ({ download: async (key: string) => {
      downloads.push(key); return { data: new Blob([bytes]), error: null };
    } }) },
  } as unknown as SupabaseClient;
  return { sb, asset, version, approval, tables, downloads };
}
const pin = (version = 4) => [{ assetId, assetVersionNumber: version }];

test("render loads exactly the placed approved version, shared with the cover", async () => {
  const f = fixture();
  const result = await loadRenderImages(f.sb, workspace, [assetId], assetId, pin());
  assert.deepEqual(f.downloads, [path]);
  assert.equal(result.coverBase64, bytes.toString("base64"));
  assert.equal(result.assetImagesBase64[assetId], result.coverBase64);
  assert.deepEqual(result.artworkSnapshot, {
    schemaVersion: 1, coverAssetId: assetId, illustrationAssetIds: [assetId],
    assets: [{ assetId, versionNumber: 4, storagePath: path, checksum, mimeType: "image/png",
      sizeBytes: bytes.length, requiresApproval: true, approvalId }],
  });
});

test("identical image bytes do not hide a revised cover or replacement approval", async () => {
  for (const change of ["version", "approval"]) {
    const f = fixture();
    const before = renderImagesFingerprint(await loadRenderImages(f.sb, workspace, [], assetId));
    if (change === "version") {
      f.version.version_number = 5; f.approval.entity_version_number = 5;
    } else f.approval.id = "07400000-0000-4000-8000-000000000002";
    await assert.rejects(assertRenderImagesCurrent(f.sb, workspace, [], assetId, [], before), /artwork changed/u);
  }
});

test("books without artwork still have an explicit empty completion snapshot", async () => {
  const f = fixture();
  const result = await loadRenderImages(f.sb, workspace, [], null);
  assert.deepEqual(result.artworkSnapshot, { schemaVersion: 1, coverAssetId: null, illustrationAssetIds: [], assets: [] });
  assert.deepEqual(f.downloads, []);
});

test("artwork fingerprint ignores PostgreSQL JSONB object-key ordering", async () => {
  const f = fixture();
  const images = await loadRenderImages(f.sb, workspace, [assetId], assetId, pin());
  const reverse = (value: object) => Object.fromEntries(Object.entries(value).reverse());
  const snapshot = reverse(images.artworkSnapshot) as typeof images.artworkSnapshot;
  snapshot.assets = images.artworkSnapshot.assets.map(asset => reverse(asset) as typeof asset);
  assert.notEqual(JSON.stringify(snapshot), JSON.stringify(images.artworkSnapshot));
  assert.equal(renderImagesFingerprint({ ...images, artworkSnapshot: snapshot }), renderImagesFingerprint(images));
});

test("a later approved revision cannot silently replace a pinned illustration", async () => {
  const f = fixture();
  await assert.rejects(loadRenderImages(f.sb, workspace, [assetId], null, pin(3)), /placed.*version|version.*changed/i);
  assert.deepEqual(f.downloads, []);
});

test("review-required placements need an explicit consistent version across all nodes", async () => {
  for (const refs of [[], [{ assetId }], [...pin(), ...pin(3)], [...pin(), { assetId }]]) {
    const f = fixture();
    await assert.rejects(loadRenderImages(f.sb, workspace, [assetId], null, refs), /version/i);
    assert.deepEqual(f.downloads, []);
  }
});

test("unreviewed imports still require a clean current version and live state", async () => {
  for (const state of ["pending", "infected", "error"]) {
    const f = fixture(); f.asset.requires_approval = false; f.version.scan_status = state;
    await assert.rejects(loadRenderImages(f.sb, workspace, [assetId], null, pin()), /clean|quarantined/i);
    assert.deepEqual(f.downloads, []);
  }
  for (const state of ["archived", "rejected"]) {
    const f = fixture(); f.asset.requires_approval = false; f.asset.status = state;
    await assert.rejects(loadRenderImages(f.sb, workspace, [assetId], null, pin()), /unavailable|archived|rejected/i);
    assert.deepEqual(f.downloads, []);
  }
  const f = fixture(); f.asset.requires_approval = false; f.asset.status = "draft";
  assert.equal((await loadRenderImages(f.sb, workspace, [assetId], null)).assetImagesBase64[assetId], bytes.toString("base64"));
});

test("superseded approvals, mismatched versions, foreign assets and corrupt bytes fail closed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.approval.superseded_at = "2026-10-03T00:00:00Z"; },
    (f: ReturnType<typeof fixture>) => { f.version.checksum = "b".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.asset.workspace_id = "another-workspace"; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(loadRenderImages(f.sb, workspace, [assetId], null, pin()));
    assert.deepEqual(f.downloads, []);
  }
  const f = fixture(); f.asset.checksum = f.version.checksum = "b".repeat(64);
  await assert.rejects(loadRenderImages(f.sb, workspace, [assetId], null, pin()), /confirmed version/i);
  assert.deepEqual(f.downloads, [path]);
});

test("manuscript attachment rejects superseded reviews and archived artwork", async () => {
  const node = { id: "image-node", type: "image" as const, assetId, assetVersionNumber: 4 };
  const f = fixture();
  await checkAssetReferences(f.sb, [node], workspace);
  f.approval.superseded_at = "2026-10-03T02:00:00Z";
  await assert.rejects(checkAssetReferences(f.sb, [node], workspace), /approved.*current version/u);
  f.asset.requires_approval = false;
  f.asset.status = "archived";
  await assert.rejects(checkAssetReferences(f.sb, [node], workspace), /missing|unconfirmed/u);
});
