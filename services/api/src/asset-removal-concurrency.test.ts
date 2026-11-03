import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.ASSET_LIFECYCLE_ENABLED = "true";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");

type Asset = { id: string; workspace_id: string; deleted_at: string | null; status: string };

async function fixture(initial: Asset, beforeWrite?: (row: Asset) => void, role = "editor", enabled = true, readiness = true) {
  const row = { ...initial };
  const events: string[] = [];
  let updateCount = 0;
  const factory = () => ({
    auth: { getUser: async () => ({ data: { user: { id: "author" } }, error: null }) },
    rpc: async (name: string) => name === "asset_lifecycle_readiness" && readiness ? { data: "asset-lifecycle-v1", error: null } : { data: null, error: { code: "PGRST202" } },
    from(table: string) {
      const predicates: ((asset: Asset) => boolean)[] = [];
      let update: Partial<Asset> | undefined;
      const builder = {
        select: () => builder,
        eq: (key: keyof Asset, value: unknown) => { predicates.push(asset => asset[key] === value); return builder; },
        is: (key: keyof Asset, value: unknown) => { predicates.push(asset => asset[key] === value); return builder; },
        update: (value: Partial<Asset>) => { update = value; return builder; },
        insert: async (value: { event_type: string }) => { events.push(value.event_type); return { error: null }; },
        maybeSingle: async () => {
          if (table === "workspace_members") return { data: { role }, error: null };
          if (table !== "assets") return { data: null, error: null };
          if (update) { updateCount++; beforeWrite?.(row); }
          if (!predicates.every(predicate => predicate(row))) return { data: null, error: null };
          if (update) Object.assign(row, update);
          return { data: { ...row }, error: null };
        },
      };
      return builder;
    },
  });
  const original = process.env.ASSET_LIFECYCLE_ENABLED;
  if (enabled) process.env.ASSET_LIFECYCLE_ENABLED = "true"; else delete process.env.ASSET_LIFECYCLE_ENABLED;
  let app;
  try { app = await buildApp(factory as never); } finally { if (original === undefined) delete process.env.ASSET_LIFECYCLE_ENABLED; else process.env.ASSET_LIFECYCLE_ENABLED = original; }
  return { app, row, events, getUpdates: () => updateCount };
}

const live: Asset = { id: "asset", workspace_id: "workspace", deleted_at: null, status: "draft" };
const auth = { authorization: "Bearer good" };

test('default-off capability preserves authorized legacy removal and disables new lifecycle endpoints', async () => {
  const f = await fixture(live, undefined, 'editor', false);
  try {
    const access = await f.app.inject({ method: 'GET', url: '/v1/assets/access?workspaceId=cc910000-0000-4000-8000-000000000001', headers: auth });
    assert.equal(access.statusCode, 200); assert.deepEqual(access.json(), { canEdit: true, assetLifecycleEnabled: false, assetLifecycleReady: false });
    const inactive = await f.app.inject({ method: 'POST', url: '/v1/assets/asset/lifecycle/remove', headers: auth, payload: {} });
    assert.equal(inactive.statusCode, 404); assert.equal(f.getUpdates(), 0);
    const removed = await f.app.inject({ method: 'DELETE', url: '/v1/assets/asset', headers: auth });
    assert.equal(removed.statusCode, 200); assert.equal(f.row.status, 'archived'); assert.notEqual(f.row.deleted_at, null); assert.equal(f.getUpdates(), 1);
  } finally { await f.app.close(); }
  const viewer = await fixture(live, undefined, 'viewer', false);
  try { const denied = await viewer.app.inject({ method: 'DELETE', url: '/v1/assets/asset', headers: auth }); assert.equal(denied.statusCode, 403); assert.equal(viewer.getUpdates(), 0); } finally { await viewer.app.close(); }
});

test('default-off legacy restore works only for removed files and authorized editors', async () => {
  const f=await fixture(live,undefined,'editor',false);
  try {
    const premature=await f.app.inject({method:'POST',url:'/v1/assets/asset/restore',headers:auth});
    assert.equal(premature.statusCode,409);assert.equal(f.getUpdates(),0);
    const removed=await f.app.inject({method:'DELETE',url:'/v1/assets/asset',headers:auth});
    assert.equal(removed.statusCode,200,removed.body);
    const duplicate=await f.app.inject({method:'DELETE',url:'/v1/assets/asset',headers:auth});
    assert.equal(duplicate.statusCode,409);
    const restored=await f.app.inject({method:'POST',url:'/v1/assets/asset/restore',headers:auth});
    assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().restored,true);
    assert.equal(f.row.deleted_at,null);assert.equal(f.row.status,'draft');
  } finally {await f.app.close();}
  const viewer=await fixture({...live,status:'archived',deleted_at:'2026-01-01T00:00:00Z'},undefined,'viewer',false);
  try {const denied=await viewer.app.inject({method:'POST',url:'/v1/assets/asset/restore',headers:auth});assert.equal(denied.statusCode,403);assert.equal(viewer.getUpdates(),0);}
  finally {await viewer.app.close();}
});

test("legacy removal records exactly one event on the observed row", async () => {
  const f=await fixture(live,undefined,"editor",false);
  try {const response=await f.app.inject({method:"DELETE",url:"/v1/assets/asset",headers:auth});
    assert.equal(response.statusCode,200);assert.equal(f.row.status,"archived");assert.ok(f.row.deleted_at);assert.deepEqual(f.events,["asset_deleted"]);
  } finally {await f.app.close();}
});

