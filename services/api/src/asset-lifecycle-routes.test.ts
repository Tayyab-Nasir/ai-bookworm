import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.ASSET_LIFECYCLE_ENABLED = "true";
process.env.LOG_LEVEL = "error";
const { buildApp } = await import("./app.js");
const user = "aa910000-0000-4000-8000-000000000001";
const workspace = "cc910000-0000-4000-8000-000000000001";
const asset = "dd910000-0000-4000-8000-000000000001";
const version = "ee910000-0000-4000-8000-000000000001";
const operation = "ff910000-0000-4000-8000-000000000001";
const deleted = "2026-11-03T01:00:00.000Z";
const bytes = Buffer.from("synthetic asset bytes");
const checksum = createHash("sha256").update(bytes).digest("hex");
const storagePath = `workspaces/${workspace}/assets/${asset}/v1/image.png`;
const auth = { authorization: "Bearer synthetic", "x-bookworm-actor": user };

async function fixture(opts: { role?: string; missing?: boolean; corrupt?: boolean; deniedDuringCommit?: boolean; lostReply?: boolean; invalidPath?: boolean; pending?: boolean; wrongClose?: boolean } = {}) {
  let receipt: Record<string, unknown> | null = null;
  let commits = 0, downloads = 0;
  const removals: Record<string, unknown>[] = [];
  const row = { id: asset, workspace_id: workspace, deleted_at: deleted, storage_path: opts.invalidPath ? `workspaces/${workspace}/assets/${asset}/v1/..` : storagePath,
    checksum: opts.pending ? 'pending' : checksum, mime_type: "image/png", size_bytes: bytes.length, name: "image.png", lifecycle_revision: null };
  const versionRow = { id: version, asset_id: asset, storage_path: row.storage_path, checksum, mime_type: "image/png", size_bytes: bytes.length, scan_status: "clean" };
  const factory = (token?: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const builder = { select: () => builder, not: () => builder, order: () => builder, limit: async () => ({ data: [{id: row.id, workspace_id: row.workspace_id, name: row.name, deleted_at: row.deleted_at, checksum: row.checksum, lifecycle_revision:row.lifecycle_revision}], error: null }), eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        maybeSingle: async () => {
          const candidate = table === "workspace_members" ? { role: opts.role ?? "editor", workspace_id: workspace, user_id: user, status: "active" }
            : table === "assets" ? row : table === "asset_versions" ? versionRow : null;
          return { data: candidate && filters.every(([key, value]) => (candidate as Record<string, unknown>)[key] === value) ? candidate : null, error: null };
        } };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "asset_lifecycle_readiness") return { data: "asset-lifecycle-v1", error: null };
      if (name === "asset_lifecycle_status") return { data: receipt, error: null };
      if (name === "close_asset_lifecycle") {
        if (receipt) return { data: receipt, error: null };
        receipt = { assetId: asset, operationId: operation, action: args.p_action, expectedDeletedAt: opts.wrongClose ? "2026-11-03T01:00:00.000001Z" : args.p_expected_deleted_at, expectedRevision:args.p_expected_revision, outcome: "closed", committedAt: null, closedAt: deleted };
        return { data: receipt, error: null };
      }
      if (name === "mutate_asset_lifecycle") { removals.push(args); return { data: { assetId: asset, operationId: operation, action: "remove", expectedRevision: args.p_expected_revision, replayed: false }, error: null }; }
      if (name !== "restore_verified_asset" || token) throw new Error("unexpected rpc");
      commits++;
      if (opts.deniedDuringCommit) return { data: null, error: { code: "42501" } };
      assert.equal(args.p_actor_id, user); assert.equal(args.p_workspace_id, workspace); assert.equal(args.p_asset_id, asset);
      assert.equal(args.p_version_id, version); assert.equal(args.p_checksum, checksum); assert.equal(args.p_storage_path, storagePath);
      receipt = { assetId: asset, operationId: operation, action: "restore", expectedDeletedAt: deleted, expectedRevision:args.p_expected_revision, outcome: "committed", committedAt: deleted, closedAt: null };
      return opts.lostReply ? { data: null, error: { code: "timeout" } } : { data: { assetId: asset, operationId: operation, action: "restore", expectedRevision: args.p_expected_revision, replayed: false }, error: null };
    },
    storage: { from: () => ({ download: async () => { downloads++; return { data: opts.missing ? null : new Blob([opts.corrupt ? Buffer.from("x".repeat(bytes.length)) : bytes]), error: null }; } }) },
  });
  const app = await buildApp(factory as never);
  const body = { workspaceId: workspace, operationId: operation, expectedDeletedAt: deleted, expectedRevision:null };
  return { app, body, commits: () => commits, downloads: () => downloads, removals };
}

