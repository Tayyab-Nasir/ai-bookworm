/** Dedicated disposable PostgreSQL only. Never reads app connection settings. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

if (process.env.BOOKWORM_NATIVE_TEST !== '1' || !process.env.BOOKWORM_NATIVE_TEST_PASSWORD) {
  throw new Error('Requires explicit BOOKWORM_NATIVE_TEST=1 and a disposable test password.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const database = `bookworm_native_${randomUUID().replaceAll('-', '')}`;
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function session(db = database, name = 'bookworm-native') {
  // Whitelist environment: do not inherit PGHOSTADDR, PGSERVICE or app secrets.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: '55439', PGUSER: 'bookworm_ci',
    PGPASSWORD: process.env.BOOKWORM_NATIVE_TEST_PASSWORD, PGDATABASE: db,
    PGAPPNAME: name, PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable',
    PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=20000' });
  const child = spawn('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const state = { child, stdout: '', stderr: '', ended: false };
  child.stdout.on('data', (data) => { state.stdout += data; });
  child.stderr.on('data', (data) => { state.stderr += data; });
  child.stdin.on('error', () => {});
  state.done = new Promise((resolve) => {
    child.on('error', (error) => { state.stderr += error.message; });
    child.on('close', (code) => { state.ended = true; children.delete(child); resolve({ code, stdout: state.stdout, stderr: state.stderr }); });
  });
  return state;
}
async function sql(statement, db = database) {
  const s = session(db); s.child.stdin.end(statement);
  const result = await s.done;
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
async function until(check, message) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error(message);
}
async function fixture(media) {
  const [u, org, ws, other, plan, job] = Array.from({ length: 6 }, () => randomUUID());
  await sql(`insert into auth.users(id,email) values('${u}','native@local.test');
    insert into organizations(id,name,slug,owner_user_id) values('${org}','Native race','${org}','${u}');
    insert into workspaces(id,organization_id,name,slug,created_by) values
      ('${ws}','${org}','First','${ws}','${u}'),('${other}','${org}','Second','${other}','${u}');
    insert into workspace_members(workspace_id,user_id,role) values('${ws}','${u}','editor'),('${other}','${u}','editor');
    insert into plans(id,name,billing_period,price_cents,entitlements_json) values('${plan}','Native test','month',1000,'{"${media.meter}_monthly":1}');
    insert into subscriptions(organization_id,plan_id,status) values('${org}','${plan}','active');`);
  const insert = (workspace, id, agent) => `insert into ai_jobs(id,workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values('${id}','${workspace}','${agent}','running','{"creditUnits":1}','${id}','${u}');`;
  return { u, org, ws, job, first: insert(ws, job, media.first), second: insert(other, randomUUID(), media.second) };
}
async function race(kind, media) {
  const f = await fixture(media);
  if (kind === 'completion') await sql(f.first);
  const held = session();
  const work = kind === 'completion'
    ? `insert into usage_events(ai_job_id,organization_id,workspace_id,user_id,meter,quantity) values('${f.job}','${f.org}','${f.ws}','${f.u}','${media.meter}',1);
       update ai_jobs set status='succeeded' where id='${f.job}';`
    : f.first;
  held.child.stdin.write(`begin; ${work} select 'BOOKWORM_READY';\n`);
  await until(() => {
    assert.equal(held.ended, false, held.stderr);
    return held.stdout.includes('BOOKWORM_READY');
  }, 'Holder did not become ready');
  const name = `race_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name); contender.child.stdin.end(f.second);
  await until(async () => {
    assert.equal(contender.ended, false, `Contender did not wait: ${contender.stderr}`);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Expected a PostgreSQL lock wait');
  held.child.stdin.end(kind === 'rollback' ? 'rollback;\n' : 'commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const result = await contender.done;
  if (kind === 'rollback') assert.equal(result.code, 0, result.stderr);
  else { assert.notEqual(result.code, 0); assert.match(result.stderr, new RegExp(`23514.*${media.label} credit capacity exhausted`, 's')); }
  assert.equal(await sql(`select count(*) from ai_jobs j join workspaces w on w.id=j.workspace_id where w.organization_id='${f.org}' and j.status in ('queued','running');`), kind === 'completion' ? '0' : '1');
  console.log(`PASS native concurrent ${media.label} ${kind}`);
}
async function deductionRace(replay) {
  const user = randomUUID(); const job = randomUUID();
  await sql(`insert into auth.users(id,email) values('${user}','deduction@local.test');
    insert into credit_ledger(user_id,source,amount,balance_after) values('${user}','purchase',1,1);`);
  const call = (id) => `set request.jwt.claim.role='service_role'; select public.deduct_job_credits('${user}',null,null,'ai_credits',1,'${id}');`;
  const held = session();
  held.child.stdin.write(`begin; ${call(job)} select 'BOOKWORM_READY';\n`);
  await until(() => { assert.equal(held.ended, false, held.stderr); return held.stdout.includes('BOOKWORM_READY'); }, 'Deduction holder not ready');
  const name = `deduct_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name);
  contender.child.stdin.end(call(replay ? job : randomUUID()));
  await until(async () => {
    assert.equal(contender.ended, false, contender.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Deduction did not wait for receipt/balance lock');
  held.child.stdin.end('commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const result = await contender.done;
  if (replay) {
    assert.equal(result.code, 0, result.stderr);
    const first = JSON.parse(held.stdout.split('\n').find((line) => line.startsWith('{')));
    assert.deepEqual(JSON.parse(result.stdout.trim()), first);
  } else {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /23514.*insufficient credits/s);
  }
  assert.equal(await sql(`select count(*) from usage_events where user_id='${user}';`), '1');
  assert.equal(await sql(`select sum(amount) from credit_ledger where user_id='${user}';`), '0');
  console.log(`PASS native deduction ${replay ? 'receipt replay' : 'competing debit rollback'}`);
}
async function fundedQuoteRace() {
  const f = await fixture({ meter: 'ai_credits', first: 'writer', second: 'metadata' });
  const a = randomUUID(); const b = randomUUID();
  // Synthetic non-provider jobs isolate ledger concurrency from operational quotas.
  await sql(`insert into ai_jobs(id,workspace_id,agent_type,input_ref,idempotency_key,created_by) values
    ('${a}','${f.ws}','test_quote','{}','${a}','${f.u}'),('${b}','${f.ws}','test_quote','{}','${b}','${f.u}');
    insert into credit_ledger(user_id,source,amount,balance_after) values('${f.u}','purchase',2,2);`);
  const quote = (job) => `jsonb_build_object('scope',jsonb_build_object('jobId','${job}','workspaceId','${f.ws}','userId','${f.u}','inputSha256',repeat('c',64)),
    'reservedCredits','2','fingerprint',repeat('b',64),'policy',jsonb_build_object('approved',true,'version','test'),
    'price',jsonb_build_object('version','test','provider','openai','model','synthetic'),'createdAt',now()-interval '1 second','expiresAt',now()+interval '10 minutes')`;
  const held = session();
  held.child.stdin.write(`begin; set request.jwt.claim.role='service_role'; select reserve_funded_usage_quote(${quote(a)}); select 'BOOKWORM_READY';\n`);
  await until(() => { assert.equal(held.ended, false, held.stderr); return held.stdout.includes('BOOKWORM_READY'); }, 'Quote holder not ready');
  const name = `quote_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name);
  contender.child.stdin.end(`set request.jwt.claim.role='service_role'; select reserve_funded_usage_quote(${quote(b)});`);
  await until(async () => {
    assert.equal(contender.ended, false, contender.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Quote contender did not wait for funds');
  held.child.stdin.end('commit;\n'); assert.equal((await held.done).code, 0, held.stderr);
  const result = await contender.done;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /23514.*insufficient credits/s);
  assert.equal(await sql(`select count(*) from funded_usage_quotes where user_id='${f.u}';`), '1');
  assert.equal(await sql(`select sum(amount) from credit_ledger where user_id='${f.u}';`), '0');
  console.log('PASS native competing funded quotes');
  const lease = randomUUID();
  await sql(`update ai_jobs set status='running',lease_token='${lease}',lease_expires_at=now()+interval '5 minutes' where id='${a}';`);
  const dispatchSql = `set request.jwt.claim.role='service_role'; select claim_funded_dispatch('${a}','${lease}',repeat('c',64),'synthetic');`;
  const firstDispatch = session();
  firstDispatch.child.stdin.write(`begin; ${dispatchSql} select 'BOOKWORM_READY';\n`);
  await until(() => { assert.equal(firstDispatch.ended, false, firstDispatch.stderr); return firstDispatch.stdout.includes('BOOKWORM_READY'); }, 'Dispatch holder not ready');
  const dispatchName = `dispatch_${randomUUID().replaceAll('-', '')}`;
  const secondDispatch = session(database, dispatchName); secondDispatch.child.stdin.end(dispatchSql);
  await until(async () => {
    assert.equal(secondDispatch.ended, false, secondDispatch.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${dispatchName}' and wait_event_type='Lock';`) === '1';
  }, 'Competing dispatch did not wait');
  firstDispatch.child.stdin.end('commit;\n');
  assert.equal((await firstDispatch.done).code, 0, firstDispatch.stderr);
  const secondResult = await secondDispatch.done;
  assert.equal(secondResult.code, 0, secondResult.stderr); assert.equal(secondResult.stdout.trim(), 'f');
  assert.equal(firstDispatch.stdout.split('\n')[0], 't');
  console.log('PASS native one-time funded dispatch');
}
let created = false;
try {
  assert.equal(await sql("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role');", 'postgres'), '0', 'Refusing a reused/shared server: Supabase roles already exist');
  await sql(`create database ${database};`, 'postgres'); created = true;
  await sql(await readFile(join(root, 'tests/security/local-supabase-fixture.sql'), 'utf8'));
  for (const file of (await readdir(join(root, 'supabase/migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
    await sql(`begin;\n${await readFile(join(root, 'supabase/migrations', file), 'utf8')}\ncommit;`);
    console.log(`PASS native migration ${file}`);
  }
  for (const file of (await readdir(join(root, 'tests/security'))).filter((f) => f.endsWith('.test.sql')).sort()) {
    await sql(await readFile(join(root, 'tests/security', file), 'utf8'));
    console.log(`PASS native assertions ${file}`);
  }
  for (const media of [
    { label: 'text', meter: 'ai_credits', first: 'writer', second: 'metadata' },
    { label: 'image', meter: 'image_credits', first: 'illustrator', second: 'cover_designer' },
    { label: 'audio', meter: 'audio_credits', first: 'narrator', second: 'narrator' },
    { label: 'translation', meter: 'translation_credits', first: 'translator', second: 'translator' },
  ]) {
    for (const kind of ['reservation', 'completion', 'rollback']) await race(kind, media);
  }
  await deductionRace(true);
  await deductionRace(false);
  await fundedQuoteRace();
} finally {
  for (const child of children) child.kill();
  if (created) await sql(`drop database ${database} with (force);`, 'postgres');
}
