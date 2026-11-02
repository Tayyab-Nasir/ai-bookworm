-- STAGE 2: manual review artifact, intentionally outside supabase/migrations.
-- Apply only after every API instance uses submit_delete_data_rights_request.
-- This is atomic: a failed catalog preflight rolls back without changing policy.
begin;
-- Serialize policy DDL and wait for in-flight direct inserts before inspecting.
lock table public.data_rights_requests in share row exclusive mode;
do $guard$
declare
  v_relation oid := 'public.data_rights_requests'::pg_catalog.regclass;
  v_authenticated oid := 'authenticated'::pg_catalog.regrole;
  v_anon oid := 'anon'::pg_catalog.regrole;
  v_rpc oid := pg_catalog.to_regprocedure('public.submit_delete_data_rights_request(text,text)');
  v_cancel oid := pg_catalog.to_regprocedure('public.cancel_data_rights_request(uuid)');
begin
  if not exists(select 1 from pg_catalog.pg_class where oid=v_relation and relrowsecurity) then
    raise exception 'data request row security is not enabled' using errcode='55000';
  end if;
  -- RLS cannot protect a role that can become an owner, superuser or bypass role.
  if exists(select 1 from pg_catalog.pg_roles r cross join pg_catalog.pg_class c
    where c.oid=v_relation and (r.rolsuper or r.rolbypassrls or r.oid=c.relowner)
      and (pg_catalog.pg_has_role(v_authenticated,r.oid,'MEMBER') or pg_catalog.pg_has_role(v_anon,r.oid,'MEMBER'))) then
    raise exception 'client can assume a row security bypass role' using errcode='55000';
  end if;
  -- No anonymous role may have direct INSERT; authenticated may insert only
  -- the four fields required by the current export API, never server fields.
  if pg_catalog.has_any_column_privilege(v_anon,v_relation,'INSERT')
     or pg_catalog.has_table_privilege(v_authenticated,v_relation,'INSERT')
     or exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=v_relation
       and a.attnum>0 and not a.attisdropped
       and a.attname not in ('user_id','request_type','status','reason')
       and pg_catalog.has_column_privilege(v_authenticated,v_relation,a.attnum,'INSERT')) then
    raise exception 'unexpected direct insert privilege' using errcode='55000';
  end if;
  -- Do not allow role membership or column grants to turn an export into a
  -- delete request, or to remove/modify records outside the cancellation RPC.
  if exists(select 1 from pg_catalog.unnest(array[v_authenticated,v_anon]) client_role
    where pg_catalog.has_any_column_privilege(client_role,v_relation,'UPDATE')
      or pg_catalog.has_table_privilege(client_role,v_relation,'DELETE')
      or pg_catalog.has_table_privilege(client_role,v_relation,'TRUNCATE')
      or pg_catalog.has_table_privilege(client_role,v_relation,'TRIGGER')
      or pg_catalog.has_any_column_privilege(client_role,v_relation,'REFERENCES')) then
    raise exception 'unexpected client mutation privilege' using errcode='55000';
  end if;
  if not pg_catalog.has_schema_privilege(v_authenticated,'public','USAGE')
     or not pg_catalog.has_schema_privilege(v_authenticated,'auth','USAGE')
     or not pg_catalog.has_function_privilege(v_authenticated,pg_catalog.to_regprocedure('auth.uid()'),'EXECUTE')
     or not pg_catalog.has_table_privilege(v_authenticated,v_relation,'SELECT')
     or exists(select 1 from pg_catalog.unnest(array['user_id','request_type','status','reason']) col
       where not pg_catalog.has_column_privilege(v_authenticated,v_relation,col,'INSERT')) then
    raise exception 'legacy export client dependency unavailable' using errcode='55000';
  end if;
  -- Ensure the intended RPC is installed, protected and can insert under the
  -- actual FORCE RLS and function-owner configuration. Do not alter FORCE RLS.
  if v_rpc is null or not exists(
    select 1 from pg_catalog.pg_proc f join pg_catalog.pg_roles owner_role on owner_role.oid=f.proowner
      join pg_catalog.pg_class c on c.oid=v_relation
    where f.oid=v_rpc and f.prosecdef
      and pg_catalog.has_function_privilege(v_authenticated,f.oid,'EXECUTE')
      and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE')
      -- BYPASSRLS does not grant table/schema/function permissions. Verify the
      -- explicit dependencies used by the reviewed function and RETURNING *.
      and pg_catalog.has_schema_privilege(f.proowner,'public','USAGE')
      and pg_catalog.has_schema_privilege(f.proowner,'auth','USAGE')
      and pg_catalog.has_function_privilege(f.proowner,pg_catalog.to_regprocedure('auth.uid()'),'EXECUTE')
      and pg_catalog.has_table_privilege(f.proowner,v_relation,'INSERT')
      and pg_catalog.has_table_privilege(f.proowner,v_relation,'SELECT')
      and (owner_role.rolsuper or owner_role.rolbypassrls or (f.proowner=c.relowner and not c.relforcerowsecurity))
  ) then
    raise exception 'confirmation RPC is unavailable or cannot safely insert' using errcode='55000';
  end if;
  -- Existing cancellation uses a separate security-definer RPC. Its owner must
  -- retain the permissions and RLS bypass needed after the restrictive fence.
  if v_cancel is null or not exists(
    select 1 from pg_catalog.pg_proc f join pg_catalog.pg_roles owner_role on owner_role.oid=f.proowner
      join pg_catalog.pg_class c on c.oid=v_relation
    where f.oid=v_cancel and f.prosecdef
      and pg_catalog.has_function_privilege(v_authenticated,f.oid,'EXECUTE')
      and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE')
      and pg_catalog.has_schema_privilege(f.proowner,'public','USAGE')
      and pg_catalog.has_schema_privilege(f.proowner,'auth','USAGE')
      and pg_catalog.has_function_privilege(f.proowner,pg_catalog.to_regprocedure('auth.uid()'),'EXECUTE')
      and pg_catalog.has_table_privilege(f.proowner,v_relation,'UPDATE')
      and pg_catalog.has_table_privilege(f.proowner,v_relation,'SELECT')
      and (owner_role.rolsuper or owner_role.rolbypassrls or (f.proowner=c.relowner and not c.relforcerowsecurity))
  ) then
    raise exception 'cancellation RPC is unavailable or cannot safely update' using errcode='55000';
  end if;
  -- A preexisting fence name may belong to an unrelated restrictive policy.
  -- This one-time cutover must never silently replace an unknown safeguard.
  if exists(select 1 from pg_catalog.pg_policy p where p.polrelid=v_relation and p.polname in
      ('data_rights_delete_confirmation_fence','data_rights_delete_confirmation_update_fence')) then
    raise exception 'confirmation fence name already exists' using errcode='55000';
  end if;
  -- Permissive policies are ORed. Refuse other INSERT/UPDATE/ALL policies that
  -- could apply to a client through PUBLIC, anonymous, or inherited roles.
  if exists(
    select 1 from pg_catalog.pg_policy p cross join lateral pg_catalog.unnest(p.polroles) role_id
    where p.polrelid=v_relation and p.polpermissive and p.polcmd in ('a','w','*')
      and p.polname<>'data_rights_owner_insert'
      and case when role_id=0 then true else pg_catalog.pg_has_role(v_authenticated,role_id,'MEMBER') or pg_catalog.pg_has_role(v_anon,role_id,'MEMBER') end
  ) then
    raise exception 'additional permissive insert policy applies to authenticated' using errcode='55000';
  end if;
end $guard$;
drop policy if exists data_rights_owner_insert on public.data_rights_requests;
create policy data_rights_owner_insert on public.data_rights_requests for insert to authenticated
with check (
  user_id = (select auth.uid()) and status = 'submitted'
  and request_type = 'export'
  and (reason is null or (char_length(reason) + regexp_count(reason, U&'[\+010000-\+10FFFF]')) <= 2000)
);
-- Defense in depth against later permissive INSERT policies on non-bypass roles.
create policy data_rights_delete_confirmation_fence on public.data_rights_requests
  as restrictive for insert to public with check (request_type='export');
-- Prevent a later permissive UPDATE from converting an export into delete.
create policy data_rights_delete_confirmation_update_fence on public.data_rights_requests
  as restrictive for update to public with check (request_type='export');
commit;
