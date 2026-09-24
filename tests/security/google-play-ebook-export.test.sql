-- Google Play Books export remains service-only, edition/source-bound, manual.
begin;

insert into auth.users(id,email) values
  ('ab000000-0000-4000-8000-000000000001','google-export@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('1b000000-0000-4000-8000-000000000001','Google Export Org','google-export-org','ab000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('1b000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('2b000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','Google Export Workspace','google-export-ws','ab000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('2b000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('3b000000-0000-4000-8000-000000000001','2b000000-0000-4000-8000-000000000001','Google Export Book','Author','ab000000-0000-4000-8000-000000000001');
insert into public.editions(id,book_id,type,language,updated_at) values
  ('4b000000-0000-4000-8000-000000000001','3b000000-0000-4000-8000-000000000001','ebook','en','2026-09-24T00:00:00Z');
insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,response_json,idempotency_key,created_by,started_at,completed_at) values
  ('5b000000-0000-4000-8000-000000000001','3b000000-0000-4000-8000-000000000001','4b000000-0000-4000-8000-000000000001','render','succeeded',
   jsonb_build_object('action','render','editionUpdatedAt','2026-09-24T00:00:00Z','bookModelSha256',repeat('a',64)),
   '{"artifacts":[],"rendererVersion":"test","usage":{}}','google-render','ab000000-0000-4000-8000-000000000001',now(),now()),
  ('5b000000-0000-4000-8000-000000000002','3b000000-0000-4000-8000-000000000001','4b000000-0000-4000-8000-000000000001','googleplay','running',
   '{"action":"validate"}',null,'google-preflight','ab000000-0000-4000-8000-000000000001',now(),null),
  ('5b000000-0000-4000-8000-000000000003','3b000000-0000-4000-8000-000000000001','4b000000-0000-4000-8000-000000000001','googleplay','running',
   jsonb_build_object('action','export_package','editionUpdatedAt','2026-09-24T00:00:00Z','bookModelSha256',repeat('a',64),
     'sourceRenderJobId','5b000000-0000-4000-8000-000000000001','sourcePreflightJobId','5b000000-0000-4000-8000-000000000002'),
   null,'google-package','ab000000-0000-4000-8000-000000000001',now(),null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"ab000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  begin
    perform public.complete_preflight_job('5b000000-0000-4000-8000-000000000002',
      '{"ruleVersion":"core+google-play","errors":0,"warnings":0,"findings":[]}'::jsonb);
    assert false, 'member completed Google preflight';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
select public.complete_preflight_job('5b000000-0000-4000-8000-000000000002',
  '{"ruleVersion":"core+google-play","channel":"googleplay","requestedChannel":"googleplay","errors":0,"warnings":0,"findings":[]}'::jsonb);
do $$
declare v_result public.publishing_jobs;
begin
  select * into v_result from public.complete_publishing_package_job(
    '5b000000-0000-4000-8000-000000000003',
    jsonb_build_object('assetId','6b000000-0000-4000-8000-000000000001',
      'name','Google export','type','publishing_package','role','publishing_package',
      'filename','googleplay-export.zip',
      'storagePath','workspaces/2b000000-0000-4000-8000-000000000001/assets/6b000000-0000-4000-8000-000000000001/v1/googleplay-export.zip',
      'mimeType','application/zip','sizeBytes',512,'checksum',repeat('b',64)),
    'core+google-play','5b000000-0000-4000-8000-000000000001','5b000000-0000-4000-8000-000000000002');
  assert v_result.status='succeeded' and v_result.channel='googleplay', 'Google package did not complete';
  assert v_result.response_json->>'submissionMode'='manual', 'Google package claimed submission';
  assert exists(select 1 from public.usage_events where publishing_job_id=v_result.id and meter='publishing' and quantity=1), 'publishing debit missing';
  assert exists(select 1 from public.assets where id='6b000000-0000-4000-8000-000000000001' and storage_path like '%/googleplay-export.zip'), 'private Google package missing';
end $$;
reset role;
rollback;
