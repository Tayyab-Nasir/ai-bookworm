begin;
do $$ begin
 assert not (select prosecdef from pg_proc where oid='public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure);
 assert not (select prosecdef from pg_proc where oid='public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'::regprocedure);
 assert not (select prosecdef from pg_proc where oid='public.asset_lifecycle_status(uuid,uuid,uuid)'::regprocedure);
 assert (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure);
 assert (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'::regprocedure);
 assert (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='private.asset_lifecycle_status_internal(uuid,uuid,uuid)'::regprocedure);
 assert (select proowner from pg_proc where oid='private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure)=(select proowner from pg_proc where oid='private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'::regprocedure),'lifecycle helpers require same owner for trigger';
 assert has_function_privilege('authenticated','private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','execute');
 assert not has_function_privilege('anon','private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','execute');
 assert not has_function_privilege('service_role','private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','execute');
 assert has_function_privilege('service_role','private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','execute');
 assert not has_function_privilege('authenticated','private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','execute');
 assert not has_function_privilege('anon','private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','execute');
 assert has_function_privilege('authenticated','private.asset_lifecycle_status_internal(uuid,uuid,uuid)','execute');
 assert not has_function_privilege('anon','private.asset_lifecycle_status_internal(uuid,uuid,uuid)','execute');
 assert not has_function_privilege('service_role','private.asset_lifecycle_status_internal(uuid,uuid,uuid)','execute');
 assert has_function_privilege('authenticated','public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','execute');
 assert not has_function_privilege('anon','public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','execute');
 assert not has_function_privilege('service_role','public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','execute');
 assert not has_table_privilege('authenticated','bookworm_private.asset_lifecycle_receipts','select');
 assert not has_column_privilege('authenticated','public.assets','status','update');
 assert not has_function_privilege('authenticated','public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','execute');
 assert has_function_privilege('service_role','public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','execute');
end $$;
insert into auth.users(id,email) values
 ('aa910000-0000-4000-8000-000000000001','lifecycle-editor@local.test'),
 ('aa910000-0000-4000-8000-000000000002','lifecycle-reviewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('bb910000-0000-4000-8000-000000000001','Fixture','lifecycle-fixture','aa910000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('cc910000-0000-4000-8000-000000000001','bb910000-0000-4000-8000-000000000001','Fixture','lifecycle-fixture','aa910000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
 ('cc910000-0000-4000-8000-000000000001','aa910000-0000-4000-8000-000000000001','editor','active'),
 ('cc910000-0000-4000-8000-000000000001','aa910000-0000-4000-8000-000000000002','viewer','active');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,requires_approval,created_by) values
 ('dd910000-0000-4000-8000-000000000001','cc910000-0000-4000-8000-000000000001','illustration','clean','workspaces/cc910000-0000-4000-8000-000000000001/assets/dd910000-0000-4000-8000-000000000001/v1/clean.png','image/png',10,repeat('a',64),'approved',true,'aa910000-0000-4000-8000-000000000001'),
 ('dd910000-0000-4000-8000-000000000002','cc910000-0000-4000-8000-000000000001','illustration','unsafe','fixture/unsafe.png','image/png',10,repeat('b',64),'archived',true,'aa910000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values
 ('dd910000-0000-4000-8000-000000000001',1,'workspaces/cc910000-0000-4000-8000-000000000001/assets/dd910000-0000-4000-8000-000000000001/v1/clean.png',repeat('a',64),'image/png',10,'aa910000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims','{}',true);
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values
 ('dd910000-0000-4000-8000-000000000002',1,'fixture/unsafe.png',repeat('b',64),'image/png',10,'aa910000-0000-4000-8000-000000000001');
update public.assets set deleted_at='2026-01-01T00:00:00Z' where id='dd910000-0000-4000-8000-000000000002';
insert into public.approvals(workspace_id,entity_type,entity_id,entity_version_number,requested_by,status) values
 ('cc910000-0000-4000-8000-000000000001','asset','dd910000-0000-4000-8000-000000000001',1,'aa910000-0000-4000-8000-000000000001','pending');
select set_config('test.original_revision',(select lifecycle_revision::text from public.assets where id='dd910000-0000-4000-8000-000000000001'),true);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000002"}',true);
do $$ begin
 begin perform public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000001','remove',null,current_setting('test.original_revision')::uuid);
  assert false,'viewer mutation allowed'; exception when insufficient_privilege then null; end;
 begin perform private.mutate_asset_lifecycle_internal('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000001','remove',null,current_setting('test.original_revision')::uuid);
  assert false,'viewer direct helper mutation allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',true);
do $$ declare result jsonb; deleted timestamptz; begin
 result:=public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000001','remove',null,current_setting('test.original_revision')::uuid);
 assert result->>'replayed'='false' and (result->>'expectedRevision')::uuid=current_setting('test.original_revision')::uuid;
 result:=public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000001','remove',null,current_setting('test.original_revision')::uuid);
 assert result->>'replayed'='true';
 select deleted_at into deleted from public.assets where id='dd910000-0000-4000-8000-000000000001';
 begin perform public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000002','restore',deleted,null);
  assert false,'direct restore allowed'; exception when insufficient_privilege then null; end;
 begin perform public.mutate_asset_lifecycle('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000002','ee910000-0000-4000-8000-000000000001','remove',null,current_setting('test.original_revision')::uuid);
  assert false,'operation id reused'; exception when unique_violation then null; end;
end $$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$ declare result jsonb; deleted timestamptz; ver uuid; rev uuid; begin
 select deleted_at,lifecycle_revision into deleted,rev from public.assets where id='dd910000-0000-4000-8000-000000000001';
 begin update public.assets set deleted_at=null,status='draft' where id='dd910000-0000-4000-8000-000000000001';
  assert false,'service role direct restore allowed'; exception when insufficient_privilege then null; end;
 select id into ver from public.asset_versions where asset_id='dd910000-0000-4000-8000-000000000001' and version_number=1;
 begin perform public.restore_verified_asset('aa910000-0000-4000-8000-000000000001','cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000002',deleted,rev,ver,'workspaces/cc910000-0000-4000-8000-000000000001/assets/dd910000-0000-4000-8000-000000000001/v1/clean.png',repeat('b',64),10);
  assert false,'wrong checksum accepted'; exception when serialization_failure then null; end;
 result:=public.restore_verified_asset('aa910000-0000-4000-8000-000000000001','cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000002',deleted,rev,ver,'workspaces/cc910000-0000-4000-8000-000000000001/assets/dd910000-0000-4000-8000-000000000001/v1/clean.png',repeat('a',64),10);
 assert result->>'replayed'='false' and (result->>'expectedRevision')::uuid=rev;
 result:=public.restore_verified_asset('aa910000-0000-4000-8000-000000000001','cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000002',deleted,rev,ver,'workspaces/cc910000-0000-4000-8000-000000000001/assets/dd910000-0000-4000-8000-000000000001/v1/clean.png',repeat('a',64),10);
 assert result->>'replayed'='true';
end $$;
reset role;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000001"}',true);
set local role authenticated;
do $$ declare receipt jsonb; begin
 receipt:=public.asset_lifecycle_status('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000002');
 assert receipt->>'action'='restore' and receipt->>'expectedDeletedAt' is not null;
 assert public.asset_lifecycle_status('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000099') is null;
end $$;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"aa910000-0000-4000-8000-000000000002"}',true);
do $$ begin
 assert public.asset_lifecycle_status('cc910000-0000-4000-8000-000000000001','dd910000-0000-4000-8000-000000000001','ee910000-0000-4000-8000-000000000002') is null;
end $$;
reset role;
do $$ begin
 assert (select status='draft' and deleted_at is null and requires_approval from public.assets where id='dd910000-0000-4000-8000-000000000001');
 assert exists(select 1 from public.approvals where entity_id='dd910000-0000-4000-8000-000000000001' and status='cancelled' and superseded_at is not null);
 assert (select count(*)=2 from bookworm_private.asset_lifecycle_receipts where asset_id='dd910000-0000-4000-8000-000000000001');
 assert (select count(*)=2 from public.activity_events where entity_id='dd910000-0000-4000-8000-000000000001');
end $$;
-- A pending upload exists before removal; scanner completion cannot replace
-- the current bytes after removal, even if the verdict is clean.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
values ('dd910000-0000-4000-8000-000000000001',2,'fixture/new.png','pending','image/png',10,'aa910000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values ('dd910000-0000-4000-8000-000000000001',3,'fixture/infected.png','pending','image/png',10,'aa910000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims','{}',true);
update public.assets set deleted_at='2026-02-01T00:00:00Z',status='archived' where id='dd910000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$ begin
 begin
  perform public.record_asset_scan_verdict('dd910000-0000-4000-8000-000000000001',2,'clean',repeat('c',64),'image/png',10,'fixture-scanner','clean',null);
  raise exception 'scanner replaced removed asset';
 exception when serialization_failure then null; end;
 begin
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
  values ('dd910000-0000-4000-8000-000000000001',4,'fixture/third.png','pending','image/png',10,'aa910000-0000-4000-8000-000000000001');
  raise exception 'new version created after removal';
 exception when serialization_failure then null; end;
 perform public.record_asset_scan_verdict('dd910000-0000-4000-8000-000000000001',3,'infected',repeat('d',64),'image/png',10,'fixture-scanner','Eicar-Test','malware_detected');
end $$;
reset role;
do $$ begin
 assert (select deleted_at is not null and storage_path='workspaces/cc910000-0000-4000-8000-000000000001/assets/dd910000-0000-4000-8000-000000000001/v1/clean.png' and checksum=repeat('a',64) from public.assets where id='dd910000-0000-4000-8000-000000000001');
 assert (select checksum='pending' and scan_status='pending' from public.asset_versions where asset_id='dd910000-0000-4000-8000-000000000001' and version_number=2);
 assert (select scan_status='infected' from public.asset_versions where asset_id='dd910000-0000-4000-8000-000000000001' and version_number=3);
end $$;
rollback;
