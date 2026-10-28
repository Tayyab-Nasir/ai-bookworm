/**
 * Populated historical migration 45 -> migration 127 rehearsal, entirely in memory.
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
const guardedCustomerJobs = '20261024040000_customer_ai_jobs.sql';
const targetEnd = '20261028110000_chapter_restore_ledger.sql';
const guardedReadingText = '20261013110000_canonical_import_reading_text.sql';
const guardedBible = '20261013100000_manual_book_bible_recovery.sql';
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

async function expectedReadingTextGuard(migration, fixture, historical, signature) {
  step = `expected canonical reading-text definition guard: ${signature}`;
  const signatures = ['public.create_book_chapters(uuid,jsonb,uuid)', 'public.complete_manuscript_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)'];
  const captureTargets = async () => (await db.query(`select oid::text,proacl,prosecdef,proconfig,proretset,prorettype::text,
    pg_get_functiondef(oid) as definition from pg_proc where oid in ($1::regprocedure,$2::regprocedure) order by oid`, signatures)).rows;
  await db.exec('begin;');
  try {
    const { rows: [{ definition }] } = await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature]);
    const marker = "from jsonb_array_elements(v_item->'nodes') with ordinality;";
    assert.equal(definition.split(marker).length, 2, 'Drift fixture changes exactly one current projection');
    await db.exec(definition.replace(marker, "from jsonb_array_elements(v_item->'nodes') with ordinality /* synthetic projection drift */;"));
    const before = await captureTargets();
    const schemaAcl = (await db.query("select nspacl from pg_namespace where nspname='private'")).rows;
    await db.exec('savepoint reading_text_guard;');
    await assert.rejects(db.exec(migration.sql), error => error.code === 'P0001'
      && error.message.startsWith('Canonical import reading text target definition drift:')
      && error.message.includes(signature.split('(')[0].split('.').at(-1)));
    await db.exec('rollback to savepoint reading_text_guard;');
    assert.deepEqual(await captureTargets(), before, 'Both function bodies and ACLs survive failed migration, including second-target failure');
    assert.deepEqual((await db.query("select nspacl from pg_namespace where nspname='private'")).rows, schemaAcl, 'Schema ACL addition rolls back');
    for (const helper of ['private.canonical_book_nodes_plain_text(jsonb)', 'private.canonical_book_plain_text_word_count(text)']) {
      assert.equal((await db.query('select to_regprocedure($1) as helper', [helper])).rows[0].helper, null, 'Failed migration leaves no helper');
    }
  } finally { await db.exec('rollback;'); }
  assert.deepEqual(await captureHistoricalState(db, fixture), historical);
  console.log(`PASS expected canonical reading-text drift and atomic rollback ${signature}`);
}

async function expectedCustomerGuard(migration, fixture, historical, signature, marker, message) {
  step = `expected customer authorization definition guard: ${signature}`;
  await db.exec('begin;');
  try {
    const { rows: [{ definition }] } = await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature]);
    assert.equal(definition.split(marker).length, 2, 'Drift probe changes exactly one reviewed guard target');
    // Harmless whitespace is enough to refuse an unreviewed body, not silently
    // rewrite a similar-looking function after operator/schema drift.
    await db.exec(definition.replace(marker, marker.replace(':=', ':= ').replace("if new.billing_mode=", "if new.billing_mode =")));
    const before = (await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])).rows[0].definition;
    assert.notEqual(before, definition);
    await db.exec('savepoint customer_guard;');
    await assert.rejects(db.exec(migration.sql), error => error.code === 'P0001' && error.message === message);
    await db.exec('rollback to savepoint customer_guard;');
    assert.equal((await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])).rows[0].definition, before);
    for (const table of ['bookworm_credentials.customer_ai_policies', 'bookworm_credentials.customer_ai_jobs']) {
      assert.equal((await db.query('select to_regclass($1) as target', [table])).rows[0].target, null);
    }
    assert.equal((await db.query("select to_regprocedure('public.guard_customer_ai_job()') as target")).rows[0].target, null);
    assert.equal((await db.query("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.ai_jobs'::regclass and conname='ai_jobs_billing_mode_check'")).rows[0].definition.includes('customer_key'), false);
  } finally { await db.exec('rollback;'); }
  assert.deepEqual(await captureHistoricalState(db, fixture), historical);
  console.log(`PASS expected customer definition drift and atomic rollback ${signature}`);
}

