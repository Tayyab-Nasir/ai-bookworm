begin;
insert into auth.users(id,email) values ('a5000000-0000-0000-0000-000000000001','chapter-replay@local.test');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000001"}';
do $$
declare ws public.workspaces; b uuid; first public.chapters; replay public.chapters; n integer;
begin
  select * into strict ws from public.create_workspace_with_owner('Chapter replay');
  insert into public.books(workspace_id,title,author_name,created_by)
    values(ws.id,'Replay book','Author',auth.uid()) returning id into b;
  select * into strict first from public.create_book_chapter_once(b,'First',null,'request-one');
  select * into strict replay from public.create_book_chapter_once(b,'First',null,'request-one');
  assert first.id=replay.id, 'replay duplicated chapter';
  assert (select count(*) from public.chapters where book_id=b)=1, 'duplicate chapter row';
  assert (select count(*) from public.document_versions where chapter_id=first.id)=1, 'duplicate version';
  assert (select content_json->'nodes'->0->>'type' from public.document_versions where chapter_id=first.id)='paragraph', 'default node missing';
  begin
    perform public.create_book_chapter_once(b,'Changed',null,'request-one');
    assert false, 'changed title accepted for same key';
  exception when serialization_failure then null; end;
  begin
    perform public.create_book_chapter_once(b,'First','[]','request-one');
    assert false, 'changed nodes accepted for same key';
  exception when serialization_failure then null; end;
  begin
    perform public.create_book_chapter_once(b,'First',null,'short');
    assert false, 'short key accepted';
  exception when invalid_parameter_value then null; end;
  begin
    select count(*) into n from public.chapter_creation_requests;
    assert false, 'receipt table exposed';
  exception when insufficient_privilege then null; end;
  -- Another actor cannot replay the author's authorized request.
  perform set_config('request.jwt.claims','{"sub":"b5000000-0000-0000-0000-000000000001"}',true);
  begin
    perform public.create_book_chapter_once(b,'First',null,'request-one');
    assert false, 'foreign actor recovered chapter';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
