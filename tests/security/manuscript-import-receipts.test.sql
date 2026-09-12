begin;
insert into auth.users(id,email) values
 ('a7900000-0000-4000-8000-000000000001','import-owner@local.test'),
 ('b7900000-0000-4000-8000-000000000001','import-outsider@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('a7900000-0000-4000-8000-000000000002','Import Org','import-org','a7900000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
 ('a7900000-0000-4000-8000-000000000002','a7900000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('a7900000-0000-4000-8000-000000000003','a7900000-0000-4000-8000-000000000002','Import Workspace','import-ws','a7900000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('a7900000-0000-4000-8000-000000000003','a7900000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('a7900000-0000-4000-8000-000000000004','a7900000-0000-4000-8000-000000000003','Imported Story','Author','a7900000-0000-4000-8000-000000000001');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
 select id,'a7900000-0000-4000-8000-000000000003','manuscript','source.docx',
   format('workspaces/a7900000-0000-4000-8000-000000000003/assets/%s/v1/source.docx',id),
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'pending','a7900000-0000-4000-8000-000000000001'
 from unnest(array['a7900000-0000-4000-8000-000000000005'::uuid,'a7900000-0000-4000-8000-000000000006'::uuid]) id;
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
 select id,1,storage_path,'pending',mime_type,size_bytes,created_by from public.assets
 where id in ('a7900000-0000-4000-8000-000000000005','a7900000-0000-4000-8000-000000000006');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$
declare
 actor uuid := 'a7900000-0000-4000-8000-000000000001';
 book uuid := 'a7900000-0000-4000-8000-000000000004';
 source uuid := 'a7900000-0000-4000-8000-000000000005';
 source2 uuid := 'a7900000-0000-4000-8000-000000000006';
 chapters jsonb := '[{"title":"Text opening","nodes":[{"id":"p","type":"paragraph","text":"A text-only manuscript."}]}]';
 result jsonb;
begin
 assert not has_function_privilege('authenticated','public.complete_manuscript_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)','EXECUTE'), 'user can forge import';
 assert not has_function_privilege('anon','public.complete_manuscript_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)','EXECUTE'), 'anon can import';
 perform public.record_asset_scan_verdict(source,1,'clean',repeat('a',64),
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'fixture-scanner','fixture-v1',null);
 begin
   perform public.complete_manuscript_import('b7900000-0000-4000-8000-000000000001',book,source,repeat('a',64),chapters,'[]','{}');
   assert false, 'outsider imported';
 exception when insufficient_privilege then null; end;
 result := public.complete_manuscript_import(actor,book,source,repeat('a',64),chapters,'[]',
   '{"warnings":["Review headings"],"chapterCount":1,"imageCount":0}');
 assert result->'assetIds'='[]'::jsonb, 'text-only import invented assets';
 assert result->'report'->'warnings'='["Review headings"]'::jsonb, 'report lost';
 assert jsonb_array_length(result->'chapters')=1, 'missing chapter';
 assert (select created_by from public.document_versions where chapter_id=(result->'chapters'->0->>'id')::uuid)=actor, 'wrong actor';
 assert public.complete_manuscript_import(actor,book,source,repeat('a',64),'[]','[]','{}')=result, 'retry did not return original receipt';
 assert (select count(*) from public.chapters where book_id=book)=1, 'duplicate chapters';
 assert (select count(*) from public.assets where workspace_id='a7900000-0000-4000-8000-000000000003')=2, 'unexpected image assets';
 begin
   perform public.complete_manuscript_import(actor,book,source,repeat('b',64),chapters,'[]','{}');
   assert false, 'changed checksum replayed';
 exception when invalid_parameter_value then null; end;
 perform public.record_asset_scan_verdict(source2,1,'clean',repeat('a',64),
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'fixture-scanner','fixture-v1',null);
 begin
   perform public.complete_manuscript_import(actor,book,source2,repeat('a',64),
     '[{"title":"First","nodes":[]},{"title":" ","nodes":[]}]','[]','{}');
   assert false, 'invalid later chapter committed';
 exception when invalid_parameter_value then null; end;
 assert not exists(select 1 from public.book_import_receipts where source_asset_id=source2), 'failed import left receipt';
 assert (select count(*) from public.chapters where book_id=book)=1, 'failed import left partial chapters';
end; $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
 assert (select count(*) from public.book_import_receipts)=1, 'member cannot recover receipt';
 begin
   insert into public.book_import_receipts(book_id,source_asset_id,source_checksum,result)
     values('a7900000-0000-4000-8000-000000000004','a7900000-0000-4000-8000-000000000006',repeat('a',64),'{}');
   assert false, 'member forged receipt';
 exception when insufficient_privilege then null; end;
end; $$;
set local request.jwt.claims = '{"sub":"b7900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin assert not exists(select 1 from public.book_import_receipts), 'outsider sees reports'; end; $$;
rollback;
