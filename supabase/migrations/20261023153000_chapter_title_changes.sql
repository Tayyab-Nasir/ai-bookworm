-- Titles have their own CAS revision; renaming never replaces manuscript nodes.
alter table public.chapters add column title_revision integer not null default 0
  check (title_revision between 0 and 2147483646);

create function public.track_chapter_title_revision() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then new.title_revision := 0;
  elsif new.title is distinct from old.title then
    if old.title_revision >= 2147483646 then raise exception 'title revision exhausted' using errcode='22023'; end if;
    new.title_revision := old.title_revision + 1;
    new.updated_at := clock_timestamp();
  else new.title_revision := old.title_revision;
  end if;
  return new;
end $$;
revoke all on function public.track_chapter_title_revision() from public, anon, authenticated;
create trigger chapter_title_revision before insert or update on public.chapters
  for each row execute function public.track_chapter_title_revision();

create table public.chapter_title_changes (
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  expected_revision integer not null check (expected_revision between 0 and 2147483646),
  title_digest text not null check (title_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('saved','closed','conflict')),
  saved_title text,
  saved_revision integer,
  created_at timestamptz not null default clock_timestamp(),
  primary key (chapter_id,actor_id,operation_id),
  check ((status='saved' and saved_title is not null and saved_revision is not null
    and saved_revision between expected_revision and expected_revision+1)
    or (status in ('closed','conflict') and saved_title is null and saved_revision is null))
);
alter table public.chapter_title_changes enable row level security;
revoke all on public.chapter_title_changes from public, anon, authenticated;

create function public.get_chapter_title_change(p_chapter_id uuid, p_operation_id uuid,
  p_expected_revision integer, p_title_digest text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.chapters; r public.chapter_title_changes; w uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_operation_id is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646
    or p_title_digest is null or p_title_digest !~ '^[a-f0-9]{64}$' then raise exception 'invalid title request' using errcode='22023'; end if;
  select * into c from public.chapters where id=p_chapter_id;
  select workspace_id into w from public.books where id=c.book_id;
  if c.id is null or not exists(select 1 from public.workspace_members where workspace_id=w
    and user_id=auth.uid() and status='active') then raise exception 'chapter not found' using errcode='P0002'; end if;
  select * into r from public.chapter_title_changes where chapter_id=c.id and actor_id=auth.uid() and operation_id=p_operation_id;
  if r.operation_id is not null and (r.expected_revision<>p_expected_revision or r.title_digest<>p_title_digest) then
    raise exception 'title request identity reused' using errcode='40001'; end if;
  return jsonb_build_object('chapterId',c.id,'bookId',c.book_id,'operationId',p_operation_id,
    'expectedRevision',p_expected_revision,'titleDigest',p_title_digest,'status',coalesce(r.status,'not_found'),
    'receipt',case when r.status='saved' then jsonb_build_object('title',r.saved_title,'revision',r.saved_revision) else null end,
    'current',jsonb_build_object('title',c.title,'revision',c.title_revision,'updatedAt',c.updated_at));
end $$;

create function public.change_chapter_title(p_chapter_id uuid, p_operation_id uuid,
  p_expected_revision integer, p_title text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.chapters; w uuid; d text; existing jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_title is null or length(p_title) not between 1 and 500 or p_title<>btrim(p_title)
    or p_title ~ '[[:cntrl:]]' then raise exception 'invalid chapter title' using errcode='22023'; end if;
  select * into c from public.chapters where id=p_chapter_id for update;
  select workspace_id into w from public.books where id=c.book_id;
  if c.id is null then raise exception 'chapter not found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid() and status='active'
    and role::text in ('owner','admin','editor','writer','illustrator','designer')) then raise exception 'role cannot edit' using errcode='42501'; end if;
  d := encode(sha256(convert_to(p_title,'UTF8')),'hex');
  existing := public.get_chapter_title_change(c.id,p_operation_id,p_expected_revision,d);
  if existing->>'status'<>'not_found' then return existing; end if;
  if c.title_revision<>p_expected_revision then
    insert into public.chapter_title_changes(chapter_id,actor_id,operation_id,expected_revision,title_digest,status)
      values(c.id,auth.uid(),p_operation_id,p_expected_revision,d,'conflict');
  else
    update public.chapters set title=p_title where id=c.id returning * into c;
    insert into public.chapter_title_changes(chapter_id,actor_id,operation_id,expected_revision,title_digest,status,saved_title,saved_revision)
      values(c.id,auth.uid(),p_operation_id,p_expected_revision,d,'saved',c.title,c.title_revision);
    insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id,payload_json)
      values(w,auth.uid(),'chapter.title_changed','chapter',c.id,jsonb_build_object('revision',c.title_revision,'operationId',p_operation_id));
  end if;
  return public.get_chapter_title_change(c.id,p_operation_id,p_expected_revision,d);
end $$;

create function public.close_chapter_title_change(p_chapter_id uuid, p_operation_id uuid,
  p_expected_revision integer, p_title_digest text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.chapters; w uuid; existing jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into c from public.chapters where id=p_chapter_id for update;
  select workspace_id into w from public.books where id=c.book_id;
  if c.id is null then raise exception 'chapter not found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid() and status='active'
    and role::text in ('owner','admin','editor','writer','illustrator','designer')) then raise exception 'role cannot edit' using errcode='42501'; end if;
  existing := public.get_chapter_title_change(c.id,p_operation_id,p_expected_revision,p_title_digest);
  if existing->>'status'<>'not_found' then return existing; end if;
  -- Tombstone the exact operation while holding the same lock as save. No title is overwritten.
  insert into public.chapter_title_changes(chapter_id,actor_id,operation_id,expected_revision,title_digest,status)
    values(c.id,auth.uid(),p_operation_id,p_expected_revision,p_title_digest,'closed');
  return public.get_chapter_title_change(c.id,p_operation_id,p_expected_revision,p_title_digest);
end $$;

revoke all on function public.get_chapter_title_change(uuid,uuid,integer,text) from public, anon;
revoke all on function public.change_chapter_title(uuid,uuid,integer,text) from public, anon;
revoke all on function public.close_chapter_title_change(uuid,uuid,integer,text) from public, anon;
grant execute on function public.get_chapter_title_change(uuid,uuid,integer,text) to authenticated;
grant execute on function public.change_chapter_title(uuid,uuid,integer,text) to authenticated;
grant execute on function public.close_chapter_title_change(uuid,uuid,integer,text) to authenticated;
