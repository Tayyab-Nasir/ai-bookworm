import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ImageGenerator } from "./lib/image-generation.js";
import { createHttpAssetScanner, type AssetMalwareScanner } from "./lib/asset-scanner.js";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

type Row = Record<string, unknown>;
interface Store {
  imageJobInsertError?: { code: string; message: string };
  tables: Record<string, Row[]>;
  objects: Map<string, Buffer>;
  rpcCalls: { name: string; args: Row }[];
}

function fakeSupabase(store: Store, allowPendingStorageDownload = true) {
  return {
    auth: { getUser: async (token: string) => token === "good"
      ? { data: { user: { id: USER } }, error: null }
      : { data: { user: null }, error: { message: "bad" } } },
    storage: { from: () => ({
      upload: async (path: string, bytes: Buffer) => {
        if (store.objects.has(path)) return { data: null, error: { message: "exists" } };
        store.objects.set(path, Buffer.from(bytes));
        return { data: { path }, error: null };
      },
      download: async (path: string) => {
        if (!allowPendingStorageDownload) return { data: null, error: { message: "storage RLS denied pending object" } };
        const bytes = store.objects.get(path);
        if (!bytes) return { data: null, error: { message: "missing" } };
        const copy = new ArrayBuffer(bytes.length);
        new Uint8Array(copy).set(bytes);
        return { data: new Blob([copy]), error: null };
      },
      createSignedUrl: async (path: string, seconds: number) => ({ data: { signedUrl: `signed:${seconds}:${path}` }, error: null }),
      createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `upload:${path}` }, error: null }),
      remove: async (paths: string[]) => { paths.forEach((path) => store.objects.delete(path)); return { data: paths, error: null }; },
    }) },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let limit: number | null = null;
      let descending = false;
      let pendingInsert: Row | null = null;
      let pendingUpdate: Row | null = null;
      const selected = () => {
        let result = rows.filter((row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
        if (descending) result = [...result].reverse();
        return limit == null ? result : result.slice(0, limit);
      };
      const mutate = () => {
        if (pendingInsert) {
          const row = { ...pendingInsert, created_at: pendingInsert.created_at ?? new Date().toISOString() };
          rows.push(row); pendingInsert = null; return [row];
        }
        if (pendingUpdate) {
          const result = selected();
          result.forEach((row) => Object.assign(row, pendingUpdate)); pendingUpdate = null; return result;
        }
        return selected();
      };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.in = (key: string, values: unknown[]) => { filters.push([key, values]); return builder; };
      builder.is = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.gte = () => builder;
      builder.order = (_key: string, options?: { ascending?: boolean }) => { descending ||= options?.ascending === false; return builder; };
      builder.limit = (value: number) => { limit = value; return builder; };
      builder.insert = (row: Row) => { pendingInsert = row; return builder; };
      builder.update = (row: Row) => { pendingUpdate = row; return builder; };
      builder.single = async () => ({ data: mutate()[0] ?? null, error: null });
      builder.maybeSingle = async () => ({ data: mutate()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve(
        table === "ai_jobs" && pendingInsert && store.imageJobInsertError
          ? { data: null, error: store.imageJobInsertError }
          : { data: mutate(), error: null });
      return builder;
    },
    rpc: async (name: string, args: Row) => {
      store.rpcCalls.push({ name, args });
      if (name === "record_asset_scan_verdict") {
        const version = store.tables.asset_versions.find((row) => row.asset_id === args.p_asset_id && row.version_number === args.p_version_number);
        if (!version || version.checksum !== "pending") return { data: null, error: { code: "40001" } };
        Object.assign(version, {
          scan_status: args.p_verdict,
          detected_mime_type: args.p_detected_mime_type,
          scan_scanner: args.p_scanner,
          scan_signature: args.p_signature,
          scan_error_code: args.p_error_code,
        });
        if (args.p_verdict !== "error") Object.assign(version, {
          checksum: args.p_checksum, mime_type: args.p_detected_mime_type, size_bytes: args.p_size_bytes,
        });
        if (args.p_verdict === "clean") {
          const asset = store.tables.assets.find((row) => row.id === args.p_asset_id);
          if (asset) Object.assign(asset, {
            checksum: args.p_checksum, mime_type: args.p_detected_mime_type,
            size_bytes: args.p_size_bytes, storage_path: version.storage_path,
          });
        }
        return { data: version, error: null };
      }
      if (name !== "complete_image_job") return { data: null, error: { code: "42883" } };
      const job = store.tables.ai_jobs.find((row) => row.id === args.p_job_id);
      if (!job) return { data: null, error: { code: "P0002" } };
      const asset = {
        id: args.p_asset_id, workspace_id: job.workspace_id, folder_id: args.p_folder_id,
        type: args.p_asset_type, name: args.p_asset_name, storage_path: args.p_storage_path,
        mime_type: args.p_mime_type, size_bytes: args.p_size_bytes, checksum: args.p_checksum,
        status: "draft", deleted_at: null, created_by: job.created_by,
      };
      store.tables.assets.push(asset);
      store.tables.asset_versions.push({ asset_id: asset.id, version_number: 1, storage_path: asset.storage_path, checksum: asset.checksum, mime_type: asset.mime_type, size_bytes: asset.size_bytes, scan_status: "trusted_generated" });
      if (job.book_id) store.tables.asset_links.push({ asset_id: asset.id, entity_type: "book", entity_id: job.book_id, usage_role: args.p_link_role });
      store.tables.usage_events.push({ organization_id: ORG, workspace_id: WORKSPACE, user_id: USER, meter: "image_credits", quantity: 1, ai_job_id: job.id });
      Object.assign(job, { status: "succeeded", output_ref: { assetId: asset.id }, model: args.p_model, usage_json: args.p_usage });
      return { data: job, error: null };
    },
  } as never;
}

const USER = "b0000000-0000-4000-8000-000000000001";
const ORG = "b0000000-0000-4000-8000-000000000002";
const WORKSPACE = "b0000000-0000-4000-8000-000000000003";
const BOOK = "b0000000-0000-4000-8000-000000000004";
const EXISTING_ASSET = "b0000000-0000-4000-8000-000000000005";
const auth = { authorization: "Bearer good" };

test("image reservation refusal never starts a provider call or stores an image", async () => {
  for (const [code, message, status, errorCode] of [
    ["23514", "image credit capacity exhausted", 422, "image_credit_capacity_exhausted"],
    ["42501", "image reservation requires editing access", 403, "image_reservation_access_changed"],
    ["23514", "private unrelated SQL detail", 500, null],
  ] as const) {
    const store = baseStore();
    store.imageJobInsertError = { code, message };
    const prompts: string[] = [];
    const app = await buildApp(() => fakeSupabase(store), { imageGenerator: fakeImageGenerator(prompts) });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
        workspaceId: WORKSPACE, kind: "illustration", name: "Reserved scene",
        prompt: "A quiet forest clearing at dawn", idempotencyKey: "reserve-rejected",
      } });
      assert.equal(response.statusCode, status, response.body);
      if (errorCode) assert.equal(response.json().error.code, errorCode);
      assert.doesNotMatch(response.body, /private unrelated SQL detail/);
      assert.equal(prompts.length, 0);
      assert.equal(store.tables.ai_jobs.length, 0);
      assert.equal(store.objects.size, 0);
      assert.equal(store.tables.usage_events.length, 0);
    } finally { await app.close(); }
  }
});