test("legacy removal refuses concurrent removal or approval", async () => {
  for (const mutate of [(row:Asset)=>{row.deleted_at="2026-01-01T00:00:00.000Z";row.status="archived";},(row:Asset)=>{row.status="approved";}]) {
    const f=await fixture(live,mutate,"editor",false);
    try {const response=await f.app.inject({method:"DELETE",url:"/v1/assets/asset",headers:auth});assert.equal(response.statusCode,409);assert.deepEqual(f.events,[]);}
    finally {await f.app.close();}
  }
});

test("legacy restore refuses later removal and workspace changes", async () => {
  for (const mutate of [(row:Asset)=>{row.deleted_at="2026-01-02T00:00:00.000Z";},(row:Asset)=>{row.workspace_id="other";}]) {
    const f=await fixture({...live,status:"archived",deleted_at:"2026-01-01T00:00:00.000Z"},mutate,"editor",false);
    try {const response=await f.app.inject({method:"POST",url:"/v1/assets/asset/restore",headers:auth});assert.equal(response.statusCode,409);assert.equal(f.row.status,"archived");assert.deepEqual(f.events,[]);}
    finally {await f.app.close();}
  }
});

test('enabled capability reports the active server mode and retires legacy routes', async () => {
  const f = await fixture(live);
  try {
    const access = await f.app.inject({ method: 'GET', url: '/v1/assets/access?workspaceId=cc910000-0000-4000-8000-000000000001', headers: auth });
    assert.equal(access.statusCode, 200); assert.deepEqual(access.json(), { canEdit: true, assetLifecycleEnabled: true, assetLifecycleReady: true });
    const disabled = await f.app.inject({ method: 'DELETE', url: '/v1/assets/asset', headers: auth }); assert.equal(disabled.statusCode, 410); assert.equal(f.getUpdates(), 0);
  } finally { await f.app.close(); }
});

test('enabled but unready capability never falls back to legacy writes', async () => {
  const f = await fixture(live, undefined, 'editor', true, false);
  try {
    const access = await f.app.inject({method:'GET',url:'/v1/assets/access?workspaceId=cc910000-0000-4000-8000-000000000001',headers:auth});
    assert.equal(access.statusCode,200); assert.deepEqual(access.json(),{canEdit:true,assetLifecycleEnabled:true,assetLifecycleReady:false});
    for (const [method,url] of [['DELETE','/v1/assets/asset'],['POST','/v1/assets/asset/restore']] as const) {
      const response=await f.app.inject({method,url,headers:auth}); assert.equal(response.statusCode,410);
    }
    for (const [method,url] of [['GET','/v1/assets/removed?workspaceId=cc910000-0000-4000-8000-000000000001'],['POST','/v1/assets/asset/lifecycle/remove']] as const) {
      const response=await f.app.inject({method,url,headers:auth,payload:method==='POST'?{}:undefined}); assert.equal(response.statusCode,503);
    }
    for (const [method,url] of [
      ['POST','/v1/assets/generation-jobs/job/finalize'],['POST','/v1/assets/generate'],['POST','/v1/assets/upload-url'],
      ['POST','/v1/assets/asset/confirm'],['POST','/v1/assets/asset/versions'],['POST','/v1/assets/asset/versions/1/confirm'],
      ['PATCH','/v1/assets/asset']
    ] as const) {
      const response=await f.app.inject({method,url,headers:auth,payload:{}});
      assert.equal(response.statusCode,503,`${method} ${url}`);
    }
    assert.equal(f.getUpdates(),0); assert.deepEqual(f.events,[]); assert.deepEqual(f.row,live);
  } finally { await f.app.close(); }
});

test('legacy removal and restore cannot bypass lifecycle operations', async () => {
  for (const [method,url] of [['DELETE','/v1/assets/asset'],['POST','/v1/assets/asset/restore']] as const) {
    for (const role of ['editor','viewer']) {
      const f=await fixture(live, undefined, role); try {
        const response=await f.app.inject({method,url,headers:auth});
        assert.equal(response.statusCode,410); assert.equal(f.getUpdates(),0); assert.deepEqual(f.events,[]); assert.deepEqual(f.row,live);
      } finally {await f.app.close()}
    }
  }
});

test('failed initial allocation retains both pending and concurrently removed assets', async () => {
  for (const removedDuringAllocation of [true, false]) {
    const workspace = 'cc910000-0000-4000-8000-000000000001';
    const actor = 'aa910000-0000-4000-8000-000000000001';
    let row: Record<string, unknown> | null = null;
    let deletes = 0;
    const factory = () => ({
      auth: { getUser: async () => ({ data: { user: { id: actor } }, error: null }) },
      rpc: async (name: string) => name === 'asset_lifecycle_readiness' ? { data: 'asset-lifecycle-v1', error: null } : { data: null, error: { code: 'PGRST202' } },
      from(table: string) {
        const builder = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          delete: () => { deletes++; return builder; },
          insert: (value: Record<string, unknown>) => {
            if (table === 'assets') { row = { ...value, deleted_at: null, status: 'draft' }; return builder; }
            if (table === 'asset_versions') {
              if (removedDuringAllocation && row) { row.deleted_at = '2026-11-03T01:00:00Z'; row.status = 'archived'; }
              return Promise.resolve({ error: { code: '40001' } });
            }
            throw new Error('unexpected insert');
          },
          single: async () => ({ data: { id: row?.id }, error: null }),
          maybeSingle: async () => table === 'workspace_members' ? { data: { role: 'editor' }, error: null } : { data: null, error: null },
        };
        return builder;
      },
    });
    const app = await buildApp(factory as never);
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/assets/upload-url', headers: auth,
        payload: { workspaceId: workspace, filename: 'draft.txt', mimeType: 'text/plain', sizeBytes: 12 } });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(deletes, 0);
      assert.ok(row);
    } finally { await app.close(); }
  }
});