test("restore verifies the private bytes before invoking the service-only atomic mutation", async () => {
  const f = await fixture(); try {
    const response = await f.app.inject({ method: "POST", url: `/v1/assets/${asset}/lifecycle/restore`, headers: auth, payload: f.body });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().replayed, false);
    assert.equal(response.headers["cache-control"], "private, no-store"); assert.equal(f.downloads(), 1); assert.equal(f.commits(), 1);
  } finally { await f.app.close(); }
});

test("closing an unconfirmed restore keeps it closed instead of reporting a replay", async () => {
  const f = await fixture();
  try {
    const closed = await f.app.inject({ method: "POST", url: `/v1/assets/${asset}/lifecycle/close`, headers: auth, payload: {...f.body, action:"restore"} });
    assert.equal(closed.statusCode,200,closed.body); assert.equal(closed.json().operation.outcome,"closed");
    const repeat = await f.app.inject({ method:"POST",url:`/v1/assets/${asset}/lifecycle/restore`,headers:auth,payload:f.body });
    assert.equal(repeat.statusCode,409); assert.equal(f.downloads(),0); assert.equal(f.commits(),0);
    const checked = await f.app.inject({ method:"GET",url:`/v1/assets/${asset}/lifecycle/${operation}?workspaceId=${workspace}`,headers:auth });
    assert.equal(checked.statusCode,200); assert.equal(checked.json().operation.outcome,"closed");
  } finally { await f.app.close(); }
});

test("close denies viewers and rejects a receipt for a different exact timestamp", async () => {
  for (const [opts, expected] of [[{role:"viewer"},403],[{wrongClose:true},503]] as const) {
    const f=await fixture(opts);
    try {
      const response=await f.app.inject({method:"POST",url:`/v1/assets/${asset}/lifecycle/close`,headers:auth,payload:{...f.body,action:"restore"}});
      assert.equal(response.statusCode,expected,response.body);
      assert.equal(f.downloads(),0);assert.equal(f.commits(),0);
    } finally {await f.app.close();}
  }
});

test("restore requires explicit revision and rejects stale identity before downloading", async () => {
  const f=await fixture();
  try {
    const {expectedRevision: _revision,...missing}=f.body;
    const first=await f.app.inject({method:"POST",url:`/v1/assets/${asset}/lifecycle/restore`,headers:auth,payload:missing});
    assert.equal(first.statusCode,422);
    const second=await f.app.inject({method:"POST",url:`/v1/assets/${asset}/lifecycle/restore`,headers:auth,payload:{...f.body,expectedRevision:"aa910000-0000-4000-8000-000000000099"}});
    assert.equal(second.statusCode,409);assert.equal(f.downloads(),0);assert.equal(f.commits(),0);
  } finally {await f.app.close();}
});

test("remove forwards the exact explicit lifecycle revision", async () => {
  const f=await fixture();
  try {
    const noRevision=await f.app.inject({method:"POST",url:`/v1/assets/${asset}/lifecycle/remove`,headers:auth,payload:{workspaceId:workspace,operationId:operation}});
    assert.equal(noRevision.statusCode,422);assert.equal(f.removals.length,0);
    const removed=await f.app.inject({method:"POST",url:`/v1/assets/${asset}/lifecycle/remove`,headers:auth,payload:{workspaceId:workspace,operationId:operation,expectedRevision:null}});
    assert.equal(removed.statusCode,200,removed.body);assert.equal(f.removals.length,1);assert.equal(f.removals[0].p_expected_revision,null);
  } finally {await f.app.close();}
});

