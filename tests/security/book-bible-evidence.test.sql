-- Exercise the table boundary, not only the HTTP route: authenticated writers
-- can reach book_bible_items through PostgREST under its RLS policy.
begin;
insert into auth.users(id,email) values
  ('bb180000-0000-4000-8000-000000000001','bible-evidence@local.test');
set local role authenticated;
set local request.jwt.claims='{"sub":"bb180000-0000-4000-8000-000000000001"}';
do $$
declare
  w public.workspaces;
  b uuid;
  c uuid;
  v uuid;
  item uuid;
  h text;
  valid_ref jsonb;
begin
  select * into w from public.create_workspace_with_owner('Bible evidence');
  insert into public.books(workspace_id,title,author_name,created_by)
    values(w.id,'Evidence','Author',auth.uid()) returning id into b;
  select id into c from public.create_book_chapters(b,
    '[{"title":"Arrival","nodes":[{"id":"n1","type":"paragraph","text":"Elara carries a silver compass."}]}]');
  select current_document_version_id into v from public.chapters where id=c;
  h := encode(digest('Elara carries a silver compass.', 'sha256'), 'hex');
  valid_ref := jsonb_build_object('chapterId',c,'documentVersionId',v,'nodeId','n1','textHash',h);
  insert into public.book_bible_items(book_id,type,name,source_refs_json)
    values(b,'character','Elara',jsonb_build_array(valid_ref)) returning id into item;
  assert (select source_refs_json from public.book_bible_items where id=item)=jsonb_build_array(valid_ref),
    'valid pinned evidence was not stored';

  begin
    insert into public.book_bible_items(book_id,type,name,source_refs_json)
      values(b,'character','Invented',jsonb_build_array(valid_ref || '{"nodeId":"invented"}'::jsonb));
    assert false,'direct write accepted an invented node';
  exception when invalid_parameter_value then null; end;
  begin
    insert into public.book_bible_items(book_id,type,name,source_refs_json)
      values(b,'character','Stale',jsonb_build_array(valid_ref || jsonb_build_object('textHash',repeat('0',64))));
    assert false,'direct write accepted a stale text hash';
  exception when invalid_parameter_value then null; end;
  begin
    insert into public.book_bible_items(book_id,type,name,source_refs_json)
      values(b,'character','Unpinned',jsonb_build_array(valid_ref - 'documentVersionId'));
    assert false,'direct write accepted an unpinned node';
  exception when invalid_parameter_value then null; end;
  begin
    update public.book_bible_items set source_refs_json=jsonb_build_array(valid_ref || jsonb_build_object('textHash',repeat('0',64)))
      where id=item;
    assert false,'direct update accepted a stale text hash';
  exception when invalid_parameter_value then null; end;
  assert (select count(*) from public.book_bible_items where book_id=b)=1,
    'rejected direct writes changed Book Bible state';
  insert into public.book_bible_items(book_id,type,name,source_refs_json)
    values(b,'fact','Chapter note',jsonb_build_array(jsonb_build_object('chapterId',c)));
end;
$$;
rollback;
