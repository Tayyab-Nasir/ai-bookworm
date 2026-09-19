-- A book-level, human-authored planning surface. It deliberately stores no
-- provider prompt or generated text: paid AI drafting remains a separate,
-- reviewable AI-job flow after a planned chapter is materialized.
create table public.story_blueprints (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null unique references public.books(id) on delete cascade,
  revision integer not null default 1 check (revision >= 1),
  details_json jsonb not null default '{}'::jsonb check (jsonb_typeof(details_json) = 'object'),
  chapter_plan_json jsonb not null default '[]'::jsonb check (jsonb_typeof(chapter_plan_json) = 'array'),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (jsonb_array_length(chapter_plan_json) <= 200),
  check (octet_length(details_json::text) <= 48000),
  check (octet_length(chapter_plan_json::text) <= 240000)
);

create table public.story_blueprint_materializations (
  blueprint_id uuid not null references public.story_blueprints(id) on delete cascade,
  blueprint_chapter_id uuid not null,
  chapter_id uuid not null unique references public.chapters(id) on delete restrict,
  materialized_by uuid not null references auth.users(id),
  request_key text not null check (length(request_key) between 8 and 160),
  created_at timestamptz not null default clock_timestamp(),
  primary key (blueprint_id, blueprint_chapter_id),
  unique (blueprint_id, materialized_by, request_key)
);

create index story_blueprints_book_updated on public.story_blueprints(book_id, updated_at desc);
create index story_blueprint_materializations_blueprint on public.story_blueprint_materializations(blueprint_id, created_at);

alter table public.story_blueprints enable row level security;
alter table public.story_blueprint_materializations enable row level security;
revoke all on public.story_blueprints, public.story_blueprint_materializations from public, anon, authenticated;
grant select on public.story_blueprints, public.story_blueprint_materializations to authenticated;
grant all on public.story_blueprints, public.story_blueprint_materializations to service_role;

create policy story_blueprints_read on public.story_blueprints for select to authenticated
  using (exists(select 1 from public.books b where b.id = book_id and private.is_workspace_member(b.workspace_id)));

create policy story_blueprint_materializations_read on public.story_blueprint_materializations for select to authenticated
  using (exists(select 1 from public.story_blueprints bp join public.books b on b.id = bp.book_id
    where bp.id = blueprint_id and private.is_workspace_member(b.workspace_id)));

create trigger story_blueprints_preserve_parent before update on public.story_blueprints
  for each row execute function private.preserve_parent_reference('book_id');
create trigger story_blueprints_preserve_creator before update on public.story_blueprints
  for each row execute function private.preserve_created_by();

create function public.save_story_blueprint(
  p_book_id uuid,
  p_expected_revision integer,
  p_details jsonb,
  p_chapters jsonb
) returns public.story_blueprints
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_book public.books; v_blueprint public.story_blueprints; v_item jsonb;
  v_chapter_id uuid; v_seen uuid[] := '{}'::uuid[];
