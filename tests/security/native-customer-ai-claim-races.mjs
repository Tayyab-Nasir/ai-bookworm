// Synthetic PostgreSQL only. Per-job fencing proof, not a worker-owner protocol.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function customerAiClaimRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';
 assert.equal(source.split(marker).length,2,'Review synthetic fixture boundary');
 let seed=source.slice(0,source.indexOf(marker));
 const claim=' select * into j from public.claim_customer_ai_job(j.id,180);';
 const dispatch=" perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));";
 assert.equal(seed.split(claim).length,2,'Review fixture claim boundary');
 assert.equal(seed.split(dispatch).length,2,'Review fixture dispatch boundary');
 seed=seed.replace(claim,'').replace(dispatch,'');
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split(/\r?\n/).find(line=>line.startsWith('{'))??'null');
 const capture=`select jsonb_build_object('job',j.id,'lease',j.lease_token,'status',j.status,'dispatched',a.dispatched_at is not null,'attempts',j.attempts,
  'reservations',(select count(*) from public.credit_ledger where reference_id=j.id and source='generation_reservation'),
  'releases',(select count(*) from public.credit_ledger where reference_id=j.id and source='generation_release'))
  from public.ai_jobs j join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id`;
 async function fixture() {
  const f=parse(await sql(`${seed}
    create temp table native_claim_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
    select jsonb_build_object('job',j.id) from public.ai_jobs j join native_claim_job n on n.id=j.id; commit;`));
  assert(f?.job); return f.job;
 }
 async function state(job) {return parse(await sql(`${capture} where j.id='${job}';`));}
 const claimSql=job=>`${auth} select to_jsonb(public.claim_customer_ai_job('${job}',180));`;
 const resolveSql=(job,lease)=>`${auth} select jsonb_build_object('dispatch',true) from public.resolve_customer_ai_dispatch('${job}','${lease}',repeat('b',64));`;
 async function contend(first,second,rollback=false) {
  const holder=session(database,`claim_holder_${randomUUID().replaceAll('-','')}`);
  let waiter;
  try {
   holder.child.stdin.write(`begin; ${first} select 'CLAIM_READY';\n`);
   await until(()=>{assert.equal(holder.ended,false,holder.stderr);return holder.stdout.includes('CLAIM_READY')},'First transaction was not ready');
   const name=`claim_wait_${randomUUID().replaceAll('-','')}`; waiter=session(database,name);
   waiter.child.stdin.end(`begin; ${second} commit;\n`);
   await until(async()=>Number(await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`))===1,'Second transaction did not wait');
   holder.child.stdin.end(rollback?'rollback;\n':'commit;\n');
   const a=await holder.done,b=await waiter.done;assert.equal(a.code,0,a.stderr);return {a,b};
  } finally {if(!holder.ended)holder.child.kill();if(waiter&&!waiter.ended)waiter.child.kill();}
 }
 for(const rollback of [false,true]) {
  const job=await fixture(),result=await contend(claimSql(job),claimSql(job),rollback);
  if(rollback) assert.equal(result.b.code,0,result.b.stderr); else {assert.notEqual(result.b.code,0);assert.match(result.b.stderr,/40001/)}
  const after=await state(job);assert.equal(after.status,'running');assert.equal(after.attempts,1);assert.equal(after.dispatched,false);assert.equal(after.reservations,1);assert.equal(after.releases,0);assert(after.lease);
 }
 for(const rollback of [false,true]) {
  const job=await fixture(),firstClaim=parse(await sql(`begin; ${claimSql(job)} commit;`)); assert(firstClaim?.lease_token);
  const result=await contend(resolveSql(job,firstClaim.lease_token),resolveSql(job,firstClaim.lease_token),rollback);
  if(rollback) assert.equal(result.b.code,0,result.b.stderr); else {assert.notEqual(result.b.code,0);assert.match(result.b.stderr,/40001/)}
  const after=await state(job);assert.equal(after.dispatched,true);assert.equal(after.lease,firstClaim.lease_token);assert.equal(after.reservations,1);assert.equal(after.releases,0);
 }
 {
  const job=await fixture(),old=parse(await sql(`begin; ${claimSql(job)} commit;`));
  await sql(`update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${job}';`);
  const fresh=parse(await sql(`begin; ${claimSql(job)} commit;`));assert.notEqual(fresh.lease_token,old.lease_token);
  await assert.rejects(sql(`begin; ${resolveSql(job,old.lease_token)} commit;`),/40001/);
  await sql(`begin; ${resolveSql(job,fresh.lease_token)} commit;`);
  await sql(`update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${job}';`);
  await assert.rejects(sql(`begin; ${claimSql(job)} commit;`),/40001/);
  const after=await state(job);assert.equal(after.attempts,2);assert.equal(after.dispatched,true);assert.equal(after.reservations,1);assert.equal(after.releases,0);
 }
 console.log('PASS native per-job claim/dispatch fencing: competing sessions, rollback, lease takeover and no reclaim after dispatch. Not a cross-process owner or provider-cancellation proof.');
}