function baseStore(role = "editor"): Store {
  return { objects: new Map(), rpcCalls: [], tables: {
    workspaces: [{ id: WORKSPACE, organization_id: ORG }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role, status: "active" }],
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "River Moon", author_name: "A. Writer", genre: "fantasy", language: "en" }],
    book_bible_items: [{ id: "bible-1", book_id: BOOK, type: "character", name: "Mira", description: "Silver hair and a blue coat", attributes_json: { age: 12 } }],
    folders: [], subscriptions: [{ id: "paid-sub", organization_id: ORG, plan_id: "paid-plan", status: "active" }],
    plans: [{ id: "paid-plan", name: "Paid fixture", entitlements_json: { image_credits_monthly: 5 } }],
    usage_events: [], ai_jobs: [], assets: [], asset_versions: [], asset_links: [],
  } };
}

function fakeImageGenerator(prompts: string[]): ImageGenerator {
  return async (input) => {
    prompts.push(input.prompt);
    return {
      bytes: Buffer.from("generated-private-image"), mimeType: "image/png", provider: "openai", model: "mock-image",
      requestId: "request-1", usage: { inputTokens: 12, outputTokens: 34, estimatedCostUsd: 0, latencyMs: 5 },
    };
  };
}

const cleanScanner: AssetMalwareScanner = {
  name: "fixture-clamav",
  async scan() { return { verdict: "clean", signature: "ClamAV/fixture/1" }; },
};

