-- Fail safely if a prior deployment changed the function or its effective grants.
do $guard$
declare routine regprocedure; body_hash text; definer boolean; settings text[];
begin
  routine := to_regprocedure('public.create_book_chapter_once(uuid,text,jsonb,text)');
  if routine is null then raise exception 'chapter creation function is missing'; end if;
  select encode(sha256(convert_to(replace(prosrc, E'\r\n', E'\n'),'UTF8')),'hex'), prosecdef, proconfig
    into body_hash, definer, settings from pg_proc where oid=routine;
  if body_hash <> '50765b4b3db01736df0088796fc01413fb450f08257f1266633d253ce80a15e7'
    or not definer or settings is distinct from array['search_path=public, pg_temp']::text[]
    or has_function_privilege('anon',routine,'EXECUTE')
    or not has_function_privilege('authenticated',routine,'EXECUTE') then
    raise exception 'chapter creation function differs from the reviewed contract';
  end if;
end
$guard$;
-- Retain the outcome after a chapter is deleted, and fence requests closed before arrival.
alter table public.chapter_creation_requests
  drop constraint chapter_creation_requests_chapter_id_fkey;
alter table public.chapter_creation_requests alter column chapter_id drop not null;
alter table public.chapter_creation_requests
  add constraint chapter_creation_requests_chapter_id_fkey
  foreign key (chapter_id) references public.chapters(id) on delete set null;
alter table public.chapter_creation_requests add column closed boolean not null default false;

create or replace function public.create_book_chapter_once(p_book_id uuid, p_title text, p_nodes jsonb, p_request_key text)
returns setof public.chapters language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_book public.books; v_receipt public.chapter_creation_requests;
  v_chapter public.chapters; v_hash text; v_nodes jsonb;
begin
  select * into v_book from public.books where id=p_book_id for update;
  if not found then raise exception 'book not found' using errcode='P0002'; end if;
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=v_book.workspace_id and user_id=auth.uid() and status='active'
    and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'role cannot edit' using errcode='42501';
  end if;
  if coalesce(length(p_request_key),0) not between 8 and 200
    or coalesce(length(trim(p_title)),0) not between 1 and 500
    or (p_nodes is not null and (jsonb_typeof(p_nodes) <> 'array' or octet_length(p_nodes::text)>4000000)) then
    raise exception 'invalid chapter request' using errcode='22023';
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_object('title',trim(p_title),'nodes',p_nodes)::text,'UTF8')),'hex');
  select * into v_receipt from public.chapter_creation_requests
    where book_id=p_book_id and actor_id=auth.uid() and request_key=p_request_key;
  if found then
    if v_receipt.closed then raise exception 'chapter creation request closed' using errcode='PT409'; end if;
    if v_receipt.request_hash <> v_hash then
      raise exception 'request key reused with different chapter' using errcode='40001';
    end if;
    if v_receipt.chapter_id is null then
      raise exception 'created chapter was removed' using errcode='PT409';
    end if;
    return query select * from public.chapters where id=v_receipt.chapter_id;
    return;
  end if;
  v_nodes := coalesce(p_nodes,jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'type','paragraph','text','')));
  select * into strict v_chapter from public.create_book_chapters(p_book_id,
    jsonb_build_array(jsonb_build_object('title',trim(p_title),'nodes',v_nodes)),null);
  insert into public.chapter_creation_requests(book_id,actor_id,request_key,request_hash,chapter_id)
    values(p_book_id,auth.uid(),p_request_key,v_hash,v_chapter.id);
  return next v_chapter;
end;
$$;

create function public.chapter_creation_status(p_book_id uuid, p_request_key text, p_close boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_book public.books; v_receipt public.chapter_creation_requests;
begin
  -- The same book lock serializes closing, creation and existing receipt checks.
  select * into v_book from public.books where id=p_book_id for update;
  if not found then raise exception 'book not found' using errcode='P0002'; end if;
  if auth.uid() is null or not exists(select 1 from public.workspace_members
    where workspace_id=v_book.workspace_id and user_id=auth.uid() and status='active'
    and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'role cannot edit' using errcode='42501';
  end if;
  if coalesce(length(p_request_key),0) not between 8 and 200 or p_close is null then
    raise exception 'invalid chapter request' using errcode='22023';
  end if;
  select * into v_receipt from public.chapter_creation_requests
    where book_id=p_book_id and actor_id=auth.uid() and request_key=p_request_key;
  if not found and p_close then
    insert into public.chapter_creation_requests(book_id,actor_id,request_key,request_hash,chapter_id,closed)
      values(p_book_id,auth.uid(),p_request_key,'',null,true)
      returning * into v_receipt;
  elsif not found then
    return jsonb_build_object('bookId',p_book_id,'requestKey',p_request_key,'status','not_found','chapterId',null);
  end if;
  return jsonb_build_object('bookId',p_book_id,'requestKey',p_request_key,
    'status',case when v_receipt.closed then 'closed' when v_receipt.chapter_id is null then 'removed' else 'created' end,
    'chapterId',v_receipt.chapter_id);
end;
$$;
revoke all on function public.chapter_creation_status(uuid,text,boolean) from public, anon;
grant execute on function public.chapter_creation_status(uuid,text,boolean) to authenticated;
