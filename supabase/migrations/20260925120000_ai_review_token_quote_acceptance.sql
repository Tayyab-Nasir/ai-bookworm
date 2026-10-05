-- Explicit author acceptance atomically creates one quoted review job and holds
-- its token-credit maximum. Quote preparation alone never creates a job.

alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check (
  (billing_mode='quoted' and agent_type in ('translator','story_blueprint','metadata','writer','proofreader','copyeditor','consistency'))
  or (billing_mode='operational' and agent_type<>'story_blueprint')
);

alter table public.ai_review_token_quote_requests
  add column accepted_job_id uuid unique references public.ai_jobs(id) on delete restrict,
  add column accepted_at timestamptz,
  add constraint ai_review_quote_acceptance_pair check ((accepted_job_id is null)=(accepted_at is null));

create or replace function public.guard_ai_review_token_quote_request() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if (to_jsonb(new)-array['status','lease_token','lease_expires_at','error_code','request_sha256',
      'counted_input_tokens','usage_quote_json','accepted_job_id','accepted_at']) is distinct from
     (to_jsonb(old)-array['status','lease_token','lease_expires_at','error_code','request_sha256',
      'counted_input_tokens','usage_quote_json','accepted_job_id','accepted_at']) then
    raise exception 'AI review token quote snapshot is immutable' using errcode='23514'; end if;
  if new.status is distinct from old.status and not ((old.status='counting' and new.status in ('ready','failed'))
    or (old.status='failed' and new.status='counting')) then
    raise exception 'invalid AI review quote transition' using errcode='23514'; end if;
  if old.usage_quote_json is not null and (new.usage_quote_json is distinct from old.usage_quote_json
    or new.request_sha256 is distinct from old.request_sha256
    or new.counted_input_tokens is distinct from old.counted_input_tokens) then
    raise exception 'ready AI review quote is immutable' using errcode='23514'; end if;
  if old.accepted_job_id is not null and (new.accepted_job_id is distinct from old.accepted_job_id
    or new.accepted_at is distinct from old.accepted_at) then
    raise exception 'accepted AI review quote is immutable' using errcode='23514'; end if;
  return new;
end $$;

