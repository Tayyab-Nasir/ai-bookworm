-- Leased, one-way-dispatch metadata generation using the existing private AI
-- result receipt and funded-usage settlement ledger.

create function public.claim_quoted_metadata_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_request public.metadata_token_quote_requests;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds not between 30 and 600 then raise exception 'invalid metadata lease' using errcode='22023'; end if;
  select j.* into v_job from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    where j.agent_type='metadata' and j.billing_mode='quoted'
      and ((j.status='queued' and q.status='held' and q.dispatched_at is null)
        or (j.status='running' and j.lease_expires_at<=clock_timestamp()
          and q.status in ('held','settled') and q.dispatched_at is not null))
    order by j.created_at,j.id for update of j skip locked limit 1;
  if not found then return; end if;
  select * into v_request from public.metadata_token_quote_requests
    where id=(v_job.input_ref->>'metadataQuoteRequestId')::uuid for update;
  if not found or v_request.accepted_job_id is distinct from v_job.id or v_request.user_id is distinct from v_job.created_by
    or v_request.workspace_id is distinct from v_job.workspace_id or v_request.book_id is distinct from v_job.book_id
    or v_request.generation_request_sha256 is distinct from v_job.input_ref->>'generationRequestSha256' then
    raise exception 'metadata quote/job identity mismatch' using errcode='22023'; end if;
  if v_job.status='queued' then
    if exists(select 1 from jsonb_each(v_request.generation_request_json#>'{input,chapters}') chapter
      where not exists(select 1 from public.chapters c join public.document_versions d
          on d.id=c.current_document_version_id and d.chapter_id=c.id
        where c.id=chapter.key::uuid and c.book_id=v_job.book_id
          and d.id=(chapter.value->>'documentVersionId')::uuid)) then
      raise exception 'metadata source version changed before dispatch' using errcode='40001'; end if;
  elsif not exists(select 1 from public.funded_usage_quotes q where q.job_id=v_job.id and q.dispatched_at is not null) then
    raise exception 'metadata recovery cannot dispatch again' using errcode='23514';
  end if;
  update public.ai_jobs set status='running',lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),started_at=coalesce(started_at,clock_timestamp())
    where id=v_job.id returning * into v_job;
  return next v_job;
end $$;

create function public.renew_quoted_metadata_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds not between 30 and 600 then raise exception 'invalid metadata lease' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and agent_type='metadata' and billing_mode='quoted' and status='running'
      and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.fail_quoted_metadata_before_dispatch(p_job_id uuid,p_lease_token uuid,p_reason text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes; v_code text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_reason not in ('source_changed','request_mismatch') then raise exception 'invalid metadata failure reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.agent_type<>'metadata' or v_job.billing_mode<>'quoted' or v_job.status<>'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'metadata job lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is not null then
    raise exception 'dispatched metadata request cannot be released' using errcode='23514'; end if;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',p_job_id);
  update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
    'status','cancelled','reason',p_reason,'releaseCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint')
    where job_id=p_job_id;
  v_code:=case when p_reason='source_changed' then 'metadata_source_changed_before_dispatch' else 'metadata_request_mismatch_before_dispatch' end;
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code=v_code,error_message='Metadata request could not be verified before dispatch.' where id=p_job_id;
  return true;
end $$;

create function public.mark_quoted_metadata_requires_review(p_job_id uuid,p_lease_token uuid,p_reason text,p_request_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes; v_settlement jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_reason not in ('provider_outcome_unknown','invalid_result','unreconciled_receipt')
    or coalesce(length(trim(p_request_id)),0) not between 1 and 256 then raise exception 'invalid metadata review reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.agent_type<>'metadata' or v_job.billing_mode<>'quoted' or v_job.status<>'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'metadata job lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status not in ('held','requires_review') or v_quote.dispatched_at is null then
    raise exception 'metadata review requires a dispatched held quote' using errcode='23514'; end if;
  if v_quote.status='held' then
    v_settlement:=jsonb_build_object('status','requires_review','requestId',trim(p_request_id),
      'reason',p_reason,'heldCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint');
    perform public.settle_funded_usage_quote(p_job_id,v_settlement);
  end if;
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code='metadata_generation_requires_review',error_message='Metadata generation requires billing review.' where id=p_job_id;
  return true;
end $$;

revoke all on function public.claim_quoted_metadata_job(integer) from public,anon,authenticated;
revoke all on function public.renew_quoted_metadata_lease(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.fail_quoted_metadata_before_dispatch(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.mark_quoted_metadata_requires_review(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_quoted_metadata_job(integer) to service_role;
grant execute on function public.renew_quoted_metadata_lease(uuid,uuid,integer) to service_role;
grant execute on function public.fail_quoted_metadata_before_dispatch(uuid,uuid,text) to service_role;
grant execute on function public.mark_quoted_metadata_requires_review(uuid,uuid,text,text) to service_role;

comment on function public.claim_quoted_metadata_job(integer) is
  'Leases an accepted funded metadata quote and revalidates source versions before the first dispatch.';
