-- Direct authenticated intake is for data export. Account deletion uses the
-- existing confirmation-aware RPC and its private SECURITY DEFINER helper.
do $migration$
declare
  implementation regprocedure := to_regprocedure('private.submit_delete_data_rights_request_internal(text,text)');
  entrypoint regprocedure := to_regprocedure('public.submit_delete_data_rights_request(text,text)');
begin
  set local lock_timeout = '5s';
  if not exists (
    select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
    join pg_class c on c.oid = 'public.data_rights_requests'::regclass
    where p.oid = implementation and p.prosecdef and p.prorettype = c.reltype
      and c.relrowsecurity and (r.rolsuper or r.rolbypassrls or (p.proowner = c.relowner and not c.relforcerowsecurity))
  ) or not exists (
    select 1 from pg_proc
    where oid = entrypoint and not prosecdef and prorettype = 'public.data_rights_requests'::regtype
  ) or not has_function_privilege('authenticated', entrypoint, 'EXECUTE')
    or not has_function_privilege('authenticated', implementation, 'EXECUTE') then
    raise exception 'The confirmed account deletion function is not ready for direct intake restriction.';
  end if;

  create policy data_rights_direct_export_only on public.data_rights_requests
    as restrictive for insert to authenticated
    with check (request_type = 'export');

  revoke all privileges on table public.data_rights_requests from public, anon, authenticated;
  revoke all privileges (id, user_id, request_type, status, reason, requested_at, due_at, updated_at, completed_at)
    on public.data_rights_requests from public, anon, authenticated;
  grant select on public.data_rights_requests to authenticated;
  grant insert (user_id, request_type, status, reason) on public.data_rights_requests to authenticated;
end
$migration$;