begin
  if p_book_id is null or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_details) is distinct from 'object'
    or jsonb_typeof(p_chapters) is distinct from 'array'
    or octet_length(p_details::text) > 48000 or octet_length(p_chapters::text) > 240000
    or jsonb_array_length(p_chapters) > 200 then
    raise exception 'invalid story blueprint' using errcode = '22023';
  end if;

  -- Every detail is explicit, bounded, and typed. The API applies the same
  -- schema, while this guard keeps direct RPC callers from bypassing it.
  if not (p_details ?& array['workingTitle','premise','readerPromise','genre','tone','pointOfView','tense','targetWordCount','synopsis','theme','notes'])
    or exists(select 1 from jsonb_object_keys(p_details) key where key not in
      ('workingTitle','premise','readerPromise','genre','tone','pointOfView','tense','targetWordCount','synopsis','theme','notes'))
    or jsonb_typeof(p_details->'workingTitle') is distinct from 'string'
    or jsonb_typeof(p_details->'premise') is distinct from 'string'
    or jsonb_typeof(p_details->'readerPromise') is distinct from 'string'
    or jsonb_typeof(p_details->'genre') is distinct from 'string'
    or jsonb_typeof(p_details->'tone') is distinct from 'string'
    or jsonb_typeof(p_details->'pointOfView') is distinct from 'string'
    or jsonb_typeof(p_details->'tense') is distinct from 'string'
    or jsonb_typeof(p_details->'synopsis') is distinct from 'string'
    or jsonb_typeof(p_details->'theme') is distinct from 'string'
    or jsonb_typeof(p_details->'notes') is distinct from 'string'
    or length(trim(p_details->>'workingTitle')) > 500
    or length(trim(p_details->>'premise')) > 12000
    or length(trim(p_details->>'readerPromise')) > 4000
    or length(trim(p_details->>'genre')) > 240
    or length(trim(p_details->>'tone')) > 240
    or length(trim(p_details->>'pointOfView')) > 120
    or length(trim(p_details->>'tense')) > 120
    or length(trim(p_details->>'synopsis')) > 24000
    or length(trim(p_details->>'theme')) > 4000
    or length(trim(p_details->>'notes')) > 12000
    or (jsonb_typeof(p_details->'targetWordCount') not in ('number','null'))
    or (jsonb_typeof(p_details->'targetWordCount') = 'number' and
      (coalesce(p_details->>'targetWordCount','') !~ '^[1-9][0-9]{2,6}$'
        or (p_details->>'targetWordCount')::integer > 2000000)) then
    raise exception 'invalid story blueprint details' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_chapters) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or not (v_item ?& array['id','title','purpose','summary','targetWords'])
      or exists(select 1 from jsonb_object_keys(v_item) key where key not in ('id','title','purpose','summary','targetWords'))
      or jsonb_typeof(v_item->'id') is distinct from 'string'
      or coalesce(v_item->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(v_item->'title') is distinct from 'string'
      or jsonb_typeof(v_item->'purpose') is distinct from 'string'
      or jsonb_typeof(v_item->'summary') is distinct from 'string'
      or length(trim(v_item->>'title')) not between 1 and 500
      or length(trim(v_item->>'purpose')) > 4000
      or length(trim(v_item->>'summary')) > 16000
      or jsonb_typeof(v_item->'targetWords') not in ('number','null')
      or (jsonb_typeof(v_item->'targetWords') = 'number' and
        (coalesce(v_item->>'targetWords','') !~ '^[1-9][0-9]{1,5}$'
          or (v_item->>'targetWords')::integer > 200000)) then
      raise exception 'invalid story blueprint chapter' using errcode = '22023';
    end if;
    v_chapter_id := (v_item->>'id')::uuid;
    if v_chapter_id = any(v_seen) then
      raise exception 'duplicate story blueprint chapter' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_chapter_id);
  end loop;

  -- Lock the book first. It serializes first saves and materialization with
  -- chapter creation, rather than relying on a race-prone insert retry.
  select * into v_book from public.books where id = p_book_id for update;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id = v_book.workspace_id and user_id = auth.uid() and status = 'active'
      and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'role cannot edit' using errcode = '42501';
  end if;

  select * into v_blueprint from public.story_blueprints where book_id = p_book_id for update;
  if not found then
    if p_expected_revision <> 0 then
      raise exception 'story blueprint changed' using errcode = '40001', detail = '0';
    end if;
    insert into public.story_blueprints(book_id, revision, details_json, chapter_plan_json, created_by, updated_by)
      values(p_book_id, 1, p_details, p_chapters, auth.uid(), auth.uid()) returning * into v_blueprint;
  else
    if p_expected_revision <> v_blueprint.revision then
      raise exception 'story blueprint changed' using errcode = '40001', detail = v_blueprint.revision::text;
    end if;
    if exists(select 1 from public.story_blueprint_materializations m
      where m.blueprint_id = v_blueprint.id and not (m.blueprint_chapter_id = any(v_seen))) then
      raise exception 'a materialized plan chapter cannot be removed' using errcode = '23514';
    end if;
    update public.story_blueprints set revision = revision + 1, details_json = p_details,
      chapter_plan_json = p_chapters, updated_by = auth.uid(), updated_at = clock_timestamp()
      where id = v_blueprint.id returning * into v_blueprint;
  end if;
  return v_blueprint;
