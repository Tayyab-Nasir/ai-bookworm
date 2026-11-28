-- Keep rich manuscript content searchable without introducing a second tenant
-- store. Canonical document versions remain authoritative for every citation.
create function private.searchable_book_node_text(p_node jsonb)
returns text language sql stable set search_path = pg_catalog as $$
  select concat_ws(E'\n',
    nullif(p_node->>'text', ''),
    nullif(p_node->>'caption', ''),
    nullif(p_node->>'altText', ''),
    (select string_agg(cell.value, E'\n' order by row_item.position, cell.position)
     from jsonb_array_elements(case when jsonb_typeof(p_node->'rows') = 'array'
       then p_node->'rows' else '[]'::jsonb end) with ordinality as row_item(value, position)
     cross join lateral jsonb_array_elements_text(case when jsonb_typeof(row_item.value) = 'array'
       then row_item.value else '[]'::jsonb end) with ordinality as cell(value, position))
  );
$$;
revoke all on function private.searchable_book_node_text(jsonb) from public, anon, authenticated;

create or replace function private.refresh_chapter_search() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.book_search_chunks where chapter_id = new.id;
  insert into public.book_search_chunks(book_id,chapter_id,document_version_id,node_id,chunk_index,title,text_content,text_hash)
  select new.book_id,new.id,d.id,n.value->>'id',s.offset_index,new.title,
    substring(t.content from s.offset_index+1 for 1800),
    md5(substring(t.content from s.offset_index+1 for 1800))
  from public.document_versions d
  cross join lateral jsonb_array_elements(case when jsonb_typeof(d.content_json->'nodes')='array'
    then d.content_json->'nodes' else '[]'::jsonb end) n
  cross join lateral (select private.searchable_book_node_text(n.value) as content) t
  cross join lateral generate_series(0,greatest(length(t.content)-1,0),1600) s(offset_index)
  where d.id=new.current_document_version_id and d.chapter_id=new.id
    and coalesce(trim(t.content),'')<>'';
  return new;
end;
$$;

-- Re-index only current documents containing rich fields. Plain-text chapters
-- retain their existing exact-version chunks and avoid unnecessary rewrites.
update public.chapters c set current_document_version_id = c.current_document_version_id
where c.current_document_version_id is not null and exists (
  select 1 from public.document_versions d
  cross join lateral jsonb_array_elements(case when jsonb_typeof(d.content_json->'nodes')='array'
    then d.content_json->'nodes' else '[]'::jsonb end) n
  where d.id = c.current_document_version_id and d.chapter_id = c.id
    and (n.value ? 'caption' or n.value ? 'altText' or n.value ? 'rows')
);
