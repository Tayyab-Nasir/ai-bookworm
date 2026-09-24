-- Generated-image completion is service-only, tenant-scoped, atomic, and idempotent.
begin;

insert into auth.users(id,email) values
  ('a6000000-0000-0000-0000-000000000001','image-editor@local.test'),
  ('a6000000-0000-0000-0000-000000000002','image-second-editor@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('11000000-0000-4000-8000-000000000001','Image Org','image-org','a6000000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('11000000-0000-4000-8000-000000000001','a6000000-0000-0000-0000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('21000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Image Workspace','image-ws','a6000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('21000000-0000-4000-8000-000000000001','a6000000-0000-0000-0000-000000000001','editor'),
  ('21000000-0000-4000-8000-000000000001','a6000000-0000-0000-0000-000000000002','editor');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
  ('71000000-0000-4000-8000-000000000001','Image test','month',1000,'{"image_credits_monthly":5}');
insert into public.subscriptions(organization_id,plan_id,status) values
  ('11000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','active');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('31000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','Image Book','Author','a6000000-0000-0000-0000-000000000001');
insert into public.folders(id,workspace_id,name,created_by) values
  ('41000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','Illustrations','a6000000-0000-0000-0000-000000000001');
insert into public.ai_jobs(
  id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by
) values
  ('51000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','illustrator','running','{"size":"1024x1024","quality":"medium"}','image-success','a6000000-0000-0000-0000-000000000001'),
  ('51000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','illustrator','running','{"size":"1024x1024","quality":"low"}','image-invalid','a6000000-0000-0000-0000-000000000002');

do $$
begin
  assert not has_function_privilege('anon', 'public.complete_image_job(uuid,uuid,text,text,uuid,text,text,bigint,text,text,text,text,jsonb)', 'execute'),
    'anon can complete image jobs';
  assert not has_function_privilege('authenticated', 'public.complete_image_job(uuid,uuid,text,text,uuid,text,text,bigint,text,text,text,text,jsonb)', 'execute'),
    'authenticated can complete image jobs';
  assert has_function_privilege('service_role', 'public.complete_image_job(uuid,uuid,text,text,uuid,text,text,bigint,text,text,text,text,jsonb)', 'execute'),
    'service role cannot complete image jobs';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.complete_image_job(
      '51000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','Scene','illustration',null,
      'workspaces/21000000-0000-4000-8000-000000000001/assets/61000000-0000-4000-8000-000000000001/v1/generated.png',
      'image/png',8,repeat('a',64),'illustration','mock','mock-image','{}'
    );
    assert false, 'authenticated role completed an image job';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare
  result public.ai_jobs;
  asset_count integer;
  run_count integer;
  usage_count integer;
begin
  select * into result from public.complete_image_job(
    '51000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','Forest scene','illustration','41000000-0000-4000-8000-000000000001',
    'workspaces/21000000-0000-4000-8000-000000000001/assets/61000000-0000-4000-8000-000000000001/v1/generated.png',
    'image/png',128,repeat('a',64),'illustration','mock','mock-image',
    '{"inputTokens":12,"outputTokens":34,"estimatedCostUsd":0,"latencyMs":56}'
  );
  assert result.status='succeeded' and result.output_ref->>'assetId'='61000000-0000-4000-8000-000000000001', 'image job not completed';
  assert exists(
    select 1 from public.assets where id='61000000-0000-4000-8000-000000000001'
      and workspace_id='21000000-0000-4000-8000-000000000001' and type='illustration'
      and size_bytes=128 and checksum=repeat('a',64)
  ), 'generated asset missing';
  assert exists(
    select 1 from public.asset_versions where asset_id='61000000-0000-4000-8000-000000000001'
      and version_number=1 and mime_type='image/png' and size_bytes=128
      and scan_status='trusted_generated'
  ), 'immutable generated version missing metadata';
  assert exists(
    select 1 from public.asset_links where asset_id='61000000-0000-4000-8000-000000000001'
      and entity_type='book' and entity_id='31000000-0000-4000-8000-000000000001' and usage_role='illustration'
  ), 'book link missing';
  assert exists(
    select 1 from public.usage_events where ai_job_id=result.id and meter='image_credits' and quantity=1
      and organization_id='11000000-0000-4000-8000-000000000001'
  ), 'image usage missing or incorrectly scoped';
  assert exists(
    select 1 from public.ai_runs where ai_job_id=result.id and provider='mock' and model='mock-image'
      and tokens_in=12 and tokens_out=34 and latency_ms=56
  ), 'image model run missing';

  select count(*) into asset_count from public.assets where id='61000000-0000-4000-8000-000000000001';
  select count(*) into run_count from public.ai_runs where ai_job_id=result.id;
  select count(*) into usage_count from public.usage_events where ai_job_id=result.id and meter='image_credits';
  perform public.complete_image_job(
    result.id,'61000000-0000-4000-8000-000000000001','Forest scene','illustration','41000000-0000-4000-8000-000000000001',
    'workspaces/21000000-0000-4000-8000-000000000001/assets/61000000-0000-4000-8000-000000000001/v1/generated.png',
    'image/png',128,repeat('a',64),'illustration','mock','mock-image',
    '{"inputTokens":12,"outputTokens":34,"estimatedCostUsd":0,"latencyMs":56}'
  );
  assert asset_count=(select count(*) from public.assets where id='61000000-0000-4000-8000-000000000001'), 'retry duplicated asset';
  assert run_count=(select count(*) from public.ai_runs where ai_job_id=result.id), 'retry duplicated run';
  assert usage_count=(select count(*) from public.usage_events where ai_job_id=result.id and meter='image_credits'), 'retry duplicated usage';

  begin
    perform public.complete_image_job(
      '51000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','Bad scene','illustration','41000000-0000-4000-8000-000000000001',
      'workspaces/21000000-0000-4000-8000-000000000001/assets/61000000-0000-4000-8000-000000000002/v1/wrong.png',
      'image/png',128,repeat('b',64),'illustration','mock','mock-image','{}'
    );
    assert false, 'invalid storage path completed image job';
  exception when invalid_parameter_value then null;
  end;
  assert (select status from public.ai_jobs where id='51000000-0000-4000-8000-000000000002')='running', 'failed completion changed job';
  assert not exists(select 1 from public.assets where id='61000000-0000-4000-8000-000000000002'), 'failed completion left asset';
  assert not exists(select 1 from public.usage_events where ai_job_id='51000000-0000-4000-8000-000000000002'), 'failed completion charged usage';
end $$;
reset role;

-- Finalization rechecks revoked permissions and the remaining monthly quota.
update public.workspace_members set role='viewer'
where workspace_id='21000000-0000-4000-8000-000000000001';
set local role service_role;
do $$
begin
  begin
    perform public.complete_image_job(
      '51000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','Recovery','illustration',null,
      'workspaces/21000000-0000-4000-8000-000000000001/assets/61000000-0000-4000-8000-000000000002/v1/generated.png',
      'image/png',128,repeat('b',64),'illustration','mock','mock-image',
      '{"inputTokens":12,"outputTokens":34,"estimatedCostUsd":0,"latencyMs":56}');
    raise exception 'revoked editor completed image';
  exception when insufficient_privilege then
    assert sqlerrm='image creator can no longer edit this workspace';
  end;
  assert not exists(select 1 from public.assets where id='61000000-0000-4000-8000-000000000002');
end $$;
reset role;
update public.workspace_members set role='editor'
where workspace_id='21000000-0000-4000-8000-000000000001';
insert into public.usage_events(organization_id,user_id,workspace_id,meter,quantity)
values ('11000000-0000-4000-8000-000000000001','a6000000-0000-0000-0000-000000000001',
  '21000000-0000-4000-8000-000000000001','image_credits',4);
set local role service_role;
do $$
begin
  begin
    perform public.complete_image_job(
      '51000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','Recovery','illustration',null,
      'workspaces/21000000-0000-4000-8000-000000000001/assets/61000000-0000-4000-8000-000000000002/v1/generated.png',
      'image/png',128,repeat('b',64),'illustration','mock','mock-image',
      '{"inputTokens":12,"outputTokens":34,"estimatedCostUsd":0,"latencyMs":56}');
    raise exception 'exhausted credits completed image';
  exception when check_violation then
    assert sqlerrm='image credit quota exceeded at completion';
  end;
  assert (select status from public.ai_jobs where id='51000000-0000-4000-8000-000000000002')='running';
  assert not exists(select 1 from public.assets where id='61000000-0000-4000-8000-000000000002');
  assert not exists(select 1 from public.usage_events where ai_job_id='51000000-0000-4000-8000-000000000002');
end $$;
reset role;
rollback;
