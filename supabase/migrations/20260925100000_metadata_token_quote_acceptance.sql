-- Durable, author-confirmed token quotes for metadata generation.

alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check (
  (billing_mode = 'quoted' and agent_type in ('translator', 'story_blueprint', 'metadata'))
  or (billing_mode = 'operational' and agent_type <> 'story_blueprint')
);

create or replace function public.guard_job_billing_mode() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op='UPDATE' and new.billing_mode is distinct from old.billing_mode then
    raise exception 'job billing mode is immutable' using errcode='23514'; end if;
  if tg_op='INSERT' and new.billing_mode='quoted' and new.status<>'queued' then
    raise exception 'quoted job must enter queued' using errcode='23514'; end if;
  if new.billing_mode='quoted' and new.status='running' and not exists (
    select 1 from public.funded_usage_quotes q where q.job_id=new.id
      and q.user_id=new.created_by and q.workspace_id=new.workspace_id and (
        (q.status='held' and ((q.quote_json->>'expiresAt')::timestamptz>clock_timestamp() or q.dispatched_at is not null))
        or (new.agent_type='story_blueprint' and q.status='settled' and q.settlement_json is not null
          and exists(select 1 from public.story_blueprint_generation_results r where r.ai_job_id=new.id))
        or (new.agent_type='metadata' and q.status='settled' and q.settlement_json is not null
          and exists(select 1 from public.metadata_service_receipts r where r.job_id=new.id and r.result_json is not null))
      )
  ) then raise exception 'quoted job requires funded hold' using errcode='23514'; end if;
  return new;
end $$;

-- Keep legacy metadata unit reservations only for operational billing.
create or replace function public.reserve_metadata_job_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_role text; v_quota_text text; v_quota numeric:=0; v_used numeric; v_pending bigint;
begin
  if new.billing_mode='quoted' then return new; end if;
  if new.agent_type<>'metadata' or new.status not in ('queued','running') then return new; end if;
  if tg_op='UPDATE' and old.agent_type='metadata' and old.status in ('queued','running')
    and old.workspace_id=new.workspace_id and old.created_by=new.created_by then return new; end if;
  select role into v_role from public.workspace_members where workspace_id=new.workspace_id
    and user_id=new.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'metadata reservation requires editing access' using errcode='42501'; end if;
  select organization_id into v_org from public.workspaces where id=new.workspace_id;
  perform id from public.organizations where id=v_org for update;
  if not found then raise exception 'metadata organization missing' using errcode='22023'; end if;
  select coalesce(p.entitlements_json->>'ai_credits_monthly','0') into v_quota_text
    from public.subscriptions s join public.plans p on p.id=s.plan_id
    where s.organization_id=v_org and s.status in ('active','trialing') order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'invalid metadata credit entitlement' using errcode='22023'; end if;
    v_quota:=v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity),0) into v_used from public.usage_events where organization_id=v_org
    and meter='ai_credits' and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  select count(*) into v_pending from public.ai_jobs j join public.workspaces w on w.id=j.workspace_id
    where w.organization_id=v_org and j.agent_type='metadata' and j.billing_mode='operational'
      and j.status in ('queued','running') and j.id<>new.id;
  if v_used+v_pending+1>v_quota then raise exception 'metadata credit capacity exhausted' using errcode='23514'; end if;
  return new;
end $$;

