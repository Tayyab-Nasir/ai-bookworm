-- Atomic authoring writes. Originals and historical versions are never overwritten.
alter table public.document_versions add column if not exists change_summary text;
alter table public.document_versions add column if not exists operation_id text;
create unique index if not exists document_versions_operation_id_key
  on public.document_versions(chapter_id, operation_id) where operation_id is not null;

create or replace function public.append_chapter_version(
  p_chapter_id uuid, p_expected_version integer, p_content_json jsonb,
  p_plain_text text, p_word_count integer, p_change_summary text, p_operation_id text
) returns public.document_versions
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_chapter public.chapters; v_workspace uuid; v_current integer;
  v_existing public.document_versions; v_result public.document_versions;
begin
  select * into v_chapter from public.chapters where id = p_chapter_id for update;
  if not found then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  select workspace_id into v_workspace from public.books where id = v_chapter.book_id;
  if not exists(select 1 from public.workspace_members where workspace_id = v_workspace
    and user_id = auth.uid() and status = 'active' and role::text in ('owner','admin','editor','writer','illustrator','designer'))
    then raise exception 'role cannot edit' using errcode = '42501'; end if;
  if p_expected_version is null or p_expected_version < 0 or p_word_count is null
    or p_plain_text is null or coalesce(length(p_operation_id),0) not between 1 and 200
    or jsonb_typeof(p_content_json->'nodes') is distinct from 'array'
    or p_content_json->>'schemaVersion' is distinct from '1.0'
    or octet_length(p_content_json::text) > 4000000 or p_word_count < 0
    then raise exception 'invalid document' using errcode = '22023'; end if;
  select * into v_existing from public.document_versions
    where chapter_id = p_chapter_id and operation_id = p_operation_id;
  if found then
    if v_existing.content_json <> p_content_json then
      raise exception 'operation ID reused with different content' using errcode = '40001';
    end if;
    return v_existing;
  end if;
  select coalesce(max(version_number),0) into v_current from public.document_versions where chapter_id = p_chapter_id;
  if p_expected_version <> v_current then
    raise exception 'stale document version' using errcode = '40001', detail = v_current::text;
  end if;
  insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by,change_summary,operation_id)
    values(p_chapter_id,v_current+1,p_content_json,p_plain_text,p_word_count,auth.uid(),left(p_change_summary,500),p_operation_id)
    returning * into v_result;
  update public.chapters set current_document_version_id = v_result.id, updated_at = clock_timestamp() where id = p_chapter_id;
  return v_result;
end;
$$;

create or replace function public.create_book_chapters(p_book_id uuid, p_chapters jsonb, p_source_asset_id uuid default null)
returns setof public.chapters language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_book public.books; v_item jsonb; v_chapter public.chapters;
  v_version uuid; v_next integer; v_text text; v_source public.assets;
begin
  select * into v_book from public.books where id = p_book_id for update;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id = v_book.workspace_id
    and user_id = auth.uid() and status = 'active' and role::text in ('owner','admin','editor','writer','illustrator','designer'))
    then raise exception 'role cannot edit' using errcode = '42501'; end if;
  if jsonb_typeof(p_chapters) is distinct from 'array' or jsonb_array_length(p_chapters) not between 1 and 500
    or octet_length(p_chapters::text) > 16000000 then raise exception 'invalid chapters' using errcode = '22023'; end if;
  if p_source_asset_id is not null then
    select * into v_source from public.assets where id = p_source_asset_id and workspace_id = v_book.workspace_id and deleted_at is null;
    if not found or v_source.checksum = 'pending' then raise exception 'source is not confirmed' using errcode = '22023'; end if;
    if exists(select 1 from public.asset_links where asset_id = p_source_asset_id and entity_type = 'book'
      and entity_id = p_book_id and usage_role = 'manuscript_source') then
      raise exception 'source already imported into this book' using errcode = '23505';
    end if;
  end if;
  select coalesce(max(order_index)+1,0) into v_next from public.chapters where book_id = p_book_id;
  for v_item in select value from jsonb_array_elements(p_chapters) loop
    if jsonb_typeof(v_item->'nodes') is distinct from 'array' or coalesce(length(trim(v_item->>'title')),0) = 0
      then raise exception 'invalid chapter' using errcode = '22023'; end if;
    insert into public.chapters(book_id,order_index,title) values(p_book_id,v_next,left(v_item->>'title',500)) returning * into v_chapter;
    select coalesce(string_agg(value->>'text', E'\n\n' order by ordinality),'') into v_text
      from jsonb_array_elements(v_item->'nodes') with ordinality;
    insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by,change_summary)
      values(v_chapter.id,1,jsonb_build_object('schemaVersion','1.0','nodes',v_item->'nodes'),v_text,
      case when trim(v_text)='' then 0 else cardinality(regexp_split_to_array(trim(v_text), '\s+')) end,
      auth.uid(),case when p_source_asset_id is null then 'Chapter created' else 'Manuscript imported' end) returning id into v_version;
    update public.chapters set current_document_version_id = v_version where id = v_chapter.id returning * into v_chapter;
    return next v_chapter;
    v_next := v_next + 1;
  end loop;
  if p_source_asset_id is not null then
    insert into public.asset_links(asset_id,entity_type,entity_id,usage_role)
      values(p_source_asset_id,'book',p_book_id,'manuscript_source');
  end if;
end;
$$;

create or replace function public.reorder_book_chapters(p_book_id uuid, p_ordered_ids uuid[], p_expected_ids uuid[])
returns setof public.chapters language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_book public.books; v_ids uuid[]; v_offset integer;
begin
  select * into v_book from public.books where id=p_book_id for update;
  if not found then raise exception 'book not found' using errcode='P0002'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=v_book.workspace_id and user_id=auth.uid()
    and status='active' and role::text in ('owner','admin','editor','writer','illustrator','designer'))
    then raise exception 'role cannot edit' using errcode='42501'; end if;
  select coalesce(array_agg(id order by order_index),'{}'::uuid[]), coalesce(max(order_index),0)+cardinality(p_ordered_ids)+1
    into v_ids,v_offset from public.chapters where book_id=p_book_id;
  if v_ids is distinct from p_expected_ids then raise exception 'chapter order changed' using errcode='40001'; end if;
  if p_ordered_ids is null or array_position(p_ordered_ids,null) is not null
    or cardinality(p_ordered_ids) <> cardinality(v_ids) or not p_ordered_ids @> v_ids or not p_ordered_ids <@ v_ids
    then raise exception 'must include every chapter exactly once' using errcode='22023'; end if;
  -- Positive temporary indices avoid collisions with the immediate unique constraint.
  update public.chapters set order_index=order_index+v_offset where book_id=p_book_id;
  update public.chapters c set order_index=s.ordinality-1,updated_at=clock_timestamp()
    from unnest(p_ordered_ids) with ordinality s(id,ordinality) where c.id=s.id and c.book_id=p_book_id;
  return query select * from public.chapters where book_id=p_book_id order by order_index;
end;
$$;

revoke all on function public.append_chapter_version(uuid,integer,jsonb,text,integer,text,text) from public, anon;
revoke all on function public.create_book_chapters(uuid,jsonb,uuid) from public, anon;
revoke all on function public.reorder_book_chapters(uuid,uuid[],uuid[]) from public, anon;
grant execute on function public.append_chapter_version(uuid,integer,jsonb,text,integer,text,text) to authenticated;
grant execute on function public.create_book_chapters(uuid,jsonb,uuid) to authenticated;
grant execute on function public.reorder_book_chapters(uuid,uuid[],uuid[]) to authenticated;