end;
$$;

create function public.materialize_story_blueprint_chapter(
  p_book_id uuid,
  p_blueprint_chapter_id uuid,
  p_expected_revision integer,
  p_request_key text
) returns public.chapters
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_book public.books; v_blueprint public.story_blueprints; v_item jsonb;
  v_existing public.story_blueprint_materializations; v_chapter public.chapters;
begin
  if p_book_id is null or p_blueprint_chapter_id is null or p_expected_revision is null or p_expected_revision < 0
    or coalesce(length(trim(p_request_key)), 0) not between 8 and 160 then
    raise exception 'invalid story blueprint chapter request' using errcode = '22023';
  end if;
  select * into v_book from public.books where id = p_book_id for update;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id = v_book.workspace_id and user_id = auth.uid() and status = 'active'
      and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'role cannot edit' using errcode = '42501';
  end if;
  select * into v_blueprint from public.story_blueprints where book_id = p_book_id for update;
  if not found then raise exception 'story blueprint not found' using errcode = 'P0002'; end if;
  -- Retry the caller's original action first. A later plan edit must not turn
  -- a lost response into a second chapter or a misleading stale-write error.
  select * into v_existing from public.story_blueprint_materializations
    where blueprint_id = v_blueprint.id and materialized_by = auth.uid() and request_key = trim(p_request_key);
  if found then
    if v_existing.blueprint_chapter_id <> p_blueprint_chapter_id then
      raise exception 'request key reused with different plan chapter' using errcode = '40001', detail = v_blueprint.revision::text;
    end if;
    select * into v_chapter from public.chapters where id = v_existing.chapter_id;
    if not found then raise exception 'materialized chapter not found' using errcode = 'P0002'; end if;
    return v_chapter;
  end if;
  select * into v_existing from public.story_blueprint_materializations
    where blueprint_id = v_blueprint.id and blueprint_chapter_id = p_blueprint_chapter_id;
  if found then
    select * into v_chapter from public.chapters where id = v_existing.chapter_id;
    if not found then raise exception 'materialized chapter not found' using errcode = 'P0002'; end if;
    return v_chapter;
  end if;
  if p_expected_revision <> v_blueprint.revision then
    raise exception 'story blueprint changed' using errcode = '40001', detail = v_blueprint.revision::text;
  end if;
  select value into v_item from jsonb_array_elements(v_blueprint.chapter_plan_json)
    where value->>'id' = p_blueprint_chapter_id::text;
  if not found then raise exception 'story blueprint chapter not found' using errcode = 'P0002'; end if;
  select * into v_chapter from public.create_book_chapter_once(
    p_book_id,
    trim(v_item->>'title'),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'type', 'paragraph', 'text', '')),
    'story-blueprint:' || trim(p_request_key)
  );
  insert into public.story_blueprint_materializations(blueprint_id, blueprint_chapter_id, chapter_id, materialized_by, request_key)
    values(v_blueprint.id, p_blueprint_chapter_id, v_chapter.id, auth.uid(), trim(p_request_key));
  return v_chapter;
end;
$$;

revoke all on function public.save_story_blueprint(uuid,integer,jsonb,jsonb) from public, anon, service_role;
revoke all on function public.materialize_story_blueprint_chapter(uuid,uuid,integer,text) from public, anon, service_role;
grant execute on function public.save_story_blueprint(uuid,integer,jsonb,jsonb) to authenticated;
grant execute on function public.materialize_story_blueprint_chapter(uuid,uuid,integer,text) to authenticated;

comment on table public.story_blueprints is
  'Human-authored, versioned story planning. Paid AI generation is intentionally outside this table.';
comment on function public.materialize_story_blueprint_chapter(uuid,uuid,integer,text) is
  'Creates exactly one empty manuscript chapter from an explicit plan item; it never queues or calls AI.';