test("asset UI capabilities follow current workspace membership and deny nonmembers", async () => {
  for (const role of ["viewer", "reviewer", "editor", "owner", "outsider"]) {
    const store = baseStore(role);
    if (role === "outsider") store.tables.workspace_members = [];
    const app = await buildApp(() => fakeSupabase(store));
    try {
      const response = await app.inject({ method: "GET", url: `/v1/assets/access?workspaceId=${WORKSPACE}`, headers: auth });
      assert.equal(response.statusCode, role === "outsider" ? 403 : 200);
      if (role !== "outsider") assert.equal(response.json().canEdit, ["editor", "owner"].includes(role));
    } finally { await app.close(); }
  }
});

test("image history is bounded, author/workspace scoped and omits private job payloads", async () => {
  const store = baseStore();
  const seed = { workspace_id: WORKSPACE, created_by: USER, agent_type: "illustrator", status: "running", created_at: "2026-09-12T00:00:00Z",
    input_ref: { prompt: "private manuscript prompt" }, output_ref: { url: "private-provider-url" }, idempotency_key: "private-request-key" };
  store.tables.ai_jobs.push({ ...seed, id: "own" }, { ...seed, id: "other-author", created_by: "other" },
    { ...seed, id: "other-workspace", workspace_id: "other" }, { ...seed, id: "text-job", agent_type: "writer" });
  const app = await buildApp(() => fakeSupabase(store));
  try {
    const response = await app.inject({ method: "GET", url: `/v1/assets/generation-jobs?workspaceId=${WORKSPACE}&limit=1`, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().jobs.map((job: { id: string }) => job.id), ["own"]);
    assert.doesNotMatch(response.body, /private-|input_ref|output_ref|idempotency/);
    assert.equal(response.headers["cache-control"], "private, no-store");
    const invalid = await app.inject({ method: "GET", url: `/v1/assets/generation-jobs?workspaceId=${WORKSPACE}&limit=51`, headers: auth });
    assert.equal(invalid.statusCode, 422);
    const anonymous = await app.inject({ method: "GET", url: `/v1/assets/generation-jobs?workspaceId=${WORKSPACE}` });
    assert.equal(anonymous.statusCode, 401);
  } finally { await app.close(); }
});

test("reference generation forwards verified private bytes and rejects changed, quarantined or foreign assets before spending", async () => {
  for (const scenario of ["valid", "changed", "quarantined", "foreign", "oversized"] as const) {
    const store = baseStore();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=", "base64");
    const path = `workspaces/${WORKSPACE}/assets/${EXISTING_ASSET}/v1/reference.png`;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    store.objects.set(path, scenario === "changed" ? Buffer.alloc(bytes.length) : bytes);
    store.tables.assets.push({ id: EXISTING_ASSET, workspace_id: scenario === "foreign" ? "other-workspace" : WORKSPACE,
      storage_path: path, checksum, mime_type: "image/png", size_bytes: scenario === "oversized" ? 6 * 1024 * 1024 : bytes.length, deleted_at: null });
    store.tables.asset_versions.push({ asset_id: EXISTING_ASSET, storage_path: path, checksum, scan_status: scenario === "quarantined" ? "infected" : "clean" });
    let calls = 0;
    const app = await buildApp(() => fakeSupabase(store), { imageGenerator: async input => {
      calls++; assert.equal(input.referenceImages?.length, 1);
      assert.deepEqual(input.referenceImages[0].bytes, bytes);
      return fakeImageGenerator([])(input);
    } });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
        workspaceId: WORKSPACE, kind: "illustration", name: "Mira", prompt: "Keep this character consistent in the forest",
        idempotencyKey: `reference-${scenario}`, referenceAssetIds: [EXISTING_ASSET],
      } });
      assert.equal(response.statusCode, scenario === "valid" ? 201 : scenario === "foreign" ? 404 : scenario === "oversized" ? 422 : 409, response.body);
      assert.equal(calls, scenario === "valid" ? 1 : 0);
      assert.equal(store.tables.usage_events.length, scenario === "valid" ? 1 : 0);
      assert.equal(store.tables.ai_jobs.length, scenario === "valid" ? 1 : 0);
    } finally { await app.close(); }
  }
});

