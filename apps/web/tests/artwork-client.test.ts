import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@bookworm/api-client";
import { BookNodeSchema } from "@bookworm/book-model";

test("artwork client preserves exact versions, review identity and rejection notes", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({});
  };
  try {
    const api = createClient({ baseUrl: "/api/backend" });
    await api.getAssetDownloadUrl("artwork", 4);
    await api.getAssetDownloadUrl("artwork", 0);
    await api.getAssetDownloadUrl("artwork");
    assert.equal(calls[0].url, "/api/backend/v1/assets/artwork/download-url?versionNumber=4");
    assert.equal(calls[1].url, "/api/backend/v1/assets/artwork/download-url?versionNumber=0",
      "invalid zero must reach server validation, not silently load the current version");
    assert.equal(calls[2].url, "/api/backend/v1/assets/artwork/download-url");

    const request = { workspaceId: "workspace", entityType: "asset" as const, entityId: "artwork",
      reviewerId: "reviewer", entityVersionNumber: 4, idempotencyKey: "request-key", comment: "Check composition" };
    await api.createApproval(request);
    await api.resolveApproval("approval", "reject", "Adjust lighting.");
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)), request);
    assert.equal(calls[4].url, "/api/backend/v1/approvals/approval/reject");
    assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { comment: "Adjust lighting." });
    assert.ok(calls.every(call => call.init?.credentials === "same-origin"));
  } finally { globalThis.fetch = original; }
});

test("canonical image pins require a positive integer and real asset identity", () => {
  const node = { id: "image-node", type: "image", assetId: "f7200000-0000-4000-8000-000000000001", assetVersionNumber: 4 };
  assert.equal(BookNodeSchema.parse(node).assetVersionNumber, 4);
  for (const version of [0, -1, 1.5]) assert.equal(BookNodeSchema.safeParse({ ...node, assetVersionNumber: version }).success, false);
  assert.equal(BookNodeSchema.safeParse({ ...node, assetId: "not-an-asset-uuid" }).success, false);
});