-- The generic text reservation trigger was introduced after the metadata-only
-- trigger. Keep quoted jobs out of legacy quota accounting there as well.
create or replace function public.reserve_text_job_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_role text; v_quota_text text; v_quota numeric:=0; v_used numeric; v_pending bigint;
begin
  if new.billing_mode='quoted' then return new; end if;
  if new.agent_type not in ('metadata','writer','proofreader','copyeditor','consistency','bookbible')
    or new.status not in ('queued','running') then return new; end if;
  if tg_op='UPDATE' and old.agent_type in ('metadata','writer','proofreader','copyeditor','consistency','bookbible')
    and old.billing_mode='operational' and old.status in ('queued','running')
    and old.workspace_id=new.workspace_id and old.created_by=new.created_by then return new; end if;
  select role into v_role from public.workspace_members where workspace_id=new.workspace_id
    and user_id=new.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'text reservation requires editing access' using errcode='42501'; end if;
  select organization_id into v_org from public.workspaces where id=new.workspace_id;
  perform id from public.organizations where id=v_org for update;
  if not found then raise exception 'text organization missing' using errcode='22023'; end if;
  select coalesce(p.entitlements_json->>'ai_credits_monthly','0') into v_quota_text
    from public.subscriptions s join public.plans p on p.id=s.plan_id
    where s.organization_id=v_org and s.status in ('active','trialing') order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'invalid text credit entitlement' using errcode='22023'; end if;
    v_quota:=v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity),0) into v_used from public.usage_events where organization_id=v_org
    and meter='ai_credits' and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  select count(*) into v_pending from public.ai_jobs j join public.workspaces w on w.id=j.workspace_id
    where w.organization_id=v_org and j.billing_mode='operational'
      and j.agent_type in ('metadata','writer','proofreader','copyeditor','consistency','bookbible')
      and j.status in ('queued','running') and j.id<>new.id;
  if v_used+v_pending+1>v_quota then raise exception 'text credit capacity exhausted' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.reserve_text_job_credit() from public,anon,authenticated;

