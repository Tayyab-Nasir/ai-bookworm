// Disposable PGlite proof for the source-only cutover. No app credentials or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
const read=path=>readFile(join(root,path),'utf8');
const hash=x=>createHash('sha256').update(x).digest('hex');
const canonicalSql=sql=>{const normalized=sql.replace(/\r\n/g,'\n'); assert(!normalized.includes('\r'),'SQL contains a lone carriage return'); return normalized};
assert.equal(canonicalSql('a\r\nb'),'a\nb');
assert.throws(()=>canonicalSql('a\rb'),/lone carriage return/);
const atomic=canonicalSql(await read('ops/asset-lifecycle/atomic-cutover.source-only.sql'));
assert.equal(hash(atomic),'52e38a90f7b96fa6234ffbeaa4002f74dba2d7f366ef863ccf79807686347231','Review source changes and regenerate proof before running');
const boundary='-- Isolated readiness prototype; never apply to a live database without review.';
assert.equal(atomic.split(boundary).length,2,'The injected-failure boundary must be unique');
const db=new PGlite({extensions:{citext,pgcrypto}});
const privilegeSql="select has_function_privilege('authenticated','public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','execute') as granted,to_regprocedure('public.asset_lifecycle_readiness()') as readiness,(select count(*)::int from pg_trigger where tgname in ('aa_guard_removed_asset_bytes','aa_guard_removed_asset_version_insert') and not tgisinternal) as guards";
let phase='fixture';
try {
  await db.exec(await read('tests/security/local-supabase-fixture.sql'));
  const files=(await readdir(join(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort();
  const additive=files.filter(f=>f.endsWith('_asset_lifecycle_additive.sql'));
  assert.equal(additive.length,1,'Exactly one additive lifecycle migration is required');
  const additiveSql=canonicalSql(await read('supabase/migrations/'+additive[0]));
  assert.equal(hash(additiveSql),'75f967991b7993eadc9ee7eb17373c76767d1638837121da50c121685c86c008');
  for(const f of files){
    phase=f;
    const migration=f===additive[0]?additiveSql:await read('supabase/migrations/'+f);
    if (f===additive[0]) {
      const absent=async()=>assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='assets' and column_name='lifecycle_revision'")).rows[0].n,0);
      await db.exec('begin;\n'+migration+'\nrollback;');
      await absent();
      const marker='$bookworm_asset_sql$;';
      assert.equal(migration.split(marker).length,2,'Failure injection must match exactly once');
      const broken=migration.replace(marker,"do $fail$ begin raise exception 'synthetic stage1 failure'; end $fail$;\n"+marker);
      await assert.rejects(db.exec(broken),e=>e.message.includes('synthetic stage1 failure'));
      await absent();
      console.log('PASS additive stage supports outer rollback and autocommit failure rollback');
    }
    await db.exec('begin;\n'+migration+'\ncommit;');
  }
  phase='hosted-shaped synthetic Auth fixture';
  await db.exec(await read('tests/security/asset-lifecycle-managed-auth-fixture.sql'));
  async function rejected(label,change,fragment) {
    let rejected=false;
    try { await db.exec('begin;\n'+change+'\n'+atomic.replace(/^BEGIN;\s*/m,'').replace(/\s*COMMIT;\s*$/m,'')+'\ncommit;'); }
    catch(e) { assert.equal(e.code,'55000',label);assert.ok(e.message.includes(fragment),label+': '+e.message);rejected=true;await db.exec('rollback;'); }
    assert.ok(rejected,label+' should fail closed');
    const row=(await db.query(privilegeSql)).rows[0];
    assert.equal(row.granted,false,label);assert.equal(row.readiness,null,label);assert.equal(row.guards,0,label);
  }
  phase='preflight drift rejection';
  for(const [label,change,fragment] of [
    ['custom lifecycle grant',"create role unexpected_exec; grant execute on function private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid) to unexpected_exec;",'staged function privilege drift'],
    ['custom receipt grant',"create role unexpected_reader; grant select on bookworm_private.asset_lifecycle_receipts to unexpected_reader;",'receipt privilege drift'],
    ['managed Auth',"alter function auth.uid() volatile;",'managed auth baseline drift'],
    ['Auth schema',"grant create on schema auth to authenticated;",'managed auth privilege drift'],
    ['folder helper',"alter function private.folder_belongs_to_workspace(uuid,uuid) security invoker;",'legacy authorization baseline drift'],
    ['folder trigger',"alter table public.folders disable trigger folders_preserve_parent;",'legacy authorization baseline drift'],
    ['policy',"alter policy assets_select on public.assets using (true);",'legacy authorization baseline drift'],
    ['column grant',"grant update(name) on public.assets to anon;",'legacy authorization baseline drift'],
    ['schema grant',"grant create on schema private to authenticated;",'legacy authorization baseline drift'],
    ['role drift',"alter role authenticated bypassrls;",'legacy authorization baseline drift'],
    ['manifest default grant',"create role unexpected_archive; alter default privileges in schema bookworm_private grant select on tables to unexpected_archive;",'manifest privilege drift'],
    ['function default grant',"create role unexpected_function; alter default privileges in schema private grant execute on functions to unexpected_function;",'lifecycle function privilege drift'],
  ]) await rejected(label,change,fragment);
  console.log('PASS preflight/default-grant drift rejects atomically');
  phase='grant-option drift';
  const grantOption=atomic.replace('do $lifecycle_acl$',()=>"grant execute on function private.asset_lifecycle_readiness_internal() to service_role with grant option;\ndo $lifecycle_acl$");
  assert.notEqual(grantOption,atomic,'The grant-option test must modify the intended preflight');
  await assert.rejects(db.exec(grantOption),e=>e.code==='55000'&&e.message.includes('lifecycle function privilege drift'));
  await db.exec('rollback;');
  const afterGrant=(await db.query(privilegeSql)).rows[0];
  assert.equal(afterGrant.granted,false);assert.equal(afterGrant.readiness,null);assert.equal(afterGrant.guards,0);
  console.log('PASS function grant option rejects atomically');
  phase='interrupted cutover';
  const interrupted=atomic.replace(boundary,()=>"do $abort$ begin raise exception 'synthetic cutover interruption'; end $abort$;\n"+boundary);
  await assert.rejects(db.exec(interrupted),e=>e.message.includes('synthetic cutover interruption'));
  await db.exec('rollback;');
  const row=(await db.query(privilegeSql)).rows[0];
  assert.equal(row.granted,false);assert.equal(row.readiness,null);assert.equal(row.guards,0);
  console.log('PASS interrupted cutover rolls back grants, readiness and guards');
  phase='exact cutover';
  await db.exec(atomic);
  const after=(await db.query(privilegeSql)).rows[0];
  assert.equal(after.granted,true);assert.notEqual(after.readiness,null);assert.equal(after.guards,2);
  await db.exec("begin; set local role service_role; select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true); select public.asset_lifecycle_readiness(); rollback;");
  console.log('PASS exact source-only atomic cutover and readiness');
  phase='post-cutover drift';
  for(const [label,change] of [
    ['version helper ACL',"create role unexpected_exec; grant execute on function private.track_asset_version_revision() to unexpected_exec;"],
    ['folder helper',"alter function private.folder_belongs_to_workspace(uuid,uuid) security invoker;"],
    ['folder trigger',"alter table public.folders disable trigger folders_preserve_parent;"],
    ['asset policy',"alter policy assets_select on public.assets using (true);"],
    ['trigger owner',"alter function private.preserve_parent_reference() owner to service_role;"],
    ['Auth schema',"grant create on schema auth to authenticated;"],
    ['role membership',"grant service_role to authenticated;"],
  ]) {
    let rejected=false;
    try { await db.exec("begin;"+change+"\nset local role service_role; select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true); select public.asset_lifecycle_readiness(); commit;"); }
    catch(e) { assert.equal(e.code,'55000',label);assert.ok(e.message.includes('capability unavailable'),label);rejected=true;await db.exec('rollback;'); }
    assert.ok(rejected,label+' should disable readiness');
  }
  console.log('PASS post-cutover helper, policy and privilege drift fails closed');
} catch(e) { console.error('FAIL '+phase+': '+e.message);process.exitCode=1; }
finally { await db.close(); }
