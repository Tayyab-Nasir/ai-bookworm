import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

const workspaceId = "c7100000-0000-4000-8000-000000000001";
const requesterId = "a7100000-0000-0000-0000-000000000002";
const reviewerId = "a7100000-0000-0000-0000-000000000003";
const assetId = "d7100000-0000-4000-8000-000000000001";
const approvalId = "e7100000-0000-4000-8000-000000000001";
const auth = { authorization: "Bearer good" };

type Response = { data?: unknown; error?: unknown };
type Call = { table: string; op: string; row: unknown };

function fakeSupabase(responses: Record<string, Response>, calls: Call[]) {
  return {
    auth: {
      getUser: async (token: string) => token === "good"
        ? { data: { user: { id: requesterId } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
    storage: { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `signed:${path}` }, error: null }) }) },
    from: (table: string) => {
      const response = responses[table] ?? { data: null, error: null };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "in", "order", "limit"]) query[method] = () => query;
      query.insert = (row: unknown) => { calls.push({ table, op: "insert", row }); return query; };
      query.update = (row: unknown) => { calls.push({ table, op: "update", row }); return query; };
      query.delete = () => { calls.push({ table, op: "delete", row: null }); return query; };
      query.single = async () => response;
      query.maybeSingle = async () => response;
      query.then = (resolve: (value: unknown) => unknown) => resolve({
        data: Array.isArray(response.data) ? response.data : response.data == null ? [] : [response.data],
        error: response.error ?? null,
      });
      return query;
    },
    rpc: async (name: string, args: unknown) => {
      calls.push({ table: `rpc:${name}`, op: "rpc", row: args });
      return responses[`rpc:${name}`] ?? { data: null, error: null };
    },
  } as never;
}

async function appWith(responses: Record<string, Response>) {
  const calls: Call[] = [];
  const app = await buildApp(() => fakeSupabase(responses, calls));
  return { app, calls };
}

const activeEditor = { workspace_members: { data: { role: "editor", status: "active" }, error: null } };
const asset = {
  id: assetId, workspace_id: workspaceId, type: "illustration", mime_type: "image/png",
  status: "draft", requires_approval: true, storage_path: `workspaces/${workspaceId}/assets/${assetId}/v3/art.png`,
  checksum: "a".repeat(64), deleted_at: null,
};
const cleanCurrentVersion = { data: { version_number: 3, storage_path: asset.storage_path, scan_status: "clean", checksum: asset.checksum }, error: null };

test("asset review request requires an assigned reviewer and exact version", async () => {
  const { app } = await appWith({
    ...activeEditor,
    assets: { data: asset },
    asset_versions: cleanCurrentVersion,
    approvals: { data: { ...asset, id: approvalId, status: "pending" } },
  });
  const response = await app.inject({
    method: "POST", url: "/v1/approvals", headers: auth,
    payload: { workspaceId, entityType: "asset", entityId: assetId, entityVersionNumber: 3,
      idempotencyKey: "f7100000-0000-4000-8000-000000000001", comment: "Check details" },
  });
  assert.equal(response.statusCode, 422);
  assert.match(response.json().error.message, /reviewer is required/i);
  await app.close();
});

test("asset review request is version-bound and uses the atomic database workflow", async () => {
  const approval = { id: approvalId, workspace_id: workspaceId, entity_type: "asset", entity_id: assetId,
    requested_by: requesterId, reviewer_id: reviewerId, entity_version_number: 3, status: "pending" };
  const { app, calls } = await appWith({
    ...activeEditor,
    assets: { data: asset },
    asset_versions: cleanCurrentVersion,
    "rpc:request_asset_approval": { data: approval },
  });
  const response = await app.inject({
    method: "POST", url: "/v1/approvals", headers: auth,
    payload: { workspaceId, entityType: "asset", entityId: assetId, entityVersionNumber: 3, reviewerId,
      idempotencyKey: "f7100000-0000-4000-8000-000000000002", comment: "Check details" },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().entity_version_number, 3);
  assert.equal(calls.filter((call) => call.table === "rpc:request_asset_approval").length, 1);
  assert.equal(calls.some((call) => call.table === "approvals" && call.op === "insert"), false);
  await app.close();
});

test("retry after an uncertain review response repeats the same idempotency key", async () => {
  const approval = { id: approvalId, workspace_id: workspaceId, entity_type: "asset", entity_id: assetId,
    requested_by: requesterId, reviewer_id: reviewerId, entity_version_number: 3, status: "pending" };
  const { app, calls } = await appWith({
    ...activeEditor,
    assets: { data: asset },
    asset_versions: cleanCurrentVersion,
    "rpc:request_asset_approval": { data: approval },
  });
  const request = {
    workspaceId, entityType: "asset", entityId: assetId, entityVersionNumber: 3, reviewerId,
    idempotencyKey: "f7100000-0000-4000-8000-000000000005", comment: "Check details",
  };
  const first = await app.inject({ method: "POST", url: "/v1/approvals", headers: auth, payload: request });
  const retry = await app.inject({ method: "POST", url: "/v1/approvals", headers: auth, payload: request });
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 201);
  const rpcCalls = calls.filter((call) => call.table === "rpc:request_asset_approval");
  assert.equal(rpcCalls.length, 2);
  assert.equal((rpcCalls[0]!.row as Record<string, unknown>).p_request_key, request.idempotencyKey);
  assert.equal((rpcCalls[1]!.row as Record<string, unknown>).p_request_key, request.idempotencyKey);
  assert.equal(calls.some((call) => call.table === "approvals" && call.op === "insert"), false);
  await app.close();
});

