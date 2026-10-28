/** DB-owned maintenance slots; real PostgreSQL transactions only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export async function customerAiMaintenanceSlotRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';assert.equal(source.split(marker).length,2);
 const seed=source.slice(0,source.indexOf(marker));
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 async function fixture(withReceipt=true) {
  const f=parse(await sql(`${seed}
   create temp table native_slot_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
   ${withReceipt ? `insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
    select j.id,repeat('b',64),pg_temp.customer_receipt(j) from public.ai_jobs j join native_slot_job n on n.id=j.id;` : ''}
   select jsonb_build_object('job',j.id,'owner',j.created_by,'lease',j.lease_token)
    from public.ai_jobs j join native_slot_job n on n.id=j.id; commit;`));
  assert(f?.job && f.owner && f.lease);
  return {...f,
   open:action=>`${auth} select public.open_customer_ai_maintenance_slot('${f.job}','${action}');`,
   execute:id=>`${auth} select public.execute_customer_ai_maintenance('${id}');`,
   ack:(action,id,version)=>`${auth} select public.ack_customer_ai_maintenance_slot('${f.job}','${action}','${id}',${version});`};
 }
 async function contend(first,second,rollback=false) {
  const holder=session(database,`slot_holder_${randomUUID().replaceAll('-','')}`);
  holder.child.stdin.write(`begin; ${first} select 'CUSTOMER_SLOT_READY';\n`);
  await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('CUSTOMER_SLOT_READY')},'Slot holder not ready');
  const name=`slot_wait_${randomUUID().replaceAll('-','')}`,waiter=session(database,name);
  waiter.child.stdin.end(`begin; ${second} commit;`);
  await until(async()=>{assert.equal(waiter.ended,false,waiter.stderr);return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`)==='1'},'Expected real slot lock wait');
  holder.child.stdin.end(rollback?'rollback;':'commit;');const a=await holder.done,b=await waiter.done;
  assert.equal(a.code,0,a.stderr);assert.equal(b.code,0,b.stderr);return {first:parse(a.stdout),second:parse(b.stdout)};
 }
 async function verifySettled(f) {
  const state=parse(await sql(`select jsonb_build_object('status',j.status,'authority',a.state,
   'runs',(select count(*) from public.ai_runs where ai_job_id=j.id),
   'events',(select count(*) from public.usage_events where ai_job_id=j.id),
   'fees',(select count(*) from public.credit_ledger where reference_id=j.id),
   'debit',(select sum(amount) from public.credit_ledger where reference_id=j.id))
   from public.ai_jobs j join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id where j.id='${f.job}';`));
  assert.deepEqual(state,{status:'succeeded',authority:'settled',runs:1,events:1,fees:1,debit:-2});
 }
 for(const rollback of [false,true]) {
  const f=await fixture(),race=await contend(f.open('recover_receipt'),f.open('recover_receipt'),rollback);
  assert.equal(race.second?.status,'open');
  if(!rollback) assert.deepEqual(race.first,race.second);
  const replay=parse(await sql(`begin; ${f.open('recover_receipt')} commit;`));assert.deepEqual(replay,race.second);
  const id=replay.attempt.attemptId,v=replay.version;
  const execute=await contend(f.execute(id),f.execute(id),rollback);
  assert.equal(execute.second?.result,'settled');
  const ack=await contend(f.ack('recover_receipt',id,v),f.ack('recover_receipt',id,v),rollback);
  assert.equal(ack.second?.status,'observed');assert.equal(ack.second?.result,'settled');
  assert.deepEqual(parse(await sql(`begin; ${f.ack('recover_receipt',id,v)} commit;`)),ack.second);
  assert.equal(await sql(`select count(*) from bookworm_credentials.customer_ai_maintenance_observations where attempt_id='${id}';`),'1');
  await verifySettled(f);
  console.log(`PASS native customer slot: open/execute/ack ${rollback?'rollback takeover':'commit replay'}`);
 }
 {
  const f=await fixture();await sql(`update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${f.job}';`);
  const v1=parse(await sql(`begin; ${f.open('reconcile')} commit;`));const id1=v1.attempt.attemptId;
  await sql(`update public.ai_jobs set lease_expires_at=clock_timestamp()+interval '1 minute' where id='${f.job}';`);
  assert.equal(parse(await sql(`begin; ${f.execute(id1)} commit;`))?.result,'unchanged');
  const oldAck=parse(await sql(`begin; ${f.ack('reconcile',id1,v1.version)} commit;`));
  await sql(`update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${f.job}';`);
  const v2=parse(await sql(`begin; ${f.open('reconcile')} commit;`));assert.equal(v2.version,v1.version+1);assert.notEqual(v2.attempt.attemptId,id1);
  assert.deepEqual(parse(await sql(`begin; ${f.ack('reconcile',id1,v1.version)} commit;`)),oldAck);
  assert.deepEqual(parse(await sql(`begin; ${f.open('reconcile')} commit;`)),v2);
  assert.equal(parse(await sql(`begin; ${f.execute(v2.attempt.attemptId)} commit;`))?.result,'requires_review');
  const denied=session(database,`slot_review_${randomUUID().replaceAll('-','')}`);
  denied.child.stdin.end(`begin; ${f.ack('reconcile',v2.attempt.attemptId,v2.version)} commit;`);
  const error=await denied.done;assert.notEqual(error.code,0);assert.match(error.stderr,/40001/);
  console.log('PASS native customer slot: stale acknowledgement cannot close rotated or review slot');
 }
 {
  const f=await fixture(false),id=randomUUID();
  await sql(`begin; ${auth} select public.begin_customer_ai_maintenance('${id}','${f.job}','recover_receipt'); commit;`);
  const opened=parse(await sql(`begin; ${f.open('recover_receipt')} commit;`));assert.equal(opened.attempt.attemptId,id);
  assert.equal(parse(await sql(`begin; ${f.execute(id)} commit;`))?.state,'needs_review');
  const denied=session(database,`slot_needs_review_${randomUUID().replaceAll('-','')}`);
  denied.child.stdin.end(`begin; ${f.ack('recover_receipt',id,opened.version)} commit;`);
  const error=await denied.done;assert.notEqual(error.code,0);assert.match(error.stderr,/40001/);
  const replay=parse(await sql(`begin; ${f.open('recover_receipt')} commit;`));assert.equal(replay.attempt.state,'needs_review');
  const ledger=parse(await sql(`select jsonb_build_object('fees',count(*),'debit',sum(amount)) from public.credit_ledger where reference_id='${f.job}';`));
  assert.deepEqual(ledger,{fees:1,debit:-2});
  console.log('PASS native customer slot: needs_review is retained without refund');
 }
}
