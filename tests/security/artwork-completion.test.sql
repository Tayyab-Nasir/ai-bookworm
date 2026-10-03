-- Completion must reject stale artwork inside the transaction that persists
-- artifact metadata, findings and usage. This is not a Storage-byte test.
begin;
insert into auth.users(id,email) values
 ('a7300000-0000-4000-8000-000000000001','completion-author@local.test'),
 ('a7300000-0000-4000-8000-000000000002','completion-reviewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('b7300000-0000-4000-8000-000000000001','Artwork completion','artwork-completion','a7300000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('c7300000-0000-4000-8000-000000000001','b7300000-0000-4000-8000-000000000001','Completion','completion','a7300000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('c7300000-0000-4000-8000-000000000001','a7300000-0000-4000-8000-000000000001','editor'),
 ('c7300000-0000-4000-8000-000000000001','a7300000-0000-4000-8000-000000000002','reviewer');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('d7300000-0000-4000-8000-000000000001','c7300000-0000-4000-8000-000000000001','Illustrated','Author','a7300000-0000-4000-8000-000000000001');
insert into public.editions(id,book_id,type,language,edition_metadata_json) values
 ('e7300000-0000-4000-8000-000000000001','d7300000-0000-4000-8000-000000000001','ebook','en',
  '{"kind":"ebook","cover":{"asset_id":"f7300000-0000-4000-8000-000000000001"}}');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,requires_approval,created_by) values
 ('f7300000-0000-4000-8000-000000000001','c7300000-0000-4000-8000-000000000001','illustration','Approved scene',
  'workspaces/c7300000-0000-4000-8000-000000000001/assets/f7300000-0000-4000-8000-000000000001/v1/scene.png',
  'image/png',128,repeat('a',64),'approved',true,'a7300000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,scan_status,created_by)
 select id,1,storage_path,checksum,mime_type,size_bytes,'clean',created_by from public.assets
 where id='f7300000-0000-4000-8000-000000000001';
insert into public.approvals(id,workspace_id,entity_type,entity_id,entity_version_number,status,requested_by,reviewer_id,resolved_by,resolved_at) values
 ('07300000-0000-4000-8000-000000000001','c7300000-0000-4000-8000-000000000001','asset',
  'f7300000-0000-4000-8000-000000000001',1,'approved','a7300000-0000-4000-8000-000000000001',
  'a7300000-0000-4000-8000-000000000002','a7300000-0000-4000-8000-000000000002',now());
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('c7300000-0000-4000-8000-000000000002','b7300000-0000-4000-8000-000000000001','Foreign artwork','foreign-artwork','a7300000-0000-4000-8000-000000000001');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values
 ('f7300000-0000-4000-8000-000000000002','c7300000-0000-4000-8000-000000000002','illustration','Foreign scene',
  'workspaces/c7300000-0000-4000-8000-000000000002/assets/f7300000-0000-4000-8000-000000000002/v1/scene.png',
  'image/png',128,repeat('a',64),'a7300000-0000-4000-8000-000000000001');

create function pg_temp.artwork_job(p_action text, p_override jsonb default '{}', p_bad_proof boolean default false)
returns uuid language plpgsql as $$
declare j uuid := gen_random_uuid(); r uuid := gen_random_uuid(); p uuid := gen_random_uuid(); request jsonb;
begin
 select jsonb_build_object('action',p_action,'editionUpdatedAt',e.updated_at,'bookModelSha256',repeat('a',64),'imageSha256',repeat('b',64),
  'artworkSnapshot',jsonb_build_object('schemaVersion',1,'coverAssetId',a.id,'illustrationAssetIds',jsonb_build_array(a.id),
   'assets',jsonb_build_array(jsonb_build_object('assetId',a.id,'versionNumber',1,'storagePath',a.storage_path,'checksum',a.checksum,
    'mimeType',a.mime_type,'sizeBytes',a.size_bytes,'requiresApproval',true,'approvalId','07300000-0000-4000-8000-000000000001'))))
 into request from public.editions e cross join public.assets a
 where e.id='e7300000-0000-4000-8000-000000000001' and a.id='f7300000-0000-4000-8000-000000000001';
 request := request || p_override;
 if p_action='export_package' then
  insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,response_json,idempotency_key,created_by)
   values(r,'d7300000-0000-4000-8000-000000000001','e7300000-0000-4000-8000-000000000001','render','succeeded',
    request || jsonb_build_object('action','render','imageSha256',case when p_bad_proof then repeat('c',64) else repeat('b',64) end),
    '{"artifacts":[]}',r::text,'a7300000-0000-4000-8000-000000000001'),
   (p,'d7300000-0000-4000-8000-000000000001','e7300000-0000-4000-8000-000000000001','kdp','succeeded',
    request || '{"action":"validate"}', '{"requestedChannel":"kdp","errors":0}',p::text,'a7300000-0000-4000-8000-000000000001');
  request := request || jsonb_build_object('sourceRenderJobId',r,'sourcePreflightJobId',p);
 end if;
 insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,idempotency_key,created_by,lease_token,lease_expires_at)
 values(j,'d7300000-0000-4000-8000-000000000001','e7300000-0000-4000-8000-000000000001',
  case when p_action='render' then 'render' else 'kdp' end,'running',request,j::text,'a7300000-0000-4000-8000-000000000001',j,clock_timestamp()+interval '5 minutes');
 return j;
