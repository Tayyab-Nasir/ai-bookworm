create function public.claim_translation_quote_request() returns setof public.translation_quote_requests
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_request public.translation_quote_requests;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  -- A crashed counting call has an unknown outcome. Never silently repeat it.
  update public.translation_quote_requests set status='failed',error_code='counting_outcome_unknown',lease_token=null,lease_expires_at=null
    where status='running' and lease_expires_at<=clock_timestamp();
  select * into v_request from public.translation_quote_requests where status='queued' order by created_at,id for update skip locked limit 1;
  if not found then return; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=v_request.workspace_id and user_id=v_request.user_id
    and status='active' and role in ('owner','admin','editor','writer')) then
    update public.translation_quote_requests set status='failed',error_code='editing_access_revoked' where id=v_request.id; return;
  end if;
  update public.translation_quote_requests set status='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '120 seconds'
    where id=v_request.id returning * into v_request;
  return next v_request;
end $$;

create function public.record_translation_quote_count(p_request_id uuid,p_lease_token uuid,p_job_id uuid,p_count jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_request public.translation_quote_requests;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_request from public.translation_quote_requests where id=p_request_id for update;
  if not found or v_request.status<>'running' or v_request.lease_token is distinct from p_lease_token or v_request.lease_expires_at<=clock_timestamp() then
    raise exception 'quote lease lost' using errcode='40001'; end if;
  if not exists(select 1 from jsonb_array_elements(v_request.chapters_json) c where c->>'jobId'=p_job_id::text)
    or coalesce(p_count->>'inputSha256','')!~'^[a-f0-9]{64}$'
    or coalesce(p_count->>'inputTokens','')!~'^[1-9][0-9]{0,6}$'
    or (p_count->>'inputTokens')::integer>2000000
    or not exists(select 1 from jsonb_array_elements(v_request.catalog_json->'entries') e where e->>'id'=v_request.model_id and e#>>'{price,model}'=p_count->>'model') then
    raise exception 'invalid translation count receipt' using errcode='22023'; end if;
  if v_request.counts_json ? p_job_id::text then raise exception 'count already recorded' using errcode='23505'; end if;
  update public.translation_quote_requests set counts_json=counts_json||jsonb_build_object(p_job_id::text,p_count),status='queued',lease_token=null,lease_expires_at=null
    where id=p_request_id;
  return true;
end $$;

create function public.fail_translation_quote_request(p_request_id uuid,p_lease_token uuid) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  update public.translation_quote_requests set status='failed',error_code='quote_preparation_failed',lease_token=null,lease_expires_at=null
    where id=p_request_id and status='running' and lease_token=p_lease_token;
  return found;
end $$;

create function public.complete_translation_quote_request(p_request_id uuid,p_lease_token uuid,p_chapters jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_request public.translation_quote_requests; v_item jsonb; v_total bigint:=0; v_expiry timestamptz;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_request from public.translation_quote_requests where id=p_request_id for update;
  if not found then raise exception 'quote request missing' using errcode='P0002'; end if;
  if v_request.status='ready' then return v_request.proposal_id; end if;
  if v_request.status<>'running' or v_request.lease_token is distinct from p_lease_token or v_request.lease_expires_at<=clock_timestamp() then
    raise exception 'quote lease lost' using errcode='40001'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=v_request.workspace_id and user_id=v_request.user_id
    and status='active' and role in ('owner','admin','editor','writer')) then raise exception 'editing access required' using errcode='42501'; end if;
  if jsonb_typeof(p_chapters) is distinct from 'array' or jsonb_array_length(p_chapters)<>jsonb_array_length(v_request.chapters_json)
    or (select jsonb_agg(c-'quote' order by ord) from jsonb_array_elements(p_chapters) with ordinality a(c,ord)) is distinct from v_request.chapters_json then
    raise exception 'proposal chapters changed' using errcode='22023'; end if;
  for v_item in select value from jsonb_array_elements(p_chapters) loop
    if not (v_request.counts_json ? (v_item->>'jobId'))
      or v_item#>>'{quote,scope,inputSha256}' is distinct from v_request.counts_json#>>array[v_item->>'jobId','inputSha256']
      or v_item#>>'{quote,scope,jobId}' is distinct from v_item->>'jobId'
      or v_item#>>'{quote,scope,userId}' is distinct from v_request.user_id::text
      or v_item#>>'{quote,scope,workspaceId}' is distinct from v_request.workspace_id::text
      or coalesce(v_item#>>'{quote,reservedCredits}','')!~'^[1-9][0-9]{0,9}$'
      or v_item#>>'{quote,expiresAt}' is null then raise exception 'proposal count scope mismatch' using errcode='22023'; end if;
    v_total:=v_total+(v_item#>>'{quote,reservedCredits}')::integer;
    v_expiry:=least(v_expiry,(v_item#>>'{quote,expiresAt}')::timestamptz);
  end loop;
  if v_expiry<=clock_timestamp() or v_expiry>(v_request.catalog_json->>'expiresAt')::timestamptz or v_total>2147483647 then
    raise exception 'proposal expired or exceeds ledger capacity' using errcode='22023'; end if;
  insert into public.translation_quote_proposals(id,user_id,workspace_id,book_id,source_language,target_language,catalog_version,chapters_json,reserved_credits,expires_at)
    values(v_request.id,v_request.user_id,v_request.workspace_id,v_request.book_id,v_request.source_language,v_request.target_language,
      v_request.catalog_json->>'version',p_chapters,v_total::integer,v_expiry);
  update public.translation_quote_requests set status='ready',proposal_id=id,lease_token=null,lease_expires_at=null where id=p_request_id;
  return p_request_id;
end $$;
revoke all on function public.claim_translation_quote_request() from public,anon,authenticated;
revoke all on function public.record_translation_quote_count(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.fail_translation_quote_request(uuid,uuid) from public,anon,authenticated;
revoke all on function public.complete_translation_quote_request(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_translation_quote_request() to service_role;
grant execute on function public.record_translation_quote_count(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.fail_translation_quote_request(uuid,uuid) to service_role;
grant execute on function public.complete_translation_quote_request(uuid,uuid,jsonb) to service_role;
