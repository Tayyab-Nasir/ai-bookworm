-- Private server-owned offers; neither quotes nor counts are client-writable.
create table public.translation_quote_proposals (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  workspace_id uuid not null references public.workspaces(id),
  book_id uuid not null references public.books(id),
  source_language text not null check(source_language ~ '^[a-z]{2,8}(-[a-z0-9]{2,8})*$' and length(source_language)<=35),
  target_language text not null check(target_language ~ '^[a-z]{2,8}(-[a-z0-9]{2,8})*$' and length(target_language)<=35),
  catalog_version text not null check(length(catalog_version) between 1 and 128),
  chapters_json jsonb not null check(jsonb_typeof(chapters_json)='array' and jsonb_array_length(chapters_json) between 1 and 500 and octet_length(chapters_json::text)<=33554432),
  reserved_credits integer not null check(reserved_credits>0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_project_id uuid unique references public.translation_projects(id),
  check(source_language<>target_language),
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour'),
  check((accepted_at is null)=(accepted_project_id is null))
);
alter table public.translation_quote_proposals enable row level security;
revoke all on public.translation_quote_proposals from public,anon,authenticated;
grant select,insert on public.translation_quote_proposals to service_role;
grant update(accepted_at,accepted_project_id) on public.translation_quote_proposals to service_role;

create function public.guard_translation_proposal() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if (to_jsonb(new)-'accepted_at'-'accepted_project_id') is distinct from (to_jsonb(old)-'accepted_at'-'accepted_project_id')
    or (old.accepted_at is not null and new is distinct from old) then
    raise exception 'translation proposal is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_translation_proposal() from public,anon,authenticated;
create trigger translation_proposal_immutable before update on public.translation_quote_proposals
for each row execute function public.guard_translation_proposal();

create function public.accept_translation_quote(p_proposal_id uuid,p_user_id uuid,p_expected_credits integer)
returns public.translation_projects language plpgsql security invoker set search_path=public,extensions,pg_temp as $$
declare v_offer public.translation_quote_proposals; v_project public.translation_projects;
  v_book public.books; v_role text; v_item jsonb; v_doc public.document_versions;
  v_total bigint:=0; v_units integer; v_total_units integer:=0; v_chapter_id uuid; v_job_id uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_offer from public.translation_quote_proposals where id=p_proposal_id for update;
  if not found then raise exception 'translation proposal missing' using errcode='P0002'; end if;
  if p_user_id is null or v_offer.user_id<>p_user_id then raise exception 'proposal payer mismatch' using errcode='42501'; end if;
  select role into v_role from public.workspace_members where workspace_id=v_offer.workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then
    raise exception 'translation editing access required' using errcode='42501'; end if;
  if p_expected_credits is distinct from v_offer.reserved_credits then
    raise exception 'proposal credit confirmation mismatch' using errcode='23514'; end if;
  if v_offer.accepted_project_id is not null then
    select * into strict v_project from public.translation_projects where id=v_offer.accepted_project_id;
    return v_project;
  end if;
  if v_offer.expires_at<=clock_timestamp() or v_offer.created_at>clock_timestamp() then
    raise exception 'translation proposal expired' using errcode='22023'; end if;
  select * into v_book from public.books where id=v_offer.book_id for share;
  if not found or v_book.workspace_id<>v_offer.workspace_id or lower(v_book.language)<>v_offer.source_language then
    raise exception 'translation source scope changed' using errcode='23514'; end if;
  if exists(select 1 from jsonb_array_elements(v_offer.chapters_json) c group by c->>'chapterId' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(v_offer.chapters_json) c group by c->>'jobId' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(v_offer.chapters_json) c group by c->>'chapterOrder' having count(*)>1) then
    raise exception 'duplicate proposal chapter' using errcode='22023'; end if;
  for v_item in select value from jsonb_array_elements(v_offer.chapters_json) loop
    select d.* into v_doc from public.document_versions d join public.chapters c on c.id=d.chapter_id
      where d.id=(v_item->>'documentVersionId')::uuid and c.id=(v_item->>'chapterId')::uuid and c.book_id=v_book.id for share of d,c;
    if not found or length(trim(coalesce(v_doc.plain_text,'')))=0 or length(v_doc.plain_text)>32000
      or v_item->>'sourceSha256' is distinct from encode(digest(convert_to(v_doc.plain_text,'UTF8'),'sha256'),'hex') then
      raise exception 'proposal source unavailable or changed' using errcode='23514'; end if;
    if v_item#>>'{quote,scope,jobId}' is distinct from v_item->>'jobId'
      or v_item#>>'{quote,scope,userId}' is distinct from p_user_id::text
      or v_item#>>'{quote,scope,workspaceId}' is distinct from v_offer.workspace_id::text
      or (v_item#>>'{quote,expiresAt}')::timestamptz<v_offer.expires_at then
      raise exception 'proposal quote scope mismatch' using errcode='22023'; end if;
    v_total:=v_total+(v_item#>>'{quote,reservedCredits}')::integer;
    v_total_units:=v_total_units+ceil(length(v_doc.plain_text)::numeric/1000)::integer;
  end loop;
  if v_total is distinct from v_offer.reserved_credits::bigint then
    raise exception 'proposal credits do not balance' using errcode='23514'; end if;
  insert into public.translation_projects(id,workspace_id,book_id,source_language,target_language,chapter_count,credit_units,idempotency_key,created_by)
    values(v_offer.id,v_offer.workspace_id,v_offer.book_id,v_offer.source_language,v_offer.target_language,
      jsonb_array_length(v_offer.chapters_json),v_total_units,'quoted:'||v_offer.id::text,p_user_id) returning * into v_project;
  for v_item in select value from jsonb_array_elements(v_offer.chapters_json) loop
    select * into strict v_doc from public.document_versions where id=(v_item->>'documentVersionId')::uuid;
    v_units:=ceil(length(v_doc.plain_text)::numeric/1000)::integer;
    v_chapter_id:=gen_random_uuid(); v_job_id:=(v_item->>'jobId')::uuid;
    insert into public.ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,status,input_ref,idempotency_key,created_by)
      values(v_job_id,v_offer.workspace_id,v_offer.book_id,'translator','quoted','queued',jsonb_build_object(
        'translationProjectId',v_project.id,'translationChapterId',v_chapter_id,
        'chapterId',v_item->>'chapterId','documentVersionId',v_item->>'documentVersionId',
        'sourceSha256',v_item->>'sourceSha256','sourceLanguage',v_offer.source_language,
        'targetLanguage',v_offer.target_language,'creditUnits',v_units),'quoted:'||v_job_id::text,p_user_id);
    insert into public.translation_chapters(id,project_id,ai_job_id,chapter_id,document_version_id,chapter_order,source_sha256,credit_units)
      values(v_chapter_id,v_project.id,v_job_id,(v_item->>'chapterId')::uuid,(v_item->>'documentVersionId')::uuid,
        (v_item->>'chapterOrder')::integer,v_item->>'sourceSha256',v_units);
    perform public.reserve_funded_usage_quote(v_item->'quote');
  end loop;
  update public.translation_quote_proposals set accepted_at=clock_timestamp(),accepted_project_id=v_project.id where id=v_offer.id;
  return v_project;
end $$;
revoke all on function public.accept_translation_quote(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.accept_translation_quote(uuid,uuid,integer) to service_role;
