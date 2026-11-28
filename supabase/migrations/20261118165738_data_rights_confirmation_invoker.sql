-- Move the existing implementation so the Data API exposes an invoker.
-- The hosted rollout can install both stages in one transaction.
do $migration$
declare
  entrypoint regprocedure := to_regprocedure('public.submit_delete_data_rights_request(text,text)');
  implementation regprocedure := to_regprocedure('private.submit_delete_data_rights_request_internal(text,text)');
begin
  if implementation is null then
    if not exists (
      select 1 from pg_catalog.pg_proc
      where oid = entrypoint and prosecdef and prorettype = 'public.data_rights_requests'::regtype
    ) then
      raise exception 'Expected the confirmed data-rights intake function';
    end if;
    alter function public.submit_delete_data_rights_request(text,text) set schema private;
    alter function private.submit_delete_data_rights_request(text,text) rename to submit_delete_data_rights_request_internal;
  elsif not exists (
    select 1 from pg_catalog.pg_proc
    where oid = implementation and prosecdef and prorettype = 'public.data_rights_requests'::regtype
  ) or not exists (
    select 1 from pg_catalog.pg_proc
    where oid = entrypoint and not prosecdef and prorettype = 'public.data_rights_requests'::regtype
  ) then
    raise exception 'Unexpected data-rights intake function layout';
  end if;
end
$migration$;

create or replace function public.submit_delete_data_rights_request(p_confirmation text, p_reason text default null)
returns public.data_rights_requests
language sql security invoker set search_path = '' as $$
  select private.submit_delete_data_rights_request_internal(p_confirmation, p_reason);
$$;

revoke all on function private.submit_delete_data_rights_request_internal(text,text),
  public.submit_delete_data_rights_request(text,text) from public, anon, authenticated, service_role;
grant execute on function private.submit_delete_data_rights_request_internal(text,text),
  public.submit_delete_data_rights_request(text,text) to authenticated;
