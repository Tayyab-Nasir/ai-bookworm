begin;
insert into auth.users(id,email) values
 ('ac600000-0000-4000-8000-000000000001','rich-retrieval-a@local.test'),
 ('ac600000-0000-4000-8000-000000000002','rich-retrieval-b@local.test');
create temp table rich_retrieval_ids(book_id uuid,chapter_id uuid) on commit drop;
grant all on rich_retrieval_ids to authenticated;
set local role authenticated;
set local request.jwt.claims='{"sub":"ac600000-0000-4000-8000-000000000001"}';
do $$
declare w public.workspaces; b uuid; c uuid; v public.document_versions; hit record;
begin
  select * into w from public.create_workspace_with_owner('Rich retrieval');
  insert into public.books(workspace_id,title,author_name,created_by) values(w.id,'Atlas','Author',auth.uid()) returning id into b;
  select id into c from public.create_book_chapters(b,'[{"title":"Field notes","nodes":[
    {"id":"p1","type":"paragraph","text":"Ordinary introduction."},
    {"id":"t1","type":"table","rows":[["Port","Azimuth"],["Sable Bay","Forty-two degrees"]]},
    {"id":"i1","type":"image","caption":"Portrait of the cartographer","altText":"Sunrise over the amber harbor"}
  ]}]');
  insert into rich_retrieval_ids values(b,c);
  select * into hit from public.search_book_context(b,'azimuth');
  assert hit.chapter_id=c and hit.node_id='t1' and hit.source_type='manuscript','table cell was not indexed with its node citation';
  assert hit.excerpt like '%Sable Bay%' and hit.text_hash=md5(hit.excerpt),'table excerpt/hash mismatch';
  select * into hit from public.search_book_context(b,'sunrise');
  assert hit.node_id='i1' and hit.excerpt like '%amber harbor%','image alt text was not indexed';
  select * into hit from public.search_book_context(b,'cartographer');
  assert hit.node_id='i1' and hit.excerpt like '%Portrait%','caption was not indexed';
  assert (select count(*) from public.search_book_context(b,'azimuth',8,array[c],false))=1,'rich chapter filter changed';
  select * into v from public.append_chapter_version(c,1,
    '{"schemaVersion":"1.0","nodes":[{"id":"p1","type":"paragraph","text":"A new lantern replaces the old chart."}]}',
    'A new lantern replaces the old chart.',8,'Revised','rich-retrieval-edit-1');
  assert (select count(*) from public.search_book_context(b,'azimuth'))=0,'old table remained searchable';
  assert (select count(*) from public.search_book_context(b,'sunrise'))=0,'old image description remained searchable';
  assert (select count(*) from public.search_book_context(b,'cartographer'))=0,'old caption remained searchable';
  select * into hit from public.search_book_context(b,'lantern');
  assert hit.document_version_id=v.id and hit.node_id='p1','new version citation was not pinned';
end;
$$;
set local request.jwt.claims='{"sub":"ac600000-0000-4000-8000-000000000002"}';
do $$ begin
  assert (select count(*) from public.book_search_chunks)=0,'rich index exposed another tenant';
  begin
    perform public.search_book_context((select book_id from rich_retrieval_ids),'lantern');
    assert false,'cross-tenant rich search succeeded';
  exception when no_data_found then null; end;
end; $$;
rollback;