end $$;
create function pg_temp.finish_artwork_job(p_job uuid, p_leased boolean default false)
returns void language plpgsql as $$
declare request jsonb; action text; result jsonb; artifact jsonb;
begin
 select request_json into request from public.publishing_jobs where id=p_job; action:=request->>'action';
 artifact:=jsonb_build_object('assetId',p_job,'name','Artifact','type',case when action='export_package' then 'publishing_package' else 'rendered_book' end,
  'role',case when action='export_package' then 'publishing_package' else 'rendered_ebook' end,
  'filename',case when action='export_package' then 'kdp-export.zip' else 'book.epub' end,
  'storagePath',format('workspaces/c7300000-0000-4000-8000-000000000001/assets/%s/v1/%s',p_job,case when action='export_package' then 'kdp-export.zip' else 'book.epub' end),
  'mimeType',case when action='export_package' then 'application/zip' else 'application/epub+zip' end,'sizeBytes',256,'checksum',repeat('c',64));
 result:=case when action='render' then jsonb_build_object('artifacts',jsonb_build_array(artifact),'rendererVersion','test','usage','{}'::jsonb)
  when action='export_package' then jsonb_build_object('artifact',artifact,'ruleVersion','test')
  else '{"ruleVersion":"test","requestedChannel":"kdp","errors":0,"warnings":1,"findings":[{"severity":"warning","code":"TEST","message":"Fixture warning","rule_id":"TEST","rule_version":"test"}]}'::jsonb end;
 if p_leased then perform public.complete_leased_publishing_job(p_job,p_job,result);
 elsif action='render' then perform public.complete_render_job(p_job,result->'artifacts','test','{}');
 elsif action='validate' then perform public.complete_preflight_job(p_job,result);
 else perform public.complete_publishing_package_job(p_job,artifact,'test',(request->>'sourceRenderJobId')::uuid,(request->>'sourcePreflightJobId')::uuid); end if;
