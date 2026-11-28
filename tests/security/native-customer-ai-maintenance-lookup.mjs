/** Concurrent attempt-id binding across owners/jobs in disposable PostgreSQL. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export async function customerAiMaintenanceLookupRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';assert.equal(source.split(marker).length,2);
 const seed=source.slice(0,source.indexOf(marker));
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 async function fixture() {
  const f=parse(await sql(`${seed}
   create temp table native_lookup_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
   select jsonb_build_object('job',j.id,'owner',j.created_by) from public.ai_jobs j join native_lookup_job n on n.id=j.id;
   commit;`));
  assert(f?.job && f.owner);return f;
 }
 for(const rollback of [false,true]) {
  const a=await fixture(),b=await fixture(),id=randomUUID();assert.notEqual(a.job,b.job);assert.notEqual(a.owner,b.owner);
  const holder=session(database,`lookup_holder_${randomUUID().replaceAll('-','')}`);
  holder.child.stdin.write(`begin; ${auth} select public.begin_customer_ai_maintenance('${id}','${a.job}','reconcile'); select 'LOOKUP_READY';\n`);
  await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('LOOKUP_READY')},'Cross-job holder not ready');
  const name=`lookup_wait_${randomUUID().replaceAll('-','')}`,waiter=session(database,name);
  waiter.child.stdin.end(`begin; ${auth} select public.begin_customer_ai_maintenance('${id}','${b.job}','recover_receipt'); commit;`);
  await until(async()=>{assert.equal(waiter.ended,false,waiter.stderr);return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`)==='1'},'Expected concurrent same-id conflict');
  holder.child.stdin.end(rollback?'rollback;':'commit;');const first=await holder.done,second=await waiter.done;
  assert.equal(first.code,0,first.stderr);
  if(rollback) {assert.equal(second.code,0,second.stderr);assert.equal(parse(second.stdout)?.jobId,b.job);}
  else {assert.notEqual(second.code,0);assert.match(second.stderr,/40001[\s\S]*maintenance identity changed/);}
  const expectedJob=rollback?b.job:a.job,expectedAction=rollback?'recover_receipt':'reconcile';
  const read=parse(await sql(`begin; ${auth} select public.read_customer_ai_maintenance('${id}'); commit;`));
  assert.deepEqual(read,{attemptId:id,jobId:expectedJob,action:expectedAction,state:'pending',result:null});
  console.log(`PASS native customer maintenance lookup: cross-job same ID ${rollback?'rollback takeover':'commit conflict'}`);
 }
}
