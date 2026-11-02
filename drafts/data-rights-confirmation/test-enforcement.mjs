import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {citext} from '@electric-sql/pglite/contrib/citext';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const db=new PGlite({extensions:{citext,pgcrypto}});
try {
 await db.exec(await readFile('tests/security/local-supabase-fixture.sql','utf8'));
 const migrations=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
 assert.equal(migrations.length,130);assert.equal(migrations.at(-1),'20261102170000_data_rights_confirmation_rpc.sql');
 for(const f of migrations)await db.exec('begin;\n'+(await readFile('supabase/migrations/'+f,'utf8')).replace(/\r\n/g,'\n')+'\ncommit;');
 const actor='a8960000-0000-4000-8000-000000000001';
 await db.query('insert into auth.users(id,email) values($1,$2)',[actor,'retained-request@invalid.test']);
 await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 const before=(await db.query("select to_jsonb(x) v from public.submit_delete_data_rights_request('DELETE MY ACCOUNT','retain me') x")).rows[0].v;
 await db.exec('reset role');
 const stage2=await readFile('drafts/data-rights-confirmation/stage-2-enforce.source-only.sql','utf8');
 const oldPolicy=()=>db.query("select pg_get_expr(polwithcheck,polrelid) value from pg_policy where polrelid='public.data_rights_requests'::regclass and polname='data_rights_owner_insert'").then(r=>r.rows[0]?.value);
 const beforePolicy=await oldPolicy();
 const refuses=async label=>{
   await assert.rejects(db.exec(stage2),e=>e.code==='55000',label);
   await db.exec('rollback');
   assert.equal(await oldPolicy(),beforePolicy,`${label}: previous policy must survive rollback`);
 };
 for(const [name,action] of [['data_rights_delete_confirmation_fence','insert'],['data_rights_delete_confirmation_update_fence','update']]){
   await db.exec(`create policy ${name} on public.data_rights_requests as restrictive for ${action} to PUBLIC with check (false)`);
   await refuses(`existing unrelated restrictive ${action} fence`);
   assert.equal((await db.query("select count(*)::int n from pg_policy where polrelid='public.data_rights_requests'::regclass and polname=$1",[name])).rows[0].n,1,'preexisting restrictive policy must remain after rollback');
   await db.exec(`drop policy ${name} on public.data_rights_requests`);
 }
 for(const [label,roles] of [['authenticated','authenticated'],['PUBLIC','PUBLIC']]){
   await db.exec(`create policy test_extra on public.data_rights_requests for insert to ${roles} with check (true)`);
   await refuses(`extra permissive ${label} policy`);
   await db.exec('drop policy test_extra on public.data_rights_requests');
 }
 await db.exec('create role bookworm_test_anon nologin; grant bookworm_test_anon to anon');
 await db.exec('grant insert (user_id,request_type,status) on public.data_rights_requests to bookworm_test_anon');
 await refuses('anon inherited column INSERT');
 await db.exec('revoke insert (user_id,request_type,status) on public.data_rights_requests from bookworm_test_anon');
 await db.exec('create policy test_extra on public.data_rights_requests for insert to bookworm_test_anon with check (true)');
 await refuses('anon inherited permissive policy');
 await db.exec('drop policy test_extra on public.data_rights_requests; revoke bookworm_test_anon from anon');
 await db.exec('grant insert (id) on public.data_rights_requests to authenticated');
 await refuses('authenticated server-owned column INSERT');
 await db.exec('revoke insert (id) on public.data_rights_requests from authenticated');
 await db.exec('grant insert on public.data_rights_requests to authenticated');
 await refuses('authenticated table-wide INSERT');
 await db.exec('revoke insert on public.data_rights_requests from authenticated; grant insert (user_id,request_type,status,reason) on public.data_rights_requests to authenticated');
 await db.exec('grant bookworm_test_anon to anon');
 for(const privilege of ['DELETE','TRUNCATE','TRIGGER','REFERENCES']) {
   await db.exec(`grant ${privilege} on public.data_rights_requests to bookworm_test_anon`);
   await refuses(`anon inherited ${privilege}`);
   await db.exec(`revoke ${privilege} on public.data_rights_requests from bookworm_test_anon`);
 }
 await db.exec('grant references (id) on public.data_rights_requests to bookworm_test_anon');
 await refuses('anon inherited REFERENCES column');
 await db.exec('revoke references (id) on public.data_rights_requests from bookworm_test_anon; revoke bookworm_test_anon from anon');
 await db.exec('revoke execute on function public.cancel_data_rights_request(uuid) from authenticated');
 await refuses('cancellation RPC unavailable');
 await db.exec('grant execute on function public.cancel_data_rights_request(uuid) to authenticated');
 await db.exec('revoke execute on function auth.uid() from PUBLIC,authenticated');
 await refuses('authenticated auth.uid dependency unavailable');
 await db.exec('grant execute on function auth.uid() to PUBLIC');
 await db.exec('create role bookworm_test_inherited nologin; grant bookworm_test_inherited to authenticated');
 await db.exec('grant update (request_type) on public.data_rights_requests to bookworm_test_inherited');
 await refuses('authenticated inherited UPDATE column');
 await db.exec('revoke update (request_type) on public.data_rights_requests from bookworm_test_inherited');
 await db.exec('create policy test_extra on public.data_rights_requests for update to bookworm_test_inherited using (true) with check (true)');
 await refuses('authenticated inherited permissive UPDATE');
 await db.exec('drop policy test_extra on public.data_rights_requests');
 await db.exec('create policy test_extra on public.data_rights_requests for all to bookworm_test_inherited using (true) with check (true)');
 await refuses('inherited permissive ALL policy');
 await db.exec('drop policy test_extra on public.data_rights_requests; revoke bookworm_test_inherited from authenticated');
 await db.exec('alter table public.data_rights_requests disable row level security');
 await refuses('disabled RLS');
 await db.exec('alter table public.data_rights_requests enable row level security');
 await db.exec('revoke execute on function public.submit_delete_data_rights_request(text,text) from authenticated');
 await refuses('RPC execute unavailable');
 await db.exec('grant execute on function public.submit_delete_data_rights_request(text,text) to authenticated');
 const owner=(await db.query('select current_user name')).rows[0].name;
 assert.match(owner,/^[a-z_][a-z0-9_]*$/);
 await db.exec('create role bookworm_test_rpc_owner nologin; alter function public.submit_delete_data_rights_request(text,text) owner to bookworm_test_rpc_owner');
 await refuses('RPC owner lacks RLS bypass or table ownership');
 await db.exec(`alter function public.submit_delete_data_rights_request(text,text) owner to ${owner}`);
 // A non-superuser table/RPC owner bypasses RLS but still needs auth.uid and
 // both schema and table privileges. Exercise each loss in isolation.
 await db.exec('alter table public.data_rights_requests owner to bookworm_test_rpc_owner; alter function public.submit_delete_data_rights_request(text,text) owner to bookworm_test_rpc_owner; grant usage on schema public, auth to bookworm_test_rpc_owner');
 await db.exec('revoke execute on function auth.uid() from PUBLIC,authenticated,bookworm_test_rpc_owner');
 await refuses('RPC owner lacks auth.uid execute');
 await db.exec('grant execute on function auth.uid() to bookworm_test_rpc_owner');
 await db.exec('revoke usage on schema auth from bookworm_test_rpc_owner');
 await refuses('RPC owner lacks auth schema usage');
 await db.exec('grant usage on schema auth to bookworm_test_rpc_owner; grant execute on function auth.uid() to PUBLIC');
 await db.exec(`alter table public.data_rights_requests owner to ${owner}; alter function public.submit_delete_data_rights_request(text,text) owner to service_role`);
 await db.exec('revoke all on table public.data_rights_requests from service_role');
 await refuses('bypass role without insert/select on table');
 await db.exec(`grant all on table public.data_rights_requests to service_role; alter function public.submit_delete_data_rights_request(text,text) owner to ${owner}`);
 await db.exec('grant service_role to authenticated');
 await refuses('authenticated can assume BYPASSRLS role');
 await db.exec('revoke service_role from authenticated');
 // A policy for an unrelated role does not apply to authenticated.
 await db.exec('create policy test_unrelated on public.data_rights_requests for insert to bookworm_test_inherited with check (true)');
 await db.exec(stage2);
 await db.exec('drop policy test_unrelated on public.data_rights_requests');
 // Simulate policy/privilege drift after the guarded transaction. The PUBLIC
 // restrictive policy still vetoes direct delete for non-bypass roles.
 await db.exec('create policy test_drift on public.data_rights_requests for insert to PUBLIC with check (true); grant insert (user_id,request_type,status) on public.data_rights_requests to anon');
 await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 await assert.rejects(db.query("insert into public.data_rights_requests(user_id,request_type,status) values($1,'delete','submitted')",[actor]),e=>e.code==='42501','restrictive fence must reject authenticated drift');
 await db.exec('reset role; set role anon');
 await assert.rejects(db.query("insert into public.data_rights_requests(user_id,request_type,status) values($1,'delete','submitted')",[actor]),e=>e.code==='42501','restrictive fence must reject anonymous drift');
 await db.exec('reset role; drop policy test_drift on public.data_rights_requests; revoke insert (user_id,request_type,status) on public.data_rights_requests from anon');
 // Later UPDATE grants and a permissive policy cannot convert an export into
 // an unconfirmed delete because the PUBLIC restrictive update fence applies.
 await db.exec('grant bookworm_test_inherited to authenticated; grant update (request_type) on public.data_rights_requests to bookworm_test_inherited; create policy test_update_drift on public.data_rights_requests for update to bookworm_test_inherited using (true) with check (true)');
 await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 const exported=(await db.query("insert into public.data_rights_requests(user_id,request_type,status) values($1,'export','submitted') returning id",[actor])).rows[0].id;
 await assert.rejects(db.query("update public.data_rights_requests set request_type='delete' where id=$1",[exported]),e=>e.code==='42501','restrictive UPDATE fence must reject drift');
 await db.exec('reset role; drop policy test_update_drift on public.data_rights_requests; revoke update (request_type) on public.data_rights_requests from bookworm_test_inherited; revoke bookworm_test_inherited from authenticated');
 await db.query('delete from public.data_rights_requests where id=$1',[exported]);
 await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 assert.deepEqual((await db.query('select to_jsonb(x) v from public.data_rights_requests x where id=$1',[before.id])).rows[0].v,before,'existing pending request must survive stage 2');
 assert.equal((await db.query('select status from public.cancel_data_rights_request($1)',[before.id])).rows[0].status,'cancelled');
 await db.exec('reset role');
 await db.query('delete from public.data_rights_requests where id=$1',[before.id]);
 await db.exec(await readFile('drafts/data-rights-confirmation/stage-2-enforced.test.sql','utf8'));
 await db.exec(await readFile('tests/security/account-intake-hardening.test.sql','utf8'));
 await db.exec(await readFile('tests/security/account-support.test.sql','utf8'));
 await db.exec(await readFile('tests/security/data-rights-confirmation-rpc.test.sql','utf8'));
 console.log('PASS stage-2 enforcement and old support/export/intake SQL suites');
}finally{await db.close()}
