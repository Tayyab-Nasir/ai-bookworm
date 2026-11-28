-- Consented, exact-input Book Bible quotes and atomic funded execution.
-- Existing operational Book Bible jobs retain their legacy recovery contract.

alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check (
  (billing_mode='quoted' and agent_type in ('translator','story_blueprint','metadata','writer','proofreader','copyeditor','consistency','bookbible'))
  or (billing_mode='operational' and agent_type<>'story_blueprint')
);

create or replace function public.guard_job_billing_mode() returns trigger
language plpgsql set search_path=public,pg_temp as $$
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
        or (new.agent_type='bookbible' and q.status='settled' and q.settlement_json is not null
          and exists(select 1 from public.book_bible_quote_service_receipts r where r.job_id=new.id and r.result_json is not null))
      )
  ) then raise exception 'quoted job requires funded hold' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_job_billing_mode() from public,anon,authenticated,service_role;

create table public.book_bible_token_quote_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  generation_job_id uuid not null unique,
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  consented_at timestamptz not null default clock_timestamp(),
  generation_request_json jsonb not null check(jsonb_typeof(generation_request_json)='object'
    and octet_length(generation_request_json::text)<=524288
    and generation_request_json->>'agentType'='bookbible'),
  catalog_json jsonb not null check(jsonb_typeof(catalog_json)='object'
    and octet_length(catalog_json::text)<=65536 and catalog_json->'approved'='true'::jsonb),
  source_versions_json jsonb not null check(jsonb_typeof(source_versions_json)='object'
    and jsonb_typeof(source_versions_json->'versions')='array'
    and jsonb_array_length(source_versions_json->'versions') between 1 and 3
    and jsonb_typeof(source_versions_json->'reading')='object'
    and octet_length(source_versions_json::text)<=16384),
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  generation_request_sha256 text check(generation_request_sha256 is null or generation_request_sha256 ~ '^[a-f0-9]{64}$'),
  counted_input_tokens integer check(counted_input_tokens is null or counted_input_tokens between 1 and 2000000),
  usage_quote_json jsonb check(usage_quote_json is null or jsonb_typeof(usage_quote_json)='object'
    and octet_length(usage_quote_json::text)<=65536),
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
  check((status='ready')=(usage_quote_json is not null and generation_request_sha256 is not null and counted_input_tokens is not null))
);
create index book_bible_token_quote_history on public.book_bible_token_quote_requests(book_id,created_at desc);
create unique index book_bible_token_quote_one_counting on public.book_bible_token_quote_requests(user_id,book_id) where status='counting';
alter table public.book_bible_token_quote_requests enable row level security;
revoke all on public.book_bible_token_quote_requests from public,anon,authenticated,service_role;
grant select,insert,update on public.book_bible_token_quote_requests to service_role;

