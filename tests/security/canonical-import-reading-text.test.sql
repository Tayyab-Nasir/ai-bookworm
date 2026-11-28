-- Real role/RPC assertions, rolled back; no provider or hosted database.
begin;
insert into auth.users(id,email) values
 ('c1310000-0000-4000-8000-000000000001','canonical-reading-author@local.test'),
 ('c1310000-0000-4000-8000-000000000002','canonical-reading-outsider@local.test');
create temp table canonical_reading_fixture(book_id uuid,workspace_id uuid,nodes jsonb) on commit drop;
grant select,insert on canonical_reading_fixture to authenticated,service_role;
set local role authenticated;
set local request.jwt.claims='{"sub":"c1310000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare ws public.workspaces; b uuid; c public.chapters; replay public.chapters; d public.document_versions;
  before_count integer; nodes jsonb:='[
    {"id":"p","type":"paragraph","text":"Opening words","attributes":{"richText":[{"text":"Do not duplicate"}]}},
    {"id":"t","type":"table","rows":[["Name","Role"],["Elara","Writer"]]},
    {"id":"empty","type":"table","text":"","rows":[["Stale retained cells"]]},
    {"id":"i","type":"image","text":"Figure text","caption":"Visible caption","altText":"Private accessibility"}]';
  expected text:=E'Opening words\n\nName\tRole\nElara\tWriter\n\nFigure text\n\nVisible caption';
begin
  assert private.canonical_book_nodes_plain_text(nodes)=expected,'canonical reading block order or empty precedence differs';
  assert private.canonical_book_plain_text_word_count(expected)=10,'canonical reading count differs';
  assert private.canonical_book_nodes_plain_text('[{"type":"image","text":"Same caption","caption":"Same caption"}]')='Same caption','mirrored caption duplicated';
  assert private.canonical_book_nodes_plain_text('[{"type":"image","text":"","caption":"Visible caption"}]')='Visible caption','empty image text hid its distinct caption';
  assert private.canonical_book_nodes_plain_text('[{"type":"image","text":"Caption","caption":" Caption "}]')=E'Caption\n\n Caption ','caption comparison must be exact';
  assert private.canonical_book_nodes_plain_text('[{"type":"paragraph","caption":"Ignored"},{"type":"image","altText":"Ignored"}]')='','nonreading fields leaked';
  assert private.canonical_book_nodes_plain_text('[{"type":"table","rows":[[],[]]}]')=E'\n','empty row separators lost';
  assert private.canonical_book_nodes_plain_text('[{"type":"table","rows":[["",""]]}]')=E'\t','empty cell separators lost';
  assert private.canonical_book_plain_text_word_count(E'\t\n')=0,'whitespace-only table counted as a word';
  assert private.canonical_book_plain_text_word_count('A'||chr(160)||'B'||chr(65279)||'C')=3,'ECMAScript NBSP/BOM separators differ';
  assert private.canonical_book_plain_text_word_count(chr(160)||chr(65279)||E'\t')=0,'Unicode whitespace did not trim';
  assert private.canonical_book_plain_text_word_count('A'||chr(8203)||'B')=1,'zero-width space is not an ECMAScript separator';
  select * into strict ws from public.create_workspace_with_owner('Canonical reading');
  insert into public.books(workspace_id,title,author_name,created_by) values(ws.id,'Reading projections','Author',auth.uid()) returning id into b;
  insert into canonical_reading_fixture values(b,ws.id,nodes);
  select * into strict c from public.create_book_chapters(b,jsonb_build_array(jsonb_build_object('title','Direct creation','nodes',nodes)));
  select * into strict d from public.document_versions where id=c.current_document_version_id;
  assert d.plain_text=expected and d.word_count=10 and d.version_number=1 and d.created_by=auth.uid(),'direct authenticated creation did not use canonical initial projection';
  assert d.content_json=jsonb_build_object('schemaVersion','1.0','nodes',nodes),'projection changed the rich model';
  select * into strict c from public.create_book_chapter_once(b,'Replay creation',nodes,'canonical-reading-request');
  select * into strict replay from public.create_book_chapter_once(b,'Replay creation',nodes,'canonical-reading-request');
  assert c.id=replay.id,'creation receipt replay duplicated the chapter';
  assert (select count(*) from public.document_versions where chapter_id=c.id)=1,'creation replay duplicated the initial version';
  assert (select plain_text=expected and word_count=10 from public.document_versions where id=c.current_document_version_id),'creation wrapper bypassed corrected projection';
  select count(*) into before_count from public.chapters where book_id=b;
  begin
    perform public.create_book_chapters(b,'[{"title":"Valid first","nodes":[{"type":"table","rows":[["Valid cell"]]}]},{"title":"Invalid second","nodes":[{"type":"table","rows":[[null]]}]}]');
    assert false,'malformed canonical cell was coerced';
  exception when invalid_parameter_value then null; end;
  assert (select count(*) from public.chapters where book_id=b)=before_count,'later projection error left partial creation';
  assert (select plain_text=expected and word_count=10 from public.document_versions where id=d.id),'another creation rewrote prior history';
end $$;
reset role;

