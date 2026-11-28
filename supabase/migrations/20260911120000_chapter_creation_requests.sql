-- Receipts make single-chapter creation safe to replay after response loss.
create table public.chapter_creation_requests (
  book_id uuid not null references public.books(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null check (length(request_key) between 8 and 200),
  request_hash text not null,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  primary key (book_id, actor_id, request_key)
);
alter table public.chapter_creation_requests enable row level security;
revoke all on public.chapter_creation_requests from public, anon, authenticated;

create function public.create_book_chapter_once(p_book_id uuid, p_title text, p_nodes jsonb, p_request_key text)
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
    if v_receipt.request_hash <> v_hash then
      raise exception 'request key reused with different chapter' using errcode='40001';
    end if;
    return query select * from public.chapters where id=v_receipt.chapter_id;
    return;
  end if;
  v_nodes := coalesce(p_nodes,jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'type','paragraph','text','')));
  select * into strict v_chapter from public.create_book_chapters(p_book_id,
    jsonb_build_array(jsonb_build_object('title',trim(p_title),'nodes',v_nodes)),null);
  insert into public.chapter_creation_requests values(p_book_id,auth.uid(),p_request_key,v_hash,v_chapter.id);
  return next v_chapter;
end;
$$;
revoke all on function public.create_book_chapter_once(uuid,text,jsonb,text) from public, anon;
grant execute on function public.create_book_chapter_once(uuid,text,jsonb,text) to authenticated;
