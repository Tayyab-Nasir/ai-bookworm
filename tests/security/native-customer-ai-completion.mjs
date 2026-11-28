/** Called only by the explicitly disposable native PostgreSQL harness. No app keys. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function customerAiCompletionRaces({ sql, session, until, database }) {
  // Reuse the reviewed synthetic seeder and receipt builder, not a second fake
  // lifecycle. Only the fixture preamble is committed in the disposable DB.
  const source = await readFile(new URL('./customer-ai-completion.test.sql', import.meta.url), 'utf8');
  const marker = '\ndo $$ declare signature text;';
  assert.equal(source.split(marker).length, 2, 'Review fixture boundary before changing the native seeder');
  const seed = source.slice(0, source.indexOf(marker));
  const auth = `set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
  const parse = text => JSON.parse(text.split('\n').find(line => line.startsWith('{')) ?? 'null');
  async function fixture() {
    const result = parse(await sql(`${seed}
      create temp table native_customer_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
      insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
        select j.id,repeat('b',64),pg_temp.customer_receipt(j) from public.ai_jobs j join native_customer_job n on n.id=j.id;
      select jsonb_build_object('job',j.id,'owner',j.created_by,'lease',j.lease_token,
        'connection',a.connection_id,'revision',a.credential_revision)
        from public.ai_jobs j join native_customer_job n on n.id=j.id join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id;
      commit;`));
    assert(result?.job && result.owner && result.lease && result.connection);
    return { ...result,
      complete: `${auth} select to_jsonb(public.complete_customer_ai_job('${result.job}','${result.owner}',repeat('b',64)));`,
      hold: `${auth} select to_jsonb(public.hold_customer_ai_job('${result.job}','${result.lease}'));`,
      revoke: `${auth} select public.mutate_ai_connection('${result.owner}','openai','${result.connection}',${result.revision},'${randomUUID()}','revoke',null,null,null,null,null);`,
    };
  }
  async function contention(first, second, rollback = false) {
    const holder = session(database, `customer_complete_holder_${randomUUID().replaceAll('-', '')}`);
    holder.child.stdin.write(`begin; ${first} select 'BOOKWORM_CUSTOMER_READY';\n`);
    await until(() => {
      assert.equal(holder.ended, false, holder.stderr);
      return holder.stdout.includes('BOOKWORM_CUSTOMER_READY');
    }, 'Customer completion holder did not become ready');
    const name = `customer_complete_wait_${randomUUID().replaceAll('-', '')}`;
    const waiter = session(database, name);
    waiter.child.stdin.end(`begin; ${second} commit;`);
    await until(async () => {
      assert.equal(waiter.ended, false, waiter.stderr);
      return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`) === '1';
    }, 'Expected an actual customer completion PostgreSQL lock wait');
    holder.child.stdin.end(rollback ? 'rollback;\n' : 'commit;\n');
    const a = await holder.done, b = await waiter.done;
    assert.equal(a.code, 0, a.stderr);
    return { first: parse(a.stdout), second: b };
  }
  async function state(f) {
    const result = parse(await sql(`select jsonb_build_object('status',j.status,'authority',a.state,
      'runs',(select count(*) from public.ai_runs where ai_job_id=j.id and cost_payer='customer' and estimated_cost is null),
      'suggestions',(select count(*) from public.ai_suggestions where ai_job_id=j.id and status='pending'),
      'events',(select count(*) from public.usage_events where ai_job_id=j.id and meter='customer_ai_request'),
      'fees',(select count(*) from public.credit_ledger where reference_id=j.id),
      'debit',(select sum(amount) from public.credit_ledger where reference_id=j.id))
      from public.ai_jobs j join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id where j.id='${f.job}';`));
    assert.deepEqual(result, { status: 'succeeded', authority: 'settled', runs: 1, suggestions: 1, events: 1, fees: 1, debit: -2 });
  }
  for (const rollback of [false, true]) {
    const f = await fixture();
    const race = await contention(f.complete, f.complete, rollback);
    assert.equal(race.second.code, 0, race.second.stderr);
    const result = parse(race.second.stdout);
    assert.equal(result.status, 'succeeded');
    if (!rollback) assert.deepEqual(result, race.first, 'Concurrent replay returns the committed result unchanged');
    await state(f);
    console.log(`PASS native customer completion: simultaneous completion ${rollback ? 'rollback takeover' : 'commit replay'}`);
  }
  for (const first of ['hold', 'revoke']) {
    const f = await fixture(), race = await contention(f[first], f.complete);
    assert.equal(race.second.code, 0, race.second.stderr);
    await state(f);
    console.log(`PASS native customer completion: ${first} before receipt-only completion`);
  }
  const f = await fixture(), race = await contention(f.complete, f.hold);
  assert.notEqual(race.second.code, 0);
  assert.match(race.second.stderr, /40001[\s\S]*customer dispatch lease changed/);
  await state(f);
  console.log('PASS native customer completion: late unknown-outcome hold cannot overwrite completed receipt');
}