test("image generation uses saved book context and atomically returns a private asset", async () => {
  const store = baseStore();
  const prompts: string[] = [];
  const app = await buildApp(() => fakeSupabase(store), { imageGenerator: fakeImageGenerator(prompts) });
  const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
    workspaceId: WORKSPACE, bookId: BOOK, kind: "front_cover", name: "Cover concept",
    prompt: "A moonlit river beneath an ancient stone bridge", quality: "low", idempotencyKey: "image-request-0001",
  } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.asset.type, "cover");
  assert.equal(body.asset.mime_type, "image/png");
  assert.match(body.preview.url, /^signed:300:/);
  assert.equal(body.model, "mock-image");
  assert.match(prompts[0], /Mira/);
  assert.match(prompts[0], /"age":12/, "saved attributes must reach the image provider");
  assert.match(prompts[0], /Do not render any title/);
  assert.equal(response.body.includes("generated-private-image"), false);
  assert.equal(store.tables.usage_events.length, 1);
  assert.equal(store.tables.usage_events[0].meter, "image_credits");
  assert.equal(store.rpcCalls[0].name, "complete_image_job");
  assert.equal(store.objects.size, 1);
  await app.close();
});

test("viewer cannot spend image credits or call the provider", async () => {
  const store = baseStore("viewer");
  const prompts: string[] = [];
  const app = await buildApp(() => fakeSupabase(store), { imageGenerator: fakeImageGenerator(prompts) });
  const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
    workspaceId: WORKSPACE, kind: "illustration", name: "Scene", prompt: "A detailed forest scene for a chapter",
    idempotencyKey: "image-request-0002",
  } });
  assert.equal(response.statusCode, 403);
  assert.equal(prompts.length, 0);
  assert.equal(store.tables.usage_events.length, 0);
  await app.close();
});

test("provider failure marks the job failed without storing an asset or usage", async () => {
  const store = baseStore();
  const app = await buildApp(() => fakeSupabase(store), { imageGenerator: async () => { throw new Error("provider details"); } });
  const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
    workspaceId: WORKSPACE, kind: "illustration", name: "Scene", prompt: "A detailed forest scene for a chapter",
    idempotencyKey: "image-request-0003",
  } });
  assert.equal(response.statusCode, 503);
  assert.equal(store.tables.ai_jobs[0].status, "failed");
  assert.equal(store.tables.assets.length, 0);
  assert.equal(store.tables.usage_events.length, 0);
  assert.equal(store.objects.size, 0);
  assert.equal(response.body.includes("provider details"), false);
  await app.close();
});

test("signed downloads require membership and a confirmed live asset", async () => {
  const store = baseStore();
  const storagePath = `workspaces/${WORKSPACE}/assets/${EXISTING_ASSET}/v1/a.png`;
  store.tables.assets.push({ id: EXISTING_ASSET, workspace_id: WORKSPACE, deleted_at: null, storage_path: storagePath, checksum: repeatHex("a"), mime_type: "image/png", size_bytes: 8 });
  store.tables.asset_versions.push({ asset_id: EXISTING_ASSET, version_number: 1, storage_path: storagePath, checksum: repeatHex("a"), scan_status: "clean" });
  const app = await buildApp(() => fakeSupabase(store), { imageGenerator: fakeImageGenerator([]) });
  const response = await app.inject({ method: "GET", url: `/v1/assets/${EXISTING_ASSET}/download-url`, headers: auth });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  store.tables.assets[0].checksum = "pending";
  const pending = await app.inject({ method: "GET", url: `/v1/assets/${EXISTING_ASSET}/download-url`, headers: auth });
  assert.equal(pending.statusCode, 409);
  await app.close();
});

