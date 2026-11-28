import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.LOG_LEVEL = "error";
const { buildApp } = await import("./app.js");

const actor = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const book = "44444444-4444-4444-8444-444444444444";
const sha = "a".repeat(64);
const receipt = {
  package_job_id: job, workspace_id: workspace, requested_by: actor, package_sha256: sha,
  requested_at: "2026-11-20T18:00:00+00:00",
  withdrawn_at: null as string | null,
  claimed_at: null as string | null,
  claimed_by: null as string | null,
  confirmed_at: null,
  listing_url: null,
};

test("operator queue and claim require both allowlists and bind the claim to the authenticated operator", async () => {
  const keys = ["ADMIN_USER_IDS", "MANAGED_PUBLISHING_ENABLED", "MANAGED_PUBLISHING_OPERATOR_IDS"] as const;
  const previous = keys.map(key => process.env[key]);
  const calls: unknown[] = [];
  const archive = Buffer.from("PK\x03\x04sample");
  const archiveHash = createHash("sha256").update(archive).digest("hex");
  const storagePath = `workspaces/${workspace}/assets/${book}/v1/kdp-export.zip`;
  let revoked = false;
  let revokeOnRead = false;
  let corruptArchive = false;
  const app = await buildApp(((token?: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: actor } }, error: null }) },
    rpc: async (name: string, args: unknown) => {
      assert.equal(token, undefined);
      calls.push([name, args]);
      if (name === "list_managed_publishing_queue") return { data: [{ ...receipt, channel: "kdp", title: "Example", claimed_at: null }], error: null };
      if (name === "read_managed_publishing_package") {
        assert.deepEqual(args, { p_job_id: job, p_operator: actor });
        return { data: revoked ? [] : [{ storage_path: storagePath, filename: "kdp-export.zip",
          package_sha256: archiveHash, size_bytes: archive.length }], error: null };
      }
      if (name === "confirm_managed_publishing") return { data: { ...receipt, claimed_by: actor,
        confirmed_at: receipt.requested_at, listing_url: "https://www.amazon.com/dp/B000000001" }, error: null };
      assert.equal(name, "claim_managed_publishing");
      return { data: { ...receipt, claimed_by: actor, claimed_at: receipt.requested_at }, error: null };
    },
    storage: { from: (bucket: string) => ({
      download: async (path: string) => {
        assert.equal(bucket, "book-assets");
        assert.equal(path, storagePath);
        if (revokeOnRead) revoked = true;
        return { data: new Blob([corruptArchive ? Buffer.alloc(archive.length) : archive]), error: null };
      },
    }) },
  })) as never);
  const send = (claim = false, includeActor = true) => app.inject({
    method: claim ? "PUT" : "GET",
    url: "/v1/admin/managed-publishing" + (claim ? `/${job}/claim` : ""),
    headers: { authorization: "Bearer fixture", ...(includeActor ? { "x-bookworm-actor": actor } : {}) },
    ...(claim ? { payload: { packageSha256: sha } } : {}),
  });
  try {
    process.env.ADMIN_USER_IDS = actor;
    process.env.MANAGED_PUBLISHING_ENABLED = "false";
    assert.equal((await send()).statusCode, 404);
    process.env.MANAGED_PUBLISHING_ENABLED = "true";
    process.env.MANAGED_PUBLISHING_OPERATOR_IDS = workspace;
    assert.equal((await send()).statusCode, 403);
    process.env.MANAGED_PUBLISHING_OPERATOR_IDS = actor;
    assert.equal((await send(true, false)).statusCode, 422);
    process.env.ADMIN_USER_IDS = workspace;
    assert.equal((await send()).statusCode, 403);
    assert.deepEqual(calls, []);
    process.env.ADMIN_USER_IDS = actor;
    const queue = await send();
    assert.equal(queue.statusCode, 200);
    assert.equal(queue.headers["cache-control"], "private, no-store");
    assert.deepEqual(queue.json(), { requests: [{ jobId: job, channel: "kdp", title: "Example",
      packageSha256: sha, requestedAt: receipt.requested_at, claimedAt: null, confirmedAt: null, listingUrl: null }], nextOffset: null });
    assert.deepEqual((await send(true)).json(), { claim: { jobId: job, packageSha256: sha, claimedAt: receipt.requested_at } });
    assert.deepEqual(calls, [
      ["list_managed_publishing_queue", { p_operator: actor, p_limit: 51, p_offset: 0 }],
      ["claim_managed_publishing", { p_job_id: job, p_sha256: sha, p_operator: actor }],
    ]);
    const download = () => app.inject({ url: `/v1/admin/managed-publishing/${job}/package?checksum=${archiveHash}`,
      headers: { authorization: "Bearer fixture", "x-bookworm-actor": actor } });
    const file = await download();
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-disposition"], 'attachment; filename="kdp-export.zip"');
    assert.deepEqual(file.rawPayload, archive);
    corruptArchive = true;
    assert.equal((await download()).statusCode, 409);
    corruptArchive = false;
    revokeOnRead = true;
    const refused = await download();
    assert.equal(refused.statusCode, 404);
    assert.ok(!refused.headers["content-disposition"]);
    const listingUrl = "https://www.amazon.com/dp/B000000001";
    const confirm = (url: string) => app.inject({ method: "PUT", url: `/v1/admin/managed-publishing/${job}/confirmation`,
      headers: { authorization: "Bearer fixture", "x-bookworm-actor": actor }, payload: { packageSha256: sha, listingUrl: url } });
    const prior = calls.length;
    assert.equal((await confirm("javascript:alert(1)")).statusCode, 422);
    assert.equal(calls.length, prior);
    const confirmed = await confirm(listingUrl);
    assert.equal(confirmed.statusCode, 200);
    assert.deepEqual(confirmed.json(), { confirmation: { jobId: job, packageSha256: sha, listingUrl, confirmedAt: receipt.requested_at } });
    assert.deepEqual(calls.at(-1), ["confirm_managed_publishing", { p_job_id: job, p_sha256: sha, p_operator: actor, p_listing_url: listingUrl }]);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await app.close();
  }
});