create table public.book_bible_quote_service_receipts (
  job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
  request_id text not null check(length(trim(request_id)) between 1 and 256),
  provider text not null check(provider='openai'),
  model text not null check(length(trim(model)) between 1 and 128),
  result_json jsonb not null check(jsonb_typeof(result_json)='object' and octet_length(result_json::text)<=3500000),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.book_bible_quote_service_receipts enable row level security;
revoke all on public.book_bible_quote_service_receipts from public,anon,authenticated,service_role;
grant select,insert on public.book_bible_quote_service_receipts to service_role;

create function public.guard_book_bible_token_quote_request() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if (to_jsonb(new)-array['status','lease_token','lease_expires_at','error_code','generation_request_sha256',
      'counted_input_tokens','usage_quote_json','accepted_job_id','accepted_at']) is distinct from
     (to_jsonb(old)-array['status','lease_token','lease_expires_at','error_code','generation_request_sha256',
      'counted_input_tokens','usage_quote_json','accepted_job_id','accepted_at']) then
    raise exception 'Book Bible quote snapshot is immutable' using errcode='23514'; end if;
  if new.status is distinct from old.status and not ((old.status='counting' and new.status in ('ready','failed'))
    or (old.status='failed' and new.status='counting')) then
    raise exception 'invalid Book Bible quote transition' using errcode='23514'; end if;
  if old.usage_quote_json is not null and (new.usage_quote_json is distinct from old.usage_quote_json
    or new.generation_request_sha256 is distinct from old.generation_request_sha256
    or new.counted_input_tokens is distinct from old.counted_input_tokens) then
    raise exception 'ready Book Bible quote is immutable' using errcode='23514'; end if;
  if old.accepted_job_id is not null and (new.accepted_job_id is distinct from old.accepted_job_id
    or new.accepted_at is distinct from old.accepted_at) then
    raise exception 'accepted Book Bible quote is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_book_bible_token_quote_request() from public,anon,authenticated,service_role;
create trigger book_bible_token_quote_immutable before update on public.book_bible_token_quote_requests
for each row execute function public.guard_book_bible_token_quote_request();

create function public.request_book_bible_token_quote(
  p_user_id uuid,p_book_id uuid,p_workspace_id uuid,p_generation_job_id uuid,
  p_generation_request jsonb,p_catalog jsonb,p_source_versions jsonb,p_idempotency_key text,
  p_provider_counting_consent boolean
) returns jsonb language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_role text; v_existing public.book_bible_token_quote_requests; v_now timestamptz:=clock_timestamp();
  v_source jsonb; v_version uuid; v_chapter uuid; v_nodes jsonb; v_node jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_user_id is null or p_book_id is null or p_workspace_id is null or p_generation_job_id is null
    or coalesce(length(trim(p_idempotency_key)),0) not between 8 and 200 or p_provider_counting_consent is distinct from true
    or jsonb_typeof(p_generation_request) is distinct from 'object' or octet_length(p_generation_request::text)>524288
    or p_generation_request->>'agentType' is distinct from 'bookbible'
    or (p_generation_request->>'jobId')::uuid is distinct from p_generation_job_id
    or (p_generation_request->>'workspaceId')::uuid is distinct from p_workspace_id
    or (p_generation_request->>'bookId')::uuid is distinct from p_book_id
    or p_generation_request->>'model' is null or length(p_generation_request->>'model')>128
    or coalesce(p_generation_request->>'maxOutputTokens','') !~ '^[1-9][0-9]{0,4}$'
    or (p_generation_request->>'maxOutputTokens')::integer>6000
    or jsonb_typeof(p_generation_request#>'{input,chapterIds}') is distinct from 'array'
    or jsonb_typeof(p_generation_request#>'{input,chapters}') is distinct from 'object'
    or jsonb_typeof(p_source_versions) is distinct from 'object'
    or jsonb_typeof(p_source_versions->'versions') is distinct from 'array'
    or jsonb_array_length(p_source_versions->'versions') not between 1 and 3
    or coalesce(p_source_versions#>>'{reading,fingerprint}','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_source_versions#>>'{reading,pageIndex}','') !~ '^(0|[1-9][0-9]{0,3})$'
    or (p_source_versions#>>'{reading,pageIndex}')::integer>4999
    or jsonb_typeof(p_catalog) is distinct from 'object' or octet_length(p_catalog::text)>65536
    or p_catalog->'approved' is distinct from 'true'::jsonb
    or p_catalog->>'expiresAt' is null or (p_catalog->>'expiresAt')::timestamptz<=v_now
    or not exists(select 1 from jsonb_array_elements(p_catalog->'entries') entry
      where entry#>'{price,provider}'='"openai"'::jsonb
        and entry#>'{policy,approved}'='true'::jsonb
        and entry#>>'{price,model}'=p_generation_request->>'model'
        and coalesce(entry#>>'{maxOutputTokens}','') ~ '^[1-9][0-9]{0,4}$'
        and (entry#>>'{maxOutputTokens}')::integer=(p_generation_request->>'maxOutputTokens')::integer) then
    raise exception 'invalid Book Bible quote request' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('book-bible-token-quote:'||p_user_id::text||':'||p_book_id::text,0));
  select role::text into v_role from public.workspace_members where workspace_id=p_workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then raise exception 'Book Bible quote requires writing access' using errcode='42501'; end if;
  if not exists(select 1 from public.books where id=p_book_id and workspace_id=p_workspace_id for share) then
    raise exception 'Book Bible quote book scope mismatch' using errcode='22023'; end if;
  if jsonb_array_length(p_generation_request#>'{input,chapterIds}')<>jsonb_array_length(p_source_versions->'versions')
    or exists(select 1 from jsonb_array_elements(p_source_versions->'versions') src(item) where
      jsonb_typeof(src.item) is distinct from 'object'
      or src.item - array['chapterId','documentVersionId','version'] <> '{}'::jsonb
      or coalesce(src.item->>'chapterId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(src.item->>'documentVersionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(src.item->>'version','') !~ '^[1-9][0-9]*$'
      or not exists(select 1 from jsonb_array_elements_text(p_generation_request#>'{input,chapterIds}') c(chapter_id)
        where c.chapter_id=src.item->>'chapterId')
      or jsonb_typeof(p_generation_request#>'{input,chapters}'->(src.item->>'chapterId')) is distinct from 'object'
      or (p_generation_request#>>array['input','chapters',src.item->>'chapterId','documentVersionId']) is distinct from src.item->>'documentVersionId'
      or (p_generation_request#>>array['input','chapters',src.item->>'chapterId','version']) is distinct from src.item->>'version')
    or (select count(distinct src.item->>'chapterId') from jsonb_array_elements(p_source_versions->'versions') src(item))<>jsonb_array_length(p_source_versions->'versions') then
    raise exception 'Book Bible source version list is invalid' using errcode='22023'; end if;
  for v_source in select value from jsonb_array_elements(p_source_versions->'versions') loop
    v_chapter:=(v_source->>'chapterId')::uuid; v_version:=(v_source->>'documentVersionId')::uuid;
    if not exists(select 1 from public.chapters c join public.document_versions d
      on d.id=c.current_document_version_id and d.chapter_id=c.id
      where c.id=v_chapter and c.book_id=p_book_id and d.id=v_version and d.version_number=(v_source->>'version')::integer) then
      raise exception 'Book Bible saved source version changed' using errcode='40001'; end if;
    v_nodes:=p_generation_request#>array['input','chapters',v_chapter::text,'nodes'];
    if jsonb_typeof(v_nodes) is distinct from 'array' or jsonb_array_length(v_nodes)<1 or jsonb_array_length(v_nodes)>200 then
      raise exception 'Book Bible chapter snapshot is invalid' using errcode='22023'; end if;
    for v_node in select value from jsonb_array_elements(v_nodes) loop
      if jsonb_typeof(v_node) is distinct from 'object' or coalesce(length(v_node->>'id'),0) not between 1 and 200
        or jsonb_typeof(v_node->'text') is distinct from 'string' or coalesce(v_node->>'textHash','') !~ '^[a-f0-9]{64}$'
        or coalesce(v_node->>'excerptStart','') !~ '^(0|[1-9][0-9]{0,8})$'
        or coalesce(v_node->>'excerptEnd','') !~ '^[1-9][0-9]{0,8}$'
        or coalesce(v_node->>'fullTextLength','') !~ '^[1-9][0-9]{0,8}$'
        or (v_node->>'excerptEnd')::integer<=(v_node->>'excerptStart')::integer
        or (v_node->>'excerptEnd')::integer>(v_node->>'fullTextLength')::integer
        or length(v_node->>'text')>(v_node->>'excerptEnd')::integer-(v_node->>'excerptStart')::integer
        or 2*length(v_node->>'text')<(v_node->>'excerptEnd')::integer-(v_node->>'excerptStart')::integer
        or not exists(select 1 from public.document_versions d,jsonb_array_elements(d.content_json->'nodes') n(value)
          where d.id=v_version and n.value->>'id'=v_node->>'id'
            and jsonb_typeof(n.value->'text')='string'
            and encode(public.digest(n.value->>'text','sha256'),'hex')=v_node->>'textHash'
            and length(n.value->>'text')<=(v_node->>'fullTextLength')::integer
            and 2*length(n.value->>'text')>=(v_node->>'fullTextLength')::integer) then
        raise exception 'Book Bible excerpt does not match its pinned saved source' using errcode='42501'; end if;
    end loop;
  end loop;
  select * into v_existing from public.book_bible_token_quote_requests where user_id=p_user_id
    and idempotency_key=trim(p_idempotency_key) for update;
  if found then
    if v_existing.book_id<>p_book_id or v_existing.workspace_id<>p_workspace_id
      or v_existing.generation_request_json is distinct from p_generation_request
      or v_existing.catalog_json is distinct from p_catalog or v_existing.source_versions_json is distinct from p_source_versions then
      raise exception 'Book Bible quote idempotency conflict' using errcode='23505'; end if;
    if v_existing.status='counting' and v_existing.lease_expires_at<=v_now then
      update public.book_bible_token_quote_requests set lease_token=gen_random_uuid(),lease_expires_at=v_now+interval '3 minutes'
        where id=v_existing.id returning * into v_existing;
      return jsonb_build_object('request',to_jsonb(v_existing),'claimed',true);
    end if;
    return jsonb_build_object('request',to_jsonb(v_existing),'claimed',false);
  end if;
  if exists(select 1 from public.book_bible_token_quote_requests where user_id=p_user_id and book_id=p_book_id and status='counting') then
    raise exception 'Book Bible quote already being counted' using errcode='23505'; end if;
  if (select count(*) from public.book_bible_token_quote_requests where user_id=p_user_id and book_id=p_book_id and created_at>v_now-interval '1 hour')>=8 then
    raise exception 'Book Bible token counting limit reached' using errcode='54000'; end if;
  insert into public.book_bible_token_quote_requests(user_id,workspace_id,book_id,generation_job_id,idempotency_key,
      generation_request_json,catalog_json,source_versions_json,source_sha256,lease_token,lease_expires_at)
    values(p_user_id,p_workspace_id,p_book_id,p_generation_job_id,trim(p_idempotency_key),p_generation_request,
      p_catalog,p_source_versions,encode(public.digest(convert_to((p_generation_request#>'{input,chapters}')::text,'UTF8'),'sha256'),'hex'),
      gen_random_uuid(),v_now+interval '3 minutes') returning * into v_existing;
  return jsonb_build_object('request',to_jsonb(v_existing),'claimed',true);
end $$;

create function public.complete_book_bible_token_quote_count(
  p_request_id uuid,p_user_id uuid,p_lease_token uuid,p_request_sha256 text,
  p_counted_input_tokens integer,p_usage_quote jsonb
) returns public.book_bible_token_quote_requests language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_request public.book_bible_token_quote_requests; v_credits integer; v_entry jsonb;
  v_quote_cost numeric; v_quote_credits numeric; v_quote_minimum numeric; v_quote_micro_per_credit numeric;
  v_quote_markup numeric; v_quote_platform numeric;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_request from public.book_bible_token_quote_requests where id=p_request_id for update;
  if not found or v_request.user_id is distinct from p_user_id then raise exception 'Book Bible quote request missing' using errcode='P0002'; end if;
  if v_request.status='ready' then
    if v_request.usage_quote_json is distinct from p_usage_quote or v_request.generation_request_sha256 is distinct from p_request_sha256
      or v_request.counted_input_tokens is distinct from p_counted_input_tokens then raise exception 'Book Bible quote replay conflict' using errcode='23505'; end if;
    return v_request;
  end if;
  if v_request.status<>'counting' or v_request.lease_token is distinct from p_lease_token or v_request.lease_expires_at<=clock_timestamp()
    or coalesce(p_request_sha256,'') !~ '^[a-f0-9]{64}$' or p_counted_input_tokens not between 1 and 2000000
    or jsonb_typeof(p_usage_quote) is distinct from 'object' or octet_length(p_usage_quote::text)>65536
    or coalesce(p_usage_quote->>'reservedCredits','') !~ '^[1-9][0-9]{0,9}$'
    or (p_usage_quote->>'reservedCredits')::numeric>2147483647
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
    or p_usage_quote#>'{policy,approved}' is distinct from 'true'::jsonb
    or p_usage_quote#>>'{price,version}' is distinct from (select e#>>'{price,version}' from jsonb_array_elements(v_request.catalog_json->'entries') e
       where e#>>'{price,model}'=v_request.generation_request_json->>'model')
    or p_usage_quote#>>'{policy,version}' is distinct from (select e#>>'{policy,version}' from jsonb_array_elements(v_request.catalog_json->'entries') e
       where e#>>'{price,model}'=v_request.generation_request_json->>'model')
    or not exists(select 1 from jsonb_array_elements(p_usage_quote->'maximumTokens') q
      where q->>'dimension'='text_input' and q->>'tokens'=p_counted_input_tokens::text)
    or not exists(select 1 from jsonb_array_elements(p_usage_quote->'maximumTokens') q
      where q->>'dimension'='text_cached_input' and q->>'tokens'=p_counted_input_tokens::text)
    or not exists(select 1 from jsonb_array_elements(p_usage_quote->'maximumTokens') q
      where q->>'dimension'='text_output' and q->>'tokens'=v_request.generation_request_json->>'maxOutputTokens')
    or (p_usage_quote->>'expiresAt')::timestamptz>(v_request.catalog_json->>'expiresAt')::timestamptz then
    raise exception 'Book Bible quote count lease or result invalid' using errcode='40001'; end if;
  select e.value into v_entry from jsonb_array_elements(v_request.catalog_json->'entries') e(value)
    where e.value#>>'{price,model}'=v_request.generation_request_json->>'model'
      and e.value#>>'{price,version}'=p_usage_quote#>>'{price,version}'
      and e.value#>>'{policy,version}'=p_usage_quote#>>'{policy,version}'
      and e.value#>'{price,provider}'='"openai"'::jsonb and e.value#>'{policy,approved}'='true'::jsonb;
  if v_entry is null or p_usage_quote->'price' is distinct from v_entry->'price'
    or p_usage_quote->'policy' is distinct from v_entry->'policy'
    or jsonb_typeof(p_usage_quote->'maximumTokens') is distinct from 'array'
    or jsonb_array_length(p_usage_quote->'maximumTokens')<>3
    or (select count(distinct x.value->>'dimension') from jsonb_array_elements(p_usage_quote->'maximumTokens') x(value))<>3
    or (select count(*) from jsonb_array_elements(p_usage_quote->'maximumTokens') x(value)
      where x.value->>'dimension'='text_input' and x.value->>'tokens'=p_counted_input_tokens::text)<>1
    or (select count(*) from jsonb_array_elements(p_usage_quote->'maximumTokens') x(value)
      where x.value->>'dimension'='text_cached_input' and x.value->>'tokens'=p_counted_input_tokens::text)<>1
    or (select count(*) from jsonb_array_elements(p_usage_quote->'maximumTokens') x(value)
      where x.value->>'dimension'='text_output' and x.value->>'tokens'=v_request.generation_request_json->>'maxOutputTokens')<>1
    or jsonb_typeof(p_usage_quote#>'{price,rates}') is distinct from 'array'
    or jsonb_array_length(p_usage_quote#>'{price,rates}')<>3
    or (select count(distinct x.value->>'dimension') from jsonb_array_elements(p_usage_quote#>'{price,rates}') x(value))<>3
    or coalesce(p_usage_quote#>>'{policy,microUsdPerCredit}','') !~ '^[1-9][0-9]{0,20}$'
    or coalesce(p_usage_quote#>>'{policy,markupBasisPoints}','') !~ '^[1-9][0-9]{0,6}$'
    or (p_usage_quote#>>'{policy,markupBasisPoints}')::integer not between 10000 and 1000000
    or coalesce(p_usage_quote#>>'{policy,platformMicroUsd}','') !~ '^(0|[1-9][0-9]{0,20})$'
    or coalesce(p_usage_quote#>>'{policy,minimumCredits}','') !~ '^[1-9][0-9]{0,20}$'
    or coalesce(p_usage_quote->>'maximumProviderMicroUsd','') !~ '^(0|[1-9][0-9]{0,20})$' then
    raise exception 'Book Bible quote must exactly use its approved catalog snapshot' using errcode='22023'; end if;
  select sum((rate.value->>'microUsdPerMillionTokens')::numeric*(maximum.value->>'tokens')::numeric)
    into v_quote_cost from jsonb_array_elements(p_usage_quote#>'{price,rates}') rate(value)
    join jsonb_array_elements(p_usage_quote->'maximumTokens') maximum(value)
      on maximum.value->>'dimension'=rate.value->>'dimension';
  v_quote_minimum:=(p_usage_quote#>>'{policy,minimumCredits}')::numeric;
  v_quote_micro_per_credit:=(p_usage_quote#>>'{policy,microUsdPerCredit}')::numeric;
  v_quote_markup:=(p_usage_quote#>>'{policy,markupBasisPoints}')::numeric;
  v_quote_platform:=(p_usage_quote#>>'{policy,platformMicroUsd}')::numeric;
  v_quote_credits:=greatest(v_quote_minimum,ceil((v_quote_cost+v_quote_platform*1000000)*v_quote_markup
    /(1000000::numeric*10000*v_quote_micro_per_credit)));
  if (p_usage_quote->>'maximumProviderMicroUsd')::numeric is distinct from ceil(v_quote_cost/1000000)
    or (p_usage_quote->>'reservedCredits')::numeric is distinct from v_quote_credits then
    raise exception 'Book Bible quote credits do not match the approved token-price catalog' using errcode='23514'; end if;
  v_credits:=(p_usage_quote->>'reservedCredits')::integer;
  if v_credits<=0 then raise exception 'Book Bible quote must reserve positive credits' using errcode='22023'; end if;
  update public.book_bible_token_quote_requests set status='ready',lease_token=null,lease_expires_at=null,
    generation_request_sha256=p_request_sha256,counted_input_tokens=p_counted_input_tokens,usage_quote_json=p_usage_quote
    where id=p_request_id returning * into v_request;
  return v_request;
end $$;

create function public.fail_book_bible_token_quote_count(p_request_id uuid,p_user_id uuid,p_lease_token uuid,p_error_code text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,99}$' then raise exception 'invalid Book Bible quote error' using errcode='22023'; end if;
  update public.book_bible_token_quote_requests set status='failed',lease_token=null,lease_expires_at=null,error_code=p_error_code
    where id=p_request_id and user_id=p_user_id and status='counting' and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.accept_book_bible_token_quote(p_request_id uuid,p_user_id uuid,p_expected_credits integer)
returns public.ai_jobs language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_quote public.book_bible_token_quote_requests; v_job public.ai_jobs; v_role text; v_source jsonb; v_context jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_quote from public.book_bible_token_quote_requests where id=p_request_id for update;
  if not found or v_quote.user_id is distinct from p_user_id then raise exception 'Book Bible quote not found' using errcode='P0002'; end if;
  select role::text into v_role from public.workspace_members where workspace_id=v_quote.workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then raise exception 'Book Bible quote requires writing access' using errcode='42501'; end if;
  if v_quote.accepted_job_id is not null then
    if p_expected_credits is distinct from (v_quote.usage_quote_json->>'reservedCredits')::integer then
      raise exception 'Book Bible quote confirmation mismatch' using errcode='23514'; end if;
    select * into v_job from public.ai_jobs where id=v_quote.accepted_job_id;
    if not found then raise exception 'accepted Book Bible job missing' using errcode='P0002'; end if;
    return v_job;
  end if;
  if v_quote.status<>'ready' or v_quote.usage_quote_json is null or v_quote.generation_request_sha256 is null
    or p_expected_credits is distinct from (v_quote.usage_quote_json->>'reservedCredits')::integer
    or (v_quote.usage_quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
    or (v_quote.catalog_json->>'expiresAt')::timestamptz<=clock_timestamp()
    or v_quote.catalog_json->'approved' is distinct from 'true'::jsonb
    or v_quote.usage_quote_json#>>'{scope,jobId}' is distinct from v_quote.generation_job_id::text
    or v_quote.usage_quote_json#>>'{scope,userId}' is distinct from v_quote.user_id::text
    or v_quote.usage_quote_json#>>'{scope,workspaceId}' is distinct from v_quote.workspace_id::text
    or v_quote.usage_quote_json#>>'{scope,inputSha256}' is distinct from v_quote.generation_request_sha256
    or v_quote.usage_quote_json#>>'{price,provider}' is distinct from 'openai'
    or not exists(select 1 from jsonb_array_elements(v_quote.catalog_json->'entries') e
      where e#>'{price,provider}'='"openai"'::jsonb
        and e#>'{policy,approved}'='true'::jsonb and e#>>'{price,model}'=v_quote.usage_quote_json#>>'{price,model}'
        and e#>>'{price,version}'=v_quote.usage_quote_json#>>'{price,version}'
        and e#>>'{policy,version}'=v_quote.usage_quote_json#>>'{policy,version}') then
    raise exception 'Book Bible quote expired or confirmation mismatch' using errcode='23514'; end if;
  if not exists(select 1 from public.books where id=v_quote.book_id and workspace_id=v_quote.workspace_id for share) then
    raise exception 'Book Bible quote book scope mismatch' using errcode='22023'; end if;
  for v_source in select value from jsonb_array_elements(v_quote.source_versions_json->'versions') loop
    if not exists(select 1 from public.chapters c join public.document_versions d
      on d.id=c.current_document_version_id and d.chapter_id=c.id where c.id=(v_source->>'chapterId')::uuid
        and c.book_id=v_quote.book_id and d.id=(v_source->>'documentVersionId')::uuid
        and d.version_number=(v_source->>'version')::integer) then
      raise exception 'Book Bible source version changed; request a new quote' using errcode='40001'; end if;
  end loop;
  if exists(select 1 from public.ai_jobs where book_id=v_quote.book_id and created_by=p_user_id
      and agent_type='bookbible' and status in ('queued','running')) then
    raise exception 'Book Bible request already active' using errcode='23505'; end if;
  if exists(select 1 from public.ai_jobs where created_by=p_user_id and book_id=v_quote.book_id and agent_type='bookbible'
      and status='succeeded' and input_ref#>>'{reading,fingerprint}'=v_quote.source_versions_json#>>'{reading,fingerprint}'
      and input_ref#>>'{reading,pageIndex}'=v_quote.source_versions_json#>>'{reading,pageIndex}') then
    raise exception 'Book Bible reading page was already completed' using errcode='23505'; end if;
  v_context:=coalesce((select jsonb_agg(jsonb_build_object('chapterId',chapter.key,
      'documentVersionId',chapter.value->>'documentVersionId','nodeId',node.value->>'id','textHash',node.value->>'textHash')
      order by chapter.key,node.ordinality) from jsonb_each(v_quote.generation_request_json#>'{input,chapters}') chapter
      cross join lateral jsonb_array_elements(chapter.value->'nodes') with ordinality node(value,ordinality)),'[]'::jsonb);
  insert into public.ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,status,input_ref,idempotency_key,created_by,model)
    values(v_quote.generation_job_id,v_quote.workspace_id,v_quote.book_id,'bookbible','quoted','queued',jsonb_build_object(
      'bookBibleQuoteRequestId',v_quote.id,'sourceSha256',v_quote.source_sha256,
      'generationRequestSha256',v_quote.generation_request_sha256,'chapterVersions',v_quote.source_versions_json->'versions',
      'contextSources',v_context,'reading',v_quote.source_versions_json->'reading',
      'generationRequest',v_quote.generation_request_json),
      'book-bible-quote:'||v_quote.id::text,p_user_id,v_quote.generation_request_json->>'model') returning * into v_job;
  perform public.reserve_funded_usage_quote(v_quote.usage_quote_json);
  update public.book_bible_token_quote_requests set accepted_job_id=v_job.id,accepted_at=clock_timestamp() where id=v_quote.id;
  return v_job;
end $$;

create function public.claim_quoted_book_bible_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_request public.book_bible_token_quote_requests; v_quote public.funded_usage_quotes;
  v_reason text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds not between 30 and 600 then raise exception 'invalid Book Bible lease' using errcode='22023'; end if;
  -- Expired quotes or source versions changed before the first provider call
  -- are safe to release. Once dispatched, funds are never automatically freed.
  for v_job in select j.* from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    join public.book_bible_token_quote_requests r on r.id=(j.input_ref->>'bookBibleQuoteRequestId')::uuid
    where j.agent_type='bookbible' and j.billing_mode='quoted'
      and (j.status='queued' or (j.status='running' and j.lease_expires_at<=clock_timestamp()))
      and q.status='held' and q.dispatched_at is null
      and ((q.quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
        or exists(select 1 from jsonb_array_elements(r.source_versions_json->'versions') s(item)
          where not exists(select 1 from public.chapters c join public.document_versions d
            on d.id=c.current_document_version_id and d.chapter_id=c.id where c.id=(s.item->>'chapterId')::uuid
              and c.book_id=j.book_id and d.id=(s.item->>'documentVersionId')::uuid
              and d.version_number=(s.item->>'version')::integer)))
    order by j.created_at,j.id for update of j,q skip locked limit 25
  loop
    select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
    v_reason:=case when (v_quote.quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
      then 'quote_expired_before_dispatch' else 'source_changed_before_dispatch' end;
    insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
      values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',v_job.id);
    update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
      'status','cancelled','reason',v_reason,'releaseCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint')
      where job_id=v_job.id;
    update public.ai_jobs set status='failed',completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,
      error_code=case when v_reason='quote_expired_before_dispatch'
      then 'book_bible_quote_expired_before_dispatch' else 'book_bible_source_changed_before_dispatch' end,
      error_message='Book Bible quote could not be dispatched with the accepted source and pricing.' where id=v_job.id;
  end loop;
  select j.* into v_job from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    where j.agent_type='bookbible' and j.billing_mode='quoted'
      and ((j.status='queued' and q.status='held' and q.dispatched_at is null)
        or (j.status='running' and j.lease_expires_at<=clock_timestamp() and q.status='held'))
    order by j.created_at,j.id for update of j skip locked limit 1;
  if not found then return; end if;
  select * into v_request from public.book_bible_token_quote_requests where id=(v_job.input_ref->>'bookBibleQuoteRequestId')::uuid for update;
  select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
  if not found or v_request.accepted_job_id is distinct from v_job.id or v_request.user_id is distinct from v_job.created_by
    or v_request.workspace_id is distinct from v_job.workspace_id or v_request.book_id is distinct from v_job.book_id
    or v_request.generation_request_sha256 is distinct from v_job.input_ref->>'generationRequestSha256'
    or v_quote.user_id is distinct from v_job.created_by or v_quote.workspace_id is distinct from v_job.workspace_id
    or v_quote.status<>'held' or v_quote.quote_json is distinct from v_request.usage_quote_json then
    raise exception 'quoted Book Bible job identity or funding mismatch' using errcode='22023'; end if;
  -- A claimed lease is not a provider dispatch. A replacement worker may make
  -- the first call only through claim_funded_dispatch; a persisted marker means
  -- receipt recovery only, even if the old process never received its reply.
  if v_quote.dispatched_at is null and (v_quote.quote_json->>'expiresAt')::timestamptz<=clock_timestamp() then return; end if;
  update public.ai_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),started_at=coalesce(started_at,clock_timestamp()),completed_at=null
    where id=v_job.id returning * into v_job;
  return next v_job;
end $$;

create function public.renew_quoted_book_bible_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds not between 30 and 600 then raise exception 'invalid Book Bible lease' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and agent_type='bookbible' and billing_mode='quoted' and status='running'
      and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.release_quoted_book_bible_before_dispatch(p_job_id uuid,p_lease_token uuid,p_reason text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_reason not in ('source_changed','request_mismatch') then raise exception 'invalid Book Bible pre-dispatch reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.agent_type<>'bookbible' or v_job.billing_mode<>'quoted' or v_job.status<>'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'Book Bible lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is not null then
    raise exception 'dispatched Book Bible request cannot be released' using errcode='23514'; end if;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',p_job_id);
  update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
    'status','cancelled','reason',p_reason,'releaseCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint')
    where job_id=p_job_id;
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code=case when p_reason='source_changed' then 'book_bible_source_changed_before_dispatch' else 'book_bible_request_mismatch_before_dispatch' end,
    error_message='Book Bible request could not be verified before provider dispatch.' where id=p_job_id;
  return true;
end $$;

create function public.hold_quoted_book_bible_for_review(p_job_id uuid,p_lease_token uuid,p_reason text,p_request_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_reason not in ('provider_outcome_unknown','invalid_result','usage_unreconciled')
    or coalesce(length(trim(p_request_id)),0) not between 1 and 256 then raise exception 'invalid Book Bible review hold reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.agent_type<>'bookbible' or v_job.billing_mode<>'quoted' or v_job.status<>'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'Book Bible lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is null then
    raise exception 'Book Bible review hold requires a dispatched funded quote' using errcode='23514'; end if;
  perform public.settle_funded_usage_quote(p_job_id,jsonb_build_object('status','requires_review','requestId',trim(p_request_id),
    'reason',p_reason,'heldCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint'));
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code='book_bible_requires_billing_review',error_message='Book Bible result is held for provider and billing review.' where id=p_job_id;
  return true;
end $$;

create function public.complete_quoted_book_bible_job(
  p_job_id uuid,p_lease_token uuid,p_provider text,p_model text,p_request_id text,
  p_usage jsonb,p_diagnostics jsonb,p_candidates jsonb,p_settlement jsonb
) returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_job public.ai_jobs; v_quote public.funded_usage_quotes; v_request public.book_bible_token_quote_requests;
  v_organization_id uuid; v_candidate jsonb; v_source jsonb; v_attrs jsonb; v_node jsonb; v_content jsonb;
  v_hash text; v_receipt jsonb; v_measured_input numeric; v_measured_cached numeric; v_measured_output numeric;
  v_numerator numeric:=0; v_rate jsonb; v_item jsonb; v_actual_micro_usd numeric; v_actual_credits numeric;
  v_minimum numeric; v_micro_per_credit numeric; v_markup numeric; v_platform numeric; v_bound numeric;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if coalesce(length(trim(p_request_id)),0) not between 1 and 256 then raise exception 'invalid Book Bible provider request ID' using errcode='22023'; end if;
  v_receipt:=jsonb_build_object('requestId',trim(p_request_id),'provider',trim(p_provider),'model',trim(p_model),
    'usage',p_usage,'diagnostics',p_diagnostics,'candidates',p_candidates,'settlement',p_settlement);
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.agent_type<>'bookbible' or v_job.billing_mode<>'quoted' then raise exception 'quoted Book Bible job missing' using errcode='P0002'; end if;
  if v_job.status='succeeded' then
    if not exists(select 1 from public.book_bible_quote_service_receipts r where r.job_id=p_job_id and r.result_json=v_receipt)
      then raise exception 'Book Bible completion replay mismatch' using errcode='23505'; end if;
    return v_job;
  end if;
  if v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'Book Bible quote lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  select * into v_request from public.book_bible_token_quote_requests where id=(v_job.input_ref->>'bookBibleQuoteRequestId')::uuid for share;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is null
    or v_quote.user_id is distinct from v_job.created_by or v_quote.workspace_id is distinct from v_job.workspace_id
    or v_quote.quote_json is distinct from v_request.usage_quote_json
    or v_request.accepted_job_id is distinct from v_job.id
    or v_request.generation_request_sha256 is distinct from v_job.input_ref->>'generationRequestSha256'
    or v_quote.quote_json#>>'{price,provider}' is distinct from p_provider
    or v_quote.quote_json#>>'{price,model}' is distinct from p_model
    or p_settlement->>'status' is distinct from 'settle'
    or p_settlement->>'requestId' is distinct from trim(p_request_id)
    or jsonb_typeof(p_usage->'measuredTokens') is distinct from 'array'
    or jsonb_typeof(p_settlement->'tokens') is distinct from 'array'
    or jsonb_array_length(p_settlement->'tokens')<>3 then
    raise exception 'Book Bible funded receipt mismatch' using errcode='23514'; end if;
  if p_usage ? 'latencyMs' and (jsonb_typeof(p_usage->'latencyMs') is distinct from 'number'
      or p_usage->>'latencyMs' !~ '^[0-9]+$' or (p_usage->>'latencyMs')::numeric>2147483647) then
    raise exception 'invalid quoted Book Bible latency' using errcode='22023'; end if;
  if jsonb_typeof(p_usage->'inputTokens') is distinct from 'number' or p_usage->>'inputTokens' !~ '^[0-9]+$'
    or (p_usage->>'inputTokens')::numeric>2147483647
    or jsonb_typeof(p_usage->'outputTokens') is distinct from 'number' or p_usage->>'outputTokens' !~ '^[0-9]+$'
    or (p_usage->>'outputTokens')::numeric>2147483647
    or jsonb_typeof(p_usage->'estimatedCostUsd') is distinct from 'number' or (p_usage->>'estimatedCostUsd')::numeric<0
    or jsonb_typeof(p_diagnostics) is distinct from 'array' or jsonb_array_length(p_diagnostics)>500
    or octet_length(p_diagnostics::text)>2000000 or jsonb_typeof(p_candidates) is distinct from 'array'
    or jsonb_array_length(p_candidates)>10 or octet_length(p_candidates::text)>1000000 then
    raise exception 'invalid quoted Book Bible completion values' using errcode='22023'; end if;
  if jsonb_array_length(p_usage->'measuredTokens')<>3 then raise exception 'Book Bible needs exactly three measured token dimensions' using errcode='23514'; end if;
  for v_item in select value from jsonb_array_elements(p_usage->'measuredTokens') loop
    if jsonb_typeof(v_item) is distinct from 'object' or v_item - array['dimension','tokens']<>'{}'::jsonb
      or v_item->>'dimension' not in ('text_input','text_cached_input','text_output')
      or coalesce(v_item->>'tokens','') !~ '^(0|[1-9][0-9]{0,20})$'
      or (select count(*) from jsonb_array_elements(p_usage->'measuredTokens') x where x->>'dimension'=v_item->>'dimension')<>1
      or not exists(select 1 from jsonb_array_elements(v_quote.quote_json->'maximumTokens') m
        where m->>'dimension'=v_item->>'dimension' and (v_item->>'tokens')::numeric<=(m->>'tokens')::numeric) then
      raise exception 'invalid or out-of-quote measured Book Bible token usage' using errcode='23514'; end if;
    if not exists(select 1 from jsonb_array_elements(p_settlement->'tokens') s
      where s->>'dimension'=v_item->>'dimension' and s->>'tokens'=v_item->>'tokens') then
      raise exception 'Book Bible settlement token dimensions differ from provider receipt' using errcode='23514'; end if;
  end loop;
  select coalesce(sum((x->>'tokens')::numeric) filter(where x->>'dimension'='text_input'),0),
    coalesce(sum((x->>'tokens')::numeric) filter(where x->>'dimension'='text_cached_input'),0),
    coalesce(sum((x->>'tokens')::numeric) filter(where x->>'dimension'='text_output'),0)
    into v_measured_input,v_measured_cached,v_measured_output from jsonb_array_elements(p_usage->'measuredTokens') x;
  if (p_usage->>'inputTokens')::numeric is distinct from v_measured_input+v_measured_cached
    or (p_usage->>'outputTokens')::numeric is distinct from v_measured_output then
    raise exception 'Book Bible measured usage does not match aggregate tokens' using errcode='23514'; end if;
  if p_settlement#>>'{priceVersion}' is distinct from v_quote.quote_json#>>'{price,version}'
    or p_settlement#>>'{policyVersion}' is distinct from v_quote.quote_json#>>'{policy,version}' then
    raise exception 'Book Bible settlement version mismatch' using errcode='23514'; end if;
  for v_item in select value from jsonb_array_elements(p_usage->'measuredTokens') loop
    select value into v_rate from jsonb_array_elements(v_quote.quote_json#>'{price,rates}') rates(value)
      where value->>'dimension'=v_item->>'dimension';
    if v_rate is null or coalesce(v_rate->>'microUsdPerMillionTokens','') !~ '^(0|[1-9][0-9]{0,20})$' then
      raise exception 'Book Bible quote omits a measured token price' using errcode='23514'; end if;
    v_numerator:=v_numerator+(v_rate->>'microUsdPerMillionTokens')::numeric*(v_item->>'tokens')::numeric;
  end loop;
  v_actual_micro_usd:=ceil(v_numerator/1000000);
  v_micro_per_credit:=(v_quote.quote_json#>>'{policy,microUsdPerCredit}')::numeric;
  v_markup:=(v_quote.quote_json#>>'{policy,markupBasisPoints}')::numeric;
  v_platform:=(v_quote.quote_json#>>'{policy,platformMicroUsd}')::numeric;
  v_minimum:=(v_quote.quote_json#>>'{policy,minimumCredits}')::numeric;
  if v_micro_per_credit<=0 or v_markup<10000 or v_platform<0 or v_minimum<=0 then
    raise exception 'invalid Book Bible credit policy snapshot' using errcode='23514'; end if;
  v_actual_credits:=greatest(v_minimum,ceil((v_numerator+v_platform*1000000)*v_markup/(1000000::numeric*10000*v_micro_per_credit)));
  if coalesce(p_settlement->>'providerMicroUsd','') !~ '^(0|[1-9][0-9]{0,20})$'
    or (p_settlement->>'providerMicroUsd')::numeric is distinct from v_actual_micro_usd
    or coalesce(p_settlement->>'debitCredits','') !~ '^[1-9][0-9]{0,9}$'
    or (p_settlement->>'debitCredits')::numeric is distinct from v_actual_credits
    or coalesce(p_settlement->>'releaseCredits','') !~ '^(0|[1-9][0-9]{0,9})$'
    or (p_settlement->>'debitCredits')::numeric+(p_settlement->>'releaseCredits')::numeric<>v_quote.reserved_credits
    or (p_settlement->>'fingerprint') is distinct from v_quote.quote_json->>'fingerprint' then
    raise exception 'Book Bible measured settlement does not match approved quote math' using errcode='23514'; end if;
  if jsonb_typeof(v_job.input_ref->'contextSources') is distinct from 'array' then
    raise exception 'Book Bible trusted sources missing' using errcode='23514'; end if;
  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    v_attrs:=v_candidate->'attributes';
    if jsonb_typeof(v_candidate) is distinct from 'object'
      or not (v_candidate ?& array['suggestionKind','status','type','name','description','attributes','sourceRefs','confidence'])
      or v_candidate-array['suggestionKind','status','type','name','description','attributes','sourceRefs','confidence']<>'{}'::jsonb
      or v_candidate->>'suggestionKind' is distinct from 'book_bible_candidate' or v_candidate->>'status' is distinct from 'pending'
      or v_candidate->>'type' not in ('character','place','organization','object','event','term')
      or jsonb_typeof(v_candidate->'name') is distinct from 'string' or coalesce(length(v_candidate->>'name'),0) not between 1 and 160
      or v_candidate->>'name'<>trim(v_candidate->>'name') or jsonb_typeof(v_candidate->'description') is distinct from 'string'
      or length(v_candidate->>'description')>12000 or v_candidate->>'description'<>trim(v_candidate->>'description')
      or jsonb_typeof(v_attrs) is distinct from 'object' or octet_length(v_attrs::text)>24000
      or jsonb_typeof(v_candidate->'confidence') is distinct from 'number'
      or (v_candidate->>'confidence')::numeric not between 0 and 1
      or jsonb_typeof(v_candidate->'sourceRefs') is distinct from 'array'
      or jsonb_array_length(v_candidate->'sourceRefs') not between 1 and 30 then
      raise exception 'invalid quoted Book Bible candidate' using errcode='22023'; end if;
    if (select count(*) from jsonb_object_keys(v_attrs))>40 or exists(select 1 from jsonb_object_keys(v_attrs) k where length(k) not between 1 and 80)
      or v_attrs ?| array['imageAssetIds','__proto__','constructor','prototype'] then raise exception 'invalid Book Bible candidate attributes' using errcode='22023'; end if;
    for v_source in select value from jsonb_array_elements(v_candidate->'sourceRefs') loop
      if jsonb_typeof(v_source) is distinct from 'object'
        or not (v_source ?& array['chapterId','documentVersionId','nodeId','textHash'])
        or v_source-array['chapterId','documentVersionId','nodeId','textHash']<>'{}'::jsonb
        or coalesce(v_source->>'chapterId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_source->>'documentVersionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(length(v_source->>'nodeId'),0) not between 1 and 200 or coalesce(v_source->>'textHash','') !~ '^[a-f0-9]{64}$'
        or not exists(select 1 from jsonb_array_elements(v_job.input_ref->'contextSources') trusted where trusted.value=v_source) then
        raise exception 'Book Bible candidate cites an untrusted source' using errcode='42501'; end if;
      select d.content_json into v_content from public.chapters c join public.document_versions d
        on d.id=(v_source->>'documentVersionId')::uuid where c.id=(v_source->>'chapterId')::uuid
        and c.book_id=v_job.book_id and d.chapter_id=c.id;
      if not found then raise exception 'Book Bible candidate source version unavailable' using errcode='42501'; end if;
      select n.value into v_node from jsonb_array_elements(v_content->'nodes') n(value) where n.value->>'id'=v_source->>'nodeId' limit 1;
      if not found or encode(public.digest(v_node->>'text','sha256'),'hex') is distinct from v_source->>'textHash' then
        raise exception 'Book Bible candidate source hash mismatch' using errcode='42501'; end if;
    end loop;
  end loop;
  for v_item in select value from jsonb_array_elements(p_diagnostics) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or not (v_item ?& array['severity','code','message','location'])
      or coalesce(length(trim(v_item->>'severity')),0)=0 or coalesce(length(trim(v_item->>'code')),0)=0
      or coalesce(length(trim(v_item->>'message')),0)=0
      or jsonb_typeof(v_item->'location') is distinct from 'object' then
      raise exception 'invalid Book Bible diagnostic' using errcode='22023'; end if;
  end loop;
  select organization_id into v_organization_id from public.workspaces where id=v_job.workspace_id;
  if v_organization_id is null then raise exception 'Book Bible job workspace missing' using errcode='P0002'; end if;
  perform public.settle_funded_usage_quote(p_job_id,p_settlement);
  insert into public.ai_runs(ai_job_id,workspace_id,provider,model,tokens_in,tokens_out,estimated_cost,latency_ms,status)
    values(v_job.id,v_job.workspace_id,trim(p_provider),trim(p_model),(p_usage->>'inputTokens')::integer,
      (p_usage->>'outputTokens')::integer,(p_usage->>'estimatedCostUsd')::numeric,
      case when p_usage ? 'latencyMs' and p_usage->>'latencyMs' ~ '^[0-9]+$' then (p_usage->>'latencyMs')::integer end,'succeeded');
  insert into public.usage_events(ai_job_id,organization_id,user_id,workspace_id,meter,quantity,metadata_json)
    values(v_job.id,v_organization_id,v_job.created_by,v_job.workspace_id,'ai_credits',0,
      jsonb_build_object('aiJobId',v_job.id,'provider',trim(p_provider),'model',trim(p_model),'kind','book_bible_candidate','billingMode','quoted'));
  insert into public.book_bible_quote_service_receipts(job_id,request_sha256,request_id,provider,model,result_json)
    values(v_job.id,v_request.generation_request_sha256,trim(p_request_id),trim(p_provider),trim(p_model),v_receipt);
  update public.ai_jobs set status='succeeded',output_ref=jsonb_build_object('candidates',p_candidates,'diagnostics',p_diagnostics,
      'reviewRequired',true,'savedBibleUpdated',false),model=trim(p_model),usage_json=p_usage,error_code=null,error_message=null,
      lease_token=null,lease_expires_at=null,completed_at=clock_timestamp()
    where id=v_job.id returning * into v_job;
  return v_job;
end $$;

revoke all on function public.request_book_bible_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,boolean),
  public.complete_book_bible_token_quote_count(uuid,uuid,uuid,text,integer,jsonb),
  public.fail_book_bible_token_quote_count(uuid,uuid,uuid,text),
  public.accept_book_bible_token_quote(uuid,uuid,integer),
  public.claim_quoted_book_bible_job(integer),public.renew_quoted_book_bible_lease(uuid,uuid,integer),
  public.release_quoted_book_bible_before_dispatch(uuid,uuid,text),
  public.hold_quoted_book_bible_for_review(uuid,uuid,text,text),
  public.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.request_book_bible_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,boolean),
  public.complete_book_bible_token_quote_count(uuid,uuid,uuid,text,integer,jsonb),
  public.fail_book_bible_token_quote_count(uuid,uuid,uuid,text),
  public.accept_book_bible_token_quote(uuid,uuid,integer),
  public.claim_quoted_book_bible_job(integer),public.renew_quoted_book_bible_lease(uuid,uuid,integer),
  public.release_quoted_book_bible_before_dispatch(uuid,uuid,text),
  public.hold_quoted_book_bible_for_review(uuid,uuid,text,text),
  public.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;

comment on table public.book_bible_token_quote_requests is
  'Private exact-input Book Bible token quotes; counting consent is mandatory, and only explicit acceptance creates a funded generation job.';