test("upload confirmation recomputes stored bytes instead of trusting the browser", async () => {
  const store = baseStore();
  const path = `workspaces/${WORKSPACE}/assets/${EXISTING_ASSET}/v1/file.txt`;
  const bytes = Buffer.from("actual bytes");
  store.objects.set(path, bytes);
  store.tables.assets.push({ id: EXISTING_ASSET, workspace_id: WORKSPACE, deleted_at: null, name: "file.txt", storage_path: path, checksum: "pending", mime_type: "text/plain", size_bytes: bytes.length });
  store.tables.asset_versions.push({ asset_id: EXISTING_ASSET, version_number: 1, storage_path: path, checksum: "pending", mime_type: "text/plain", size_bytes: bytes.length, scan_status: "pending" });
  const app = await buildApp((token) => fakeSupabase(store, !token), { imageGenerator: fakeImageGenerator([]), assetScanner: cleanScanner });
  const bad = await app.inject({ method: "POST", url: `/v1/assets/${EXISTING_ASSET}/confirm`, headers: auth, payload: {
    checksumSha256: repeatHex("b"), sizeBytes: bytes.length,
  } });
  assert.equal(bad.statusCode, 422);
  assert.equal(store.tables.assets[0].checksum, "pending");
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const good = await app.inject({ method: "POST", url: `/v1/assets/${EXISTING_ASSET}/confirm`, headers: auth, payload: {
    checksumSha256, sizeBytes: bytes.length,
  } });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(store.tables.assets[0].checksum, checksumSha256);
  assert.equal(store.tables.asset_versions[0].scan_status, "clean");
  await app.close();
});

test("image request replay recovers the saved asset without another provider call or credit entry", async () => {
  const store = baseStore(); const prompts: string[] = [];
  const app = await buildApp(() => fakeSupabase(store), { imageGenerator: fakeImageGenerator(prompts) });
  const payload = { workspaceId: WORKSPACE, kind: "illustration", name: "Recovered scene",
    prompt: "A detailed forest beneath a silver moon", idempotencyKey: "replay-image-0001" };
  try {
    const first = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().asset.id, first.json().asset.id);
    assert.equal(replay.json().replayed, true);
    const mismatch = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: { ...payload, prompt: "A different forest in summer sunlight" } });
    assert.equal(mismatch.statusCode, 409);
    store.tables.asset_versions[0].scan_status = "infected";
    const quarantined = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload });
    assert.equal(quarantined.statusCode, 409);
    assert.equal(prompts.length, 1); assert.equal(store.tables.usage_events.length, 1);
    assert.equal(store.tables.ai_jobs.length, 1);
  } finally { await app.close(); }
});

test("lost image completion replies recover committed jobs without deleting the saved file", async () => {
  for (const lostReply of ["throw", "error"] as const) {
    const store = baseStore(); const prompts: string[] = [];
    const client = fakeSupabase(store) as unknown as { rpc: (...args: unknown[]) => Promise<unknown> };
    const originalRpc = client.rpc;
    client.rpc = async (...args) => {
      const result = await originalRpc(...args);
      if (args[0] === "complete_image_job") {
        if (lostReply === "throw") throw new Error("lost after commit");
        return { data: null, error: { message: "lost after commit" } };
      }
      return result;
    };
    const app = await buildApp(() => client as never, { imageGenerator: fakeImageGenerator(prompts) });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
        workspaceId: WORKSPACE, kind: "illustration", name: "Recovered image", prompt: "A blue ship under the silver moon", idempotencyKey: `lost-completion-${lostReply}`,
      } });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(store.objects.size, 1); assert.equal(store.tables.assets.length, 1);
      assert.equal(store.tables.ai_jobs[0].status, "succeeded");
      assert.equal(store.tables.usage_events.length, 1); assert.equal(prompts.length, 1);
    } finally { await app.close(); }
  }
});

