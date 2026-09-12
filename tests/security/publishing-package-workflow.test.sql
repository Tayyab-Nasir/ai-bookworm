-- Publishing package completion is service-only, source-bound, atomic, and replay-safe.
begin;

insert into auth.users(id,email) values
  ('a9000000-0000-0000-0000-000000000001','publisher@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('19000000-0000-4000-8000-000000000001','Package Org','package-org','a9000000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('19000000-0000-4000-8000-000000000001','a9000000-0000-0000-0000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('29000000-0000-4000-8000-000000000001','19000000-0000-4000-8000-000000000001','Package Workspace','package-ws','a9000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('29000000-0000-4000-8000-000000000001','a9000000-0000-0000-0000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000001','Packaged Book','Author','a9000000-0000-0000-0000-000000000001');
insert into public.editions(id,book_id,type,language,updated_at) values
  ('49000000-0000-4000-8000-000000000001','39000000-0000-4000-8000-000000000001','ebook','en','2026-09-04T00:00:00Z');

insert into public.publishing_jobs(
  id,book_id,edition_id,channel,status,request_json,response_json,idempotency_key,created_by,started_at,completed_at
) values
  ('59000000-0000-4000-8000-000000000001','39000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001','render','succeeded',
   jsonb_build_object('action','render','editionUpdatedAt','2026-09-04T00:00:00Z','bookModelSha256',repeat('a',64)),
   '{"artifacts":[],"rendererVersion":"test","usage":{}}','package-render','a9000000-0000-0000-0000-000000000001',now(),now()),
  ('59000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001','kdp','succeeded',
   jsonb_build_object('action','validate','editionUpdatedAt','2026-09-04T00:00:00Z','bookModelSha256',repeat('a',64)),
   '{"ruleVersion":"core-1+kdp-1","requestedChannel":"kdp","channel":"kdp","errors":0,"warnings":0,"findings":[]}',
   'package-preflight','a9000000-0000-0000-0000-000000000001',now(),now()),
  ('59000000-0000-4000-8000-000000000003','39000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001','kdp','running',
   jsonb_build_object('action','export_package','editionUpdatedAt','2026-09-04T00:00:00Z','bookModelSha256',repeat('a',64),
     'sourceRenderJobId','59000000-0000-4000-8000-000000000001','sourcePreflightJobId','59000000-0000-4000-8000-000000000002'),
   null,'package-success','a9000000-0000-0000-0000-000000000001',now(),null),
  ('59000000-0000-4000-8000-000000000004','39000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001','kdp','succeeded',
   jsonb_build_object('action','validate','editionUpdatedAt','2026-09-04T00:00:00Z','bookModelSha256',repeat('a',64)),
   '{"ruleVersion":"core-1+kdp-1","requestedChannel":"kdp","channel":"kdp","errors":1,"warnings":0,"findings":[]}',
   'package-bad-preflight','a9000000-0000-0000-0000-000000000001',now(),now()),
  ('59000000-0000-4000-8000-000000000005','39000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001','kdp','running',
   jsonb_build_object('action','export_package','editionUpdatedAt','2026-09-04T00:00:00Z','bookModelSha256',repeat('a',64),
     'sourceRenderJobId','59000000-0000-4000-8000-000000000001','sourcePreflightJobId','59000000-0000-4000-8000-000000000004'),
   null,'package-invalid','a9000000-0000-0000-0000-000000000001',now(),null);

do $$
begin
  assert not has_function_privilege('anon', 'public.complete_publishing_package_job(uuid,jsonb,text,uuid,uuid)', 'execute'),
    'anon can complete publishing packages';
  assert not has_function_privilege('authenticated', 'public.complete_publishing_package_job(uuid,jsonb,text,uuid,uuid)', 'execute'),
    'authenticated can complete publishing packages';
  assert has_function_privilege('service_role', 'public.complete_publishing_package_job(uuid,jsonb,text,uuid,uuid)', 'execute'),
    'service role cannot complete publishing packages';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a9000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.complete_publishing_package_job(
      '59000000-0000-4000-8000-000000000003','{}','rules',
      '59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000002');
    assert false, 'authenticated completed a package';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare
  artifact jsonb := jsonb_build_object(
    'assetId','69000000-0000-4000-8000-000000000001',
    'name','Packaged Book · kdp export','type','publishing_package','role','publishing_package',
    'filename','kdp-export.zip',
    'storagePath','workspaces/29000000-0000-4000-8000-000000000001/assets/69000000-0000-4000-8000-000000000001/v1/kdp-export.zip',
    'mimeType','application/zip','sizeBytes',512,'checksum',repeat('b',64)
  );
  result public.publishing_jobs;
  asset_count integer;
  usage_count integer;
  activity_count integer;
begin
  select * into result from public.complete_publishing_package_job(
    '59000000-0000-4000-8000-000000000003',artifact,' core-1+kdp-1 ',
    '59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000002');
  assert result.status='succeeded' and result.response_json->>'submissionMode'='manual', 'package job did not complete';
  assert result.response_json->>'ruleVersion'='core-1+kdp-1', 'ruleset not stored';
  assert exists(select 1 from public.assets where id='69000000-0000-4000-8000-000000000001'
    and workspace_id='29000000-0000-4000-8000-000000000001' and type='publishing_package'
    and mime_type='application/zip' and created_by='a9000000-0000-0000-0000-000000000001'), 'package asset missing';
  assert exists(select 1 from public.asset_versions where asset_id='69000000-0000-4000-8000-000000000001'
    and version_number=1 and size_bytes=512 and checksum=repeat('b',64)), 'package version missing';
  assert exists(select 1 from public.asset_links where asset_id='69000000-0000-4000-8000-000000000001'
    and entity_type='edition' and entity_id='49000000-0000-4000-8000-000000000001'
    and usage_role='publishing_package'), 'package link missing';
  assert exists(select 1 from public.usage_events where publishing_job_id=result.id and meter='publishing'
    and organization_id='19000000-0000-4000-8000-000000000001' and quantity=1), 'publishing usage missing';
  assert exists(select 1 from public.activity_events where event_type='publishing_package_created'
    and entity_id='49000000-0000-4000-8000-000000000001' and payload_json->>'channel'='kdp'), 'package activity missing';

  select count(*) into asset_count from public.assets where id='69000000-0000-4000-8000-000000000001';
  select count(*) into usage_count from public.usage_events where publishing_job_id=result.id and meter='publishing';
  select count(*) into activity_count from public.activity_events where payload_json->>'publishingJobId'=result.id::text;
  perform public.complete_publishing_package_job(result.id,artifact,'other',
    '59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000002');
  assert asset_count=(select count(*) from public.assets where id='69000000-0000-4000-8000-000000000001'), 'replay duplicated asset';
  assert usage_count=(select count(*) from public.usage_events where publishing_job_id=result.id and meter='publishing'), 'replay duplicated usage';
  assert activity_count=(select count(*) from public.activity_events where payload_json->>'publishingJobId'=result.id::text), 'replay duplicated activity';

  begin
    perform public.complete_publishing_package_job(
      '59000000-0000-4000-8000-000000000005',
      jsonb_set(artifact,'{assetId}','"69000000-0000-4000-8000-000000000002"'),
      'core-1+kdp-1','59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000004');
    assert false, 'zero-error preflight was not required';
  exception when invalid_parameter_value then null;
  end;
  assert (select status='running' from public.publishing_jobs where id='59000000-0000-4000-8000-000000000005'),
    'invalid completion mutated the job';
  assert not exists(select 1 from public.assets where id='69000000-0000-4000-8000-000000000002'),
    'invalid completion left an asset';
end $$;
reset role;

rollback;
