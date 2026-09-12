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
 image uuid := 'a7900000-0000-4000-8000-000000000007';
 image2 uuid := 'a7900000-0000-4000-8000-000000000008';
 images jsonb; images2 jsonb; chapters jsonb; result jsonb; n integer;
begin
 assert not has_function_privilege('authenticated','public.complete_manuscript_image_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)','EXECUTE'), 'user can forge clean import';
 perform public.record_asset_scan_verdict(source,1,'clean',repeat('a',64),
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'fixture-scanner','fixture-v1',null);
 images := jsonb_build_array(jsonb_build_object('id',image,'name','picture.png','mimeType','image/png','sizeBytes',50,
   'checksum',repeat('b',64),'storagePath',format('workspaces/a7900000-0000-4000-8000-000000000003/assets/%s/v1/imported.png',image),
   'scanner','fixture-scanner','signature','fixture-v1'));
 images2 := jsonb_build_array((images->0) || jsonb_build_object('id',image2,
   'storagePath',format('workspaces/a7900000-0000-4000-8000-000000000003/assets/%s/v1/imported.png',image2)));
 chapters := jsonb_build_array(jsonb_build_object('title','Arrival','nodes',jsonb_build_array(
   jsonb_build_object('id','paragraph','type','paragraph','text','Before picture'),
   jsonb_build_object('id','image','type','image','assetId',image,'altText','Harbor'))));
 begin
   perform public.complete_manuscript_image_import('b7900000-0000-4000-8000-000000000001',book,source,repeat('a',64),chapters,images,'{}');
   assert false, 'outsider actor imported into workspace';
 exception when insufficient_privilege then null; end;
 begin
   perform public.complete_manuscript_image_import(actor,book,source2,repeat('a',64),chapters,images,'{}');
   assert false, 'pending source imported';
 exception when invalid_parameter_value then null; end;
 result := public.complete_manuscript_image_import(actor,book,source,repeat('a',64),chapters,images,'{"warnings":[]}');
 assert jsonb_array_length(result->'chapters')=1, 'chapter missing';
 assert (select scan_status from public.asset_versions where asset_id=image)='clean', 'user image mislabeled trusted_generated';
 assert (select scan_scanner from public.asset_versions where asset_id=image)='fixture-scanner', 'scanner audit missing';
 assert (select created_by from public.document_versions where chapter_id=(result->'chapters'->0->>'id')::uuid)=actor, 'wrong document author';
 assert (select content_json->'nodes'->1->>'assetId' from public.document_versions where chapter_id=(result->'chapters'->0->>'id')::uuid)=image::text, 'image reference lost';
 assert public.complete_manuscript_image_import(actor,book,source,repeat('a',64),chapters,images2,'{}')=result, 'replay did not reuse receipt';
 assert not exists(select 1 from public.assets where id=image2), 'replay inserted duplicate images';
 assert (select count(*) from public.chapters where book_id=book)=1, 'replay duplicated chapters';
 perform public.record_asset_scan_verdict(source2,1,'clean',repeat('a',64),
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'fixture-scanner','fixture-v1',null);
 begin
   perform public.complete_manuscript_image_import(actor,book,source2,repeat('a',64),
     '[{"title":"First","nodes":[]},{"title":" ","nodes":[]}]',images2,'{}');
   assert false, 'invalid later chapter did not abort';
 exception when invalid_parameter_value then null; end;
 assert not exists(select 1 from public.assets where id=image2), 'failed transaction left an image';
 assert (select count(*) from public.chapters where book_id=book)=1, 'failed transaction left partial chapters';
 assert not exists(select 1 from public.book_import_receipts where source_asset_id=source2), 'failed transaction left receipt';
 begin
   perform public.complete_manuscript_image_import(actor,book,source2,repeat('a',64),
    '[{"title":"Foreign","nodes":[{"id":"x","type":"image","assetId":"b7900000-0000-4000-8000-000000000099"}]}]',images2,'{}');
   assert false, 'unknown image accepted';
 exception when invalid_parameter_value then null; end;
 assert not exists(select 1 from public.assets where id=image2), 'invalid image reference left assets';
end;
$$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b7900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
 assert not exists(select 1 from public.book_import_receipts), 'outsider read import receipt';
end; $$;
rollback;