create function public.accept_ai_review_token_quote(p_request_id uuid,p_user_id uuid,p_expected_credits integer)
returns public.ai_jobs language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare
  v_quote public.ai_review_token_quote_requests;
  v_job public.ai_jobs;
  v_role text;
  v_source jsonb;
  v_request jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_quote from public.ai_review_token_quote_requests where id=p_request_id for update;
  if not found or v_quote.user_id is distinct from p_user_id then raise exception 'AI review quote not found' using errcode='P0002'; end if;
  select role::text into v_role from public.workspace_members where workspace_id=v_quote.workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then
    raise exception 'AI review quote requires writing access' using errcode='42501'; end if;
  if v_quote.accepted_job_id is not null then
    if p_expected_credits is distinct from (v_quote.usage_quote_json->>'reservedCredits')::integer then
      raise exception 'AI review quote confirmation mismatch' using errcode='23514'; end if;
    select * into v_job from public.ai_jobs where id=v_quote.accepted_job_id;
    if not found then raise exception 'accepted AI review job missing' using errcode='P0002'; end if;
    return v_job;
  end if;
  if v_quote.status<>'ready' or v_quote.usage_quote_json is null or v_quote.request_sha256 is null
    or p_expected_credits is distinct from (v_quote.usage_quote_json->>'reservedCredits')::integer
    or (v_quote.usage_quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
    or v_quote.catalog_json->'approved' is distinct from 'true'::jsonb
    or v_quote.usage_quote_json#>>'{scope,jobId}' is distinct from v_quote.generation_job_id::text
    or v_quote.usage_quote_json#>>'{scope,userId}' is distinct from v_quote.user_id::text
    or v_quote.usage_quote_json#>>'{scope,workspaceId}' is distinct from v_quote.workspace_id::text
    or v_quote.usage_quote_json#>>'{scope,inputSha256}' is distinct from v_quote.request_sha256
    or v_quote.usage_quote_json#>>'{price,provider}' is distinct from 'openai' then
    raise exception 'AI review quote expired or confirmation mismatch' using errcode='23514'; end if;
  if not exists(select 1 from public.books where id=v_quote.book_id and workspace_id=v_quote.workspace_id for share) then
    raise exception 'AI review book scope mismatch' using errcode='22023'; end if;

  v_request:=v_quote.generation_request_json;
  if v_request->>'jobId' is distinct from v_quote.generation_job_id::text
    or v_request->>'workspaceId' is distinct from v_quote.workspace_id::text
    or v_request->>'bookId' is distinct from v_quote.book_id::text
    or v_request->>'agentType' not in ('writer','proofreader','copyeditor','consistency')
    or v_request->>'model' is distinct from v_quote.usage_quote_json#>>'{price,model}'
    or v_quote.usage_quote_json#>>'{price,provider}' is distinct from 'openai'
    or jsonb_typeof(v_quote.source_versions_json) is distinct from 'array'
    or jsonb_array_length(v_quote.source_versions_json)<>jsonb_array_length(v_request#>'{input,chapterIds}') then
    raise exception 'AI review quote request is invalid' using errcode='22023'; end if;
  for v_source in select value from jsonb_array_elements(v_quote.source_versions_json) loop
    if not exists(select 1 from public.chapters c join public.document_versions d
        on d.id=c.current_document_version_id and d.chapter_id=c.id
      where c.id=(v_source->>'chapterId')::uuid and c.book_id=v_quote.book_id
        and d.id=(v_source->>'documentVersionId')::uuid and d.version_number=(v_source->>'version')::integer)
      or not exists(select 1 from jsonb_array_elements_text(v_request#>'{input,chapterIds}') c(id)
        where c.id=v_source->>'chapterId') then
      raise exception 'AI review source version changed; prepare a new quote' using errcode='40001'; end if;
  end loop;
  if exists(select 1 from public.ai_jobs j where j.book_id=v_quote.book_id and j.created_by=p_user_id
    and j.agent_type in ('writer','proofreader','copyeditor','consistency') and j.status in ('queued','running')) then
    raise exception 'AI review request already active for this book' using errcode='23505'; end if;

  insert into public.ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,status,input_ref,idempotency_key,created_by,model)
    values(v_quote.generation_job_id,v_quote.workspace_id,v_quote.book_id,v_request->>'agentType','quoted','queued',
      jsonb_build_object('aiReviewQuoteRequestId',v_quote.id,'generationRequestSha256',v_quote.request_sha256,
        'chapterVersions',v_quote.source_versions_json,'userInstruction',v_request#>>'{input,userInstruction}',
        'contextPolicy',v_request->'contextPolicy','maxOutputTokens',v_request->'maxOutputTokens'),
      'ai-review-quote:'||v_quote.id::text,p_user_id,v_request->>'model') returning * into v_job;
  perform public.reserve_funded_usage_quote(v_quote.usage_quote_json);
  update public.ai_review_token_quote_requests set accepted_job_id=v_job.id,accepted_at=clock_timestamp() where id=v_quote.id;
  return v_job;
end $$;

-- The operational review worker must never claim a token-credit funded job.
create or replace function public.claim_ai_review_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  for v_job in select * from public.ai_jobs where billing_mode='operational'
    and agent_type in ('writer','proofreader','copyeditor','consistency') and (
      (status='queued' and available_at<=clock_timestamp()) or
      (status='running' and provider_dispatched_at is null and lease_expires_at<=clock_timestamp())
    ) order by available_at,created_at,id for update skip locked limit 100
  loop
    if v_job.attempts >= 5 then
      update public.ai_jobs set status='failed',error_code='ai_attempts_exhausted',error_message='AI review attempts exhausted',
        lease_token=null,lease_expires_at=null,completed_at=clock_timestamp() where id=v_job.id;
      insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
        values('jobs.ai','ai_review',v_job.id,jsonb_build_object('jobId',v_job.id),v_job.attempts,'ai_attempts_exhausted');
      continue;
    end if;
    update public.ai_jobs set status='running',attempts=attempts+1,started_at=coalesce(started_at,clock_timestamp()),
      completed_at=null,error_code=null,error_message=null,lease_token=gen_random_uuid(),
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
      where id=v_job.id returning * into v_job;
    return next v_job; return;
  end loop;
end $$;

revoke all on function public.accept_ai_review_token_quote(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.accept_ai_review_token_quote(uuid,uuid,integer) to service_role;
revoke all on function public.claim_ai_review_job(integer) from public,anon,authenticated;
grant execute on function public.claim_ai_review_job(integer) to service_role;

comment on function public.accept_ai_review_token_quote(uuid,uuid,integer) is
  'Author-confirmed token quote acceptance. Atomically validates current saved versions, creates one quoted job, and reserves exact maximum credits.';