test("asset requester cannot assign approval to themself", async () => {
  const { app, calls } = await appWith({ ...activeEditor, assets: { data: asset }, asset_versions: cleanCurrentVersion });
  const response = await app.inject({
    method: "POST", url: "/v1/approvals", headers: auth,
    payload: { workspaceId, entityType: "asset", entityId: assetId, entityVersionNumber: 3, reviewerId: requesterId,
      idempotencyKey: "f7100000-0000-4000-8000-000000000003" },
  });
  assert.equal(response.statusCode, 422);
  assert.match(response.json().error.message, /reviewer cannot request their own/i);
  assert.equal(calls.some((call) => call.table === "rpc:request_asset_approval"), false);
  await app.close();
});

test("asset rejection requires a note and resolves through the database workflow", async () => {
  const approval = { id: approvalId, workspace_id: workspaceId, entity_type: "asset", entity_id: assetId,
    requested_by: reviewerId, reviewer_id: requesterId, entity_version_number: 3, status: "pending" };
  const { app, calls } = await appWith({
    ...activeEditor,
    approvals: { data: approval },
    "rpc:resolve_asset_approval": { data: { ...approval, status: "rejected", resolution_note: "Adjust the lighting." } },
  });
  const missingNote = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/reject`, headers: auth, payload: {} });
  assert.equal(missingNote.statusCode, 422);
  assert.equal(calls.some((call) => call.table === "rpc:resolve_asset_approval"), false);
  const rejected = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/reject`, headers: auth, payload: { comment: "Adjust the lighting." } });
  assert.equal(rejected.statusCode, 200);
  const call = calls.find((item) => item.table === "rpc:resolve_asset_approval");
  assert.ok(call);
  assert.equal((call.row as Record<string, unknown>).p_comment, "Adjust the lighting.");
  await app.close();
});

test("asset requester cannot resolve their own approval", async () => {
  const approval = { id: approvalId, workspace_id: workspaceId, entity_type: "asset", entity_id: assetId,
    requested_by: requesterId, reviewer_id: requesterId, entity_version_number: 3, status: "pending" };
  const { app, calls } = await appWith({ ...activeEditor, approvals: { data: approval } });
  const response = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/approve`, headers: auth });
  assert.equal(response.statusCode, 403);
  assert.equal(calls.some((call) => call.table === "rpc:resolve_asset_approval"), false);
  await app.close();
});

test("asset review request exposes locked database rejection without creating an approval", async () => {
  for (const code of ["23514", "40001"]) {
    const { app, calls } = await appWith({
      ...activeEditor,
      assets: { data: asset },
      "rpc:request_asset_approval": { data: null, error: { code } },
    });
    const response = await app.inject({
      method: "POST", url: "/v1/approvals", headers: auth,
      payload: { workspaceId, entityType: "asset", entityId: assetId, entityVersionNumber: 3,
        reviewerId, idempotencyKey: "f7100000-0000-4000-8000-000000000004" },
    });
    assert.equal(response.statusCode, code === "23514" ? 422 : 409);
    assert.equal(calls.filter((call) => call.table === "rpc:request_asset_approval").length, 1);
    assert.equal(calls.some((call) => call.table === "approvals" && call.op === "insert"), false);
    await app.close();
  }
});

test("an accepted artwork request remains recoverable after the image is revised or deleted", async () => {
  const approval = { id: approvalId, workspace_id: workspaceId, entity_type: "asset", entity_id: assetId,
    requested_by: requesterId, reviewer_id: reviewerId, entity_version_number: 3, status: "cancelled", superseded_at: "2026-10-03T02:00:00Z" };
  const { app, calls } = await appWith({ ...activeEditor,
    assets: { data: null }, asset_versions: { data: null }, "rpc:request_asset_approval": { data: approval } });
  try {
    const reply = await app.inject({ method: "POST", url: "/v1/approvals", headers: auth, payload: {
      workspaceId, entityType: "asset", entityId: assetId, entityVersionNumber: 3, reviewerId,
      idempotencyKey: "f7100000-0000-4000-8000-000000000005", comment: "Check details",
    } });
    assert.equal(reply.statusCode, 201, reply.body);
    assert.equal(reply.json().entity_version_number, 3);
    assert.equal(reply.json().status, "cancelled");
    assert.equal(calls.filter(call => call.table === "rpc:request_asset_approval").length, 1);
  } finally { await app.close(); }
});

test("asset status cannot be changed through generic asset PATCH", async () => {
  const { app } = await appWith({ ...activeEditor, assets: { data: asset } });
  const response = await app.inject({
    method: "PATCH", url: `/v1/assets/${assetId}`, headers: auth,
    payload: { status: "approved" },
  });
  assert.equal(response.statusCode, 422);
  await app.close();
});
