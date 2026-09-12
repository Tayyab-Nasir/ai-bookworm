begin;
create temp table retrieval_ids(book_id uuid,chapter_id uuid,item_id uuid) on commit drop;
grant all on retrieval_ids to authenticated;
insert into auth.users(id,email) values
 ('ab600000-0000-4000-8000-000000000001','retrieval-a@local.test'),
 ('ab600000-0000-4000-8000-000000000002','retrieval-b@local.test');
set local role authenticated;
set local request.jwt.claims='{"sub":"ab600000-0000-4000-8000-000000000001"}';
do $$
declare w public.workspaces; b uuid; c uuid; item uuid; v public.document_versions; hit record;
begin
 select * into w from public.create_workspace_with_owner('Retrieval');
 insert into public.books(workspace_id,title,author_name,created_by) values(w.id,'World','A',auth.uid()) returning id into b;
 select id into c from public.create_book_chapters(b,'[{"title":"Arrival","nodes":[{"id":"n1","type":"paragraph","text":"Elara carries a silver compass from the harbor."}]}]');
 insert into public.book_bible_items(book_id,type,name,description) values(b,'character','Elara','A mapmaker with silver hair.') returning id into item;
 insert into retrieval_ids values(b,c,item);
 assert (select count(*) from public.search_book_context(b,'silver'))=2,'manuscript and Bible not both retrieved';
 select * into hit from public.search_book_context(b,'compass');
 assert hit.chapter_id=c and hit.node_id='n1' and hit.document_version_id is not null,'citation missing canonical source';
 assert hit.excerpt='Elara carries a silver compass from the harbor.','excerpt is not verbatim';
 assert (select count(*) from public.search_book_context(b,'silver',8,null,false))=1,'Bible opt-out ignored';
 assert (select count(*) from public.search_book_context(b,'silver',8,array[c]))=1,'chapter filter ignored';
 assert (select count(*) from public.search_book_context(b,'no-such-secret'))=0,'empty search fabricated results';
 begin
   insert into public.book_search_chunks(book_id,chapter_id,chunk_index,title,text_content,text_hash)
   values(b,c,0,'Poison','Injected','bad');
   assert false,'client can poison derived retrieval';
 exception when insufficient_privilege then null; end;
 select * into v from public.append_chapter_version(c,1,'{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"Elara now carries an amber lantern."}]}','Elara now carries an amber lantern.',7,'Edit','retrieval-edit-1');
 assert (select count(*) from public.search_book_context(b,'compass'))=0,'superseded manuscript leaked';
 select * into hit from public.search_book_context(b,'lantern');
 assert hit.document_version_id=v.id,'search did not advance to new version';
 update public.book_bible_items set description='A mapmaker with auburn hair.' where id=item;
 assert (select count(*) from public.search_book_context(b,'silver'))=0,'stale Bible remained indexed';
 delete from public.book_bible_items where id=item;
 assert not exists(select 1 from public.book_search_chunks where bible_item_id=item),'deleted Bible retained';
 begin
   perform public.search_book_context(b,'x',21);
   assert false,'unbounded search accepted';
 exception when invalid_parameter_value then null; end;
end;
$$;
set local request.jwt.claims='{"sub":"ab600000-0000-4000-8000-000000000002"}';
do $$ begin
 assert (select count(*) from public.book_search_chunks)=0,'cross-tenant direct index leak';
 begin
  perform public.search_book_context((select book_id from retrieval_ids),'Elara');
  assert false,'cross-tenant search succeeded';
 exception when no_data_found then null; end;
end; $$;
reset role;
-- Suspended memberships lose access even to already-built search indexes.
update public.workspace_members set status='suspended' where user_id='ab600000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims='{"sub":"ab600000-0000-4000-8000-000000000001"}';
do $$ begin
 assert (select count(*) from public.book_search_chunks)=0,'suspended member can search';
end; $$;
rollback;
