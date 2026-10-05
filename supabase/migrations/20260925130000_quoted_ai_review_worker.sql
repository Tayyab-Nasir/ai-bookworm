-- Separate funded-review leasing, one-way dispatch recovery and atomic
-- measured settlement from the legacy operational-credit worker.

create function public.claim_quoted_ai_review_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes; v_request public.ai_review_token_quote_requests; v_source jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid AI review quote lease' using errcode='22023'; end if;

  -- Expired, undispatched holds are safely released before any worker can claim
  -- them. A marked dispatch is never automatically refunded or repeated.
  for v_job in select j.* from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    where j.billing_mode='quoted' and j.agent_type in ('writer','proofreader','copyeditor','consistency')
      and j.status='queued' and q.status='held' and q.dispatched_at is null
      and (q.quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
    order by j.created_at,j.id for update of j,q skip locked limit 25
  loop
    select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
    insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
      values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',v_job.id);
    update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
      'status','cancelled','reason','quote_expired_before_dispatch','releaseCredits',v_quote.reserved_credits::text,
      'fingerprint',v_quote.quote_json->>'fingerprint') where job_id=v_job.id;
    update public.ai_jobs set status='failed',error_code='ai_review_quote_expired_before_dispatch',
      error_message='AI review quote expired before provider dispatch.',completed_at=clock_timestamp()
      where id=v_job.id;
  end loop;

  select j.* into v_job from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    where j.billing_mode='quoted' and j.agent_type in ('writer','proofreader','copyeditor','consistency')
      and ((j.status='queued' and q.status='held' and q.dispatched_at is null)
        or (j.status='running' and j.lease_expires_at<=clock_timestamp() and q.status='held' and q.dispatched_at is not null))
    order by j.available_at,j.created_at,j.id for update of j,q skip locked limit 1;
  if not found then return; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
  select * into v_request from public.ai_review_token_quote_requests
    where id=(v_job.input_ref->>'aiReviewQuoteRequestId')::uuid for update;
  if not found or v_request.accepted_job_id is distinct from v_job.id or v_request.user_id is distinct from v_job.created_by
    or v_request.workspace_id is distinct from v_job.workspace_id or v_request.book_id is distinct from v_job.book_id
    or v_request.request_sha256 is distinct from v_job.input_ref->>'generationRequestSha256'
    or v_quote.user_id is distinct from v_job.created_by or v_quote.workspace_id is distinct from v_job.workspace_id
    or v_quote.status<>'held' then
    raise exception 'quoted AI review job identity or funding mismatch' using errcode='22023'; end if;
  if v_job.status='queued' then
    if (v_quote.quote_json->>'expiresAt')::timestamptz<=clock_timestamp() then
      raise exception 'AI review quote expired before dispatch' using errcode='40001'; end if;
    for v_source in select value from jsonb_array_elements(v_request.source_versions_json)
    loop
      if not exists(select 1 from public.chapters c join public.document_versions d
          on d.id=c.current_document_version_id and d.chapter_id=c.id
        where c.id=(v_source->>'chapterId')::uuid and c.book_id=v_job.book_id
          and d.id=(v_source->>'documentVersionId')::uuid and d.version_number=(v_source->>'version')::integer) then
        raise exception 'AI review source version changed before dispatch' using errcode='40001'; end if;
    end loop;
  elsif v_quote.dispatched_at is null then
    raise exception 'quoted AI review recovery cannot dispatch again' using errcode='23514';
  end if;
  update public.ai_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    started_at=coalesce(started_at,clock_timestamp()),completed_at=null
    where id=v_job.id returning * into v_job;
  return next v_job;
end $$;

