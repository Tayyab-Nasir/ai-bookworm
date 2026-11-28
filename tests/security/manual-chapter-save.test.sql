-- Existing locked append RPC fences an uncertain manual save without DDL.
begin;
insert into auth.users(id,email) values ('a4800000-0000-4000-8000-000000000001','manual-save@local.test');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a4800000-0000-4000-8000-000000000001"}';
do $$
declare
  ws public.workspaces; book uuid; chapter uuid; original public.document_versions;
  closure public.document_versions; replay public.document_versions;
  body jsonb; closure_key text := 'manual-save-close:a4800000-0000-4000-8000-000000000001:a4800000-0000-4000-8000-000000000010';
begin
  select * into strict ws from public.create_workspace_with_owner('Manual save recovery');
  insert into public.books(workspace_id,title,author_name,created_by) values(ws.id,'Recovery','Writer',auth.uid()) returning id into book;
  perform public.create_book_chapters(book,'[{"title":"Chapter","nodes":[{"id":"n","type":"paragraph","text":"Original text"}]}]');
  select id into strict chapter from public.chapters where book_id=book;
  select * into strict original from public.document_versions where chapter_id=chapter;
  body := original.content_json;
  select * into strict closure from public.append_chapter_version(chapter,1,body,original.plain_text,original.word_count,'Closed unconfirmed save',closure_key);
  assert closure.version_number=2 and closure.content_json=original.content_json, 'closure changed manuscript text';
  assert closure.created_by=auth.uid(), 'closure lost actor binding';
  select * into strict replay from public.append_chapter_version(chapter,1,body,original.plain_text,original.word_count,'Closed unconfirmed save',closure_key);
  assert replay.id=closure.id, 'closure replay created another revision';
  begin
    perform public.append_chapter_version(chapter,1,jsonb_set(body,'{nodes,0,text}','"Delayed unsaved draft"'),'Delayed unsaved draft',3,'Delayed save','a4800000-0000-4000-8000-000000000010');
    assert false, 'late original save overwrote closure fence';
  exception when serialization_failure then null; end;
  assert (select count(*) from public.document_versions where chapter_id=chapter)=2, 'late save persisted or deleted history';
  assert (select current_document_version_id from public.chapters where id=chapter)=closure.id, 'closure pointer changed';
  -- In the opposite ordering, the original wins and the closure CAS fails.
  perform public.create_book_chapters(book,'[{"title":"Other chapter","nodes":[{"id":"n","type":"paragraph","text":"Original text"}]}]');
  select id into strict chapter from public.chapters where book_id=book and title='Other chapter';
  select * into strict original from public.append_chapter_version(chapter,1,body,'Original text',2,'Original saved','a4800000-0000-4000-8000-000000000011');
  begin
    perform public.append_chapter_version(chapter,1,body,'Original text',2,'Close late','manual-save-close:a4800000-0000-4000-8000-000000000001:a4800000-0000-4000-8000-000000000011');
    assert false, 'closure replaced committed original';
  exception when serialization_failure then null; end;
  assert (select count(*) from public.document_versions where chapter_id=chapter)=2, 'closure wrote after original';
  assert (select current_document_version_id from public.chapters where id=chapter)=original.id, 'closure changed committed original pointer';
end $$;
rollback;
