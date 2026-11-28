-- Private exact-token quote proposals for author-facing AI review and drafting.
-- A ready proposal is not an accepted purchase and never creates a generation job.
create table public.ai_review_token_quote_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  generation_job_id uuid not null unique,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  generation_request_json jsonb not null check (jsonb_typeof(generation_request_json)='object'
    and octet_length(generation_request_json::text)<=524288
    and generation_request_json->>'agentType' in ('writer','proofreader','copyeditor','consistency')),
  catalog_json jsonb not null check (jsonb_typeof(catalog_json)='object'
    and octet_length(catalog_json::text)<=65536 and catalog_json->'approved'='true'::jsonb),
  source_versions_json jsonb not null check (jsonb_typeof(source_versions_json)='array'
    and jsonb_array_length(source_versions_json) between 1 and 5
    and octet_length(source_versions_json::text)<=8192),
  request_sha256 text check (request_sha256 is null or request_sha256 ~ '^[a-f0-9]{64}$'),
  counted_input_tokens integer check (counted_input_tokens is null or counted_input_tokens between 1 and 2000000),
  usage_quote_json jsonb check (usage_quote_json is null or jsonb_typeof(usage_quote_json)='object'
    and octet_length(usage_quote_json::text)<=65536),
  status text not null default 'counting' check(status in ('counting','ready','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text check(error_code is null or length(error_code)<=100),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,idempotency_key),
  check ((status='counting')=(lease_token is not null and lease_expires_at is not null)),
  check ((status='ready')=(usage_quote_json is not null and request_sha256 is not null and counted_input_tokens is not null))
);
create index ai_review_token_quote_book_history on public.ai_review_token_quote_requests(book_id,created_at desc);
create unique index ai_review_token_quote_one_counting on public.ai_review_token_quote_requests(user_id,book_id) where status='counting';
alter table public.ai_review_token_quote_requests enable row level security;
revoke all on public.ai_review_token_quote_requests from public,anon,authenticated,service_role;
grant select,insert,update on public.ai_review_token_quote_requests to service_role;

create function public.guard_ai_review_token_quote_request() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if (to_jsonb(new)-array['status','lease_token','lease_expires_at','error_code','request_sha256',
      'counted_input_tokens','usage_quote_json']) is distinct from
     (to_jsonb(old)-array['status','lease_token','lease_expires_at','error_code','request_sha256',
      'counted_input_tokens','usage_quote_json']) then
    raise exception 'AI review token quote snapshot is immutable' using errcode='23514'; end if;
  if new.status is distinct from old.status and not ((old.status='counting' and new.status in ('ready','failed'))
    or (old.status='failed' and new.status='counting')) then
    raise exception 'invalid AI review quote transition' using errcode='23514'; end if;
  if old.usage_quote_json is not null and (new.usage_quote_json is distinct from old.usage_quote_json
    or new.request_sha256 is distinct from old.request_sha256
    or new.counted_input_tokens is distinct from old.counted_input_tokens) then
    raise exception 'ready AI review quote is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_ai_review_token_quote_request() from public,anon,authenticated,service_role;
create trigger ai_review_token_quote_immutable before update on public.ai_review_token_quote_requests
for each row execute function public.guard_ai_review_token_quote_request();

create function public.request_ai_review_token_quote(
  p_user_id uuid,p_book_id uuid,p_workspace_id uuid,p_generation_job_id uuid,
  p_generation_request jsonb,p_catalog jsonb,p_source_versions jsonb,p_idempotency_key text,
  p_provider_counting_consent boolean
) returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_role text; v_existing public.ai_review_token_quote_requests; v_now timestamptz:=clock_timestamp();
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_user_id is null or p_book_id is null or p_workspace_id is null or p_generation_job_id is null
    or coalesce(length(trim(p_idempotency_key)),0) not between 8 and 200 or p_provider_counting_consent is distinct from true
    or jsonb_typeof(p_generation_request) is distinct from 'object' or octet_length(p_generation_request::text)>524288
    or (p_generation_request->>'jobId')::uuid is distinct from p_generation_job_id
    or (p_generation_request->>'workspaceId')::uuid is distinct from p_workspace_id
    or (p_generation_request->>'bookId')::uuid is distinct from p_book_id
    or p_generation_request->>'agentType' not in ('writer','proofreader','copyeditor','consistency')
    or jsonb_typeof(p_catalog) is distinct from 'object' or octet_length(p_catalog::text)>65536
    or p_catalog->'approved' is distinct from 'true'::jsonb
    or jsonb_typeof(p_source_versions) is distinct from 'array' or jsonb_array_length(p_source_versions) not between 1 and 5 then
    raise exception 'invalid AI review quote request' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai-review-token-quote:'||p_user_id::text||':'||p_book_id::text,0));
  select role::text into v_role from public.workspace_members where workspace_id=p_workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then raise exception 'AI review quote requires writing access' using errcode='42501'; end if;
  if not exists(select 1 from public.books where id=p_book_id and workspace_id=p_workspace_id for share) then
    raise exception 'AI review quote book scope mismatch' using errcode='22023'; end if;
  if jsonb_typeof(p_generation_request#>'{input,chapterIds}') is distinct from 'array'
    or jsonb_array_length(p_source_versions)<>(jsonb_array_length(p_generation_request#>'{input,chapterIds}'))
    or exists(select 1 from jsonb_array_elements(p_source_versions) as src(item) where
      jsonb_typeof(src.item) is distinct from 'object' or coalesce(src.item->>'chapterId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(src.item->>'documentVersionId','') !~* '^[0-9a-f-]{36}$'
      or coalesce(src.item->>'version','') !~ '^[1-9][0-9]*$'
      or not exists(select 1 from jsonb_array_elements_text(p_generation_request#>'{input,chapterIds}') c(chapter_id)
        where c.chapter_id=src.item->>'chapterId'))
    or (select count(distinct src.item->>'chapterId') from jsonb_array_elements(p_source_versions) as src(item))<>jsonb_array_length(p_source_versions) then
    raise exception 'AI review quote source version list is invalid' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_source_versions) as src(item) where not exists(
    select 1 from public.chapters c join public.document_versions d on d.id=c.current_document_version_id and d.chapter_id=c.id
    where c.id=(src.item->>'chapterId')::uuid and c.book_id=p_book_id and d.id=(src.item->>'documentVersionId')::uuid
      and d.version_number=(src.item->>'version')::integer)) then
    raise exception 'AI review quote source version changed' using errcode='40001'; end if;
  select * into v_existing from public.ai_review_token_quote_requests where user_id=p_user_id
    and idempotency_key=trim(p_idempotency_key) for update;
  if found then
    if v_existing.book_id<>p_book_id or v_existing.workspace_id<>p_workspace_id
      or v_existing.generation_request_json is distinct from p_generation_request
      or v_existing.catalog_json is distinct from p_catalog or v_existing.source_versions_json is distinct from p_source_versions then
      raise exception 'AI review quote idempotency conflict' using errcode='23505'; end if;
    if v_existing.status='counting' and v_existing.lease_expires_at<=v_now then
      update public.ai_review_token_quote_requests set lease_token=gen_random_uuid(),lease_expires_at=v_now+interval '3 minutes'
        where id=v_existing.id returning * into v_existing;
      return jsonb_build_object('request',to_jsonb(v_existing),'claimed',true);
    end if;
    return jsonb_build_object('request',to_jsonb(v_existing),'claimed',false);
  end if;
  if exists(select 1 from public.ai_review_token_quote_requests where user_id=p_user_id and book_id=p_book_id and status='counting') then
    raise exception 'AI review quote already being counted' using errcode='23505'; end if;
  if (select count(*) from public.ai_review_token_quote_requests where user_id=p_user_id and book_id=p_book_id and created_at>v_now-interval '1 hour')>=8 then
    raise exception 'AI review quote counting limit reached' using errcode='54000'; end if;
  insert into public.ai_review_token_quote_requests(user_id,workspace_id,book_id,generation_job_id,idempotency_key,
      generation_request_json,catalog_json,source_versions_json,lease_token,lease_expires_at)
    values(p_user_id,p_workspace_id,p_book_id,p_generation_job_id,trim(p_idempotency_key),p_generation_request,
      p_catalog,p_source_versions,gen_random_uuid(),v_now+interval '3 minutes') returning * into v_existing;
  return jsonb_build_object('request',to_jsonb(v_existing),'claimed',true);
end $$;

create function public.complete_ai_review_token_quote_count(
  p_request_id uuid,p_user_id uuid,p_lease_token uuid,p_request_sha256 text,p_counted_input_tokens integer,p_usage_quote jsonb
) returns public.ai_review_token_quote_requests language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_request public.ai_review_token_quote_requests;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_request from public.ai_review_token_quote_requests where id=p_request_id for update;
  if not found or v_request.user_id<>p_user_id then raise exception 'AI review quote request missing' using errcode='P0002'; end if;
  if v_request.status='ready' then
    if v_request.usage_quote_json is distinct from p_usage_quote or v_request.request_sha256 is distinct from p_request_sha256
      or v_request.counted_input_tokens is distinct from p_counted_input_tokens then raise exception 'AI review quote replay conflict' using errcode='23505'; end if;
    return v_request;
  end if;
  if v_request.status<>'counting' or v_request.lease_token is distinct from p_lease_token or v_request.lease_expires_at<=clock_timestamp()
    or p_request_sha256 !~ '^[a-f0-9]{64}$' or p_counted_input_tokens not between 1 and 2000000
    or jsonb_typeof(p_usage_quote) is distinct from 'object' or octet_length(p_usage_quote::text)>65536
    or p_usage_quote->>'reservedCredits' !~ '^[1-9][0-9]{0,9}$'
    or p_usage_quote#>>'{price,provider}' is distinct from 'openai'
    or p_usage_quote#>>'{price,model}' is distinct from v_request.generation_request_json->>'model'
    or p_usage_quote->>'createdAt' is null or p_usage_quote->>'expiresAt' is null
    or (p_usage_quote->>'createdAt')::timestamptz>clock_timestamp()
    or (p_usage_quote->>'expiresAt')::timestamptz<=clock_timestamp()
    or (p_usage_quote->>'expiresAt')::timestamptz>(p_usage_quote->>'createdAt')::timestamptz+interval '1 hour'
    or (p_usage_quote#>>'{scope,jobId}')::uuid is distinct from v_request.generation_job_id
    or (p_usage_quote#>>'{scope,userId}')::uuid is distinct from v_request.user_id
    or (p_usage_quote#>>'{scope,workspaceId}')::uuid is distinct from v_request.workspace_id
    or p_usage_quote#>>'{scope,inputSha256}' is distinct from p_request_sha256
    or not exists(select 1 from jsonb_array_elements(p_usage_quote->'maximumTokens') q
      where q->>'dimension'='text_input' and q->>'tokens'=p_counted_input_tokens::text)
    or not exists(select 1 from jsonb_array_elements(p_usage_quote->'maximumTokens') q
      where q->>'dimension'='text_cached_input' and q->>'tokens'=p_counted_input_tokens::text)
    or not exists(select 1 from jsonb_array_elements(p_usage_quote->'maximumTokens') q
      where q->>'dimension'='text_output' and q->>'tokens'=v_request.generation_request_json->>'maxOutputTokens') then
    raise exception 'AI review quote count lease or result invalid' using errcode='40001'; end if;
  update public.ai_review_token_quote_requests set status='ready',lease_token=null,lease_expires_at=null,
    request_sha256=p_request_sha256,counted_input_tokens=p_counted_input_tokens,usage_quote_json=p_usage_quote
    where id=p_request_id returning * into v_request;
  return v_request;
end $$;

create function public.fail_ai_review_token_quote_count(p_request_id uuid,p_user_id uuid,p_lease_token uuid,p_error_code text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,99}$' then raise exception 'invalid quote error' using errcode='22023'; end if;
  update public.ai_review_token_quote_requests set status='failed',lease_token=null,lease_expires_at=null,error_code=p_error_code
    where id=p_request_id and user_id=p_user_id and status='counting' and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

revoke all on function public.request_ai_review_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,boolean),
  public.complete_ai_review_token_quote_count(uuid,uuid,uuid,text,integer,jsonb),
  public.fail_ai_review_token_quote_count(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.request_ai_review_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,boolean),
  public.complete_ai_review_token_quote_count(uuid,uuid,uuid,text,integer,jsonb),
  public.fail_ai_review_token_quote_count(uuid,uuid,uuid,text) to service_role;

comment on table public.ai_review_token_quote_requests is
  'Private provider-counted quote proposals; quote readiness alone never authorizes generation or reserves credits.';