create function public.renew_quoted_ai_review_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid AI review lease' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and billing_mode='quoted' and agent_type in ('writer','proofreader','copyeditor','consistency')
      and status='running' and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.hold_quoted_ai_review_for_review(p_job_id uuid,p_lease_token uuid,p_reason text,p_request_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_reason not in ('provider_outcome_unknown','invalid_result','usage_unreconciled')
    or coalesce(length(trim(p_request_id)),0) not between 1 and 256 then
    raise exception 'invalid AI review hold reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.billing_mode<>'quoted' or v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at<=clock_timestamp() then raise exception 'AI review quote lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is null then
    raise exception 'AI review hold requires a dispatched funded quote' using errcode='23514'; end if;
  perform public.settle_funded_usage_quote(p_job_id,jsonb_build_object('status','requires_review','requestId',trim(p_request_id),
    'reason',p_reason,'heldCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint'));
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code='ai_review_requires_billing_review',error_message='AI review result is held for billing and provider review.'
    where id=p_job_id;
  return true;
end $$;

create function public.release_quoted_ai_review_before_dispatch(p_job_id uuid,p_lease_token uuid,p_reason text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_reason not in ('source_changed','request_mismatch') then raise exception 'invalid pre-dispatch reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.billing_mode<>'quoted' or v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at<=clock_timestamp() then raise exception 'AI review lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is not null then
    raise exception 'dispatched AI review cannot be released' using errcode='23514'; end if;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',p_job_id);
  update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
    'status','cancelled','reason',p_reason,'releaseCredits',v_quote.reserved_credits::text,
    'fingerprint',v_quote.quote_json->>'fingerprint') where job_id=p_job_id;
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code=case when p_reason='source_changed' then 'ai_review_source_changed_before_dispatch' else 'ai_review_request_mismatch_before_dispatch' end,
    error_message='AI review request could not be verified before provider dispatch.' where id=p_job_id;
  return true;
end $$;

create function public.complete_quoted_ai_review_job(
  p_job_id uuid,p_lease_token uuid,p_provider text,p_model text,p_usage jsonb,
  p_diagnostics jsonb,p_suggestions jsonb,p_settlement jsonb
) returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes; v_result public.ai_jobs;
  v_measured_input numeric; v_measured_cached numeric; v_measured_output numeric;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.billing_mode<>'quoted' or v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at<=clock_timestamp() then raise exception 'AI review quote lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is null
    or v_quote.quote_json#>>'{price,model}' is distinct from p_model
    or v_quote.quote_json#>>'{price,provider}' is distinct from p_provider
    or p_settlement->>'status' is distinct from 'settle' then
    raise exception 'AI review funded receipt mismatch' using errcode='23514'; end if;
  if jsonb_typeof(p_usage->'measuredTokens') is distinct from 'array'
    or jsonb_typeof(p_settlement->'tokens') is distinct from 'array'
    or p_usage->'measuredTokens' is distinct from p_settlement->'tokens' then
    raise exception 'AI review measured usage does not match its settlement' using errcode='23514'; end if;
  select coalesce(sum((item->>'tokens')::numeric) filter(where item->>'dimension'='text_input'),0),
    coalesce(sum((item->>'tokens')::numeric) filter(where item->>'dimension'='text_cached_input'),0),
    coalesce(sum((item->>'tokens')::numeric) filter(where item->>'dimension'='text_output'),0)
    into v_measured_input,v_measured_cached,v_measured_output
    from jsonb_array_elements(p_usage->'measuredTokens') as measured(item);
  if (p_usage->>'inputTokens')::numeric is distinct from v_measured_input+v_measured_cached
    or (p_usage->>'outputTokens')::numeric is distinct from v_measured_output then
    raise exception 'AI review aggregate usage does not match measured tokens' using errcode='23514'; end if;
  perform public.settle_funded_usage_quote(p_job_id,p_settlement);
  select * into v_result from public.complete_ai_job(p_job_id,p_provider,p_model,p_usage,p_diagnostics,p_suggestions,0);
  update public.ai_jobs set lease_token=null,lease_expires_at=null where id=p_job_id returning * into v_result;
  return v_result;
end $$;

revoke all on function public.claim_quoted_ai_review_job(integer),
  public.renew_quoted_ai_review_lease(uuid,uuid,integer),
  public.hold_quoted_ai_review_for_review(uuid,uuid,text,text),
  public.release_quoted_ai_review_before_dispatch(uuid,uuid,text),
  public.complete_quoted_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.claim_quoted_ai_review_job(integer),
  public.renew_quoted_ai_review_lease(uuid,uuid,integer),
  public.hold_quoted_ai_review_for_review(uuid,uuid,text,text),
  public.release_quoted_ai_review_before_dispatch(uuid,uuid,text),
  public.complete_quoted_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;