-- Service-invoker import resolves the same pure helpers without new client data grants.
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
  select source.id,f.workspace_id,'manuscript','canonical.txt',format('workspaces/%s/assets/%s/v1/source.txt',f.workspace_id,source.id),
    'text/plain',128,'pending','c1310000-0000-4000-8000-000000000001'
  from canonical_reading_fixture f cross join unnest(array['c1310000-0000-4000-8000-000000000010'::uuid,'c1310000-0000-4000-8000-000000000011'::uuid,'c1310000-0000-4000-8000-000000000012'::uuid]) source(id);
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
  select id,1,storage_path,'pending',mime_type,size_bytes,created_by from public.assets
  where id in ('c1310000-0000-4000-8000-000000000010','c1310000-0000-4000-8000-000000000011','c1310000-0000-4000-8000-000000000012');
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare f canonical_reading_fixture; result jsonb; replay jsonb; source uuid; job public.manuscript_import_jobs;
  actor uuid:='c1310000-0000-4000-8000-000000000001'; before_count integer; imported uuid;
  expected text:=E'Opening words\n\nName\tRole\nElara\tWriter\n\nFigure text\n\nVisible caption';
begin
  select * into strict f from canonical_reading_fixture;
  foreach source in array array['c1310000-0000-4000-8000-000000000010'::uuid,'c1310000-0000-4000-8000-000000000011'::uuid,'c1310000-0000-4000-8000-000000000012'::uuid] loop
    perform public.record_asset_scan_verdict(source,1,'clean',repeat('a',64),'text/plain',128,'fixture','canonical-v1',null);
  end loop;
  source:='c1310000-0000-4000-8000-000000000010';
  result:=public.complete_manuscript_image_import(actor,f.book_id,source,repeat('a',64),jsonb_build_array(jsonb_build_object('title','Import','nodes',f.nodes)),'[]','{"warnings":[]}');
  imported:=(result#>>'{chapters,0,current_document_version_id}')::uuid;
  assert (select plain_text=expected and word_count=10 and created_by=actor from public.document_versions where id=imported),'import wrapper did not save canonical initial reading text';
  assert (select content_json=jsonb_build_object('schemaVersion','1.0','nodes',f.nodes) from public.document_versions where id=imported),'import changed rich content';
  select count(*) into before_count from public.chapters where book_id=f.book_id;
  replay:=public.complete_manuscript_import(actor,f.book_id,source,repeat('a',64),'[]','[]','{}');
  assert replay=result and (select count(*) from public.chapters where book_id=f.book_id)=before_count,'receipt replay re-imported or rewrote chapters';
  source:='c1310000-0000-4000-8000-000000000011';
  begin
    perform public.complete_manuscript_import(actor,f.book_id,source,repeat('a',64),
      '[{"title":"Valid first","nodes":[{"type":"image","caption":"Valid caption"}]},{"title":"Invalid second","nodes":[{"type":"image","caption":null}]}]','[]','{}');
    assert false,'malformed caption committed';
  exception when invalid_parameter_value then null; end;
  assert (select count(*) from public.chapters where book_id=f.book_id)=before_count,'projection failure left partial imported chapters';
  assert not exists(select 1 from public.book_import_receipts where source_asset_id=source),'projection failure left an import receipt';
  assert not exists(select 1 from public.asset_links where asset_id=source and usage_role='manuscript_source'),'projection failure left a source link';
  source:='c1310000-0000-4000-8000-000000000012';
  perform public.enqueue_manuscript_import(actor,f.book_id,source);
  select * into strict job from public.claim_manuscript_import(30);
  begin
    perform public.complete_leased_manuscript_import(job.id,gen_random_uuid(),'[]','[]','{}');
    assert false,'wrong lease bypassed projection write';
  exception when serialization_failure then null; end;
  result:=public.complete_leased_manuscript_import(job.id,job.lease_token,jsonb_build_array(jsonb_build_object('title','Leased','nodes',f.nodes)),'[]','{}');
  assert (select plain_text=expected and word_count=10 from public.document_versions where id=(result#>>'{chapters,0,current_document_version_id}')::uuid),'leased wrapper bypassed canonical reading projection';
  assert public.complete_leased_manuscript_import(job.id,job.lease_token,'[]','[]','{}')=result,'successful lease replay lost its original receipt';
  assert (select plain_text=expected and word_count=10 from public.document_versions where id=imported),'later import rewrote saved history';
end $$;
reset role;
do $$
declare helper text;
begin
  foreach helper in array array['private.canonical_book_nodes_plain_text(jsonb)','private.canonical_book_plain_text_word_count(text)'] loop
    assert not has_function_privilege('anon',helper,'EXECUTE'),'anonymous reading helper grant leaked';
    assert has_function_privilege('authenticated',helper,'EXECUTE') and has_function_privilege('service_role',helper,'EXECUTE'),'invoker helper grant missing';
    assert not (select prosecdef from pg_proc where oid=to_regprocedure(helper)),'pure projection helper became security definer';
  end loop;
  assert has_schema_privilege('service_role','private','USAGE') and not has_schema_privilege('anon','private','USAGE'),'helper schema lookup grants differ';
  assert has_function_privilege('authenticated','public.create_book_chapters(uuid,jsonb,uuid)','EXECUTE') and not has_function_privilege('anon','public.create_book_chapters(uuid,jsonb,uuid)','EXECUTE'),'creation grants changed';
  assert has_function_privilege('authenticated','public.create_book_chapter_once(uuid,text,jsonb,text)','EXECUTE') and not has_function_privilege('anon','public.create_book_chapter_once(uuid,text,jsonb,text)','EXECUTE'),'creation wrapper grants changed';
  foreach helper in array array['public.complete_manuscript_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)',
    'public.complete_manuscript_image_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)','public.complete_leased_manuscript_import(uuid,uuid,jsonb,jsonb,jsonb)'] loop
    assert has_function_privilege('service_role',helper,'EXECUTE') and not has_function_privilege('authenticated',helper,'EXECUTE') and not has_function_privilege('anon',helper,'EXECUTE'),'import/wrapper grants changed';
  end loop;
end $$;
rollback;
