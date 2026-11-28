begin;
insert into auth.users(id,email) values
 ('b5100000-0000-4000-8000-000000000001','title-author@local.test'),
 ('b5100000-0000-4000-8000-000000000002','title-reader@local.test'),
 ('b5100000-0000-4000-8000-000000000003','title-outsider@local.test');
set local request.jwt.claims = '{"sub":"b5100000-0000-4000-8000-000000000001"}';
do $$
declare w public.workspaces; b uuid; c public.chapters;
begin
  select * into strict w from public.create_workspace_with_owner('Chapter title acceptance');
  insert into public.workspace_members(workspace_id,user_id,role,status) values(w.id,'b5100000-0000-4000-8000-000000000002','viewer','active');
  insert into public.books(workspace_id,title,author_name,created_by) values(w.id,'Book','Writer',auth.uid()) returning id into b;
  select * into strict c from public.create_book_chapters(b,'[{"title":"Imported title","nodes":[{"id":"n","type":"paragraph","text":"Preserve this manuscript"}]}]');
  perform set_config('bookworm.test_title_chapter',c.id::text,true);
end $$;
set local role authenticated;
do $$
declare w public.workspaces; b uuid; c public.chapters; original public.document_versions;
  r jsonb; again jsonb; op uuid := 'b5100000-0000-4000-8000-000000000010';
  closed_op uuid := 'b5100000-0000-4000-8000-000000000011';
  d text := encode(sha256(convert_to('The Arrival','UTF8')),'hex');
begin
  select * into strict c from public.chapters where id=current_setting('bookworm.test_title_chapter')::uuid;
  select * into strict original from public.document_versions where chapter_id=c.id;
  assert c.title_revision=0, 'new title starts at revision zero';
  r := public.get_chapter_title_change(c.id,op,0,d);
  assert r->>'status'='not_found', 'read-only lookup invented a result';
  r := public.change_chapter_title(c.id,op,0,'The Arrival');
  assert r->>'status'='saved' and r#>>'{receipt,revision}'='1', 'title not saved';
  assert r#>>'{current,title}'='The Arrival', 'current title incorrect';
  again := public.change_chapter_title(c.id,op,0,'The Arrival');
  assert again=r, 'replay changed the receipt';
  assert public.close_chapter_title_change(c.id,op,0,d)=r, 'closing undid a committed title';
  assert (select current_document_version_id from public.chapters where id=c.id)=original.id, 'title changed manuscript pointer';
  assert (select count(*) from public.document_versions where chapter_id=c.id)=1, 'title appended a manuscript revision';
  assert (select content_json from public.document_versions where id=original.id)=original.content_json, 'manuscript changed';
  assert (select count(*) from public.activity_events where entity_id=c.id and event_type='chapter.title_changed')=1, 'replay duplicated activity';
  begin
    perform public.change_chapter_title(c.id,op,0,'Different request'); assert false, 'reused identity accepted';
  exception when serialization_failure then null; end;
  r := public.close_chapter_title_change(c.id,closed_op,1,d);
  assert r->>'status'='closed', 'closure not recorded';
  assert public.change_chapter_title(c.id,closed_op,1,'The Arrival')->>'status'='closed', 'late request bypassed closure';
  assert (select title_revision from public.chapters where id=c.id)=1, 'closure changed title revision';
  r := public.change_chapter_title(c.id,gen_random_uuid(),0,'Stale title');
  assert r->>'status'='conflict', 'stale title overwrote current';
  -- Direct permitted table edits must also advance CAS and cannot rewrite the counter.
  update public.chapters set title='Collaborator title',title_revision=0 where id=c.id;
  assert (select title_revision from public.chapters where id=c.id)=2, 'direct edit bypassed CAS';
  update public.chapters set title_revision=999 where id=c.id;
  assert (select title_revision from public.chapters where id=c.id)=2, 'caller tampered with CAS';
  r := public.get_chapter_title_change(c.id,op,0,d);
  assert r#>>'{receipt,title}'='The Arrival' and r#>>'{current,title}'='Collaborator title', 'receipt overwrote collaborator';
  perform public.append_chapter_version(c.id,1,original.content_json,original.plain_text,original.word_count,'Body only','title-body-save');
  assert (select title_revision from public.chapters where id=c.id)=2, 'body save changed title revision';
  r := public.change_chapter_title(c.id,gen_random_uuid(),2,'Collaborator title');
  assert r->>'status'='saved' and r#>>'{receipt,revision}'='2', 'same-title confirmation changed revision';
  foreach d in array array['',repeat('x',501),E'line\nbreak'] loop
    begin perform public.change_chapter_title(c.id,gen_random_uuid(),2,d); assert false, 'invalid title accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  d := encode(sha256(convert_to('The Arrival','UTF8')),'hex');
  perform set_config('request.jwt.claims','{"sub":"b5100000-0000-4000-8000-000000000002"}',true);
  assert public.get_chapter_title_change(c.id,op,0,d)->>'status'='not_found', 'reader saw another author receipt';
  begin perform public.change_chapter_title(c.id,gen_random_uuid(),2,'Reader write'); assert false, 'reader wrote';
  exception when insufficient_privilege then null; end;
  begin perform public.close_chapter_title_change(c.id,op,0,d); assert false, 'reader closed';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.chapter_title_changes; assert false, 'receipt table exposed';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims','{"sub":"b5100000-0000-4000-8000-000000000003"}',true);
  begin perform public.get_chapter_title_change(c.id,op,0,d); assert false, 'cross-tenant title disclosed';
  exception when no_data_found then null; end;
end $$;
reset role;
do $$ begin
  assert not has_function_privilege('anon','public.change_chapter_title(uuid,uuid,integer,text)','execute');
  assert not has_function_privilege('authenticated','public.track_chapter_title_revision()','execute');
  assert not has_table_privilege('authenticated','public.chapter_title_changes','insert');
end $$;
rollback;