end $$;
create function pg_temp.expect_artwork_failure(p_job uuid, p_leased boolean default false, p_code text default '40001')
returns void language plpgsql as $$
declare v_code text; v_detail text;
begin
 begin perform pg_temp.finish_artwork_job(p_job,p_leased); assert false,'stale artwork completed';
 exception when sqlstate '40001' or sqlstate '22023' or sqlstate '42501' then
  get stacked diagnostics v_code=returned_sqlstate, v_detail=pg_exception_detail;
  assert v_code=p_code,'wrong artwork completion error class';
  if p_code='40001' then assert v_detail='bookworm_publishing_snapshot_changed','snapshot failure confused with lost lease'; end if;
 end;
 assert (select status='running' from public.publishing_jobs where id=p_job),'failed completion changed job state';
 assert not exists(select 1 from public.assets where id=p_job),'failed completion published artifact';
 assert not exists(select 1 from public.usage_events where publishing_job_id=p_job),'failed completion recorded usage';
 assert not exists(select 1 from public.publishing_validations where publishing_job_id=p_job),'failed completion recorded findings';
 assert not exists(select 1 from public.activity_events where payload_json->>'publishingJobId'=p_job::text),'failed completion recorded activity';
end $$;

set local role service_role;
do $$
declare action text; j uuid; scenario text; leased boolean; snapshot jsonb; bad jsonb;
begin
 foreach action in array array['render','validate','export_package'] loop
  foreach leased in array array[false,true] loop
   foreach scenario in array array['scan','review','version','deleted','archived','size'] loop
    j:=pg_temp.artwork_job(action);
    -- Confirmed versions are immutable. Operator replacement/deletion must
    -- still invalidate completion; do not disable that production guard.
    if scenario in ('scan','version','size') then
     delete from public.asset_versions where asset_id='f7300000-0000-4000-8000-000000000001';
     insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,scan_status,created_by)
      select id,case when scenario='version' then 2 else 1 end,storage_path,case when scenario='scan' then 'pending' else checksum end,mime_type,
       case when scenario='size' then 129 else 128 end,case when scenario='scan' then 'infected' else 'clean' end,created_by
      from public.assets where id='f7300000-0000-4000-8000-000000000001';
     if scenario='scan' then
      perform public.record_asset_scan_verdict('f7300000-0000-4000-8000-000000000001',1,'infected',repeat('a',64),
       'image/png',128,'fixture-scanner','Eicar-Test','malware_detected');
     end if;
    else case scenario
     when 'review' then update public.approvals set superseded_at=clock_timestamp() where id='07300000-0000-4000-8000-000000000001';
     when 'deleted' then update public.assets set deleted_at=clock_timestamp() where id='f7300000-0000-4000-8000-000000000001';
     when 'archived' then update public.assets set status='archived' where id='f7300000-0000-4000-8000-000000000001';
    end case; end if;
    perform pg_temp.expect_artwork_failure(j,leased);
    delete from public.asset_versions where asset_id='f7300000-0000-4000-8000-000000000001';
    insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,scan_status,created_by)
     select id,1,storage_path,checksum,mime_type,128,'clean',created_by from public.assets where id='f7300000-0000-4000-8000-000000000001';
    update public.approvals set superseded_at=null where id='07300000-0000-4000-8000-000000000001';
    update public.assets set deleted_at=null,status='approved' where id='f7300000-0000-4000-8000-000000000001';
   end loop;
   j:=pg_temp.artwork_job(action); perform pg_temp.finish_artwork_job(j,leased); perform pg_temp.finish_artwork_job(j,leased);
   assert (select status='succeeded' from public.publishing_jobs where id=j),'valid artwork completion failed';
   assert (select count(*) from public.usage_events where publishing_job_id=j)=case when action='validate' then 0 else 1 end,'completion replay duplicated usage';
  end loop;
 end loop;
 j:=pg_temp.artwork_job('render','{"artworkSnapshot":null}'); perform pg_temp.expect_artwork_failure(j,false,'22023');
 j:=pg_temp.artwork_job('validate','{"action":null}');
 begin perform public.complete_preflight_job(j,'{"ruleVersion":"test","errors":0,"warnings":0,"findings":[]}');
  assert false,'NULL action bypassed publishing snapshot guard'; exception when sqlstate '22023' then null; end;
 j:=pg_temp.artwork_job('export_package','{}',true); perform pg_temp.expect_artwork_failure(j);
 j:=pg_temp.artwork_job('render');
 begin update public.publishing_jobs set request_json=request_json-'artworkSnapshot' where id=j;
  assert false,'publishing input snapshot is mutable'; exception when sqlstate '22023' then null; end;
 begin update public.publishing_jobs set channel='kdp' where id=j;
  assert false,'publishing identity is mutable'; exception when sqlstate '22023' then null; end;
 select request_json->'artworkSnapshot' into snapshot from public.publishing_jobs where id=j;
 foreach scenario in array array['schema','missing-assets','duplicate-assets','duplicate-ids','size','review','checksum','path'] loop
  bad:=case scenario
   when 'schema' then jsonb_set(snapshot,'{schemaVersion}','2')
   when 'missing-assets' then jsonb_set(snapshot,'{assets}','[]')
   when 'duplicate-assets' then jsonb_set(snapshot,'{assets}',(snapshot->'assets')||(snapshot->'assets'))
   when 'duplicate-ids' then jsonb_set(snapshot,'{illustrationAssetIds}',(snapshot->'illustrationAssetIds')||(snapshot->'illustrationAssetIds'))
   when 'size' then jsonb_set(snapshot,'{assets,0,sizeBytes}','26214401')
   when 'review' then jsonb_set(snapshot,'{assets,0,requiresApproval}','false')
   when 'checksum' then jsonb_set(snapshot,'{assets,0,checksum}',to_jsonb(repeat('a',63)))
   when 'path' then jsonb_set(snapshot,'{assets,0,storagePath}',to_jsonb(repeat('a',1025))) end;
  j:=pg_temp.artwork_job('render',jsonb_build_object('artworkSnapshot',bad));
  perform pg_temp.expect_artwork_failure(j,false,'22023');
 end loop;
 bad:=jsonb_set(snapshot,'{assets,0,approvalId}','"07300000-0000-4000-8000-000000000002"');
 j:=pg_temp.artwork_job('render',jsonb_build_object('artworkSnapshot',bad)); perform pg_temp.expect_artwork_failure(j);
 bad:=jsonb_set(snapshot,'{illustrationAssetIds}',(snapshot->'illustrationAssetIds')||'"f7300000-0000-4000-8000-000000000002"'::jsonb);
 bad:=jsonb_set(bad,'{assets}',(snapshot->'assets')||jsonb_build_object('assetId','f7300000-0000-4000-8000-000000000002',
  'versionNumber',1,'storagePath','workspaces/c7300000-0000-4000-8000-000000000002/assets/f7300000-0000-4000-8000-000000000002/v1/scene.png',
  'checksum',repeat('a',64),'mimeType','image/png','sizeBytes',128,'requiresApproval',false,'approvalId',null));
 j:=pg_temp.artwork_job('render',jsonb_build_object('artworkSnapshot',bad)); perform pg_temp.expect_artwork_failure(j);
 foreach action in array array['render','validate','export_package'] loop
  foreach leased in array array[false,true] loop
   j:=pg_temp.artwork_job(action);
   update public.workspace_members set role='viewer' where workspace_id='c7300000-0000-4000-8000-000000000001' and user_id='a7300000-0000-4000-8000-000000000001';
   perform pg_temp.expect_artwork_failure(j,leased,'42501');
   update public.workspace_members set role='editor' where workspace_id='c7300000-0000-4000-8000-000000000001' and user_id='a7300000-0000-4000-8000-000000000001';
  end loop;
  j:=pg_temp.artwork_job(action);
  update public.editions set edition_metadata_json='{"kind":"ebook","cover":{"asset_id":null}}' where id='e7300000-0000-4000-8000-000000000001';
  perform pg_temp.expect_artwork_failure(j);
  update public.editions set edition_metadata_json='{"kind":"ebook","cover":{"asset_id":"f7300000-0000-4000-8000-000000000001"}}' where id='e7300000-0000-4000-8000-000000000001';
 end loop;
end $$;
reset role;
rollback;