try {
  assert.equal(process.argv.length, 2, 'No connection URLs or operator options are accepted');
  const names = (await readdir(join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.equal(names.length, 127, 'This reviewed rehearsal pins the 45 -> 127 target; review before extending');
  assert.equal(names[117], '20261028010000_customer_ai_ready_discovery.sql');
  assert.equal(names[118], '20261028020000_customer_ai_preparation_timestamp.sql');
  assert.equal(names[119], '20261028030000_customer_ai_reconciliation.sql');
  assert.equal(names[120], '20261028040000_customer_ai_reconciliation_discovery.sql');
  assert.equal(names[121], '20261028050000_customer_ai_receipt_recovery.sql');
  assert.equal(names[122], '20261028070000_customer_ai_maintenance_journal.sql');
  assert.equal(names[123], '20261028080000_customer_ai_maintenance_lookup.sql');
  assert.equal(names[124], '20261028090000_customer_ai_maintenance_slots.sql');
  assert.equal(names[125], '20261028100000_customer_ai_function_catalog_diagnostic.sql');
  assert.equal(names[110], '20261023153000_chapter_title_changes.sql');
  assert.equal(names[111], '20261024020000_ai_connection_vault.sql');
  assert.equal(names[112], guardedCustomerJobs);
  assert.equal(names[113], '20261024050000_customer_ai_completion.sql');
  assert.equal(names[44], baselineEnd);
  assert.equal(names[45], '20260912175000_pgcrypto_digest_compatibility.sql');
  assert.equal(names[46], '20260912180000_translation_workflow.sql');
  assert.equal(names.at(-1), targetEnd);
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(join(root, 'supabase/migrations', name), 'utf8');
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
  const manifest = migrations.map(({ name, sha256 }) => `${name} ${sha256}`).join('\n');
  console.log(`Ordered source manifest sha256=${createHash('sha256').update(manifest).digest('hex')} baseline=45 upgrade=${migrations.length - 45}`);
  await db.exec(await readFile(join(root, 'tests/security/local-supabase-fixture.sql'), 'utf8'));
  for (const migration of migrations.slice(0, 45)) await migrate(migration, 'baseline');
  step = 'committed populated historical fixture';
  const fixture = await seedUpgradeBaseline(db);
  const historical = await captureHistoricalState(db, fixture);
  const historicalRun = randomUUID();
  await db.query(`insert into public.ai_runs(id,workspace_id,provider,model,tokens_in,tokens_out,estimated_cost,status)
    values($1,$2,'synthetic-historical','synthetic-original',9,3,1.25,'succeeded')`, [historicalRun, fixture.tenants[0].workspace]);
  const historicalRunBefore = (await db.query('select to_jsonb(r) as value from public.ai_runs r where id=$1', [historicalRun])).rows[0].value;
  step = 'pre-upgrade historical authorization probes';
  await verifyHistoricalIsolation(db, fixture);
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Pre-upgrade authorization probes are non-mutating');
  console.log(`PASS committed baseline: two tenants, four profiles, historical versions, rich nodes, memberships, quarantined/trusted assets, ledger balances and uncertain Stripe receipts; ${Object.keys(historical).length} preserved relation projections`);
  for (const migration of migrations.slice(45)) {
    if (migration.name === guardedMetadata) await expectedGuard(migration, fixture, historical, 'duplicate metadata');
    if (migration.name === guardedTranslation) await expectedGuard(migration, fixture, historical, 'function drift');
    if (migration.name === guardedBible) await expectedGuard(migration, fixture, historical, 'nonfinite canon revision');
    if (migration.name === guardedReadingText) {
      for (const signature of ['public.create_book_chapters(uuid,jsonb,uuid)', 'public.complete_manuscript_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)']) {
        await expectedReadingTextGuard(migration, fixture, historical, signature);
      }
    }
    if (migration.name === guardedCustomerJobs) {
      await expectedCustomerGuard(migration, fixture, historical, 'public.reserve_text_job_credit()',
        "if new.billing_mode='quoted' then return new; end if;", 'unexpected text reservation definition');
      await expectedCustomerGuard(migration, fixture, historical, 'public.deduct_job_credits(uuid,uuid,uuid,text,integer,uuid)',
        "v_request:=jsonb_build_object('userId',p_user_id", 'unexpected legacy deduction definition');
    }
    await migrate(migration, 'upgrade');
    assert.deepEqual(await captureHistoricalState(db, fixture), historical, `Historical identities/content/versions/balances/ownership unchanged after ${migration.name}`);
  }
  step = 'upgraded historical authorization and grants';
  await verifyHistoricalIsolation(db, fixture);
  await verifyUpgradeGates(db, fixture);
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Post-upgrade role/grant/paid-default gates preserve historical data');
  step = 'historical chapter title revision and explicit rename recovery';
  assert.equal((await db.query('select count(*)::int as n from public.chapters where title_revision<>0')).rows[0].n, 0,
    'Legacy titles start at revision zero without inventing previous title edits');
  assert.equal((await db.query('select count(*)::int as n from public.chapter_title_changes')).rows[0].n, 0,
    'Upgrade creates no historical title receipts');
  for (const tenant of fixture.tenants) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: tenant.user, role: 'authenticated' })]);
      const preservedChapter = async () => (await db.query("select to_jsonb(c)-'title'-'title_revision'-'updated_at' as data from public.chapters c where id=$1", [tenant.chapter])).rows;
      const preservedVersions = async () => (await db.query('select to_jsonb(v) as data from public.document_versions v where chapter_id=$1 order by id', [tenant.chapter])).rows;
      const originalChapter = await preservedChapter(), originalVersions = await preservedVersions();
      assert.equal(originalVersions.length, 2, 'Probe uses both immutable historical manuscript versions');
      const operation = randomUUID(), title = `Explicit historical title ${tenant.label}`;
      const digest = createHash('sha256').update(title).digest('hex');
      const result = async (sql, args) => (await db.query(sql, args)).rows[0].result;
      assert.equal((await result('select public.get_chapter_title_change($1,$2,0,$3) as result',
        [tenant.chapter, operation, digest])).status, 'not_found', 'Legacy title has no invented saved outcome');
      const saved = await result('select public.change_chapter_title($1,$2,0,$3) as result', [tenant.chapter, operation, title]);
      assert.equal(saved.status, 'saved');
      assert.deepEqual(saved.receipt, { title, revision: 1 });
      assert.equal(saved.current.title, title);
      assert.equal(saved.current.revision, 1);
      assert.deepEqual(await result('select public.change_chapter_title($1,$2,0,$3) as result',
        [tenant.chapter, operation, title]), saved, 'Replaying the historical rename does not advance its revision');
      assert.deepEqual(await result('select public.close_chapter_title_change($1,$2,0,$3) as result',
        [tenant.chapter, operation, digest]), saved, 'Closure cannot undo a committed historical rename');
      const stale = await result('select public.change_chapter_title($1,$2,0,$3) as result',
        [tenant.chapter, randomUUID(), 'Stale historical title']);
      assert.equal(stale.status, 'conflict');
      assert.deepEqual(stale.current, saved.current, 'Stale revision cannot replace the explicitly renamed title');
      const closedOperation = randomUUID(), closedTitle = 'Closed historical request';
      const closedDigest = createHash('sha256').update(closedTitle).digest('hex');
      const closed = await result('select public.close_chapter_title_change($1,$2,1,$3) as result',
        [tenant.chapter, closedOperation, closedDigest]);
      assert.equal(closed.status, 'closed');
      assert.deepEqual(await result('select public.change_chapter_title($1,$2,1,$3) as result',
        [tenant.chapter, closedOperation, closedTitle]), closed, 'A delayed request cannot bypass closure on an upgraded chapter');
      assert.deepEqual(closed.current, saved.current, 'Closure leaves the historical chapter title and revision unchanged');
      assert.deepEqual(await preservedChapter(), originalChapter, 'Rename preserves chapter identity, ordering and manuscript pointer');
      assert.deepEqual(await preservedVersions(), originalVersions, 'Rename neither rewrites nor appends immutable manuscript history');
    } finally { await db.exec('rollback;'); }
  }
  assert.equal((await db.query('select count(*)::int as n from public.chapter_title_changes')).rows[0].n, 0, 'Title probes leave no receipts after rollback');
  assert.equal((await db.query('select count(*)::int as n from public.chapters where title_revision<>0')).rows[0].n, 0, 'Rollback restores original title revisions');
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Historical title recovery probes preserve every historical relation');
  console.log('PASS historical title revision backfill, explicit rename/replay, stale conflict, late-write closure, manuscript preservation and rollback without invented receipts');
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
  step = 'new chapter reading text after populated upgrade';
  for (const tenant of fixture.tenants) {
    const nodes = [{ id: 'table-reading', type: 'table', rows: [['Alpha', 'Beta']] },
      { id: 'empty-authoritative', type: 'table', text: '', rows: [['Hidden legacy grid']] },
      { id: 'unicode-reading', type: 'paragraph', text: 'Gamma\u00a0delta' }];
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: tenant.user, role: 'authenticated' })]);
      const { rows: [chapter] } = await db.query('select current_document_version_id from public.create_book_chapters($1,$2::jsonb)',
        [tenant.book, JSON.stringify([{ title: 'Reading text upgrade probe', nodes }])]);
      const { rows: [version] } = await db.query('select content_json,plain_text,word_count from public.document_versions where id=$1', [chapter.current_document_version_id]);
      assert.equal(version.plain_text, 'Alpha\tBeta\n\nGamma\u00a0delta');
      assert.equal(version.word_count, 4);
      assert.deepEqual(version.content_json.nodes, nodes, 'Reading projection does not rewrite canonical content');
    } finally { await db.exec('rollback;'); }
  }
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'New reading projections leave historical versions and receipts untouched');
  console.log('PASS populated upgrade reading projection: table cells, authoritative empty text, Unicode whitespace, unchanged canonical content and historical rollback');
  console.log('PASS preserved historical projections, tenant/role/quarantine isolation, tenant-scoped profiles/ledger, retired RPCs, service-only pinned RPCs, rich citations, legacy-unverified Stripe receipts and zero unentitled image capacity');
  step = 'private credential vault permissions and recovery after populated upgrade';
  await db.exec(await readFile(join(root, 'tests/security/ai-connection-vault.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Credential vault creation and rollback probes leave all historical data unchanged');
  console.log('PASS populated upgrade credential vault: no inherited credentials, owner RLS, preserved settlement schema grants, encrypted-only RPCs, CAS, revocation, closure and rollback');
  step = 'customer payer lifecycle after populated upgrade';
  await db.exec(await readFile(join(root, 'tests/security/customer-ai-jobs.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Customer policy/job fixtures and rollback leave historical rows unchanged');
  assert.equal((await db.query('select count(*)::int as n from bookworm_credentials.customer_ai_policies')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from bookworm_credentials.customer_ai_jobs')).rows[0].n, 0);
  console.log('PASS populated upgrade customer jobs: no inherited policy or quota, owner/revision binding, paid-plan isolation, single-use resolution, no duplicate fee or ambiguous refund');
  step = 'customer receipt-only completion after populated upgrade';
  const historicalRunAfter = (await db.query('select to_jsonb(r) as value from public.ai_runs r where id=$1', [historicalRun])).rows[0].value;
  assert.equal(historicalRunAfter.cost_payer, 'platform');
  const { cost_payer, ...unchangedRun } = historicalRunAfter;
  assert.deepEqual(unchangedRun, historicalRunBefore, 'Payer backfill preserves all historical model, token, cost and identity evidence');
  await db.exec(await readFile(join(root, 'tests/security/customer-ai-completion.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Customer completion fixtures roll back without historical changes');
  assert.deepEqual((await db.query('select to_jsonb(r) as value from public.ai_runs r where id=$1', [historicalRun])).rows[0].value, historicalRunAfter);
  assert.equal((await db.query("select count(*)::int as n from public.ai_runs where cost_payer='customer'")).rows[0].n, 0);
  console.log('PASS populated upgrade customer completion: historical costs unchanged, unknown customer cost distinct from zero, five-provider/six-agent receipt recovery, atomic rollback, immutable outcomes and no inherited customer activity');
  step = 'customer durable preparation and exact confirmation after populated upgrade';
  await db.exec(await readFile(join(root, 'tests/security/customer-ai-preparations.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Customer preparation and recovery probes preserve every historical projection');
  assert.equal((await db.query('select count(*)::int as n from bookworm_credentials.customer_ai_preparations')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from bookworm_credentials.customer_ai_policies')).rows[0].n, 0);
  console.log('PASS populated upgrade durable customer requests: exact consent, one fee/job, status after revocation, no manuscript exposure, expiry, closure, receipt-only recovery and rate limits; no policy seeded');
  step = 'customer author late-write closure after populated upgrade';
  await db.exec(await readFile(join(root, 'tests/security/customer-ai-author-recovery.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical);
  assert.equal((await db.query('select count(*)::int as n from bookworm_credentials.customer_ai_preparation_closures')).rows[0].n, 0);
  console.log('PASS populated upgrade author recovery: canonical revision metadata, late-write rejection, no ambiguous refund, private ACLs and bounded closure rate');
  step = 'customer function catalog diagnostic after populated upgrade';
  await db.exec(await readFile(join(root, 'tests/security/customer-ai-function-catalog.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Catalog mutation tests roll back without changing historical data');
  console.log('PASS populated upgrade function catalog diagnostic: limited RPC grants and configuration checks, drift and rollback');
  step = 'chapter restore ledger after populated upgrade';
  await db.exec(await readFile(join(root, 'tests/security/chapter-restore-ledger.test.sql'), 'utf8'));
  assert.deepEqual(await captureHistoricalState(db, fixture), historical, 'Restore ledger tests roll back without changing historical data');
  assert.equal((await db.query('select count(*)::int as n from public.chapter_restore_operations')).rows[0].n, 0, 'No historical restore receipts invented');
  console.log('PASS populated upgrade restore ledger: identity, replay, close, conflict, asset checks and rollback');
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
  console.log(`PASS populated upgrade: 45 historical migrations + committed rows + ${migrations.length - 45} upgrades + seven guarded aborts + reused synthetic paid lifecycle helpers.`);
  console.log('NOT PROVEN: hosted history/drift, real backup/restore, native concurrency, GoTrue/PostgREST/Storage HTTP, provider receipts, worker drain or production rollout authority.');
} catch (error) {
  // Never print SQL, function definitions, row contents or raw database error detail.
  const location = error.code === 'ERR_ASSERTION' ? error.stack?.split('\n').find(line => line.includes('/tests/security/'))?.trim() : null;
  console.error(`FAIL ${step}: ${error.code ? `SQLSTATE ${error.code}` : 'assertion/runtime failure'}${location ? ` ${location}` : ''}`);
  process.exitCode = 1;
} finally { await db.close(); }
