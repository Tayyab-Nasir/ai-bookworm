/** Real concurrent receipt-only recovery, disposable PostgreSQL only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function customerAiReceiptRecoveryRaces({ sql, session, until, database }) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';
 assert.equal(source.split(marker).length,2,'Review native fixture boundary');
 const seed=source.slice(0,source.indexOf(marker));
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 async function fixture(withReceipt=true) {
  const f=parse(await sql(`${seed}
   create temp table native_receipt_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
   ${withReceipt ? `insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
    select j.id,repeat('b',64),pg_temp.customer_receipt(j) from public.ai_jobs j join native_receipt_job n on n.id=j.id;` : ''}
   select jsonb_build_object('job',j.id,'owner',j.created_by,'lease',j.lease_token,'receipt',pg_temp.customer_receipt(j))
    from public.ai_jobs j join native_receipt_job n on n.id=j.id;
   commit;`));
  assert(f?.job && f.owner && f.lease && f.receipt);
  const raw=JSON.stringify(f.receipt).replaceAll("'","''");
  return {...f,
   recover:`${auth} select jsonb_build_object('state',public.recover_customer_ai_receipt('${f.job}'));`,
   hold:`${auth} select to_jsonb(public.hold_customer_ai_job('${f.job}','${f.lease}'));`,
   complete:`${auth} select to_jsonb(public.complete_customer_ai_job('${f.job}','${f.owner}',repeat('b',64)));`,
   insert:`insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values('${f.job}',repeat('b',64),'${raw}'::jsonb);`};
 }
 async function contend(first,second,rollback=false) {
  const holder=session(database,`recover_holder_${randomUUID().replaceAll('-','')}`);
  holder.child.stdin.write(`begin; ${first} select 'CUSTOMER_RECOVERY_READY';\n`);
  await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('CUSTOMER_RECOVERY_READY')},'Receipt recovery holder not ready');
  const name=`recover_wait_${randomUUID().replaceAll('-','')}`,waiter=session(database,name);
  waiter.child.stdin.end(`begin; ${second} commit;`);
  await until(async()=>{assert.equal(waiter.ended,false,waiter.stderr);return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`)==='1'},'Expected receipt recovery lock wait');
  holder.child.stdin.end(rollback?'rollback;':'commit;');
  const a=await holder.done,b=await waiter.done;assert.equal(a.code,0,a.stderr);return b;
 }
 async function verify(f) {
  const state=parse(await sql(`select jsonb_build_object('status',j.status,'authority',a.state,
   'runs',(select count(*) from public.ai_runs where ai_job_id=j.id),
   'suggestions',(select count(*) from public.ai_suggestions where ai_job_id=j.id),
   'events',(select count(*) from public.usage_events where ai_job_id=j.id),
   'fees',(select count(*) from public.credit_ledger where reference_id=j.id),
   'debit',(select sum(amount) from public.credit_ledger where reference_id=j.id))
   from public.ai_jobs j join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id where j.id='${f.job}';`));
  assert.deepEqual(state,{status:'succeeded',authority:'settled',runs:1,suggestions:1,events:1,fees:1,debit:-2});
  await sql(`begin; ${auth} do $$ begin
   begin perform public.claim_customer_ai_job('${f.job}',180); assert false,'settled dispatch reclaimed';
    exception when serialization_failure then null; end;
  end $$; rollback;`);
 }
 for(const rollback of [false,true]) {
  const f=await fixture(),result=await contend(f.recover,f.recover,rollback);
  assert.equal(result.code,0,result.stderr);assert.equal(parse(result.stdout)?.state,'settled');await verify(f);
  console.log(`PASS native customer receipt recovery: duplicate ${rollback?'rollback takeover':'commit replay'}`);
 }
 for(const first of ['hold','complete']) for(const rollback of [false,true]) {
  const f=await fixture(),result=await contend(f[first],f.recover,rollback);
  assert.equal(result.code,0,result.stderr);assert.equal(parse(result.stdout)?.state,'settled');await verify(f);
  console.log(`PASS native customer receipt recovery: ${first} ${rollback?'rollback':'commit'} before recovery`);
 }
 // An uncommitted late receipt is invisible, not evidence to regenerate.
 for(const rollback of [false,true]) {
  const f=await fixture(false),holder=session(database,`receipt_insert_${randomUUID().replaceAll('-','')}`);
  holder.child.stdin.write(`begin; ${f.insert} select 'RECEIPT_INSERTED';\n`);
  await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('RECEIPT_INSERTED')},'Late receipt insertion not ready');
  const missing=session(database,`receipt_absent_${randomUUID().replaceAll('-','')}`);
  missing.child.stdin.end(`begin; ${f.recover} commit;`);
  const rejected=await missing.done;assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/40001[\s\S]*completed customer receipt unavailable/);
  holder.child.stdin.end(rollback?'rollback;':'commit;');const inserted=await holder.done;assert.equal(inserted.code,0,inserted.stderr);
  if(rollback) await sql(f.insert);
  assert.equal(parse(await sql(`begin; ${f.recover} commit;`))?.state,'settled');await verify(f);
  console.log(`PASS native customer receipt recovery: late receipt ${rollback?'rollback then insert':'commit'} and explicit replay`);
 }
}
