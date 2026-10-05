import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { imageQuoteContext } from "./lib/image-quote-context.js";

test("image quote references require private scope, clean version and exact downloaded bytes", async () => {
  const workspaceId = "eb000000-0000-4000-8000-000000000001";
  const assetId = "eb000000-0000-4000-8000-000000000002";
  const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const path = `workspaces/${workspaceId}/assets/${assetId}/v2/reference.png`;
  const rows: Record<string, Record<string, any>> = {
    assets: { id: assetId, workspace_id: workspaceId, storage_path: path, checksum, mime_type: "image/png", size_bytes: bytes.length, deleted_at: null },
    asset_versions: { asset_id: assetId, storage_path: path, checksum, version_number: 2, scan_status: "clean" },
  };
  let downloads = 0; let output = bytes;
  const user = { from(table: string) {
    const filters: [string, unknown][] = [];
    return { select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
      async maybeSingle() { const row = rows[table]; return { data: row && filters.every(([key,value]) => row[key] === value) ? row : null, error: null }; } };
  }, storage: { from(bucket: string) { assert.equal(bucket, "book-assets"); return { async download(value: string) {
    assert.equal(value, path); downloads++; return { data: new Blob([output]), error: null };
  } }; } } } as never;
  const input = { workspaceId, prompt: "Same character", kind: "illustration" as const, referenceAssetIds: [assetId] };
  const result = await imageQuoteContext(user, input);
  assert.deepEqual(result.references, [{ assetId, version: 2, sha256: checksum, mimeType: "image/png" }]);
  rows.asset_versions!.scan_status = "infected";
  await assert.rejects(imageQuoteContext(user, input), /quarantined/);
  assert.equal(downloads, 1);
  rows.asset_versions!.scan_status = "clean";
  output = Buffer.alloc(bytes.length);
  await assert.rejects(imageQuoteContext(user, input), /integrity/);
  rows.assets!.workspace_id = assetId;
  await assert.rejects(imageQuoteContext(user, input), /not found/);
  assert.equal(downloads, 2);
});
