-- Stage 1: install the confirmation-aware delete-intake RPC. Existing direct
-- INSERT policy is intentionally unchanged until the API fleet has upgraded.
create function public.submit_delete_data_rights_request(p_confirmation text, p_reason text default null)
returns public.data_rights_requests
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid := auth.uid();
  v_reason text;
  v_result public.data_rights_requests;
  v_whitespace constant text:=E' \t\n\r\f'||pg_catalog.chr(11)||pg_catalog.chr(160)||pg_catalog.chr(5760)
    ||pg_catalog.chr(8192)||pg_catalog.chr(8193)||pg_catalog.chr(8194)||pg_catalog.chr(8195)
    ||pg_catalog.chr(8196)||pg_catalog.chr(8197)||pg_catalog.chr(8198)||pg_catalog.chr(8199)
    ||pg_catalog.chr(8200)||pg_catalog.chr(8201)||pg_catalog.chr(8202)||pg_catalog.chr(8232)
    ||pg_catalog.chr(8233)||pg_catalog.chr(8239)||pg_catalog.chr(8287)||pg_catalog.chr(12288)||pg_catalog.chr(65279);
begin
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_confirmation is distinct from 'DELETE MY ACCOUNT' then raise exception 'confirmation required' using errcode='22023'; end if;
  if p_reason is not null and pg_catalog.octet_length(p_reason)>65536 then raise exception 'invalid reason' using errcode='22023'; end if;
  v_reason:=nullif(pg_catalog.btrim(p_reason,v_whitespace),'');
  if v_reason is not null and pg_catalog.char_length(v_reason)+pg_catalog.regexp_count(v_reason,U&'[\+010000-\+10FFFF]')>2000 then
    raise exception 'invalid reason' using errcode='22023';
  end if;
  insert into public.data_rights_requests(user_id,request_type,status,reason)
    values(v_actor,'delete','submitted',v_reason) returning * into v_result;
  return v_result;
end $$;
revoke all on function public.submit_delete_data_rights_request(text,text) from public,anon,authenticated,service_role;
grant execute on function public.submit_delete_data_rights_request(text,text) to authenticated;
