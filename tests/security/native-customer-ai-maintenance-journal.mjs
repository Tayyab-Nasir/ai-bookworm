/** Real PostgreSQL transactions for the private maintenance journal. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function customerAiMaintenanceJournalRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';
 assert.equal(source.split(marker).length,2,'Review native fixture boundary');
 const seed=source.slice(0,source.indexOf(marker));
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 async function fixture(withReceipt=true) {
  const f=parse(await sql(`${seed}
   create temp table native_journal_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
   ${withReceipt ? `insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
    select j.id,repeat('b',64),pg_temp.customer_receipt(j) from public.ai_jobs j join native_journal_job n on n.id=j.id;` : ''}
   select jsonb_build_object('job',j.id,'owner',j.created_by,'lease',j.lease_token,'receipt',pg_temp.customer_receipt(j))
    from public.ai_jobs j join native_journal_job n on n.id=j.id; commit;`));
  assert(f?.job && f.owner && f.lease && f.receipt);
  const receipt=JSON.stringify(f.receipt).replaceAll("'","''");
  return {...f,
   begin:(attempt,action='recover_receipt')=>`${auth} select public.begin_customer_ai_maintenance('${attempt}','${f.job}','${action}');`,
   execute:attempt=>`${auth} select public.execute_customer_ai_maintenance('${attempt}');`,
   hold:`${auth} select to_jsonb(public.hold_customer_ai_job('${f.job}','${f.lease}'));`,
   complete:`${auth} select to_jsonb(public.complete_customer_ai_job('${f.job}','${f.owner}',repeat('b',64)));`,
   insert:`insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values('${f.job}',repeat('b',64),'${receipt}'::jsonb);`};
 }
 async function contend(first,second,rollback=false) {
  const holder=session(database,`journal_holder_${randomUUID().replaceAll('-','')}`);
  holder.child.stdin.write(`begin; ${first} select 'CUSTOMER_JOURNAL_READY';\n`);
  await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('CUSTOMER_JOURNAL_READY')},'Journal holder not ready');
  const name=`journal_wait_${randomUUID().replaceAll('-','')}`,waiter=session(database,name);
  waiter.child.stdin.end(`begin; ${second} commit;`);
  await until(async()=>{assert.equal(waiter.ended,false,waiter.stderr);return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`)==='1'},'Expected real journal lock wait');
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
  const f=await fixture(),id=randomUUID(),b=await contend(f.begin(id),f.begin(id),rollback);
  assert.equal(b.code,0,b.stderr);assert.equal(parse(b.stdout)?.state,'pending');
  const result=parse(await sql(`begin; ${f.execute(id)} commit;`));assert.equal(result?.result,'settled');await verify(f);
  console.log(`PASS native customer journal: begin ${rollback?'rollback takeover':'commit replay'}`);
 }
 for(const rollback of [false,true]) {
  const f=await fixture(),id=randomUUID();await sql(`begin; ${f.begin(id)} commit;`);
  const b=await contend(f.execute(id),f.execute(id),rollback);
  assert.equal(b.code,0,b.stderr);assert.equal(parse(b.stdout)?.result,'settled');
  assert.equal(parse(await sql(`begin; ${f.execute(id)} commit;`))?.result,'settled');await verify(f);
  console.log(`PASS native customer journal: execute ${rollback?'rollback takeover':'commit replay'}`);
 }
 {
  const f=await fixture(),other=await fixture(),id=randomUUID();await sql(`begin; ${f.begin(id)} commit;`);
  for(const statement of [f.begin(id,'reconcile'),other.begin(id),f.begin(randomUUID())]) {
   const s=session(database,`journal_conflict_${randomUUID().replaceAll('-','')}`);s.child.stdin.end(`begin; ${statement} commit;`);
   const result=await s.done;assert.notEqual(result.code,0);assert.match(result.stderr,/40001/);
  }
  assert.equal(parse(await sql(`begin; ${f.execute(id)} commit;`))?.result,'settled');await verify(f);
  console.log('PASS native customer journal: identity/action and pending conflicts fail closed');
 }
 for(const first of ['hold','complete']) for(const rollback of [false,true]) {
  const f=await fixture(),id=randomUUID();await sql(`begin; ${f.begin(id)} commit;`);
  const b=await contend(f[first],f.execute(id),rollback);
  assert.equal(b.code,0,b.stderr);assert.equal(parse(b.stdout)?.result,'settled');await verify(f);
  console.log(`PASS native customer journal: ${first} ${rollback?'rollback':'commit'} before recovery`);
 }
 for(const rollback of [false,true]) {
  const f=await fixture(false),id=randomUUID();await sql(`begin; ${f.begin(id)} commit;`);
  // The receipt FK holds a key-share lock; execute must wait before checking it.
  const b=await contend(f.insert,f.execute(id),rollback);assert.equal(b.code,0,b.stderr);
  const first=parse(b.stdout);assert.equal(first?.state,rollback?'needs_review':'completed');
  if(rollback) {
   await sql(f.insert);
   const next=randomUUID();await sql(`begin; ${f.begin(next)} commit;`);
   assert.equal(parse(await sql(`begin; ${f.execute(next)} commit;`))?.result,'settled');
  } else assert.equal(first?.result,'settled');
  await verify(f);
  console.log(`PASS native customer journal: late receipt ${rollback?'rollback then insert':'commit'} and fresh intent`);
 }
}
