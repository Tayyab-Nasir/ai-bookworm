/** Real two-session locks in the disposable PostgreSQL harness only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export async function customerAiPreparationRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-author-recovery.test.sql',import.meta.url),'utf8');
 const marker='\n-- Native harness commits only the reviewed seed before this exact marker.';
 assert.equal(source.split(marker).length,2);
 const seed=source.slice(0,source.indexOf(marker));
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 const literal=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
 async function fixture() {
  const f=parse(await sql(`${seed} select to_jsonb(f) from author_ai_fixture f; commit;`));
  assert(f?.u&&f.op&&f.sources.length===1);
  f.prepare=`${auth} select public.prepare_customer_ai_request('${f.op}','${f.u}','${f.ws}','${f.b}','${f.connection}',1,'${f.policy}',repeat('a',64),${literal(f.request)},${literal(f.sources)},0);`;
  f.close=`${auth} select public.close_customer_ai_preparation('${f.u}','${f.b}','${f.op}');`;
  f.confirm=`${auth} select public.customer_ai_request_action('${f.u}','${f.op}','confirm',0,true);`;
  f.status=`${auth} select public.customer_ai_request_action('${f.u}','${f.op}','status');`;
  return f;
 }
 async function contend(first,second,rollback=false) {
  const a=session(database,`prepare_holder_${randomUUID().replaceAll('-','')}`);
  a.child.stdin.write(`begin; ${first} select 'AUTHOR_AI_READY';\n`);
  await until(()=>{assert.equal(a.ended,false,a.stderr);return a.stdout.includes('AUTHOR_AI_READY')},'Preparation holder not ready');
  const name=`prepare_wait_${randomUUID().replaceAll('-','')}`,b=session(database,name);
  b.child.stdin.end(`begin; ${second} commit;`);
  await until(async()=>{assert.equal(b.ended,false,b.stderr);return await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`)==='1'},'Expected real preparation lock wait');
  a.child.stdin.end(rollback?'rollback;':'commit;');
  const ar=await a.done,br=await b.done;assert.equal(ar.code,0,ar.stderr);return br;
 }
 async function status(f) { return parse(await sql(`begin; ${f.status} commit;`)); }
 async function fees(f,expected) {
  const actual=parse(await sql(`select jsonb_build_object('jobs',(select count(*) from public.ai_jobs where created_by='${f.u}'),
   'debits',(select count(*) from public.credit_ledger where user_id='${f.u}' and source='generation_reservation'),
   'releases',(select count(*) from public.credit_ledger where user_id='${f.u}' and source='generation_release'))`));
  assert.deepEqual(actual,expected);
 }
 for(const rollback of [false,true]) {
  const f=await fixture(),r=await contend(f.close,f.prepare,rollback);
  if(rollback) {assert.equal(r.code,0,r.stderr);assert.equal((await status(f)).status,'prepared')}
  else {assert.notEqual(r.code,0);assert.match(r.stderr,/40001[\s\S]*closed before arrival/);assert.equal((await status(f)).status,'closed_before_prepare')}
  await fees(f,{jobs:0,debits:0,releases:0});console.log(`PASS native customer preparation: close then late prepare ${rollback?'rollback':'commit'}`);
 }
 for(const rollback of [false,true]) {
  const f=await fixture(),r=await contend(f.prepare,f.close,rollback);
  assert.equal(r.code,0,r.stderr);assert.equal((await status(f)).status,rollback?'closed_before_prepare':'closed');
  await fees(f,{jobs:0,debits:0,releases:0});console.log(`PASS native customer preparation: prepare then close ${rollback?'rollback':'commit'}`);
 }
 for(const [first,second,expected] of [['confirm','confirm','queued'],['confirm','close','cancelled'],['close','confirm','closed']]) {
  const f=await fixture();await sql(`begin; ${f.prepare} commit;`);const r=await contend(f[first],f[second]);
  if(first==='close') {assert.notEqual(r.code,0);assert.match(r.stderr,/40001[\s\S]*closed or expired/)} else assert.equal(r.code,0,r.stderr);
  assert.equal((await status(f)).status,expected);
  await fees(f,{jobs:first==='close'?0:1,debits:0,releases:0});
  console.log(`PASS native customer preparation: ${first} then ${second}, at most one job and zero Bookworm credits`);
 }
 const f=await fixture();await sql(`begin; ${f.prepare} ${f.confirm} commit;`);const r=await status(f);
 const dispatch=`${auth} do $$ declare j public.ai_jobs; begin select * into j from public.claim_customer_ai_job('${r.jobId}',180);
  perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64)); end $$;`;
 const result=await contend(dispatch,f.close);assert.notEqual(result.code,0);assert.match(result.stderr,/40001/);
 assert.equal((await status(f)).status,'running');await fees(f,{jobs:1,debits:0,releases:0});
 console.log('PASS native customer preparation: dispatched request cannot close or refund');
}
