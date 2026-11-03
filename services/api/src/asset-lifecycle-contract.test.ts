import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Load the scratch client's source at runtime without expanding the API
// package's TypeScript rootDir to include a sibling workspace.
const { createClient, ApiClientError } = await import(new URL("../../../packages/api-client/src/index.ts", import.meta.url).href);

const spec = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function pathBlock(path: string) {
  const start = spec.indexOf(`  ${path}:\n`);
  assert.notEqual(start, -1, `missing OpenAPI path ${path}`);
  const end = spec.indexOf("\n  /v1/", start + 1);
  return spec.slice(start, end === -1 ? undefined : end);
}
test("OpenAPI exposes recoverable operations and documents the gated legacy routes", () => {
  for (const [path, operationId] of [
    ["/v1/assets/removed", "listRemovedAssets"],
    ["/v1/assets/{assetId}/lifecycle/{operationId}", "getAssetLifecycleStatus"],
    ["/v1/assets/{assetId}/lifecycle/close", "closeAssetLifecycle"],
    ["/v1/assets/{assetId}/lifecycle/remove", "removeAssetLifecycle"],
    ["/v1/assets/{assetId}/lifecycle/restore", "restoreAssetLifecycle"],
  ]) {
    const block = pathBlock(path);
    assert.match(block, new RegExp(`operationId: ${operationId}`));
    assert.match(block, /"200":/);
    assert.match(block, /"503":/);
  }
  for (const schema of ["RemovedAsset", "AssetLifecycleRemove", "AssetLifecycleRestore", "AssetLifecycleClose", "AssetLifecycleReceipt", "AssetLifecycleStatus"])
    assert.match(spec, new RegExp(`    ${schema}:\\n`));
  const legacyDelete = pathBlock("/v1/assets/{assetId}").split("    delete:")[1];
  const legacyRestore = pathBlock("/v1/assets/{assetId}/restore");
  for (const block of [legacyDelete, legacyRestore]) {
    assert.match(block, /"410":/);
    assert.match(block, /"200":/);
  }
  assert.match(spec, /required: \[workspaceId, operationId, expectedDeletedAt, expectedRevision\]/);
  assert.match(spec, /required: \[id, workspace_id, name, deleted_at, lifecycle_revision, hasRecordedChecksum\]/);
  assert.match(spec, /required: \[assetId, operationId, action, expectedRevision, replayed\]/);
});

test("typed client carries the saved operation identity and surfaces legacy 410 responses", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/restore")) return Response.json({ error: { code: "gone", message: "Refresh the app", requestId: "fixture" } }, { status: 410 });
    return Response.json({ assetId: "file", operationId: "saved", action: "remove", expectedRevision: null, replayed: false });
  };
  try {
    const client = createClient({ baseUrl: "https://fixture.invalid", token: "synthetic", idempotencyKey: () => "synthetic" });
    await client.removeAssetLifecycle("file", { workspaceId: "workspace", operationId: "saved", expectedRevision: null });
    assert.equal(calls[0].url, "https://fixture.invalid/v1/assets/file/lifecycle/remove");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { workspaceId: "workspace", operationId: "saved", expectedRevision: null });
    await assert.rejects(client.restoreAsset("file"), error => error instanceof ApiClientError && (error as { status?: number }).status === 410);
    assert.equal(calls[1].url, "https://fixture.invalid/v1/assets/file/restore");
  } finally { globalThis.fetch = original; }
});
