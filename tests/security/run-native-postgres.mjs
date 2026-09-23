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
async function proposalAcceptanceRace(mode) {
  const f = await fixture({ meter: 'translation_credits', first: 'translator', second: 'translator' });
  const book = randomUUID(), first = randomUUID(), second = randomUUID();
  const chapters = Array.from({ length: 2 }, (_, index) => ({ id: randomUUID(), doc: randomUUID(), index }));
  await sql(`insert into books(id,workspace_id,title,author_name,language,created_by)
    values('${book}','${f.ws}','Concurrent proposals','Author','en','${f.u}');
    insert into credit_ledger(user_id,source,amount,balance_after) values('${f.u}','purchase',4,4);`);
  for (const c of chapters) await sql(`insert into chapters(id,book_id,order_index,title) values('${c.id}','${book}',${c.index},'Chapter');
    insert into document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
      values('${c.doc}','${c.id}',1,'{}','Source',1,'${f.u}');`);
  for (const proposal of [first, second]) {
    const items = chapters.map((c) => {
      const job = randomUUID();
      return `jsonb_build_object('chapterId','${c.id}','documentVersionId','${c.doc}','chapterOrder',${c.index},'jobId','${job}',
        'sourceSha256',encode(digest(convert_to('Source','UTF8'),'sha256'),'hex'),
        'quote',jsonb_build_object('scope',jsonb_build_object('jobId','${job}','userId','${f.u}','workspaceId','${f.ws}','inputSha256',repeat('a',64)),
          'reservedCredits','2','fingerprint',repeat('b',64),'policy',jsonb_build_object('approved',true,'version','test'),
          'price',jsonb_build_object('version','test','provider','openai','model','synthetic'),
          'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '20 minutes'))`;
    });
    await sql(`insert into translation_quote_proposals(id,user_id,workspace_id,book_id,source_language,target_language,catalog_version,chapters_json,reserved_credits,expires_at)
      values('${proposal}','${f.u}','${f.ws}','${book}','en','es','test',jsonb_build_array(${items.join(',')}),4,clock_timestamp()+interval '10 minutes');`);
  }
  const accept = (id) => `set request.jwt.claim.role='service_role'; select (accept_translation_quote('${id}','${f.u}',4)).id;`;
  const held = session();
  held.child.stdin.write(`begin; ${accept(first)} select 'BOOKWORM_READY';\n`);
  await until(() => { assert.equal(held.ended, false, held.stderr); return held.stdout.includes('BOOKWORM_READY'); }, 'Proposal holder not ready');
  const name = `proposal_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name);
  contender.child.stdin.end(accept(mode === 'replay' ? first : second));
  await until(async () => {
    assert.equal(contender.ended, false, `Proposal contender did not wait: ${contender.stderr}`);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Proposal acceptance did not wait for proposal/balance lock');
  held.child.stdin.end(mode === 'rollback' ? 'rollback;\n' : 'commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const result = await contender.done;
  if (mode === 'competing') {
    assert.notEqual(result.code, 0); assert.match(result.stderr, /23514.*insufficient credits/s);
  } else {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), mode === 'replay' ? first : second);
  }
  const winner = mode === 'rollback' ? second : first;
  assert.equal(await sql(`select id from translation_projects where book_id='${book}';`), winner);
  assert.equal(await sql(`select count(*) from ai_jobs where book_id='${book}' and billing_mode='quoted';`), '2');
  assert.equal(await sql(`select count(*) from funded_usage_quotes where user_id='${f.u}';`), '2');
  assert.equal(await sql(`select count(*) from credit_ledger where user_id='${f.u}' and source='generation_reservation';`), '2');
  assert.equal(await sql(`select sum(amount) from credit_ledger where user_id='${f.u}';`), '0');
  assert.equal(await sql(`select accepted_project_id from translation_quote_proposals where user_id='${f.u}' and accepted_project_id is not null;`), winner);
  console.log(`PASS native translation proposal ${mode}`);
}
const serviceRole = "set request.jwt.claim.role='service_role';";
function firstJson(output, message) {
  const line = output.split('\n').find((entry) => entry.startsWith('{'));
  assert.ok(line, `${message}: ${output}`);
  return JSON.parse(line);
}
function quoteCatalog() {
  return `jsonb_build_object('version','native-test','approved',true,
    'effectiveAt',clock_timestamp()-interval '1 minute','expiresAt',clock_timestamp()+interval '30 minutes',
    'entries',jsonb_build_array(jsonb_build_object('id','test-model','price',jsonb_build_object('model','synthetic'))))`;
}
function quoteCount() {
  return `jsonb_build_object('inputTokens',12,'inputSha256',repeat('a',64),'model','synthetic')`;
}
function claimQuoteSql() {
  return `${serviceRole} select json_build_object('id',id,'leaseToken',lease_token,'chapters',chapters_json,'counts',counts_json)::text
    from claim_translation_quote_request();`;
}
async function quoteRequestFixture() {
  const f = await fixture({ meter: 'translation_credits', first: 'translator', second: 'translator' });
  const [book, chapter, document] = Array.from({ length: 3 }, () => randomUUID());
  await sql(`insert into books(id,workspace_id,title,author_name,language,created_by)
      values('${book}','${f.ws}','Concurrent quote preparation','Author','en','${f.u}');
    insert into chapters(id,book_id,order_index,title) values('${chapter}','${book}',0,'Chapter');
    insert into document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
      values('${document}','${chapter}',1,'{}','Source',1,'${f.u}');
    update chapters set current_document_version_id='${document}' where id='${chapter}';`);
  const request = await sql(`${serviceRole} select (request_translation_quote('${book}','${f.u}','es','test-model',${quoteCatalog()},'${randomUUID()}')).id;`);
  return { ...f, book, chapter, document, request };
}
async function claimQuoteRequest() {
  const row = await sql(claimQuoteSql());
  assert.notEqual(row, '', 'Expected a queued quote preparation request');
  return JSON.parse(row);
}
function recordQuoteSql(request, leaseToken, jobId) {
  return `${serviceRole} select record_translation_quote_count('${request}','${leaseToken}','${jobId}',${quoteCount()});`;
}
function proposalChaptersSql(request, f) {
  return `(select jsonb_agg(c||jsonb_build_object('quote',jsonb_build_object(
    'scope',jsonb_build_object('jobId',c->>'jobId','userId','${f.u}','workspaceId','${f.ws}','inputSha256',repeat('a',64)),
    'reservedCredits','2','expiresAt',clock_timestamp()+interval '10 minutes')) order by ord)
    from jsonb_array_elements((select chapters_json from translation_quote_requests where id='${request}'))
      with ordinality as entries(c,ord))`;
}
function completeQuoteSql(request, leaseToken, f) {
  return `${serviceRole} select complete_translation_quote_request('${request}','${leaseToken}',${proposalChaptersSql(request, f)});`;
}
async function quotePreparationClaimRace() {
  const f = await quoteRequestFixture();
  const held = session();
  held.child.stdin.write(`begin; ${claimQuoteSql()} select 'BOOKWORM_READY';\n`);
  await until(() => {
    assert.equal(held.ended, false, held.stderr);
    return held.stdout.includes('BOOKWORM_READY');
  }, 'Quote claim holder did not become ready');
  const claimed = firstJson(held.stdout, 'Quote claim holder did not return a lease');
  assert.equal(claimed.id, f.request);
  assert.ok(claimed.leaseToken);
  const name = `quote_claim_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name); contender.child.stdin.end(claimQuoteSql());
  // The claim uses FOR UPDATE SKIP LOCKED: a second worker must return promptly,
  // rather than block and accidentally receive the same request after commit.
  await until(() => contender.ended, `Quote claim contender did not skip the locked request: ${contender.stderr}`);
  const result = await contender.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
  held.child.stdin.end('commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  assert.equal(await sql(`select status from translation_quote_requests where id='${f.request}';`), 'running');
  assert.equal(await sql(`select count(*) from translation_quote_requests where id='${f.request}' and lease_token is not null;`), '1');
  console.log('PASS native quote preparation claim skip locked');
}
async function quoteCountRecoveryRace() {
  const f = await quoteRequestFixture();
  const claimed = await claimQuoteRequest();
  const jobId = claimed.chapters[0].jobId;
  const held = session();
  held.child.stdin.write(`begin; ${recordQuoteSql(f.request, claimed.leaseToken, jobId)} select 'BOOKWORM_READY';\n`);
  await until(() => {
    assert.equal(held.ended, false, held.stderr);
    return held.stdout.includes('BOOKWORM_READY');
  }, 'Quote count holder did not become ready');
  const duplicateName = `quote_count_${randomUUID().replaceAll('-', '')}`;
  const duplicate = session(database, duplicateName); duplicate.child.stdin.end(recordQuoteSql(f.request, claimed.leaseToken, jobId));
  await until(async () => {
    assert.equal(duplicate.ended, false, duplicate.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${duplicateName}' and wait_event_type='Lock';`) === '1';
  }, 'Duplicate quote count did not wait for the request lock');
  const failureName = `quote_fail_${randomUUID().replaceAll('-', '')}`;
  const failure = session(database, failureName);
  failure.child.stdin.end(`${serviceRole} select fail_translation_quote_request('${f.request}','${claimed.leaseToken}');`);
  await until(async () => {
    assert.equal(failure.ended, false, failure.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${failureName}' and wait_event_type='Lock';`) === '1';
  }, 'Competing quote failure did not wait for the request lock');
  held.child.stdin.end('commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const duplicateResult = await duplicate.done;
  assert.notEqual(duplicateResult.code, 0);
  assert.match(duplicateResult.stderr, /40001.*quote lease lost/s);
  const failureResult = await failure.done;
  assert.equal(failureResult.code, 0, failureResult.stderr);
  assert.equal(failureResult.stdout.trim(), 'f');
  assert.equal(await sql(`select status from translation_quote_requests where id='${f.request}';`), 'queued');
  assert.equal(await sql(`select counts_json->'${jobId}'->>'inputTokens' from translation_quote_requests where id='${f.request}';`), '12');
  assert.equal(await sql(`select count(*) from translation_quote_requests r cross join lateral jsonb_object_keys(r.counts_json) where r.id='${f.request}';`), '1');
  const resumed = await claimQuoteRequest();
  assert.equal(resumed.id, f.request);
  assert.equal(resumed.counts[jobId].inputTokens, 12);
  console.log('PASS native quote count persisted through competing recovery');
}
async function quoteCompletionRace() {
  const f = await quoteRequestFixture();
  let claimed = await claimQuoteRequest();
  const jobId = claimed.chapters[0].jobId;
  await sql(recordQuoteSql(f.request, claimed.leaseToken, jobId));
  claimed = await claimQuoteRequest();
  const complete = completeQuoteSql(f.request, claimed.leaseToken, f);
  const held = session();
  held.child.stdin.write(`begin; ${complete} select 'BOOKWORM_READY';\n`);
  await until(() => {
    assert.equal(held.ended, false, held.stderr);
    return held.stdout.includes('BOOKWORM_READY');
  }, 'Quote completion holder did not become ready');
  const name = `quote_complete_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name); contender.child.stdin.end(complete);
  await until(async () => {
    assert.equal(contender.ended, false, contender.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Quote completion contender did not wait for the request lock');
  held.child.stdin.end('commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const result = await contender.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), f.request);
  assert.equal(await sql(`select status from translation_quote_requests where id='${f.request}';`), 'ready');
  assert.equal(await sql(`select count(*) from translation_quote_proposals where id='${f.request}';`), '1');
  assert.equal(await sql(`select count(*) from ai_jobs where book_id='${f.book}';`), '0');
  assert.equal(await sql(`select count(*) from credit_ledger where user_id='${f.u}';`), '0');
  console.log('PASS native quote completion replay');
}
function fundedQuoteSql(f, job) {
  return `jsonb_build_object('scope',jsonb_build_object('jobId','${job}','workspaceId','${f.ws}','userId','${f.u}','inputSha256',repeat('c',64)),
    'reservedCredits','2','fingerprint',repeat('b',64),'policy',jsonb_build_object('approved',true,'version','test'),
    'price',jsonb_build_object('version','test','provider','openai','model','synthetic'),
    'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '10 minutes')`;
}
async function quotedCancellationFixture() {
  const f = await fixture({ meter: 'translation_credits', first: 'translator', second: 'translator' });
  const [book, chapter, document, project, job] = Array.from({ length: 5 }, () => randomUUID());
  await sql(`insert into books(id,workspace_id,title,author_name,language,created_by)
      values('${book}','${f.ws}','Concurrent cancellation','Author','en','${f.u}');
    insert into chapters(id,book_id,order_index,title) values('${chapter}','${book}',0,'Chapter');
    insert into document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
      values('${document}','${chapter}',1,'{}','Source',1,'${f.u}');
    insert into translation_projects(id,workspace_id,book_id,source_language,target_language,chapter_count,credit_units,idempotency_key,created_by)
      values('${project}','${f.ws}','${book}','en','es',1,1,'${randomUUID()}','${f.u}');
    insert into ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,input_ref,idempotency_key,created_by)
      values('${job}','${f.ws}','${book}','translator','quoted',jsonb_build_object('translationProjectId','${project}','creditUnits',1),'${randomUUID()}','${f.u}');
    insert into translation_chapters(project_id,ai_job_id,chapter_id,document_version_id,chapter_order,source_sha256,credit_units)
      values('${project}','${job}','${chapter}','${document}',0,repeat('c',64),1);
    insert into credit_ledger(user_id,source,amount,balance_after) values('${f.u}','purchase',2,2);
    -- Earlier proposal-race fixtures leave valid quoted work in this shared
    -- disposable database. Make this fixture the deterministic next claim
    -- without changing the production worker's global queue semantics.
    update ai_jobs set available_at=clock_timestamp()-interval '1 day' where id='${job}';`);
  await sql(`${serviceRole} select reserve_funded_usage_quote(${fundedQuoteSql(f, job)});`);
  const claimedText = await sql(`${serviceRole} select json_build_object('id',id,'leaseToken',lease_token)::text from claim_quoted_translation_job(60);`);
  const claimed = JSON.parse(claimedText);
  assert.equal(claimed.id, job);
  assert.ok(claimed.leaseToken);
  return { ...f, book, project, job, leaseToken: claimed.leaseToken };
}
async function cancellationDispatchRace() {
  const f = await quotedCancellationFixture();
  const dispatch = `${serviceRole} select claim_funded_dispatch('${f.job}','${f.leaseToken}',repeat('c',64),'synthetic');`;
  const held = session();
  held.child.stdin.write(`begin; ${dispatch} select 'BOOKWORM_READY';\n`);
  await until(() => {
    assert.equal(held.ended, false, held.stderr);
    return held.stdout.includes('BOOKWORM_READY');
  }, 'Dispatch holder did not become ready');
  const name = `quote_cancel_${randomUUID().replaceAll('-', '')}`;
  const cancellation = session(database, name);
  cancellation.child.stdin.end(`${serviceRole} select cancel_quoted_translation('${f.project}','${f.u}');`);
  // Cancellation locks every job with NOWAIT. It must fail before it releases
  // any credit while a worker still holds a pre-dispatch transaction.
  await until(() => cancellation.ended, `Cancellation did not return after NOWAIT worker conflict: ${cancellation.stderr}`);
  const blocked = await cancellation.done;
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /55P03.*could not obtain lock/s);
  assert.equal(await sql(`select status from translation_projects where id='${f.project}';`), 'running');
  assert.equal(await sql(`select status from ai_jobs where id='${f.job}';`), 'running');
  assert.equal(await sql(`select status from funded_usage_quotes where job_id='${f.job}';`), 'held');
  assert.equal(await sql(`select count(*) from credit_ledger where reference_id='${f.job}' and source='generation_release';`), '0');
  held.child.stdin.end('rollback;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const cancelledText = await sql(`${serviceRole} select cancel_quoted_translation('${f.project}','${f.u}')::text;`);
  const cancelled = JSON.parse(cancelledText);
  assert.equal(cancelled.releasedCredits, '2');
  assert.equal(cancelled.cancelledChapters, 1);
  const replay = JSON.parse(await sql(`${serviceRole} select cancel_quoted_translation('${f.project}','${f.u}')::text;`));
  assert.deepEqual(replay, cancelled);
  assert.equal(await sql(`select status from translation_projects where id='${f.project}';`), 'cancelled');
  assert.equal(await sql(`select status from ai_jobs where id='${f.job}';`), 'cancelled');
  assert.equal(await sql(`select status from funded_usage_quotes where job_id='${f.job}';`), 'cancelled');
  assert.equal(await sql(`select count(*) from credit_ledger where reference_id='${f.job}' and source='generation_release';`), '1');
  assert.equal(await sql(`select sum(amount) from credit_ledger where user_id='${f.u}';`), '2');
  console.log('PASS native quoted cancellation dispatch conflict and recovery');
}

async function storyBlueprintMaterializationRace() {
  const f = await fixture({ meter: 'ai_credits', first: 'writer', second: 'writer' });
  const [book, planChapter] = [randomUUID(), randomUUID()];
  await sql(`insert into books(id,workspace_id,title,author_name,language,created_by)
    values('${book}','${f.ws}','Concurrent blueprint','Author','en','${f.u}');`);
  const details = `jsonb_build_object('workingTitle','Concurrent blueprint','premise','','readerPromise','','genre','','tone','','pointOfView','','tense','','targetWordCount',null,'synopsis','','theme','','notes','')`;
  const plan = `jsonb_build_array(jsonb_build_object('id','${planChapter}','title','First chapter','purpose','','summary','','targetWords',1200))`;
  const auth = `set local role authenticated; set local request.jwt.claims='{"sub":"${f.u}"}';`;
  await sql(`begin; ${auth} select id from save_story_blueprint('${book}',0,${details},${plan}); commit;`);
  const materialize = (key) => `${auth} select id from materialize_story_blueprint_chapter('${book}','${planChapter}',1,'${key}');`;
  const held = session();
  held.child.stdin.write(`begin; ${materialize('blueprint-race-one')} select 'BOOKWORM_READY';\n`);
  await until(() => {
    assert.equal(held.ended, false, held.stderr);
    return held.stdout.includes('BOOKWORM_READY');
  }, 'Blueprint materialization holder not ready');
  const firstId = held.stdout.split('\n').find((line) => /^[0-9a-f-]{36}$/.test(line));
  assert.ok(firstId, `Blueprint holder returned no chapter: ${held.stdout}`);
  const name = `blueprint_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name);
  contender.child.stdin.end(`begin; ${materialize('blueprint-race-two')} commit;`);
  await until(async () => {
    assert.equal(contender.ended, false, contender.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Competing blueprint materialization did not wait for the book lock');
  held.child.stdin.end('commit;\n');
  assert.equal((await held.done).code, 0, held.stderr);
  const second = await contender.done;
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim(), firstId);
  assert.equal(await sql(`select count(*) from chapters where book_id='${book}';`), '1');
  assert.equal(await sql(`select count(*) from document_versions d join chapters c on c.id=d.chapter_id where c.book_id='${book}';`), '1');
  assert.equal(await sql(`select count(*) from story_blueprint_materializations m join story_blueprints b on b.id=m.blueprint_id where b.book_id='${book}';`), '1');
  assert.equal(await sql(`select count(*) from ai_jobs where book_id='${book}';`), '0');
  console.log('PASS native concurrent story blueprint materialization replay');
}

const audioOwner = `set role authenticated;
  set request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';`;
const audioService = `set request.jwt.claim.role='service_role';`;
const queueAudio = (key) => `${audioOwner} select id from public.queue_audiobook_google_play_export(
  'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','${key}');`;
const claimAudio = `${audioService} select row_to_json(j) from public.claim_audiobook_google_play_export(300) j;`;

async function audioExportRaces() {
  // Retain the fully asserted synthetic audiobook fixture ONLY in this runner's
  // fresh disposable database, so races use real source/QC/sign-off prerequisites.
  const source = await readFile(join(root, 'tests/security/audiobook-workflow.test.sql'), 'utf8');
  assert.match(source, /rollback;\s*$/);
  await sql(source.replace(/rollback;\s*$/, 'commit;'));

  const key = `native-export-${randomUUID()}`;
  const held = session();
  held.child.stdin.write(`begin; ${queueAudio(key)} select 'BOOKWORM_READY';\n`);
  await until(() => { assert.equal(held.ended, false, held.stderr); return held.stdout.includes('BOOKWORM_READY'); }, 'Audio queue holder not ready');
  const name = `audio_queue_${randomUUID().replaceAll('-', '')}`;
  const contender = session(database, name); contender.child.stdin.end(queueAudio(key));
  await until(async () => {
    assert.equal(contender.ended, false, contender.stderr);
    return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
  }, 'Audio replay did not wait for request lock');
  const queuedId = held.stdout.trim().split('\n')[0];
  held.child.stdin.end('commit;\n'); assert.equal((await held.done).code, 0, held.stderr);
  const replay = await contender.done; assert.equal(replay.code, 0, replay.stderr);
  assert.equal(replay.stdout.trim(), queuedId);
  assert.equal(await sql(`select count(*) from audiobook_google_play_export_jobs where idempotency_key='${key}';`), '1');
  console.log('PASS native audiobook export simultaneous queue replay');

  // While the first worker holds a claim open, the next must claim the second
  // job without waiting for or stealing the first lease.
  const secondId = await sql(queueAudio(`native-export-${randomUUID()}`));
  const firstWorker = session();
  firstWorker.child.stdin.write(`begin; ${claimAudio} select 'BOOKWORM_READY';\n`);
  await until(() => { assert.equal(firstWorker.ended, false, firstWorker.stderr); return firstWorker.stdout.includes('BOOKWORM_READY'); }, 'Audio worker not ready');
  const first = JSON.parse(firstWorker.stdout.trim().split('\n')[0]);
  const second = JSON.parse(await sql(claimAudio));
  assert.notEqual(first.id, second.id);
  assert.deepEqual(new Set([first.id, second.id]), new Set([queuedId, secondId]));
  firstWorker.child.stdin.end('commit;\n'); assert.equal((await firstWorker.done).code, 0, firstWorker.stderr);
  for (const job of [first, second]) await sql(`${audioService} select public.fail_audiobook_google_play_export('${job.id}','${job.lease_token}','fixture_done',false);`);
  console.log('PASS native audiobook export worker claim skip locked');

  for (const mode of ['cancel-first', 'complete-first', 'failure-first']) {
    const id = await sql(queueAudio(`native-export-${randomUUID()}`));
    const job = JSON.parse(await sql(claimAudio)); assert.equal(job.id, id);
    await sql(`${audioService} select public.progress_audiobook_google_play_export('${id}','${job.lease_token}',1);`);
    const cancel = `${audioOwner} select status from public.cancel_audiobook_google_play_export('${id}');`;
    const complete = `${audioService} select status from public.complete_audiobook_google_play_export(
      '${id}','${job.lease_token}','workspaces/${job.workspace_id}/audiobook-exports/${id}/${job.lease_token}.zip',1024,repeat('f',64),300);`;
    const fail = `${audioService} select status from public.fail_audiobook_google_play_export('${id}','${job.lease_token}','fixture_done',false);`;
    const holder = session();
    holder.child.stdin.write(`begin; ${mode === 'cancel-first' ? cancel : mode === 'complete-first' ? complete : fail} select 'BOOKWORM_READY';\n`);
    await until(() => { assert.equal(holder.ended, false, holder.stderr); return holder.stdout.includes('BOOKWORM_READY'); }, `Audio ${mode} holder not ready`);
    const raceName = `audio_finish_${randomUUID().replaceAll('-', '')}`;
    const waiting = session(database, raceName); waiting.child.stdin.end(mode === 'complete-first' ? cancel : complete);
    await until(async () => {
      assert.equal(waiting.ended, false, waiting.stderr);
      return await sql(`select count(*) from pg_stat_activity where application_name='${raceName}' and wait_event_type='Lock';`) === '1';
    }, `Audio ${mode} contender did not wait`);
    holder.child.stdin.end('commit;\n'); assert.equal((await holder.done).code, 0, holder.stderr);
    const result = await waiting.done;
    if (mode === 'complete-first') {
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), 'succeeded');
      assert.equal(await sql(`select count(*) from audiobook_google_play_export_jobs where id='${id}' and output_storage_path is not null and cancellation_requested_at is null;`), '1');
    } else {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, mode === 'cancel-first' ? /57014.*export cancelled/s : /40001.*worker lease lost/s);
      assert.equal(await sql(`select count(*) from audiobook_google_play_export_jobs where id='${id}' and output_storage_path is null;`), '1');
      if (mode === 'cancel-first') assert.equal(await sql(fail), 'cancelled');
    }
    console.log(`PASS native audiobook export ${mode} completion race`);
  }
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
  for (const mode of ['replay', 'competing', 'rollback']) await proposalAcceptanceRace(mode);
  await quotePreparationClaimRace();
  await quoteCountRecoveryRace();
  await quoteCompletionRace();
  await cancellationDispatchRace();
  await storyBlueprintMaterializationRace();
  await audioExportRaces();
} finally {
  for (const child of children) child.kill();
  if (created) await sql(`drop database ${database} with (force);`, 'postgres');
}
