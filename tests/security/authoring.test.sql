-- Execute authoring RPCs as real authenticated roles; no mocked Supabase calls.
begin;
create temp table authoring_ids(book_id uuid, chapter_a uuid, chapter_b uuid) on commit drop;
grant select,insert on authoring_ids to authenticated;
insert into auth.users(id,email) values
  ('a4000000-0000-0000-0000-000000000001','author-a@local.test'),
  ('b4000000-0000-0000-0000-000000000001','author-b@local.test'),
  ('c4000000-0000-0000-0000-000000000001','author-viewer@local.test');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4000000-0000-0000-0000-000000000001"}';
do $$
declare
  ws public.workspaces; book uuid; ids uuid[]; result public.document_versions;
  retry public.document_versions; n int; before_ids uuid[];
  body jsonb := '{"schemaVersion":"1.0","nodes":[{"id":"p1","type":"paragraph","text":"Revised first chapter"}]}';
begin
  select * into strict ws from public.create_workspace_with_owner('Authoring');
  insert into public.books(workspace_id,title,author_name,created_by)
    values(ws.id,'Novel','A',auth.uid()) returning id into book;
  perform public.create_book_chapters(book,
    '[{"title":"First","nodes":[{"id":"a1","type":"paragraph","text":"Original first chapter"}]},{"title":"Second","nodes":[{"id":"b1","type":"paragraph","text":"Original second chapter"}]}]');
  select array_agg(id order by order_index) into ids from public.chapters where book_id=book;
  assert cardinality(ids)=2, 'chapter creation did not persist all chapters';
  assert (select count(*) from public.document_versions where chapter_id=any(ids) and version_number=1)=2, 'initial versions missing';
  assert (select plain_text from public.document_versions where chapter_id=ids[1])='Original first chapter', 'initial plain text wrong';
  assert (select word_count from public.document_versions where chapter_id=ids[1])=3, 'initial word count wrong';
  assert not exists(select 1 from public.chapters where book_id=book and current_document_version_id is null), 'initial pointers missing';
  insert into authoring_ids values(book,ids[1],ids[2]);

  select * into result from public.append_chapter_version(ids[1],1,body,'Revised first chapter',3,'Edited','edit-1');
  assert result.version_number=2 and result.created_by=auth.uid(), 'append result incorrect';
  assert (select current_document_version_id from public.chapters where id=ids[1])=result.id, 'append pointer incorrect';
  assert (select plain_text from public.document_versions where chapter_id=ids[1] and version_number=1)='Original first chapter', 'append overwrote original';
  select * into retry from public.append_chapter_version(ids[1],1,body,'Revised first chapter',3,'Edited','edit-1');
  assert retry.id=result.id, 'idempotent retry created another version';
  assert (select count(*) from public.document_versions where chapter_id=ids[1])=2, 'retry duplicates version';
  begin
    perform public.append_chapter_version(ids[1],1,body,'Revised first chapter',3,'Stale','edit-2');
    assert false, 'stale save overwrote newer edit';
  exception when serialization_failure then null; end;
  begin
    perform public.append_chapter_version(ids[1],2,jsonb_set(body,'{nodes,0,text}','"Different"'),'Different',1,'Retry mismatch','edit-1');
    assert false, 'operation id reused with different content';
  exception when serialization_failure then null; end;
  begin
    perform public.append_chapter_version(ids[1],null,body,'Revised first chapter',3,'Missing lock version','null-expected');
    assert false, 'NULL expected version bypasses stale guard';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_chapter_version(ids[1],2,'{"schemaVersion":"1.0","nodes":{}}','',0,'Invalid','bad-nodes');
    assert false, 'malformed nodes accepted';
  exception when invalid_parameter_value then null; end;
  begin
    update public.document_versions set plain_text='Changed history' where id=result.id;
    assert false, 'client can rewrite immutable manuscript history';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.document_versions where id=result.id;
    assert false, 'client can delete manuscript history';
  exception when insufficient_privilege then null; end;

  -- A bad second chapter rolls back the valid first chapter too.
  select count(*) into n from public.chapters where book_id=book;
  begin
    perform public.create_book_chapters(book,'[{"title":"Valid","nodes":[]},{"title":" ","nodes":[]}]');
    assert false, 'invalid batch did not fail';
  exception when invalid_parameter_value then null; end;
  assert n=(select count(*) from public.chapters where book_id=book), 'failed chapter batch saved partial rows';

  before_ids := ids;
  perform public.reorder_book_chapters(book, array[ids[2],ids[1]], ids);
  select array_agg(id order by order_index) into ids from public.chapters where book_id=book;
  assert ids=array[before_ids[2],before_ids[1]], 'valid reorder did not swap';
  assert (select array_agg(order_index order by order_index) from public.chapters where book_id=book)=array[0,1], 'reorder left temporary indexes';
  begin
    perform public.reorder_book_chapters(book, before_ids, before_ids);
    assert false, 'stale reorder overwrote newer chapter order';
  exception when serialization_failure then null; end;
  begin
    perform public.reorder_book_chapters(book, array[ids[1],ids[1]], ids);
    assert false, 'duplicate reorder accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.reorder_book_chapters(book, null, ids);
    assert false, 'NULL reorder accepted';
  exception when invalid_parameter_value then null; end;
  assert ids=(select array_agg(id order by order_index) from public.chapters where book_id=book), 'rejected reorder changed order';
  begin
    set constraints chapters_current_document_version_same_chapter_fk immediate;
    update public.chapters set current_document_version_id=result.id where id=before_ids[2];
    assert false, 'chapter points at another chapter version';
  exception when foreign_key_violation then null; end;
end $$;
reset role;
insert into public.workspace_members(workspace_id,user_id,role)
  select workspace_id,'c4000000-0000-0000-0000-000000000001','viewer' from public.books where id=(select book_id from authoring_ids);
set local role authenticated;
set local request.jwt.claims = '{"sub":"c4000000-0000-0000-0000-000000000001"}';
do $$
declare v authoring_ids;
begin
  select * into strict v from authoring_ids;
  begin
    perform public.create_book_chapters(v.book_id,'[{"title":"Forbidden","nodes":[]}]');
    assert false, 'viewer can create chapters';
  exception when insufficient_privilege or no_data_found then null; end;
  begin
    perform public.append_chapter_version(v.chapter_a,2,'{"schemaVersion":"1.0","nodes":[]}','',0,'Forbidden','viewer-edit');
    assert false, 'viewer can save manuscript';
  exception when insufficient_privilege or no_data_found then null; end;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b4000000-0000-0000-0000-000000000001"}';
do $$
declare v authoring_ids;
begin
  select * into strict v from authoring_ids;
  begin
    perform public.append_chapter_version(v.chapter_a,2,'{"schemaVersion":"1.0","nodes":[]}','',0,'Forbidden','other-tenant');
    assert false, 'unrelated user can save manuscript';
  exception when insufficient_privilege or no_data_found then null; end;
end $$;
reset role;
rollback;
