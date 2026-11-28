-- Derived, book-scoped retrieval. Canonical manuscript versions and Bible items
-- remain the source of truth; the index changes in the same transaction.
create table public.book_search_chunks (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  chapter_id uuid references public.chapters(id) on delete cascade,
  bible_item_id uuid references public.book_bible_items(id) on delete cascade,
  document_version_id uuid references public.document_versions(id) on delete cascade,
  node_id text,
  chunk_index integer not null,
  title text not null,
  text_content text not null,
  text_hash text not null,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', text_content), 'B')
  ) stored,
  check ((chapter_id is not null and bible_item_id is null and document_version_id is not null)
    or (chapter_id is null and bible_item_id is not null and document_version_id is null))
);
create index book_search_chunks_book on public.book_search_chunks(book_id);
create index book_search_chunks_chapter on public.book_search_chunks(chapter_id);
create index book_search_chunks_bible on public.book_search_chunks(bible_item_id);
create index book_search_chunks_fts on public.book_search_chunks using gin(search_vector);
alter table public.book_search_chunks enable row level security;
revoke all on public.book_search_chunks from public, anon, authenticated;
grant select on public.book_search_chunks to authenticated;
grant all on public.book_search_chunks to service_role;
create policy book_search_read on public.book_search_chunks for select to authenticated
  using (exists(select 1 from public.books b where b.id=book_id and private.is_workspace_member(b.workspace_id)));

create function private.refresh_chapter_search() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.book_search_chunks where chapter_id=new.id;
  insert into public.book_search_chunks(book_id,chapter_id,document_version_id,node_id,chunk_index,title,text_content,text_hash)
  select new.book_id,new.id,d.id,n.value->>'id',s.offset_index,new.title,
    substring(n.value->>'text' from s.offset_index+1 for 1800),
    md5(substring(n.value->>'text' from s.offset_index+1 for 1800))
  from public.document_versions d
  cross join lateral jsonb_array_elements(case when jsonb_typeof(d.content_json->'nodes')='array'
    then d.content_json->'nodes' else '[]'::jsonb end) n
  cross join lateral generate_series(0,greatest(length(n.value->>'text')-1,0),1600) s(offset_index)
  where d.id=new.current_document_version_id and d.chapter_id=new.id
    and coalesce(trim(n.value->>'text'),'')<>'';
  return new;
end;
$$;
revoke all on function private.refresh_chapter_search() from public, anon, authenticated;
create trigger chapter_search_refresh after insert or update of current_document_version_id,title on public.chapters
  for each row execute function private.refresh_chapter_search();

create function private.refresh_bible_search() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_text text;
begin
  delete from public.book_search_chunks where bible_item_id=new.id;
  v_text := concat_ws(E'\n',new.name,new.description,new.attributes_json::text);
  insert into public.book_search_chunks(book_id,bible_item_id,chunk_index,title,text_content,text_hash)
  select new.book_id,new.id,i,new.name,substring(v_text from i+1 for 1800),md5(substring(v_text from i+1 for 1800))
  from generate_series(0,greatest(length(v_text)-1,0),1600) i
  where new.book_id is not null;
  return new;
end;
$$;
revoke all on function private.refresh_bible_search() from public, anon, authenticated;
create trigger bible_search_refresh after insert or update of name,description,attributes_json on public.book_bible_items
  for each row execute function private.refresh_bible_search();

-- Backfill existing canonical content without changing its timestamps/versions.
update public.chapters set current_document_version_id=current_document_version_id;
update public.book_bible_items set name=name;

create function public.search_book_context(p_book_id uuid,p_query text,p_limit integer default 8,
  p_chapter_ids uuid[] default null,p_include_bible boolean default true)
returns table(id uuid,source_type text,chapter_id uuid,bible_item_id uuid,document_version_id uuid,
  node_id text,chunk_index integer,title text,excerpt text,text_hash text,score real)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v_query tsquery;
begin
  if p_book_id is null or p_query is null or length(trim(p_query)) not between 1 and 1000
    or p_limit is null or p_limit not between 1 and 20 or cardinality(p_chapter_ids)>50
    then raise exception 'invalid search request' using errcode='22023'; end if;
  if not exists(select 1 from public.books b where b.id=p_book_id and private.is_workspace_member(b.workspace_id))
    then raise exception 'book not found' using errcode='P0002'; end if;
  v_query := websearch_to_tsquery('simple',p_query);
  return query select c.id,case when c.chapter_id is null then 'bible' else 'manuscript' end,
    c.chapter_id,c.bible_item_id,c.document_version_id,c.node_id,c.chunk_index,c.title,c.text_content,c.text_hash,
    ts_rank_cd(c.search_vector,v_query)
  from public.book_search_chunks c
  where c.book_id=p_book_id and c.search_vector @@ v_query
    and (p_include_bible or c.bible_item_id is null)
    and (p_chapter_ids is null or c.chapter_id=any(p_chapter_ids))
    -- Check freshness at read time too; malformed pointers cannot expose history.
    and (c.chapter_id is null or exists(select 1 from public.chapters ch
      where ch.id=c.chapter_id and ch.book_id=p_book_id and ch.current_document_version_id=c.document_version_id))
  order by ts_rank_cd(c.search_vector,v_query) desc,c.id limit p_limit;
end;
$$;
revoke all on function public.search_book_context(uuid,text,integer,uuid[],boolean) from public,anon;
grant execute on function public.search_book_context(uuid,text,integer,uuid[],boolean) to authenticated;