test("missing, corrupted, foreign-path or viewer access never invokes restore", async () => {
  for (const opts of [{ missing: true }, { corrupt: true }, { invalidPath: true }, { role: "viewer" }]) {
    const f = await fixture(opts); try {
      const response = await f.app.inject({ method: "POST", url: `/v1/assets/${asset}/lifecycle/restore`, headers: auth, payload: f.body });
      assert.ok([403, 409].includes(response.statusCode), response.body); assert.equal(f.commits(), 0);
    } finally { await f.app.close(); }
  }
});

test("revoked permission at commit is denied even after byte verification", async () => {
  const f = await fixture({ deniedDuringCommit: true }); try {
    const response = await f.app.inject({ method: "POST", url: `/v1/assets/${asset}/lifecycle/restore`, headers: auth, payload: f.body });
    assert.equal(response.statusCode, 403); assert.equal(f.downloads(), 1); assert.equal(f.commits(), 1);
  } finally { await f.app.close(); }
});

test("lost restore reply recovers the same operation without a second mutation", async () => {
  const f = await fixture({ lostReply: true }); try {
    const first = await f.app.inject({ method: "POST", url: `/v1/assets/${asset}/lifecycle/restore`, headers: auth, payload: f.body });
    assert.equal(first.statusCode, 503);
    const second = await f.app.inject({ method: "POST", url: `/v1/assets/${asset}/lifecycle/restore`, headers: auth, payload: f.body });
    assert.equal(second.statusCode, 200, second.body); assert.equal(second.json().replayed, true); assert.equal(f.commits(), 1); assert.equal(f.downloads(), 1);
  } finally { await f.app.close(); }
});

test('removed files are scoped to workspace editors', async () => {
  for (const role of ['editor','viewer']) {
    const f=await fixture({role}); try {
      const response=await f.app.inject({method:'GET',url:`/v1/assets/removed?workspaceId=${workspace}`,headers:auth});
      assert.equal(response.statusCode,role==='editor'?200:403,response.body);
      if(role==='editor') { assert.equal(response.json().assets[0].id,asset); assert.equal(response.json().assets[0].hasRecordedChecksum,true); assert.equal('checksum' in response.json().assets[0],false); assert.equal(response.headers['cache-control'],'private, no-store'); }
    } finally { await f.app.close(); }
  }
});

test('removed pending uploads are identified without exposing their checksum or starting a restore', async () => {
  const f=await fixture({pending:true}); try {
    const list=await f.app.inject({method:'GET',url:`/v1/assets/removed?workspaceId=${workspace}`,headers:auth});
    assert.equal(list.statusCode,200); assert.equal(list.json().assets[0].hasRecordedChecksum,false);
    const attempt=await f.app.inject({method:'POST',url:`/v1/assets/${asset}/lifecycle/restore`,headers:auth,payload:f.body});
    assert.equal(attempt.statusCode,409); assert.equal(f.downloads(),0); assert.equal(f.commits(),0);
  } finally { await f.app.close(); }
});

test('receipt replay rejects a deletion timestamp changed only by microseconds', async () => {
  const f=await fixture({lostReply:true}); try {
    const first=await f.app.inject({method:'POST',url:`/v1/assets/${asset}/lifecycle/restore`,headers:auth,payload:f.body}); assert.equal(first.statusCode,503);
    const second=await f.app.inject({method:'POST',url:`/v1/assets/${asset}/lifecycle/restore`,headers:auth,payload:{...f.body,expectedDeletedAt:'2026-11-03T01:00:00.000001Z'}});
    assert.equal(second.statusCode,409); assert.equal(f.commits(),1);
  } finally { await f.app.close(); }
});