test("managed publishing authorizes, writes and recovers the exact package consent with a server-verified actor", async () => {
  let role = "owner";
  let stored: typeof receipt | null = null;
  let returned = receipt;
  const writes: unknown[] = [];
  const app = await buildApp(((token?: string) => {
    assert.ok(token === undefined || token === "fixture");
    return {
      auth: { getUser: async () => ({ data: { user: { id: actor } }, error: null }) },
      from(table: string) {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => {
            if (table === "publishing_jobs") return { data: { id: job, status: "succeeded", channel: "kdp",
              book_id: book, request_json: { action: "export_package" } }, error: null };
            if (table === "books") return { data: { id: book, workspace_id: workspace }, error: null };
            if (table === "workspace_members") return { data: { role }, error: null };
            assert.equal(table, "managed_publishing_requests");
            return { data: stored, error: null };
          },
        };
        return builder;
      },
      rpc: async (name: string, body: unknown) => {
        assert.ok(["request_managed_publishing", "withdraw_managed_publishing"].includes(name));
        assert.equal(token, name === "request_managed_publishing" ? undefined : "fixture");
        writes.push(body);
        stored = name === "withdraw_managed_publishing"
          ? { ...returned, withdrawn_at: "2026-11-20T18:10:00+00:00" } : returned;
        return { data: stored, error: null };
      },
    };
  }) as never);
  const send = (method: "GET" | "PUT", expectedActor: string | null = actor, payload?: object) =>
    app.inject({ method, url: `/v1/publishing/jobs/${job}/managed-request`, payload,
      headers: { authorization: "Bearer fixture", ...(expectedActor ? { "x-bookworm-actor": expectedActor } : {}) } });
  const previousEnabled = process.env.MANAGED_PUBLISHING_ENABLED;
  try {
    process.env.MANAGED_PUBLISHING_ENABLED = "false";
    assert.equal((await send("PUT", actor, { packageSha256: sha })).statusCode, 404);
    assert.deepEqual(writes, []);
    process.env.MANAGED_PUBLISHING_ENABLED = "true";
    assert.equal((await send("PUT", null, { packageSha256: sha })).statusCode, 422);
    assert.equal((await send("PUT", workspace, { packageSha256: sha })).statusCode, 409);
    role = "editor";
    assert.equal((await send("GET")).statusCode, 403);
    assert.equal((await send("PUT", actor, { packageSha256: sha })).statusCode, 403);
    assert.deepEqual(writes, []);
    role = "owner";
    assert.deepEqual((await send("GET")).json(), { request: null });
    assert.equal((await send("PUT", actor, { packageSha256: sha, workspaceId: workspace })).statusCode, 422);
    assert.deepEqual(writes, []);
    const saved = await send("PUT", actor, { packageSha256: sha });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.headers["cache-control"], "private, no-store");
    assert.deepEqual(saved.json(), { request: { jobId: job, workspaceId: workspace, requestedBy: actor,
      packageSha256: sha, requestedAt: receipt.requested_at, withdrawnAt: null, claimedAt: null, confirmedAt: null, listingUrl: null } });
    assert.deepEqual(writes, [{ p_job_id: job, p_sha256: sha, p_actor: actor }]);
    assert.deepEqual((await send("GET")).json(), saved.json());
    assert.equal(writes.length, 1);
    assert.ok(stored);
    const claim = "2026-11-20T18:05:00+00:00";
    stored = { ...receipt, claimed_at: claim, claimed_by: book };
    const claimed = (await send("GET")).json().request;
    assert.equal(claimed.claimedAt, claim);
    assert.equal(Object.values(claimed).includes(book), false);
    stored = { ...receipt, claimed_at: claim };
    assert.equal((await send("GET")).json().request.claimedAt, null);
    process.env.MANAGED_PUBLISHING_ENABLED = "false";
    const withdrawn = await send("PUT", actor, { packageSha256: sha, withdraw: true });
    assert.equal(withdrawn.statusCode, 200);
    assert.equal(withdrawn.json().request.withdrawnAt, "2026-11-20T18:10:00+00:00");
    assert.deepEqual((await send("GET")).json(), withdrawn.json());
    process.env.MANAGED_PUBLISHING_ENABLED = "true";
    returned = { ...receipt, package_sha256: "b".repeat(64) };
    assert.equal((await send("PUT", actor, { packageSha256: sha })).statusCode, 503);
  } finally {
    if (previousEnabled === undefined) delete process.env.MANAGED_PUBLISHING_ENABLED;
    else process.env.MANAGED_PUBLISHING_ENABLED = previousEnabled;
    await app.close();
  }
});
