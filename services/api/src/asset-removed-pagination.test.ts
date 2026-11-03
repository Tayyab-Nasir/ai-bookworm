import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY ??= 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.QDRANT_URL ??= 'http://localhost:6333';
process.env.NODE_ENV = 'test';
process.env.ASSET_LIFECYCLE_ENABLED = 'true';
process.env.LOG_LEVEL = 'error';
const { buildApp } = await import('./app.js');
const actor = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const auth = { authorization: 'Bearer synthetic', 'x-bookworm-actor': actor };
type Row = { id: string; workspace_id: string; name: string; deleted_at: string; checksum: string | null; lifecycle_revision: string | null };
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const micros = (value: string) => BigInt(Date.parse(value)) * 1000n + BigInt((/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(6, '0').slice(3));
const row = (n: number, deleted_at = '2026-11-03T01:00:00.123456+00:00'): Row => ({ id: id(n), workspace_id: workspace, name: `File ${n}`, deleted_at, checksum: 'a'.repeat(64), lifecycle_revision: null });

async function fixture(role = 'editor') {
  let rows: Row[] = Array.from({ length: 105 }, (_, index) => row(index + 1));
  let corrupt: 'foreign' | 'unordered' | null = null, filters: string[] = [], reads = 0, revokeOnRead = false;
  const factory = () => ({
    auth: { getUser: async () => ({ data: { user: { id: actor } }, error: null }) },
    from(table: string) {
      let scope = '', cursor: { time: string; id: string } | null = null;
      const builder = {
        select: () => builder,
        eq: (key: string, value: string) => { if (key === 'workspace_id') scope = value; return builder; },
        not: () => builder,
        or: (filter: string) => {
          filters.push(filter);
          const match = /^deleted_at\.lt\.([^,]+),and\(deleted_at\.eq\.([^,]+),id\.lt\.([0-9a-f-]+)\)$/i.exec(filter);
          assert.ok(match); assert.equal(match[1], match[2]); cursor = { time: match[1], id: match[3] }; return builder;
        },
        order: () => builder,
        limit: async (size: number) => {
          reads++;
          let output = rows.filter(item => item.workspace_id === scope && (!cursor || micros(item.deleted_at) < micros(cursor.time)
            || (micros(item.deleted_at) === micros(cursor.time) && item.id < cursor.id))).sort((a, b) => micros(a.deleted_at) === micros(b.deleted_at) ? b.id.localeCompare(a.id) : micros(a.deleted_at) > micros(b.deleted_at) ? -1 : 1).slice(0, size);
          if (corrupt === 'foreign' && output.length) output = [{ ...output[0], workspace_id: other }, ...output.slice(1)];
          if (corrupt === 'unordered' && output.length > 1) output = [output[1], output[0], ...output.slice(2)];
          if (revokeOnRead) role = 'viewer';
          return { data: output, error: null };
        },
        maybeSingle: async () => ({ data: table === 'workspace_members' ? { role, workspace_id: scope, user_id: actor, status: 'active' } : null, error: null }),
      };
      return builder;
    },
    rpc: async (name: string) => ({ data: name === 'asset_lifecycle_readiness' ? 'asset-lifecycle-v1' : null, error: null }),
  });
  const app = await buildApp(factory as never);
  const get = (query: Record<string, string>) => app.inject({ method: 'GET', url: `/v1/assets/removed?${new URLSearchParams({ workspaceId: workspace, ...query })}`, headers: auth });
  return { app, get, remove: (n: number) => { rows = rows.filter(item => item.id !== id(n)); }, add: (item: Row) => rows.push(item), corrupt: (kind: typeof corrupt) => { corrupt = kind; }, revokeOnRead: () => { revokeOnRead = true; }, filters, reads: () => reads };
}

test('keyset pagination reaches every older file with identical microsecond timestamps despite concurrent list changes', async () => {
  const f = await fixture();
  try {
    const first = await f.get({}); assert.equal(first.statusCode, 200, first.body);
    const a = first.json(); assert.equal(a.assets.length, 50); assert.equal(a.assets[0].id, id(105)); assert.equal(a.assets[49].id, id(56));
    assert.deepEqual(a.nextCursor, { beforeDeletedAt: row(56).deleted_at, beforeId: id(56) });
    f.remove(90); f.remove(20); f.add(row(106, '2026-11-03T01:00:01.000000Z'));
    const second = await f.get(a.nextCursor); assert.equal(second.statusCode, 200, second.body);
    const b = second.json(); assert.equal(b.assets.length, 50); assert.equal(b.assets[0].id, id(55)); assert.equal(b.assets[49].id, id(5));
    const third = await f.get(b.nextCursor); assert.equal(third.statusCode, 200, third.body);
    const c = third.json(); assert.deepEqual(c.assets.map((x: Row) => x.id), [id(4), id(3), id(2), id(1)]); assert.equal(c.nextCursor, null);
    assert.equal(new Set([...a.assets, ...b.assets, ...c.assets].map((x: Row) => x.id)).size, 104);
    assert.equal(f.filters.length, 2); assert.ok(f.filters[0].includes(row(56).deleted_at));
    const refreshed = await f.get({}); assert.equal(refreshed.json().assets[0].id, id(106));
  } finally { await f.app.close(); }
});

test('malformed, partial and injected cursors are rejected before reading rows', async () => {
  const f = await fixture();
  try {
    const malformed: Record<string, string>[] = [
      { beforeId: id(1) }, { beforeDeletedAt: row(1).deleted_at },
      { beforeDeletedAt: '2026-02-30T01:00:00Z', beforeId: id(1) },
      { beforeDeletedAt: '2026-11-03T01:00:00Z),id.not.is.null', beforeId: id(1) },
      { beforeDeletedAt: row(1).deleted_at, beforeId: `${id(1)}),id.not.is.null` },
    ];
    for (const cursor of malformed) { const response = await f.get(cursor); assert.equal(response.statusCode, 422, response.body); }
    assert.equal(f.reads(), 0);
  } finally { await f.app.close(); }
});

test('cursor preserves microseconds and timezone offsets when selecting the next page', async () => {
  const f = await fixture();
  try {
    f.add(row(106, '2026-11-03T06:00:00.123457+05:00'));
    f.add(row(107, '2026-11-03T01:00:00.123455Z'));
    const first = (await f.get({})).json(); assert.equal(first.assets[0].id, id(106));
    const second = (await f.get(first.nextCursor)).json();
    const third = (await f.get(second.nextCursor)).json();
    assert.equal(third.assets.at(-1).id, id(107));
    assert.equal(new Set([...first.assets, ...second.assets, ...third.assets].map((x: Row) => x.id)).size, 107);
  } finally { await f.app.close(); }
});

test('wrong-workspace, out-of-order and viewer results fail closed', async () => {
  const f = await fixture();
  try {
    f.corrupt('foreign'); assert.equal((await f.get({})).statusCode, 503);
    f.corrupt('unordered'); assert.equal((await f.get({})).statusCode, 503);
  } finally { await f.app.close(); }
  const viewer = await fixture('viewer');
  try { assert.equal((await viewer.get({})).statusCode, 403); assert.equal(viewer.reads(), 0); }
  finally { await viewer.app.close(); }
  const revoked = await fixture();
  try { revoked.revokeOnRead(); const response = await revoked.get({}); assert.equal(response.statusCode, 403); assert.ok(!response.body.includes('File 105')); }
  finally { await revoked.app.close(); }
});
