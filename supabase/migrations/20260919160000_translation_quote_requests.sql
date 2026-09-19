-- Preparation is distinct from purchase. No AI generation job or debit here.
create table public.translation_quote_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  workspace_id uuid not null references public.workspaces(id),
  book_id uuid not null references public.books(id),
  source_language text not null,
  target_language text not null,
  model_id text not null,
  catalog_json jsonb not null,
  chapters_json jsonb not null,
  counts_json jsonb not null default '{}',
  status text not null default 'queued' check(status in ('queued','running','ready','failed')),
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  proposal_id uuid references public.translation_quote_proposals(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,idempotency_key),
  check(jsonb_typeof(chapters_json)='array' and jsonb_array_length(chapters_json) between 1 and 500),
  check(jsonb_typeof(catalog_json)='object' and octet_length(catalog_json::text)<=65536),
  check(jsonb_typeof(counts_json)='object'),
  check((status='ready')=(proposal_id is not null)),
  check((lease_token is null)=(lease_expires_at is null))
);
alter table public.translation_quote_requests enable row level security;
revoke all on public.translation_quote_requests from public,anon,authenticated;
grant select,insert,update on public.translation_quote_requests to service_role;
create unique index translation_quote_request_active on public.translation_quote_requests(user_id,book_id)
  where status in ('queued','running');

create function public.guard_translation_quote_request() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if (to_jsonb(new)-array['counts_json','status','lease_token','lease_expires_at','error_code','proposal_id'])
    is distinct from (to_jsonb(old)-array['counts_json','status','lease_token','lease_expires_at','error_code','proposal_id'])
    or (old.status in ('ready','failed') and new is distinct from old) then
    raise exception 'translation quote request is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_translation_quote_request() from public,anon,authenticated;
create trigger translation_quote_request_immutable before update on public.translation_quote_requests
for each row execute function public.guard_translation_quote_request();

create function public.request_translation_quote(p_book_id uuid,p_user_id uuid,p_target_language text,
  p_model_id text,p_catalog_json jsonb,p_idempotency_key text) returns public.translation_quote_requests
language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_book public.books; v_role text; v_existing public.translation_quote_requests;
  v_source record; v_sources jsonb:='[]'; v_count integer:=0;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_user_id is null or p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200
    or p_target_language is null or p_target_language !~ '^[a-z]{2,8}(-[a-z0-9]{2,8})*$' or length(p_target_language)>35
    or p_model_id is null or length(p_model_id) not between 1 and 64 then
    raise exception 'invalid translation quote request' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('translation-quote-user:'||p_user_id::text,0));
  select * into v_book from public.books where id=p_book_id for share;
  if not found then raise exception 'translation book missing' using errcode='P0002'; end if;
  select role into v_role from public.workspace_members where workspace_id=v_book.workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then
    raise exception 'translation editing access required' using errcode='42501'; end if;
  select * into v_existing from public.translation_quote_requests where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.book_id<>p_book_id or v_existing.target_language<>p_target_language or v_existing.model_id<>p_model_id then
      raise exception 'translation quote key conflict' using errcode='23505'; end if;
    return v_existing;
  end if;
  if exists(select 1 from public.translation_quote_requests where user_id=p_user_id and book_id=p_book_id and status in ('queued','running')) then
    raise exception 'translation quote already preparing' using errcode='23505'; end if;
  if (select count(*) from public.translation_quote_requests where user_id=p_user_id and created_at>clock_timestamp()-interval '1 hour')>=3 then
    raise exception 'translation quote request limit reached' using errcode='54000'; end if;
  if lower(v_book.language)=p_target_language or lower(v_book.language) !~ '^[a-z]{2,8}(-[a-z0-9]{2,8})*$'
    or p_catalog_json->'approved' is distinct from 'true'::jsonb
    or coalesce(jsonb_typeof(p_catalog_json->'entries'),'')<>'array'
    or not exists(select 1 from jsonb_array_elements(p_catalog_json->'entries') e where e->>'id'=p_model_id)
    or (p_catalog_json->>'expiresAt') is null or (p_catalog_json->>'effectiveAt') is null
    or (p_catalog_json->>'expiresAt')::timestamptz<=clock_timestamp()
    or (p_catalog_json->>'effectiveAt')::timestamptz>clock_timestamp() then
    raise exception 'invalid translation catalog or language' using errcode='22023'; end if;
  for v_source in select c.id,c.order_index,d.id as version_id,d.plain_text from public.chapters c
    left join public.document_versions d on d.id=c.current_document_version_id and d.chapter_id=c.id
    where c.book_id=p_book_id order by c.order_index,c.id
  loop
    if v_source.version_id is null or length(trim(coalesce(v_source.plain_text,'')))=0 or length(v_source.plain_text)>32000 then
      raise exception 'every chapter needs saved text within translation limits' using errcode='22023'; end if;
    v_count:=v_count+1;
    v_sources:=v_sources||jsonb_build_array(jsonb_build_object('chapterId',v_source.id,'documentVersionId',v_source.version_id,
      'chapterOrder',v_source.order_index,'jobId',gen_random_uuid(),
      'sourceSha256',encode(digest(convert_to(v_source.plain_text,'UTF8'),'sha256'),'hex')));
  end loop;
  if v_count not between 1 and 500 then raise exception 'translation requires one to 500 chapters' using errcode='22023'; end if;
  insert into public.translation_quote_requests(user_id,workspace_id,book_id,source_language,target_language,model_id,catalog_json,chapters_json,idempotency_key)
    values(p_user_id,v_book.workspace_id,p_book_id,lower(v_book.language),p_target_language,p_model_id,p_catalog_json,v_sources,p_idempotency_key)
    returning * into v_existing;
  return v_existing;
end $$;
revoke all on function public.request_translation_quote(uuid,uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.request_translation_quote(uuid,uuid,text,text,jsonb,text) to service_role;