create table public.metadata_token_quote_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  generation_job_id uuid not null unique,
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  consented_at timestamptz not null default clock_timestamp(),
  generation_request_json jsonb not null check(jsonb_typeof(generation_request_json)='object'
    and octet_length(generation_request_json::text)<=262144 and generation_request_json->>'agentType'='metadata'),
  catalog_json jsonb not null check(jsonb_typeof(catalog_json)='object'
    and octet_length(catalog_json::text)<=65536 and catalog_json->'approved'='true'::jsonb),
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  generation_request_sha256 text check(generation_request_sha256 is null or generation_request_sha256 ~ '^[a-f0-9]{64}$'),
  usage_quote_json jsonb check(usage_quote_json is null or jsonb_typeof(usage_quote_json)='object'
    and octet_length(usage_quote_json::text)<=65536),
  quote_expires_at timestamptz,
  status text not null default 'counting' check(status in ('counting','ready','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text check(error_code is null or length(error_code)<=100),
  accepted_job_id uuid unique references public.ai_jobs(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,idempotency_key),
  check((accepted_job_id is null)=(accepted_at is null)),
  check((status='counting')=(lease_token is not null and lease_expires_at is not null)),
  check((status='ready')=(usage_quote_json is not null and generation_request_sha256 is not null and quote_expires_at is not null))
);
create index metadata_token_quote_book_history on public.metadata_token_quote_requests(book_id,created_at desc);
create unique index metadata_token_quote_one_counting on public.metadata_token_quote_requests(user_id,book_id) where status='counting';
alter table public.metadata_token_quote_requests enable row level security;
revoke all on public.metadata_token_quote_requests from public,anon,authenticated,service_role;
grant select,insert,update on public.metadata_token_quote_requests to service_role;

create function public.guard_metadata_token_quote_request() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if (to_jsonb(new)-array['status','lease_token','lease_expires_at','error_code','generation_request_sha256',
      'usage_quote_json','quote_expires_at','accepted_job_id','accepted_at'])
    is distinct from (to_jsonb(old)-array['status','lease_token','lease_expires_at','error_code','generation_request_sha256',
      'usage_quote_json','quote_expires_at','accepted_job_id','accepted_at']) then
    raise exception 'metadata quote snapshot is immutable' using errcode='23514'; end if;
  if new.status is distinct from old.status and not ((old.status='counting' and new.status in ('ready','failed'))
    or (old.status='ready' and new.status='ready')) then raise exception 'invalid metadata quote transition' using errcode='23514'; end if;
  if old.accepted_job_id is not null and new.accepted_job_id is distinct from old.accepted_job_id then
    raise exception 'accepted metadata quote is immutable' using errcode='23514'; end if;
  if old.usage_quote_json is not null and (new.usage_quote_json is distinct from old.usage_quote_json
    or new.generation_request_sha256 is distinct from old.generation_request_sha256
    or new.quote_expires_at is distinct from old.quote_expires_at) then
    raise exception 'ready metadata quote is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_metadata_token_quote_request() from public,anon,authenticated,service_role;
create trigger metadata_token_quote_immutable before update on public.metadata_token_quote_requests
for each row execute function public.guard_metadata_token_quote_request();

create function public.request_metadata_token_quote(
  p_user_id uuid,p_book_id uuid,p_workspace_id uuid,p_generation_job_id uuid,
  p_generation_request jsonb,p_catalog jsonb,p_idempotency_key text,p_provider_counting_consent boolean
) returns public.metadata_token_quote_requests
language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_role text; v_existing public.metadata_token_quote_requests; v_now timestamptz:=clock_timestamp();
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_user_id is null or p_book_id is null or p_workspace_id is null or p_generation_job_id is null
    or coalesce(length(trim(p_idempotency_key)),0) not between 8 and 200 or p_provider_counting_consent is distinct from true
    or jsonb_typeof(p_generation_request) is distinct from 'object' or octet_length(p_generation_request::text)>262144
    or p_generation_request->>'agentType' is distinct from 'metadata'
    or (p_generation_request->>'jobId')::uuid is distinct from p_generation_job_id
    or (p_generation_request->>'workspaceId')::uuid is distinct from p_workspace_id
    or (p_generation_request->>'bookId')::uuid is distinct from p_book_id
    or jsonb_typeof(p_catalog) is distinct from 'object' or octet_length(p_catalog::text)>65536
    or p_catalog->'approved' is distinct from 'true'::jsonb then raise exception 'invalid metadata quote request' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('metadata-token-quote:'||p_user_id::text||':'||p_book_id::text,0));
  update public.metadata_token_quote_requests set status='failed',lease_token=null,lease_expires_at=null,error_code='counting_outcome_unknown'
    where user_id=p_user_id and book_id=p_book_id and status='counting' and lease_expires_at<=v_now;
  select role::text into v_role from public.workspace_members where workspace_id=p_workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then raise exception 'metadata quote requires writing access' using errcode='42501'; end if;
  if not exists(select 1 from public.books where id=p_book_id and workspace_id=p_workspace_id for share) then
    raise exception 'metadata quote book scope mismatch' using errcode='22023'; end if;
  select * into v_existing from public.metadata_token_quote_requests where user_id=p_user_id
    and idempotency_key=trim(p_idempotency_key) for update;
  if found then
    if v_existing.book_id<>p_book_id or v_existing.workspace_id<>p_workspace_id
      or v_existing.generation_request_json is distinct from p_generation_request
      or v_existing.catalog_json is distinct from p_catalog then raise exception 'metadata quote idempotency conflict' using errcode='23505'; end if;
    return v_existing;
  end if;
  if exists(select 1 from public.metadata_token_quote_requests where user_id=p_user_id and book_id=p_book_id and status='counting') then
    raise exception 'metadata quote already being counted' using errcode='23505'; end if;
  if (select count(*) from public.metadata_token_quote_requests where user_id=p_user_id and book_id=p_book_id
      and created_at>v_now-interval '1 hour')>=5 then raise exception 'metadata token counting limit reached' using errcode='54000'; end if;
  insert into public.metadata_token_quote_requests(user_id,workspace_id,book_id,generation_job_id,idempotency_key,
    generation_request_json,catalog_json,source_sha256,lease_token,lease_expires_at)
    values(p_user_id,p_workspace_id,p_book_id,p_generation_job_id,trim(p_idempotency_key),p_generation_request,p_catalog,
      encode(digest(convert_to((p_generation_request#>'{input,chapters}')::text,'UTF8'),'sha256'),'hex'),
      gen_random_uuid(),v_now+interval '3 minutes') returning * into v_existing;
  return v_existing;
end $$;

create function public.complete_metadata_token_quote_count(
  p_request_id uuid,p_user_id uuid,p_lease_token uuid,p_generation_request_sha256 text,p_usage_quote jsonb
) returns public.metadata_token_quote_requests
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_request public.metadata_token_quote_requests; v_credits integer; v_expiry timestamptz;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_request from public.metadata_token_quote_requests where id=p_request_id for update;
  if not found or v_request.user_id<>p_user_id then raise exception 'metadata quote request missing' using errcode='P0002'; end if;
  if v_request.status='ready' then
    if v_request.usage_quote_json is distinct from p_usage_quote or v_request.generation_request_sha256 is distinct from p_generation_request_sha256 then
      raise exception 'metadata quote replay conflict' using errcode='23505'; end if;
    return v_request;
  end if;
  if v_request.status<>'counting' or v_request.lease_token is distinct from p_lease_token
    or v_request.lease_expires_at<=clock_timestamp() then raise exception 'metadata quote lease expired' using errcode='40001'; end if;
  if p_generation_request_sha256 !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_usage_quote) is distinct from 'object'
    or octet_length(p_usage_quote::text)>65536 or p_usage_quote#>>'{scope,jobId}'<>v_request.generation_job_id::text
    or p_usage_quote#>>'{scope,userId}'<>v_request.user_id::text or p_usage_quote#>>'{scope,workspaceId}'<>v_request.workspace_id::text
    or p_usage_quote#>>'{scope,inputSha256}'<>p_generation_request_sha256
    or p_usage_quote#>'{policy,approved}' is distinct from 'true'::jsonb
    or p_usage_quote#>>'{price,provider}' is distinct from 'openai'
    or p_usage_quote#>>'{price,model}' is distinct from v_request.generation_request_json->>'model' then
    raise exception 'metadata quote provider binding mismatch' using errcode='22023'; end if;
  begin
    v_credits:=(p_usage_quote->>'reservedCredits')::integer;
    v_expiry:=(p_usage_quote->>'expiresAt')::timestamptz;
  exception when others then raise exception 'invalid metadata quote values' using errcode='22023'; end;
  if v_credits<=0 or v_expiry<=clock_timestamp() or v_expiry>(p_usage_quote->>'createdAt')::timestamptz+interval '1 hour'
    or (p_usage_quote->>'createdAt')::timestamptz>clock_timestamp()
    or v_expiry>(v_request.catalog_json->>'expiresAt')::timestamptz
    or not exists(select 1 from jsonb_array_elements(v_request.catalog_json->'entries') entry
      where entry#>>'{price,model}'=v_request.generation_request_json->>'model'
        and entry#>'{price,provider}'='"openai"'::jsonb and entry#>'{policy,approved}'='true'::jsonb) then
    raise exception 'metadata quote expired or outside approved catalog' using errcode='22023'; end if;
  update public.metadata_token_quote_requests set status='ready',lease_token=null,lease_expires_at=null,
    generation_request_sha256=p_generation_request_sha256,usage_quote_json=p_usage_quote,quote_expires_at=v_expiry
    where id=p_request_id returning * into v_request;
  return v_request;
end $$;

create function public.fail_metadata_token_quote_count(p_request_id uuid,p_user_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  update public.metadata_token_quote_requests set status='failed',lease_token=null,lease_expires_at=null,error_code='counting_outcome_unknown'
    where id=p_request_id and user_id=p_user_id and status='counting' and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.accept_metadata_token_quote(p_request_id uuid,p_user_id uuid,p_expected_credits integer)
returns public.ai_jobs language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_quote public.metadata_token_quote_requests; v_job public.ai_jobs; v_role text; v_pair record; v_chapter uuid; v_version uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_quote from public.metadata_token_quote_requests where id=p_request_id for update;
  if not found or v_quote.user_id is distinct from p_user_id then raise exception 'metadata quote request missing' using errcode='P0002'; end if;
  select role::text into v_role from public.workspace_members where workspace_id=v_quote.workspace_id and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then raise exception 'metadata quote requires writing access' using errcode='42501'; end if;
  if v_quote.accepted_job_id is not null then
    if p_expected_credits is distinct from (v_quote.usage_quote_json->>'reservedCredits')::integer then raise exception 'metadata quote confirmation mismatch' using errcode='23514'; end if;
    select * into v_job from public.ai_jobs where id=v_quote.accepted_job_id;
    if not found then raise exception 'accepted metadata job missing' using errcode='P0002'; end if;
    return v_job;
  end if;
  if v_quote.status<>'ready' or v_quote.quote_expires_at<=clock_timestamp() or v_quote.created_at>clock_timestamp()
    or p_expected_credits is distinct from (v_quote.usage_quote_json->>'reservedCredits')::integer then
    raise exception 'metadata quote expired or confirmation mismatch' using errcode='23514'; end if;
  for v_pair in select key,value from jsonb_each(v_quote.generation_request_json#>'{input,chapters}') loop
    begin v_chapter:=v_pair.key::uuid; v_version:=(v_pair.value->>'documentVersionId')::uuid;
    exception when others then raise exception 'invalid metadata source snapshot' using errcode='22023'; end;
    if not exists(select 1 from public.chapters c join public.document_versions d on d.id=c.current_document_version_id
      where c.id=v_chapter and c.book_id=v_quote.book_id and d.id=v_version and d.chapter_id=c.id) then
      raise exception 'metadata source version changed; request a new quote' using errcode='40001'; end if;
  end loop;
  if exists(select 1 from public.ai_jobs where book_id=v_quote.book_id and created_by=p_user_id and agent_type='metadata' and status in ('queued','running')) then
    raise exception 'metadata request already active' using errcode='23505'; end if;
  insert into public.ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,status,input_ref,idempotency_key,created_by)
    values(v_quote.generation_job_id,v_quote.workspace_id,v_quote.book_id,'metadata','quoted','queued',jsonb_build_object(
      'metadataQuoteRequestId',v_quote.id,'sourceSha256',v_quote.source_sha256,
      'generationRequestSha256',v_quote.generation_request_sha256,
      'contextSources',coalesce((select jsonb_agg(jsonb_build_object(
        'chapterId',chapter.key,'documentVersionId',chapter.value->>'documentVersionId',
        'nodeId',node.value->>'id','textHash',node.value->>'textHash') order by chapter.key,node.ordinality)
        from jsonb_each(v_quote.generation_request_json#>'{input,chapters}') chapter
        cross join lateral jsonb_array_elements(chapter.value->'nodes') with ordinality node(value,ordinality)), '[]'::jsonb)),
      'metadata-quote:'||v_quote.id::text,p_user_id) returning * into v_job;
  perform public.reserve_funded_usage_quote(v_quote.usage_quote_json);
  update public.metadata_token_quote_requests set accepted_job_id=v_job.id,accepted_at=clock_timestamp() where id=v_quote.id;
  return v_job;
end $$;

revoke all on function public.request_metadata_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,text,boolean) from public,anon,authenticated;
revoke all on function public.complete_metadata_token_quote_count(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.fail_metadata_token_quote_count(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.accept_metadata_token_quote(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.request_metadata_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,text,boolean) to service_role;
grant execute on function public.complete_metadata_token_quote_count(uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.fail_metadata_token_quote_count(uuid,uuid,uuid) to service_role;
grant execute on function public.accept_metadata_token_quote(uuid,uuid,integer) to service_role;
comment on table public.metadata_token_quote_requests is
  'Private consented metadata source snapshots, token quotes and acceptance; token counts alone never fund generation.';
