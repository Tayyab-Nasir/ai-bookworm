-- Direct PostgREST writes must not bypass the API's verified Bible citations.
-- Historical rows are not rewritten; the trigger checks new/changed references.
create or replace function private.validate_book_bible_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ref jsonb;
  v_chapter uuid;
  v_version uuid;
  v_content jsonb;
  v_node jsonb;
  v_hash text;
begin
  if pg_catalog.jsonb_typeof(new.source_refs_json) <> 'array'
     or pg_catalog.jsonb_array_length(new.source_refs_json) > 30 then
    raise exception 'Invalid Book Bible source references' using errcode = '22023';
  end if;
  for v_ref in select value from pg_catalog.jsonb_array_elements(new.source_refs_json) as refs(value) loop
    if pg_catalog.jsonb_typeof(v_ref) <> 'object'
       or pg_catalog.jsonb_typeof(v_ref->'chapterId') <> 'string' then
      raise exception 'A Book Bible source needs a chapter' using errcode = '22023';
    end if;
    v_chapter := (v_ref->>'chapterId')::uuid;
    if not exists (select 1 from public.chapters c where c.id = v_chapter and c.book_id = new.book_id) then
      raise exception 'Book Bible source chapter is outside this book' using errcode = '22023';
    end if;
    if v_ref ? 'textHash' and not v_ref ? 'nodeId' then
      raise exception 'A Book Bible text hash needs a node' using errcode = '22023';
    end if;
    if v_ref ? 'nodeId' and not v_ref ? 'documentVersionId' then
      raise exception 'A Book Bible node needs a pinned saved version' using errcode = '22023';
    end if;
    if v_ref ? 'documentVersionId' then
      v_version := (v_ref->>'documentVersionId')::uuid;
      select d.content_json into v_content from public.document_versions d
        where d.id = v_version and d.chapter_id = v_chapter;
      if not found then
        raise exception 'Book Bible source version is outside its chapter' using errcode = '22023';
      end if;
    end if;
    if v_ref ? 'nodeId' then
      if pg_catalog.jsonb_typeof(v_content->'nodes') <> 'array' then
        raise exception 'Book Bible source version has no canonical nodes' using errcode = '22023';
      end if;
      select node.value into v_node from pg_catalog.jsonb_array_elements(v_content->'nodes') as node(value)
        where node.value->>'id' = v_ref->>'nodeId' limit 1;
      if not found then
        raise exception 'Book Bible source node is not in the saved version' using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(v_node->'text') = 'string' then
        v_hash := pg_catalog.encode(public.digest(v_node->>'text', 'sha256'), 'hex');
        if v_ref->>'textHash' is distinct from v_hash then
          raise exception 'Book Bible source text hash does not match saved text' using errcode = '22023';
        end if;
      elsif v_ref ? 'textHash' then
        raise exception 'A nontext Book Bible node cannot carry a text hash' using errcode = '22023';
      end if;
    end if;
    v_content := null;
    v_node := null;
  end loop;
  return new;
end;
$$;

revoke all on function private.validate_book_bible_evidence() from public, anon, authenticated;
create trigger bible_evidence_before_write
  before insert or update of source_refs_json, book_id on public.book_bible_items
  for each row execute function private.validate_book_bible_evidence();