test("unconfirmed image completion preserves bytes and does not claim an uncharged rollback", async () => {
  const store = baseStore();
  const client = fakeSupabase(store) as unknown as { rpc: (...args: unknown[]) => Promise<unknown> };
  client.rpc = async () => { throw new Error("connection unavailable"); };
  const app = await buildApp(() => client as never, { imageGenerator: fakeImageGenerator([]) });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
      workspaceId: WORKSPACE, kind: "illustration", name: "Pending confirmation", prompt: "A river reflecting an old lighthouse", idempotencyKey: "unconfirmed-image-1",
    } });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /confirmation is unavailable/);
    assert.doesNotMatch(response.body, /No credits were used/);
    assert.equal(store.objects.size, 1);
    assert.equal(store.tables.ai_jobs[0].status, "running");
    assert.equal(store.tables.usage_events.length, 0);
  } finally { await app.close(); }
});

test("finalize recovers a durable image receipt without regenerating and rejects corrupted stored bytes", async () => {
  const store = baseStore(); const prompts: string[] = [];
  const client = fakeSupabase(store) as unknown as { rpc: (...args: unknown[]) => Promise<unknown> };
  const originalRpc = client.rpc;
  client.rpc = async () => { throw new Error("temporary completion outage"); };
  const app = await buildApp(() => client as never, { imageGenerator: fakeImageGenerator(prompts) });
  try {
    const generated = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
      workspaceId: WORKSPACE, kind: "illustration", name: "Durable scene", prompt: "A detailed ship sailing at sunset", idempotencyKey: "durable-image-receipt",
    } });
    assert.equal(generated.statusCode, 503);
    assert.equal(store.tables.image_completion_receipts.length, 1);
    const job = store.tables.ai_jobs[0];
    const url = `/v1/assets/generation-jobs/${job.id}/finalize`;
    client.rpc = originalRpc;
    job.created_by = "other-author";
    assert.equal((await app.inject({ method: "POST", url, headers: auth })).statusCode, 404);
    job.created_by = USER;
    const [path, bytes] = [...store.objects.entries()][0];
    store.objects.set(path, Buffer.alloc(bytes.length));
    assert.equal((await app.inject({ method: "POST", url, headers: auth })).statusCode, 409);
    assert.equal(store.tables.usage_events.length, 0);
    store.objects.set(path, bytes);
    const finalized = await app.inject({ method: "POST", url, headers: auth });
    assert.equal(finalized.statusCode, 200, finalized.body);
    assert.equal((await app.inject({ method: "POST", url, headers: auth })).statusCode, 200);
    assert.equal(prompts.length, 1); assert.equal(store.tables.assets.length, 1);
    assert.equal(store.tables.usage_events.length, 1);
  } finally { await app.close(); }
});

test("known completion refusals are actionable without losing the image or leaking SQL details", async () => {
  for (const [code, message, status] of [
    ["23514", "image credit quota exceeded at completion", 422],
    ["42501", "image creator can no longer edit this workspace", 403],
    ["23514", "private database diagnostic", 503],
  ] as const) {
    const store = baseStore(); const prompts: string[] = [];
    const client = fakeSupabase(store) as unknown as { rpc: (...args: unknown[]) => Promise<unknown> };
    client.rpc = async () => ({ data: null, error: { code, message, details: "private details" } });
    const app = await buildApp(() => client as never, { imageGenerator: fakeImageGenerator(prompts) });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/assets/generate", headers: auth, payload: {
        workspaceId: WORKSPACE, kind: "illustration", name: "Preserved scene", prompt: "A character walking beside a lighthouse", idempotencyKey: `refusal-${status}`,
      } });
      assert.equal(response.statusCode, status, response.body);
      assert.doesNotMatch(response.body, /private database|private details/);
      if (status !== 503) assert.match(response.body, /generated file is preserved/);
      assert.equal(store.objects.size, 1); assert.equal(store.tables.image_completion_receipts.length, 1);
      const recovery = await app.inject({ method: "POST", url: `/v1/assets/generation-jobs/${store.tables.ai_jobs[0].id}/finalize`, headers: auth });
      assert.equal(recovery.statusCode, status, recovery.body);
      assert.equal(prompts.length, 1); assert.equal(store.tables.usage_events.length, 0);
    } finally { await app.close(); }
  }
});

