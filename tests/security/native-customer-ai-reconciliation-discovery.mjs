/** Read-only snapshot races, only for the disposable native PostgreSQL harness. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export async function customerAiReconciliationDiscoveryRaces({sql,session,until,database}) {
 const source=await readFile(new URL('./customer-ai-completion.test.sql',import.meta.url),'utf8');
 const marker='\ndo $$ declare signature text;';
 assert.equal(source.split(marker).length,2,'Review synthetic fixture boundary');
 const seed=source.slice(0,source.indexOf(marker));
 const dispatch=" perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));";
 assert.equal(seed.split(dispatch).length,2,'Review dispatch fixture boundary');
 const auth=`set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
 const parse=text=>JSON.parse(text.split('\n').find(line=>line.startsWith('{'))??'null');
 async function fixture({dispatched=false,receipt=false,review=false}={}) {
  const f=parse(await sql(`${dispatched?seed:seed.replace(dispatch,'')}
   create temp table native_discovery_job on commit drop as select j.* from pg_temp.customer_receipt_job() j;
   ${receipt?`insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
    select j.id,repeat('b',64),pg_temp.customer_receipt(j) from public.ai_jobs j join native_discovery_job n on n.id=j.id;`:''}
   ${dispatched?"update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=(select id from native_discovery_job);":''}
   ${review?`select public.reconcile_customer_ai_job((select id from native_discovery_job));`:''}
   select jsonb_build_object('job',j.id,'owner',j.created_by,'lease',a.dispatch_lease_token,
    'currentLease',j.lease_token,'createdAt',a.created_at)
    from public.ai_jobs j join native_discovery_job n on n.id=j.id join bookworm_credentials.customer_ai_jobs a on a.job_id=j.id;
   commit;`));
  assert(f?.job&&f.owner&&f.createdAt);
  f.discover=`${auth} select coalesce((select jsonb_build_object('action',action) from public.discover_customer_ai_reconciliation_candidates(100,'${f.createdAt}'::timestamptz,'00000000-0000-0000-0000-000000000000') where job_id='${f.job}'),'{"action":"absent"}'::jsonb);`;
  f.dispatch=`${auth} select jsonb_build_object('resolved',true) from public.resolve_customer_ai_dispatch('${f.job}','${f.currentLease}',repeat('b',64));
   update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${f.job}';`;
  f.reconcile=`${auth} select public.reconcile_customer_ai_job('${f.job}');`;
  f.complete=`${auth} select to_jsonb(public.complete_customer_ai_job('${f.job}','${f.owner}',repeat('b',64)));`;
  return f;
 }
 async function snapshotRace(f,write,before,after) {
  const reader=session(database,`discovery_snapshot_${randomUUID().replaceAll('-','')}`);
  reader.child.stdin.write(`begin isolation level repeatable read; ${f.discover} select 'DISCOVERY_SNAPSHOT_READY';\n`);
  await until(()=>{assert.equal(reader.ended,false,reader.stderr);return reader.stdout.includes('DISCOVERY_SNAPSHOT_READY')},'Discovery snapshot not ready');
  // The writer must complete while the read transaction stays open: discovery
  // is a non-locking hint, not a claim or an authorization decision.
  await sql(`begin; ${write} commit;`);
  reader.child.stdin.end(`${f.discover} commit;\n`);
  const result=await reader.done;assert.equal(result.code,0,result.stderr);
  const rows=result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  assert.deepEqual(rows,[{action:before},{action:before}],'repeatable snapshot changed');
  const current=parse(await sql(`begin; ${f.discover} commit;`));assert.equal(current.action,after);
 }
 {
  const f=await fixture();
  await snapshotRace(f,f.dispatch,'none','reconcile');
  const status=parse(await sql(`select jsonb_build_object('dispatched',a.dispatched_at is not null,
   'releases',(select count(*) from public.credit_ledger where reference_id=a.job_id and source='generation_release'))
   from bookworm_credentials.customer_ai_jobs a where a.job_id='${f.job}';`));
  assert.deepEqual(status,{dispatched:true,releases:0});
 }
 {
  const f=await fixture({dispatched:true});
  await snapshotRace(f,f.reconcile,'reconcile','review');
 }
 {
  const f=await fixture({dispatched:true,receipt:true,review:true});
  await snapshotRace(f,f.complete,'receipt_available','absent');
  const status=parse(await sql(`select jsonb_build_object('runs',(select count(*) from public.ai_runs where ai_job_id='${f.job}'),
   'events',(select count(*) from public.usage_events where ai_job_id='${f.job}'),
   'releases',(select count(*) from public.credit_ledger where reference_id='${f.job}' and source='generation_release'));`));
  assert.deepEqual(status,{runs:1,events:1,releases:0});
 }
 console.log('PASS native customer reconciliation discovery: repeatable snapshots across dispatch, review and completion');
}
