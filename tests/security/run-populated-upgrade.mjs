/**
 * Populated historical migration 45 -> migration 107 rehearsal, entirely in memory.
 * No .env, credentials, connection strings, native ports, hosted services or files written.
 * Keep the existing fresh-schema and native race runners; this is additional coverage.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { seedUpgradeBaseline, captureHistoricalState, verifyHistoricalIsolation, verifyUpgradeGates } from './upgrade-baseline-fixture.mjs';
import { verifyPaidQuoteFixtures } from './native-paid-quote-lifecycle.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baselineEnd = '20260912170000_audiobook_idempotency_hardening.sql';
const targetEnd = '20261013100000_manual_book_bible_recovery.sql';
const guardedMetadata = '20260919030000_metadata_single_active_request.sql';
const guardedTranslation = '20260919120000_quoted_translation_queue.sql';
const db = new PGlite({ extensions: { citext, pgcrypto } });
let step = 'ordered source manifest';

async function migrate(migration, phase) {
  step = `${phase}: ${migration.name}`;
  await db.exec(`begin;\n${migration.sql}\ncommit;`);
  console.log(`PASS ${phase} ${migration.name} sha256=${migration.sha256}`);
}

async function expectedGuard(migration, fixture, historical, kind) {
  const tenant = fixture.tenants[0];
  step = `expected ${kind} guard: ${migration.name}`;
  await db.exec('begin;');
  try {
    let before;
    if (kind === 'duplicate metadata') {
      await db.query("insert into public.ai_jobs(id,workspace_id,book_id,agent_type,idempotency_key,created_by) values($1,$2,$3,'metadata',$4,$5)",
        [randomUUID(), tenant.workspace, tenant.book, `guard-${randomUUID()}`, tenant.user]);
      before = (await db.query("select jsonb_agg(to_jsonb(j) order by id) as state from public.ai_jobs j where book_id=$1 and agent_type='metadata'", [tenant.book])).rows[0].state;
      assert.equal(before.length, 2, 'Negative fixture genuinely contains two active historical-style requests');
    } else if (kind === 'nonfinite canon revision') {
      await db.query("update public.book_bible_items set updated_at='infinity' where book_id=$1", [tenant.book]);
      before = (await db.query('select id,updated_at::text as revision from public.book_bible_items where book_id=$1', [tenant.book])).rows;
      assert.equal(before[0].revision, 'infinity');
    } else {
      // Simulate operator/schema drift without altering any source migration.
      await db.exec(`do $$ declare definition text; begin
        definition:=pg_get_functiondef('public.claim_translation_job(integer)'::regprocedure);
        assert position('where j.agent_type = ''translator''' in definition)>0;
        execute replace(definition,'where j.agent_type = ''translator''','where j.agent_type in (''translator'')');
      end $$;`);
      before = (await db.query("select pg_get_functiondef('public.claim_translation_job(integer)'::regprocedure) as definition")).rows[0].definition;
    }
    await db.exec('savepoint migration_guard;');
    await assert.rejects(db.exec(migration.sql), kind === 'duplicate metadata' ? { code: '23505' }
      : kind === 'nonfinite canon revision' ? error => error.code === 'P0001' && error.message === 'Manual Book Bible requires finite legacy revisions'
      : error => error.code === 'P0001' && error.message === 'unexpected translation claim definition');
    await db.exec('rollback to savepoint migration_guard;');
    if (kind === 'duplicate metadata') {
      assert.equal((await db.query("select to_regclass('public.ai_jobs_one_active_metadata_per_author_book') as index")).rows[0].index, null);
      assert.deepEqual((await db.query("select jsonb_agg(to_jsonb(j) order by id) as state from public.ai_jobs j where book_id=$1 and agent_type='metadata'", [tenant.book])).rows[0].state, before,
        'Guard failure neither cancels nor changes either request');
    } else if (kind === 'nonfinite canon revision') {
      assert.deepEqual((await db.query('select id,updated_at::text as revision from public.book_bible_items where book_id=$1', [tenant.book])).rows, before,
        'Guard failure does not rewrite the legacy revision');
      assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='book_bible_items' and column_name='mutation_incarnation_id'")).rows[0].n, 0);
      assert.equal((await db.query("select to_regclass('bookworm_private.book_bible_mutation_receipts') as receipt")).rows[0].receipt, null);
    } else {
      assert.equal((await db.query("select pg_get_functiondef('public.claim_translation_job(integer)'::regprocedure) as definition")).rows[0].definition, before, 'Drifted function is untouched by aborted migration');
      assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='ai_jobs' and column_name='billing_mode'")).rows[0].n, 0, 'Earlier DDL in failed file is rolled back');
      assert.equal((await db.query("select to_regprocedure('public.guard_job_billing_mode()') as function")).rows[0].function, null, 'Aborted file leaves no partial trigger function');
    }
  } finally { await db.exec('rollback;'); }
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Negative fixture rollback preserves all historical projections');
  console.log(`PASS expected ${kind} guarded failure with atomic rollback ${migration.name}`);
}

try {
  assert.equal(process.argv.length, 2, 'No connection URLs or operator options are accepted');
  const names = (await readdir(join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.equal(names.length, 107, 'This reviewed rehearsal pins the 45 -> 107 target; review before extending');
  assert.equal(names[44], baselineEnd);
  assert.equal(names[45], '20260912180000_translation_workflow.sql');
  assert.equal(names.at(-1), targetEnd);
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(join(root, 'supabase/migrations', name), 'utf8');
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
  const manifest = migrations.map(({ name, sha256 }) => `${name} ${sha256}`).join('\n');
  console.log(`Ordered source manifest sha256=${createHash('sha256').update(manifest).digest('hex')} baseline=45 upgrade=62`);
  await db.exec(await readFile(join(root, 'tests/security/local-supabase-fixture.sql'), 'utf8'));
  for (const migration of migrations.slice(0, 45)) await migrate(migration, 'baseline');
  step = 'committed populated historical fixture';
  const fixture = await seedUpgradeBaseline(db);
  const historical = await captureHistoricalState(db, fixture);
  step = 'pre-upgrade historical authorization probes';
  await verifyHistoricalIsolation(db, fixture);
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Pre-upgrade authorization probes are non-mutating');
  console.log(`PASS committed baseline: two tenants, four profiles, historical versions, rich nodes, memberships, quarantined/trusted assets, ledger balances and uncertain Stripe receipts; ${Object.keys(historical).length} preserved relation projections`);
  for (const migration of migrations.slice(45)) {
    if (migration.name === guardedMetadata) await expectedGuard(migration, fixture, historical, 'duplicate metadata');
    if (migration.name === guardedTranslation) await expectedGuard(migration, fixture, historical, 'function drift');
    if (migration.name === targetEnd) await expectedGuard(migration, fixture, historical, 'nonfinite canon revision');
    await migrate(migration, 'upgrade');
    assert.deepEqual(await captureHistoricalState(db, fixture), historical, `Historical identities/content/versions/balances/ownership unchanged after ${migration.name}`);
  }
  step = 'upgraded historical authorization and grants';
  await verifyHistoricalIsolation(db, fixture);
  await verifyUpgradeGates(db, fixture);
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Post-upgrade role/grant/paid-default gates preserve historical data');
  step = 'historical Book Bible incarnation and durable manual update';
  const incarnations = new Set();
  for (const tenant of fixture.tenants) {
    const { rows: [entry] } = await db.query('select id,updated_at,mutation_incarnation_id from public.book_bible_items where book_id=$1', [tenant.book]);
    assert.ok(entry && /^[a-f0-9-]{36}$/i.test(entry.mutation_incarnation_id), 'Legacy canon received only a new server-owned incarnation, not an invented creator');
    assert.ok(!incarnations.has(entry.mutation_incarnation_id), 'Legacy incarnations are distinct');
    incarnations.add(entry.mutation_incarnation_id);
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: tenant.user, role: 'authenticated' })]);
      const { rows: [saved] } = await db.query('select public.mutate_book_bible_item($1,$2,$3,$4,$5,$6::jsonb,$7) as result',
        [tenant.book, randomUUID(), 'update', entry.id, entry.updated_at,
          JSON.stringify({ type: 'character', name: 'Explicit upgrade probe', attributes: { age: 42 } }), entry.mutation_incarnation_id]);
      assert.equal(saved.result.disposition, 'unchanged');
      assert.equal(saved.result.item.mutation_incarnation_id, entry.mutation_incarnation_id, 'Updating a legacy row does not invent another incarnation');
      assert.equal(saved.result.item.confidence, 0.9, 'Legacy confidence survives explicit canon updates');
    } finally { await db.exec('rollback;'); }
  }
  assert.equal((await db.query('select count(*)::int as n from bookworm_private.book_bible_mutation_receipts')).rows[0].n, 0, 'Rollback probes do not leave historical mutation claims');
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Durable upgrade probes preserve all historical fields and rolled-back canon');
  console.log('PASS historical canon incarnation backfill, distinct identity, explicit authenticated recovery writes and rollback without invented historical receipts');
  console.log('PASS preserved historical projections, tenant/role/quarantine isolation, tenant-scoped profiles/ledger, retired RPCs, service-only pinned RPCs, rich citations, legacy-unverified Stripe receipts and zero unentitled image capacity');
  step = 'existing synthetic paid quote lifecycle helpers on upgraded schema';
  await verifyPaidQuoteFixtures(async statement => {
    const results = await db.exec(statement);
    const result = results.findLast(value => value.rows.length), row = result?.rows[0];
    if (!row) return '';
    const value = Object.values(row)[0];
    return [114, 3802].includes(result.fields[0].dataTypeID) ? JSON.stringify(value)
      : typeof value === 'boolean' ? value ? 't' : 'f' : String(value);
  });
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Reused paid lifecycle fixtures roll back without changing historical rows');
  console.log('PASS populated upgrade: 45 historical migrations + committed rows + 62 upgrades + three guarded aborts + reused synthetic paid lifecycle helpers.');
  console.log('NOT PROVEN: hosted history/drift, real backup/restore, native concurrency, GoTrue/PostgREST/Storage HTTP, provider receipts, worker drain or production rollout authority.');
} catch (error) {
  // Never print SQL, function definitions, row contents or raw database error detail.
  const location = error.code === 'ERR_ASSERTION' ? error.stack?.split('\n').find(line => line.includes('/tests/security/'))?.trim() : null;
  console.error(`FAIL ${step}: ${error.code ? `SQLSTATE ${error.code}` : 'assertion/runtime failure'}${location ? ` ${location}` : ''}`);
  process.exitCode = 1;
} finally { await db.close(); }