test("infected uploads remain quarantined and cannot be downloaded", async () => {
  const store = baseStore();
  const path = `workspaces/${WORKSPACE}/assets/${EXISTING_ASSET}/v1/file.txt`;
  const bytes = Buffer.from("infected fixture");
  store.objects.set(path, bytes);
  store.tables.assets.push({ id: EXISTING_ASSET, workspace_id: WORKSPACE, deleted_at: null, name: "file.txt", storage_path: path, checksum: "pending", mime_type: "text/plain", size_bytes: bytes.length });
  store.tables.asset_versions.push({ asset_id: EXISTING_ASSET, version_number: 1, storage_path: path, checksum: "pending", mime_type: "text/plain", size_bytes: bytes.length, scan_status: "pending" });
  const infectedScanner: AssetMalwareScanner = {
    name: "fixture-clamav",
    async scan() { return { verdict: "infected", signature: "Win.Test.EICAR_HDB-1" }; },
  };
  const app = await buildApp((token) => fakeSupabase(store, !token), { assetScanner: infectedScanner });
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const confirmed = await app.inject({ method: "POST", url: `/v1/assets/${EXISTING_ASSET}/confirm`, headers: auth, payload: { checksumSha256, sizeBytes: bytes.length } });
  assert.equal(confirmed.statusCode, 422);
  assert.equal(store.tables.assets[0].checksum, "pending");
  assert.equal(store.tables.asset_versions[0].scan_status, "infected");
  const download = await app.inject({ method: "GET", url: `/v1/assets/${EXISTING_ASSET}/download-url`, headers: auth });
  assert.equal(download.statusCode, 409);
  await app.close();
});

test("private scanner adapter authenticates and verifies echoed content identity", async () => {
  const bytes = Buffer.from("safe fixture");
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  let requestHeaders = new Headers();
  const scanner = createHttpAssetScanner(async (_url, init) => {
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      verdict: "clean", clean: true, infected: false, signature: null,
      sha256: checksumSha256, mimeType: "text/plain", sizeBytes: bytes.length,
      engine: { name: "ClamAV", version: "1.4.2", databaseVersion: "27888" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, {
    SCANNING_SERVICE_URL: "http://scanner.internal:8004",
    SCANNING_SERVICE_TOKEN: "scanner-test-token-that-is-at-least-32-characters",
  });
  const verdict = await scanner.scan({
    assetId: EXISTING_ASSET, workspaceId: WORKSPACE, version: 1, filename: "safe.txt",
    bytes, checksumSha256, detectedMimeType: "text/plain",
  });
  assert.deepEqual(verdict, { verdict: "clean", signature: "ClamAV/1.4.2/27888" });
  assert.match(requestHeaders.get("authorization") ?? "", /^Bearer scanner-test-token/);
  assert.equal(requestHeaders.get("x-content-sha256"), checksumSha256);

  const mismatched = createHttpAssetScanner(async () => new Response(JSON.stringify({
    verdict: "clean", clean: true, infected: false, signature: null,
    sha256: repeatHex("f"), mimeType: "text/plain", sizeBytes: bytes.length,
    engine: { name: "ClamAV", version: "1.4.2", databaseVersion: "27888" },
  }), { status: 200, headers: { "content-type": "application/json" } }), {
    SCANNING_SERVICE_URL: "http://scanner.internal:8004",
    SCANNING_SERVICE_TOKEN: "scanner-test-token-that-is-at-least-32-characters",
  });
  await assert.rejects(() => mismatched.scan({
    assetId: EXISTING_ASSET, workspaceId: WORKSPACE, version: 1, filename: "safe.txt",
    bytes, checksumSha256, detectedMimeType: "text/plain",
  }));
});

function repeatHex(value: string) {
  return value.repeat(64);
}
