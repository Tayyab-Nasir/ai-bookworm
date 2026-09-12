-- Render completion is service-only, tenant-derived, atomic, and idempotent.
begin;

insert into auth.users(id,email) values
  ('a7000000-0000-0000-0000-000000000001','render-editor@local.test'),
  ('b7000000-0000-0000-0000-000000000001','other-render-editor@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('12000000-0000-4000-8000-000000000001','Render Org','render-org','a7000000-0000-0000-0000-000000000001'),
  ('12000000-0000-4000-8000-000000000002','Other Render Org','other-render-org','b7000000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('12000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000001','owner'),
  ('12000000-0000-4000-8000-000000000002','b7000000-0000-0000-0000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Render Workspace','render-ws','a7000000-0000-0000-0000-000000000001'),
  ('22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002','Other Render Workspace','other-render-ws','b7000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('22000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000001','editor'),
  ('22000000-0000-4000-8000-000000000002','b7000000-0000-0000-0000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('32000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','Rendered Book','Author','a7000000-0000-0000-0000-000000000001');
insert into public.editions(id,book_id,type,language) values
  ('42000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001','ebook','en');
insert into public.publishing_jobs(
  id,book_id,edition_id,channel,status,idempotency_key,created_by,started_at
) values
  ('52000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001','render','running','render-success','a7000000-0000-0000-0000-000000000001',now()),
  ('52000000-0000-4000-8000-000000000002','32000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001','render','running','render-invalid','a7000000-0000-0000-0000-000000000001',now());

do $$
begin
  assert not has_function_privilege('anon', 'public.complete_render_job(uuid,jsonb,text,jsonb)', 'execute'),
    'anon can complete render jobs';
  assert not has_function_privilege('authenticated', 'public.complete_render_job(uuid,jsonb,text,jsonb)', 'execute'),
    'authenticated can complete render jobs';
  assert has_function_privilege('service_role', 'public.complete_render_job(uuid,jsonb,text,jsonb)', 'execute'),
    'service role cannot complete render jobs';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.complete_render_job(
      '52000000-0000-4000-8000-000000000001',
      jsonb_build_array(jsonb_build_object(
        'assetId','62000000-0000-4000-8000-000000000001',
        'name','Rendered Book.epub',
        'type','rendered_book',
        'role','rendered_ebook',
        'filename','book.epub',
        'storagePath','workspaces/22000000-0000-4000-8000-000000000001/assets/62000000-0000-4000-8000-000000000001/v1/book.epub',
        'mimeType','application/epub+zip',
        'sizeBytes',256,
        'checksum',repeat('a',64)
      )),
      'renderer-test-1',
      '{}'
    );
    assert false, 'authenticated role completed render job';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare
  artifacts jsonb := jsonb_build_array(
    jsonb_build_object(
      'assetId','62000000-0000-4000-8000-000000000001',
      'name','Rendered Book.epub',
      'type','rendered_book',
      'role','rendered_ebook',
      'filename','book.epub',
      'storagePath','workspaces/22000000-0000-4000-8000-000000000001/assets/62000000-0000-4000-8000-000000000001/v1/book.epub',
      'mimeType','application/epub+zip',
      'sizeBytes',256,
      'checksum',repeat('a',64)
    ),
    jsonb_build_object(
      'assetId','62000000-0000-4000-8000-000000000002',
      'name','Rendered cover',
      'type','rendered_cover',
      'role','rendered_cover',
      'filename','cover.png',
      'storagePath','workspaces/22000000-0000-4000-8000-000000000001/assets/62000000-0000-4000-8000-000000000002/v1/cover.png',
      'mimeType','image/png',
      'sizeBytes',128,
      'checksum',repeat('b',64)
    )
  );
  result public.publishing_jobs;
  asset_count integer;
  version_count integer;
  link_count integer;
  usage_count integer;
  activity_count integer;
begin
  select * into result from public.complete_render_job(
    '52000000-0000-4000-8000-000000000001', artifacts, ' renderer-test-1 ',
    '{"renderMs":42,"pageCount":12}'
  );

  assert result.status='succeeded' and result.completed_at is not null, 'render job not completed';
  assert result.response_json->>'rendererVersion'='renderer-test-1', 'renderer result missing or untrimmed';
  assert jsonb_array_length(result.response_json->'artifacts')=2, 'artifact response missing';
  assert result.response_json->'usage'='{"renderMs":42,"pageCount":12}'::jsonb, 'render usage response missing';
  assert (select count(*) from public.assets where id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  ))=2, 'render assets missing';
  assert not exists(
    select 1 from public.assets where id in (
      '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
    ) and (workspace_id<>'22000000-0000-4000-8000-000000000001'
      or created_by<>'a7000000-0000-0000-0000-000000000001')
  ), 'render assets not scoped from book and job';
  assert exists(
    select 1 from public.asset_versions
    where asset_id='62000000-0000-4000-8000-000000000001' and version_number=1
      and mime_type='application/epub+zip' and size_bytes=256 and checksum=repeat('a',64)
  ), 'rendered book version missing metadata';
  assert exists(
    select 1 from public.asset_versions
    where asset_id='62000000-0000-4000-8000-000000000002' and version_number=1
      and mime_type='image/png' and size_bytes=128 and checksum=repeat('b',64)
  ), 'rendered cover version missing metadata';
  assert exists(
    select 1 from public.asset_links
    where asset_id='62000000-0000-4000-8000-000000000001'
      and entity_type='book' and entity_id='32000000-0000-4000-8000-000000000001'
      and usage_role='rendered_ebook'
  ), 'rendered book link missing';
  assert exists(
    select 1 from public.asset_links
    where asset_id='62000000-0000-4000-8000-000000000002'
      and entity_type='book' and entity_id='32000000-0000-4000-8000-000000000001'
      and usage_role='rendered_cover'
  ), 'rendered cover link missing';
  assert exists(
    select 1 from public.usage_events
    where publishing_job_id=result.id
      and organization_id='12000000-0000-4000-8000-000000000001'
      and workspace_id='22000000-0000-4000-8000-000000000001'
      and user_id='a7000000-0000-0000-0000-000000000001'
      and meter='rendering' and quantity=1
      and metadata_json->>'editionId'='42000000-0000-4000-8000-000000000001'
      and metadata_json->>'rendererVersion'='renderer-test-1'
  ), 'render usage missing or not tenant-scoped';
  assert exists(
    select 1 from public.activity_events
    where workspace_id='22000000-0000-4000-8000-000000000001'
      and actor_id='a7000000-0000-0000-0000-000000000001'
      and event_type='edition_rendered' and entity_type='edition'
      and entity_id='42000000-0000-4000-8000-000000000001'
      and payload_json->>'artifactCount'='2'
  ), 'render activity missing or not tenant-scoped';

  select count(*) into asset_count from public.assets where id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  );
  select count(*) into version_count from public.asset_versions where asset_id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  );
  select count(*) into link_count from public.asset_links where asset_id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  );
  select count(*) into usage_count from public.usage_events where publishing_job_id=result.id and meter='rendering';
  select count(*) into activity_count from public.activity_events
    where event_type='edition_rendered' and payload_json->>'publishingJobId'=result.id::text;
  perform public.complete_render_job(result.id, artifacts, 'renderer-test-1', '{"renderMs":42,"pageCount":12}');
  assert asset_count=(select count(*) from public.assets where id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  )), 'retry duplicated assets';
  assert version_count=(select count(*) from public.asset_versions where asset_id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  )), 'retry duplicated versions';
  assert link_count=(select count(*) from public.asset_links where asset_id in (
    '62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'
  )), 'retry duplicated links';
  assert usage_count=(select count(*) from public.usage_events where publishing_job_id=result.id and meter='rendering'),
    'retry duplicated usage';
  assert activity_count=(select count(*) from public.activity_events
    where event_type='edition_rendered' and payload_json->>'publishingJobId'=result.id::text),
    'retry duplicated activity';

  begin
    perform public.complete_render_job(
      '52000000-0000-4000-8000-000000000002',
      jsonb_build_array(
        jsonb_build_object(
          'assetId','62000000-0000-4000-8000-000000000003',
          'name','First valid artifact',
          'type','rendered_book',
          'role','rendered_ebook',
          'filename','first.epub',
          'storagePath','workspaces/22000000-0000-4000-8000-000000000001/assets/62000000-0000-4000-8000-000000000003/v1/first.epub',
          'mimeType','application/epub+zip',
          'sizeBytes',64,
          'checksum',repeat('c',64)
        ),
        jsonb_build_object(
          'assetId','62000000-0000-4000-8000-000000000004',
          'name','Cross-tenant artifact',
          'type','rendered_cover',
          'role','rendered_cover',
          'filename','cover.png',
          'storagePath','workspaces/22000000-0000-4000-8000-000000000002/assets/62000000-0000-4000-8000-000000000004/v1/cover.png',
          'mimeType','image/png',
          'sizeBytes',64,
          'checksum',repeat('d',64)
        )
      ),
      'renderer-test-1','{}'
    );
    assert false, 'invalid cross-tenant artifact completed render job';
  exception when invalid_parameter_value then null;
  end;
  assert (select status from public.publishing_jobs where id='52000000-0000-4000-8000-000000000002')='running',
    'failed completion changed job';
  assert not exists(select 1 from public.assets where id in (
    '62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000004'
  )), 'failed completion left assets';
  assert not exists(select 1 from public.asset_versions where asset_id in (
    '62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000004'
  )), 'failed completion left versions';
  assert not exists(select 1 from public.asset_links where asset_id in (
    '62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000004'
  )), 'failed completion left links';
  assert not exists(select 1 from public.usage_events where publishing_job_id='52000000-0000-4000-8000-000000000002'),
    'failed completion charged usage';
  assert not exists(select 1 from public.activity_events
    where payload_json->>'publishingJobId'='52000000-0000-4000-8000-000000000002'),
    'failed completion left activity';
end $$;
reset role;

rollback;
