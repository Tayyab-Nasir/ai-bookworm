// Disposable native PostgreSQL proof: owned loopback cluster, no app env or hosted DB.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const pgBin=process.env.BOOKWORM_PG_BIN;
if (!pgBin) throw new Error('Set BOOKWORM_PG_BIN to a local PostgreSQL 17 binary directory');
const exe=name=>join(resolve(pgBin),name+(process.platform==='win32'?'.exe':''));
const hash=x=>createHash('sha256').update(x).digest('hex');
const atomic=readFileSync(join(root,'ops/asset-lifecycle/atomic-cutover.source-only.sql'),'utf8');
assert.equal(hash(atomic),'7adb6243572a4fe2d049023479921801954e22cefa0a00fc240cd41e8b439424');
const boundary='-- Isolated readiness prototype; never apply to a live database without review.';
assert.equal(atomic.split(boundary).length,2);
const migrations=readdirSync(join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
const additive=migrations.filter(f=>f.endsWith('_asset_lifecycle_additive.sql'));
assert.equal(additive.length,1);
assert.equal(hash(readFileSync(join(root,'supabase/migrations',additive[0]))),'75f967991b7993eadc9ee7eb17373c76767d1638837121da50c121685c86c008');
const own=mkdtempSync(join(tmpdir(),'bookworm-cutover-native-')),data=join(own,'cluster'),log=join(own,'postgres.log');
const envBase=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const port=await new Promise((done,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?fail(e):done(p))})});
const env={...envBase,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:'fixture_owner',PGDATABASE:'postgres',PGCONNECT_TIMEOUT:'5',PGSSLMODE:'disable',PGOPTIONS:'-c statement_timeout=30000 -c lock_timeout=15000'};
const children=new Set();
function run(bin,args){const r=spawnSync(exe(bin),args,{env:envBase,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});if(r.error||r.status!==0)throw Error(bin+' failed: '+(r.error?.message??r.stderr?.slice(0,1200)))}
function control(args){const fd=openSync(join(own,'pgctl.log'),'a');try{const r=spawnSync(exe('pg_ctl'),args,{env:envBase,stdio:['ignore',fd,fd],timeout:30000,windowsHide:true});if(r.error||r.status!==0)throw Error('Owned cluster control failed')}finally{closeSync(fd)}}
function session(name,legacyName){
  if(legacyName)name=legacyName;
  const child=spawn(exe('psql'),['-X','-qAt','-v','ON_ERROR_STOP=1'],{env:{...env,PGAPPNAME:name},stdio:['pipe','pipe','pipe'],windowsHide:true});
  children.add(child);const s={child,stdout:'',stderr:''};
  child.stdout.on('data',c=>s.stdout+=c);child.stderr.on('data',c=>s.stderr+=c);child.stdin.on('error',()=>{});
  s.done=new Promise(done=>{child.on('error',e=>s.stderr+=e.message);child.on('close',code=>{children.delete(child);done({code,stdout:s.stdout,stderr:s.stderr})})});return s;
}
async function sql(text){const s=session('cutover-proof');s.child.stdin.end(text);const r=await s.done;if(r.code!==0)throw Error('Synthetic SQL failed: '+r.stderr.slice(-1800));return r.stdout.trim()}
async function until(check,message){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await delay(50)}throw Error(message??'Synthetic transaction did not reach expected state')}
const noPartial="select has_function_privilege('authenticated','public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','execute')||','||(to_regprocedure('public.asset_lifecycle_readiness()') is null)||','||(select count(*)=0 from pg_trigger where tgname in ('aa_guard_removed_asset_bytes','aa_guard_removed_asset_version_insert') and not tgisinternal);";
let started=false,owned=false;
try {
  mkdirSync(data);run('initdb',['-D',data,'-U','fixture_owner','--no-locale','--encoding=UTF8','--auth=trust']);
  control(['-D',data,'-l',log,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
  const identity=(await sql("select current_setting('data_directory')||'|'||inet_server_port()||'|'||current_user")).split('|');
  assert.equal(resolve(identity[0]).toLowerCase(),resolve(data).toLowerCase());assert.equal(Number(identity[1]),port);assert.equal(identity[2],'fixture_owner');owned=true;
  const version=Number(await sql("select current_setting('server_version_num')"));
  assert.ok(version>=170000 && version<180000,'This native proof requires PostgreSQL 17');
  const fixture=readFileSync(join(root,'tests/security/local-supabase-fixture.sql'),'utf8');
  const history=migrations.map(f=>'begin;\n'+readFileSync(join(root,'supabase/migrations',f),'utf8')+'\ncommit;').join('\n');
  await sql(fixture+'\n'+history);
  await sql(readFileSync(join(root,'tests/security/asset-lifecycle-managed-auth-fixture.sql'),'utf8'));
  assert.equal(await sql(noPartial),'false,true,true');
  const half=session('cutover-half');half.child.stdin.write(atomic.slice(0,atomic.indexOf(boundary))+"\nselect 'CUTOVER_HALF_READY';\n");
  await until(()=>half.stdout.includes('CUTOVER_HALF_READY'));
  assert.equal(await sql("select has_function_privilege('authenticated','public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','execute')"),'f');
  const client=session('cutover-client');client.child.stdin.end("set role authenticated; select public.asset_lifecycle_status('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000001');");
  const denied=await client.done;assert.notEqual(denied.code,0);assert.match(denied.stderr,/permission denied/i);
  half.child.stdin.end('rollback;\n');assert.equal((await half.done).code,0);assert.equal(await sql(noPartial),'false,true,true');
  console.log('PASS other authenticated session cannot see intermediate grants');
  const fault=session('cutover-interrupted');fault.child.stdin.end(atomic.replace(boundary,()=>"do $abort$ begin raise exception 'synthetic cutover interruption'; end $abort$;\n"+boundary));
  const failed=await fault.done;assert.notEqual(failed.code,0);assert.match(failed.stderr,/synthetic cutover interruption/);assert.equal(await sql(noPartial),'false,true,true');
  console.log('PASS failed cutover rolls back grants, guards and readiness');
  await sql(atomic);
  assert.equal(await sql(noPartial),'true,false,false');
  assert.match(await sql("begin; set local role service_role; select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);select public.asset_lifecycle_readiness();rollback;"),/asset-lifecycle-v1$/);
  console.log('PASS exact cutover artifact and readiness');
  const securityFixture=readFileSync(join(root,'tests/security/asset-lifecycle-cutover-fixture.sql'),'utf8');
  await sql(securityFixture);
  const end=securityFixture.indexOf('set local role authenticated;');if(end<0)throw Error('fixture boundary missing');await sql(securityFixture.slice(0,end)+'\ncommit;');
  const staleActor='aa910000-0000-4000-8000-000000000001',staleWorkspace='cc910000-0000-4000-8000-000000000001';
  for(const [suffix,change] of [
    ['021',"update public.assets set name='Changed title' where id='dd910000-0000-4000-8000-000000000021';"],
    ['022',"insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values ('dd910000-0000-4000-8000-000000000022',1,'fixture/new.png','pending','image/png',10,'aa910000-0000-4000-8000-000000000001');"],
  ]) {
    const asset='dd910000-0000-4000-8000-000000000'+suffix, operation='ee910000-0000-4000-8000-000000000'+suffix;
    await sql("insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,requires_approval,created_by) values ('"+asset+"','"+staleWorkspace+"','illustration','Original','fixture/old.png','image/png',10,'pending','draft',true,'"+staleActor+"');");
    const revision=await sql("select lifecycle_revision from public.assets where id='"+asset+"';");
    await sql(change);
    assert.notEqual(await sql("select lifecycle_revision from public.assets where id='"+asset+"';"),revision);
    const stale=session('stale_revision_'+suffix);
    stale.child.stdin.end("set role authenticated; select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\""+staleActor+"\"}',false); select public.mutate_asset_lifecycle('"+staleWorkspace+"','"+asset+"','"+operation+"','remove',null,'"+revision+"');");
    const rejected=await stale.done;assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/asset lifecycle revision changed/);
    assert.equal(await sql("select count(*) from public.assets where id='"+asset+"' and deleted_at is null;"),'1');
  }
  console.log('PASS stale removal after content or version change is rejected');
 const rev1=await sql("select lifecycle_revision from public.assets where id='dd910000-0000-4000-8000-000000000001';");
 const editor=session('postgres','asset_editor');
 editor.child.stdin.write(`begin; set local role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',true); select public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000011','remove',null,'${rev1}'); select 'LOCK_READY';\n`);
 await until(()=>editor.stdout.includes('LOCK_READY'),'mutation transaction did not start');
 const replay=session('postgres','asset_replay_race');
 replay.child.stdin.end(`set role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',false); select public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000011','remove',null,'${rev1}');`);
 await until(async()=> (await sql("select count(*) from pg_stat_activity where application_name='asset_replay_race' and wait_event_type='Lock';"))==='1','same operation did not wait for receipt');
 const conflict=session('postgres','asset_other_tab');
 conflict.child.stdin.end(`set role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',false); select public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000099','remove',null,'${rev1}');`);
 await until(async()=> (await sql("select count(*) from pg_stat_activity where application_name='asset_other_tab' and wait_event_type='Lock';"))==='1','other tab did not wait on asset row');
 const downgrade=session('postgres','asset_downgrade');
 downgrade.child.stdin.end(`update public.workspace_members set role='viewer' where workspace_id='cc910000-0000-4000-8000-000000000001' and user_id='aa910000-0000-4000-8000-000000000001';`);
 await until(async()=> (await sql("select count(*) from pg_stat_activity where application_name='asset_downgrade' and wait_event_type='Lock';"))==='1','downgrade did not wait on membership lock');
 editor.child.stdin.end('commit;\n'); const a=await editor.done; const duplicate=await replay.done; const other=await conflict.done; const b=await downgrade.done; assert.equal(a.code,0,a.stderr);assert.equal(duplicate.code,0,duplicate.stderr);assert.match(replay.stdout,/\"replayed\": true/);assert.notEqual(other.code,0);assert.match(other.stderr,/asset lifecycle revision changed/);assert.equal(b.code,0,b.stderr);
 console.log('PASS other-tab removal conflicts without overwriting');
 assert.equal(await sql("select count(*) from bookworm_private.asset_lifecycle_receipts where asset_id='dd910000-0000-4000-8000-000000000001' and action='remove'"),'1'); console.log('PASS concurrent same-operation replay creates one receipt');
 console.log('PASS concurrent role downgrade waits until authorized mutation commits');
 const denial=session('postgres','asset_denial');denial.child.stdin.end(`set role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',false); select public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000012','remove',null,'${rev1}');`);const d=await denial.done;assert.notEqual(d.code,0);assert.match(d.stderr,/asset editing access required/);console.log('PASS downgraded user denied further mutation');
 const viewerClose=session('postgres','viewer_close');viewerClose.child.stdin.end(`set role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',false); select public.close_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000003','ee910000-0000-4000-8000-000000000110','remove',null,null);`);const vcl=await viewerClose.done;assert.notEqual(vcl.code,0);assert.match(vcl.stderr,/asset editing access required/);assert.equal(await sql("select count(*) from bookworm_private.asset_lifecycle_receipts where operation_id='ee910000-0000-4000-8000-000000000110';"),'0');console.log('PASS viewer cannot call close directly or create a tombstone');
 await sql(`update public.workspace_members set role='editor' where workspace_id='cc910000-0000-4000-8000-000000000001' and user_id='aa910000-0000-4000-8000-000000000001';
 insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values ('dd910000-0000-4000-8000-000000000003','cc910000-0000-4000-8000-000000000001','illustration','race','fixture/original.png','image/png',10,repeat('a',64),'aa910000-0000-4000-8000-000000000001');
 insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values ('dd910000-0000-4000-8000-000000000003',2,'fixture/replacement.png','pending','image/png',10,'aa910000-0000-4000-8000-000000000001');`);
 const remover=session('postgres','asset_removal_race');
 remover.child.stdin.write(`begin; set local role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',true); select public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000003','ee910000-0000-4000-8000-000000000014','remove',null,(select lifecycle_revision from public.assets where id='dd910000-0000-4000-8000-000000000003')); select 'REMOVED_LOCKED';\n`);
 await until(()=>remover.stdout.includes('REMOVED_LOCKED'),'asset removal did not lock');
 const scanner=session('postgres','asset_scan_race');
 scanner.child.stdin.end(`begin; set local role service_role; select set_config('request.jwt.claims','{"role":"service_role"}',true); select public.record_asset_scan_verdict('dd910000-0000-4000-8000-000000000003',2,'clean',repeat('c',64),'image/png',10,'fixture-scanner','clean',null); commit;`);
 await until(async()=> (await sql("select count(*) from pg_stat_activity where application_name='asset_scan_race' and wait_event_type='Lock';"))==='1','scan did not wait on removal lock');
 remover.child.stdin.end('commit;\n');const removed=await remover.done, scanned=await scanner.done;assert.equal(removed.code,0,removed.stderr);assert.notEqual(scanned.code,0);assert.match(scanned.stderr,/asset is removed/);
 assert.equal(await sql("select count(*) from public.assets a join public.asset_versions v on v.asset_id=a.id where a.id='dd910000-0000-4000-8000-000000000003' and a.deleted_at is not null and a.storage_path='fixture/original.png' and v.version_number=2 and v.checksum='pending';"),'1');
 console.log('PASS scan waits for committed removal and cannot change removed asset bytes');
 await sql(`insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values ('dd910000-0000-4000-8000-000000000004','cc910000-0000-4000-8000-000000000001','illustration','allocation race','fixture/original2.png','image/png',10,'pending','aa910000-0000-4000-8000-000000000001');`);
 const remover2=session('postgres','asset_removal_alloc_race');
 remover2.child.stdin.write(`begin; set local role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',true); select public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000004','ee910000-0000-4000-8000-000000000015','remove',null,(select lifecycle_revision from public.assets where id='dd910000-0000-4000-8000-000000000004')); select 'REMOVED_LOCKED';\n`);
 await until(()=>remover2.stdout.includes('REMOVED_LOCKED'),'second asset removal did not lock');
 const allocator=session('postgres','asset_alloc_race');
 allocator.child.stdin.end(`begin; set local role authenticated; select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',true); insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values ('dd910000-0000-4000-8000-000000000004',2,'fixture/late.png','pending','image/png',10,'aa910000-0000-4000-8000-000000000001'); commit;`);
 await until(async()=> (await sql("select count(*) from pg_stat_activity where application_name='asset_alloc_race' and wait_event_type='Lock';"))==='1','version allocation did not wait on removal lock');
 remover2.child.stdin.end('commit;\n');const removed2=await remover2.done, allocated=await allocator.done;assert.equal(removed2.code,0,removed2.stderr);assert.notEqual(allocated.code,0);assert.match(allocated.stderr,/asset is removed/);
 assert.equal(await sql("select count(*) from public.asset_versions where asset_id='dd910000-0000-4000-8000-000000000004';"),'0');
 assert.equal(await sql("select count(*) from public.assets where id='dd910000-0000-4000-8000-000000000004' and deleted_at is not null;"),'1');
 console.log('PASS new version allocation waits for removal and then rejects');
 console.log('PASS removed pending asset remains present after version allocation race');
 const actor='aa910000-0000-4000-8000-000000000001', workspace='cc910000-0000-4000-8000-000000000001', asset='dd910000-0000-4000-8000-000000000003';
 const jwt="set role authenticated; select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\""+actor+"\"}',false); ";
 const currentRevision=await sql("select lifecycle_revision from public.assets where id='"+asset+"';"); const original003=await sql("select expected_revision from bookworm_private.asset_lifecycle_receipts where operation_id='ee910000-0000-4000-8000-000000000014';");
 const closeOp=(id,action='remove',expected='null',target=asset,revision=currentRevision)=>"select public.close_asset_lifecycle('"+workspace+"','"+target+"','"+id+"','"+action+"',"+expected+",'"+revision+"');";
 const mutateOp=(id,target=asset,revision=currentRevision)=>"select public.mutate_asset_lifecycle('"+workspace+"','"+target+"','"+id+"','remove',null,'"+revision+"');";
 const closedId='ee910000-0000-4000-8000-000000000101';const c0=session('postgres','close_before_dispatch');c0.child.stdin.end(jwt+closeOp(closedId));const closedResult=await c0.done;assert.equal(closedResult.code,0,closedResult.stderr);assert.match(closedResult.stdout,/\"outcome\": \"closed\"/);const late=session('postgres','late_dispatch');late.child.stdin.end(jwt+mutateOp(closedId));const lateResult=await late.done;assert.notEqual(lateResult.code,0);assert.match(lateResult.stderr,/asset operation was closed/);console.log('PASS closed identity fences late removal');
 const status=session('postgres','close_status');status.child.stdin.end(jwt+"select public.asset_lifecycle_status('"+workspace+"','"+asset+"','"+closedId+"');");const statusResult=await status.done;assert.equal(statusResult.code,0,statusResult.stderr);assert.match(statusResult.stdout,/\"outcome\": \"closed\"/);
 const committedId='ee910000-0000-4000-8000-000000000014';const committed=session('postgres','close_committed');committed.child.stdin.end(jwt+closeOp(committedId,'remove','null',asset,original003));const committedResult=await committed.done;assert.equal(committedResult.code,0,committedResult.stderr);assert.match(committedResult.stdout,/\"outcome\": \"committed\"/);console.log('PASS close reports an already committed operation');
 const restoreId='ee910000-0000-4000-8000-000000000102', deletedAt=await sql("select to_char(deleted_at,'YYYY-MM-DD HH24:MI:SS.USOF') from public.assets where id='"+asset+"';");const expected="'"+deletedAt+"'::timestamptz";const rc=session('postgres','close_restore');rc.child.stdin.end(jwt+closeOp(restoreId,'restore',expected));assert.equal((await rc.done).code,0);const lateRestore=session('postgres','late_restore');lateRestore.child.stdin.end("set role service_role; select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false); select public.restore_verified_asset('"+actor+"','"+workspace+"','"+asset+"','"+restoreId+"',"+expected+",'"+currentRevision+"','dd910000-0000-4000-8000-000000000009','fixture/original.png',repeat('a',64),10);");const lr=await lateRestore.done;assert.notEqual(lr.code,0);assert.match(lr.stderr,/asset operation was closed/);console.log('PASS closed identity fences late verified restore');
 const wrong=session('postgres','wrong_actor_close');wrong.child.stdin.end("set role authenticated; select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"aa910000-0000-4000-8000-000000000099\"}',false);"+closeOp('ee910000-0000-4000-8000-000000000103'));const wrongResult=await wrong.done;assert.notEqual(wrongResult.code,0);assert.match(wrongResult.stderr,/workspace unavailable/);console.log('PASS nonmember cannot close identity');
 const raceAsset='dd910000-0000-4000-8000-000000000005'; await sql("insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values ('"+raceAsset+"','"+workspace+"','illustration','race close','fixture/close.png','image/png',10,repeat('a',64),'"+actor+"');"); const raceRevision=await sql("select lifecycle_revision from public.assets where id='"+raceAsset+"';"); const raceId='ee910000-0000-4000-8000-000000000104';const inFlight=session('postgres','close_wait_writer');inFlight.child.stdin.write("begin; "+jwt+mutateOp(raceId,raceAsset,raceRevision)+"select 'WRITER_LOCKED';\n");await until(()=>inFlight.stdout.includes('WRITER_LOCKED'),'writer did not lock');const closer=session('postgres','close_wait_reader');closer.child.stdin.end(jwt+closeOp(raceId,'remove','null',raceAsset,raceRevision));await until(async()=>(await sql("select count(*) from pg_stat_activity where application_name='close_wait_reader' and wait_event_type='Lock';"))==='1','close did not wait');inFlight.child.stdin.end('commit;');const wr=await inFlight.done,cl=await closer.done;assert.equal(wr.code,0,wr.stderr);assert.equal(cl.code,0,cl.stderr);assert.match(cl.stdout,/\"outcome\": \"committed\"/);console.log('PASS close waits for in-flight mutation and returns committed');
 const conflictClose=session('postgres','conflicting_close_identity');conflictClose.child.stdin.end(jwt+closeOp(closedId,'remove','null',raceAsset));const conflictClosed=await conflictClose.done;assert.notEqual(conflictClosed.code,0);assert.match(conflictClosed.stderr,/asset lifecycle operation conflict/);console.log('PASS mismatched closure identity rejected');
 const firstAsset='dd910000-0000-4000-8000-000000000006', firstId='ee910000-0000-4000-8000-000000000105'; await sql("insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values ('"+firstAsset+"','"+workspace+"','illustration','close first','fixture/first.png','image/png',10,repeat('a',64),'"+actor+"');");
 const firstRevision=await sql("select lifecycle_revision from public.assets where id='"+firstAsset+"';"); const closerFirst=session('postgres','close_first_locked');closerFirst.child.stdin.write("begin; "+jwt+closeOp(firstId,'remove','null',firstAsset,firstRevision)+"select 'CLOSE_LOCKED';\n");await until(()=>closerFirst.stdout.includes('CLOSE_LOCKED'),'close did not lock');const lateWriter=session('postgres','close_first_writer');lateWriter.child.stdin.end(jwt+mutateOp(firstId,firstAsset,firstRevision));await until(async()=>(await sql("select count(*) from pg_stat_activity where application_name='close_first_writer' and wait_event_type='Lock';"))==='1','late writer did not wait');closerFirst.child.stdin.end('commit;');assert.equal((await closerFirst.done).code,0);const lwr=await lateWriter.done;assert.notEqual(lwr.code,0);assert.match(lwr.stderr,/asset operation was closed/);assert.equal(await sql("select count(*) from public.assets where id='"+firstAsset+"' and deleted_at is null;"),'1');console.log('PASS close-first commit blocks in-flight late writer without removing asset');
 const rollbackAsset='dd910000-0000-4000-8000-000000000007', rollbackId='ee910000-0000-4000-8000-000000000106';await sql("insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values ('"+rollbackAsset+"','"+workspace+"','illustration','rollback','fixture/rollback.png','image/png',10,repeat('a',64),'"+actor+"');");const rollbackRevision=await sql("select lifecycle_revision from public.assets where id='"+rollbackAsset+"';"); const rollbackWriter=session('postgres','rollback_writer');rollbackWriter.child.stdin.write("begin; "+jwt+mutateOp(rollbackId,rollbackAsset,rollbackRevision)+"select 'ROLLBACK_LOCKED';\n");await until(()=>rollbackWriter.stdout.includes('ROLLBACK_LOCKED'),'rollback writer did not lock');const rollbackCloser=session('postgres','rollback_closer');rollbackCloser.child.stdin.end(jwt+closeOp(rollbackId,'remove','null',rollbackAsset,rollbackRevision));await until(async()=>(await sql("select count(*) from pg_stat_activity where application_name='rollback_closer' and wait_event_type='Lock';"))==='1','rollback closer did not wait');rollbackWriter.child.stdin.end('rollback;');assert.equal((await rollbackWriter.done).code,0);const rcl=await rollbackCloser.done;assert.equal(rcl.code,0,rcl.stderr);assert.match(rcl.stdout,/\"outcome\": \"closed\"/);assert.equal(await sql("select count(*) from public.assets where id='"+rollbackAsset+"' and deleted_at is null;"),'1');console.log('PASS close records tombstone after competing mutation rolls back');
 const closedCount=Number(await sql("select count(*) from bookworm_private.asset_lifecycle_receipts where actor_id='"+actor+"' and outcome='closed' and committed_at>clock_timestamp()-interval '1 hour';"));assert(closedCount<59);await sql("insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,outcome) select '"+actor+"',gen_random_uuid(),'"+workspace+"','"+asset+"','remove','closed' from generate_series(1,"+(59-closedCount)+");");const rateA=session('postgres','rate_a');rateA.child.stdin.write("begin; "+jwt+closeOp('ee910000-0000-4000-8000-000000000107')+"select 'RATE_LOCKED';\n");await until(()=>rateA.stdout.includes('RATE_LOCKED'),'rate close did not lock');const rateB=session('postgres','rate_b');rateB.child.stdin.end(jwt+closeOp('ee910000-0000-4000-8000-000000000108'));await until(async()=>(await sql("select count(*) from pg_stat_activity where application_name='rate_b' and wait_event_type='Lock';"))==='1','second close did not wait');rateA.child.stdin.end('commit;');assert.equal((await rateA.done).code,0);const br=await rateB.done;assert.notEqual(br.code,0);assert.match(br.stderr,/asset close limit reached/);const replayClose=session('postgres','rate_replay');replayClose.child.stdin.end(jwt+closeOp(closedId));assert.equal((await replayClose.done).code,0);console.log('PASS serialized 60 per hour cap and closed receipt replay');

} finally {
  for(const child of children)child.kill();
  if(started&&owned)control(['-D',data,'-m','fast','-w','stop']);
  else if(started)console.error('Owned-cluster identity not verified; do not stop any external server automatically');
}
