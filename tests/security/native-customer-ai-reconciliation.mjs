/** Native two-session proofs; run only in the disposable PostgreSQL harness. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export async function customerAiReconciliationRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';
 assert.equal(source.split(marker).length,2,'Review synthetic fixture boundary');
 const seed=source.slice(0,source.indexOf(marker));
 const dispatch=" perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));";
 assert.equal(seed.split(dispatch).length,2,'Review synthetic dispatch boundary');
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 const json=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
 async function fixture({dispatched=false,receipt=false,expire=false,exhaust=false}={}) {
  const script=dispatched?seed:seed.replace(dispatch,'');
  const f=parse(await sql(`${script}
   create temp table native_reconcile_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
   ${receipt?`insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
     select j.id,repeat('b',64),pg_temp.customer_receipt(j) from public.ai_jobs j join native_reconcile_job n on n.id=j.id;`:''}
   update public.ai_jobs set ${expire?"lease_expires_at=clock_timestamp()-interval '1 second'":"lease_expires_at=lease_expires_at"},
     ${exhaust?'attempts=5':'attempts=attempts'} where id=(select id from native_reconcile_job);
   select jsonb_build_object('job',j.id,'owner',j.created_by,'lease',j.lease_token,'receipt',pg_temp.customer_receipt(j))
     from public.ai_jobs j join native_reconcile_job n on n.id=j.id;
   commit;`));
  assert(f?.job && f.owner && f.lease && f.receipt);
  f.reconcile=`${auth} select jsonb_build_object('result',public.reconcile_customer_ai_job('${f.job}'));`;
  f.claim=`${auth} select to_jsonb(public.claim_customer_ai_job('${f.job}',180));`;
  f.resolve=`${auth} select jsonb_build_object('resolved',true) from public.resolve_customer_ai_dispatch('${f.job}','${f.lease}',repeat('b',64));`;
  f.complete=`${auth} select to_jsonb(public.complete_customer_ai_job('${f.job}','${f.owner}',repeat('b',64)));`;
  f.insertAndComplete=`${auth} insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
    values('${f.job}',repeat('b',64),${json(f.receipt)}); ${f.complete}`;
  return f;
 }
 async function contend(first,second,rollback=false) {
  const holder=session(database,`reconcile_holder_${randomUUID().replaceAll('-','')}`);
  holder.child.stdin.write(`begin; ${first} select 'RECONCILE_READY';\n`);
  await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('RECONCILE_READY')},'Reconcile holder not ready');
  const name=`reconcile_wait_${randomUUID().replaceAll('-','')}`,waiter=session(database,name);
  waiter.child.stdin.end(`begin; ${second} commit;`);
  await until(async()=>{assert.equal(waiter.ended,false,waiter.stderr);return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`)==='1'},'Expected real reconciliation lock wait');
  holder.child.stdin.end(rollback?'rollback;\n':'commit;\n');
  const a=await holder.done,b=await waiter.done;assert.equal(a.code,0,a.stderr);return b;
 }
 async function state(f) {
  return parse(await sql(`select jsonb_build_object('status',j.status,'authority',a.state,'dispatched',a.dispatched_at is not null,
   'runs',(select count(*) from public.ai_runs where ai_job_id=j.id),
   'events',(select count(*) from public.usage_events where ai_job_id=j.id),
   'reservations',(select count(*) from public.credit_ledger where reference_id=j.id and source='generation_reservation'),
   'releases',(select count(*) from public.credit_ledger where reference_id=j.id and source='generation_release'))
   from public.ai_jobs j join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id where j.id='${f.job}';`));
 }
 // A dispatch taking the owner lock first prevents reconciliation from releasing.
 for(const rollback of [false,true]) {
  const f=await fixture(),r=await contend(f.resolve,f.reconcile,rollback);
  assert.equal(r.code,0,r.stderr);assert.equal(parse(r.stdout).result,'unchanged');
  const s=await state(f);assert.equal(s.dispatched,!rollback);assert.equal(s.releases,0);
 }
 // Active reclaim takes the lock first; the subsequent reconciliation must not
 // cancel its new lease even though the old lease was already expired.
 {
  const f=await fixture({expire:true}),r=await contend(f.claim,f.reconcile);
  assert.equal(r.code,0,r.stderr);assert.equal(parse(r.stdout).result,'unchanged');
  const s=await state(f);assert.equal(s.authority,'held');assert.equal(s.releases,0);
 }
 // A safe undispatched release blocks a stale resolver, and replay releases once.
 {
  const f=await fixture({expire:true,exhaust:true}),r=await contend(f.reconcile,f.resolve);
  assert.notEqual(r.code,0);assert.match(r.stderr,/40001/);
  const s=await state(f);assert.equal(s.authority,'released');assert.equal(s.dispatched,false);assert.equal(s.releases,1);
  const replay=parse(await sql(`begin; ${f.reconcile} commit;`));assert.equal(replay.result,'released');
  assert.equal((await state(f)).releases,1);
 }
 // Receipt completion and post-expiry hold serialize in both orders. A late
 // receipt can settle a review job without another provider call or refund.
 for(const order of ['complete-first','reconcile-first']) {
  const f=await fixture({dispatched:true,receipt:order==='complete-first',expire:true});
  const r=await contend(order==='complete-first'?f.complete:f.reconcile,
    order==='complete-first'?f.reconcile:f.insertAndComplete);
  assert.equal(r.code,0,r.stderr);
  const s=await state(f);assert.equal(s.authority,'settled');assert.equal(s.status,'succeeded');
  assert.equal(s.dispatched,true);assert.equal(s.releases,0);assert.equal(s.reservations,1);assert.equal(s.runs,1);assert.equal(s.events,1);
 }
 console.log('PASS native customer reconciliation: dispatch, active claim, release replay, completion and late receipt races');
}
