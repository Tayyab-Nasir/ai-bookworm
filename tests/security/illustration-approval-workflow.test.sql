-- Illustration approval is bound to a clean current version and cannot be
-- bypassed through direct asset/approval/document-version table writes.
begin;

do $$
begin
  assert exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='assets' and column_name='requires_approval'
  ), 'illustration workflow migration must add assets.requires_approval';
  assert exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='approvals' and column_name='entity_version_number'
  ), 'illustration workflow migration must version-bind approvals';
  assert has_function_privilege('service_role','public.request_asset_approval(uuid,uuid,integer,uuid,uuid,uuid,text)','execute'),
    'service role must request version-bound asset review';
  assert has_function_privilege('service_role','public.resolve_asset_approval(uuid,uuid,text,text)','execute'),
    'service role must resolve version-bound asset review';
  assert not has_function_privilege('authenticated','public.request_asset_approval(uuid,uuid,integer,uuid,uuid,uuid,text)','execute'),
    'authenticated must not invoke the service-only asset review RPC';
  assert not has_function_privilege('authenticated','public.resolve_asset_approval(uuid,uuid,text,text)','execute'),
    'authenticated must not invoke the service-only review resolution RPC';
  assert not has_column_privilege('authenticated','public.assets','status','UPDATE'),
    'authenticated users must not directly approve or archive assets';
  assert not has_column_privilege('authenticated','public.assets','requires_approval','UPDATE'),
    'authenticated users must not disable required review';
  assert has_column_privilege('authenticated','public.assets','name','UPDATE'),
    'authors must still be able to rename assets';
end $$;

insert into auth.users(id,email) values
  ('a7200000-0000-4000-8000-000000000001','illustration-editor@local.test'),
  ('a7200000-0000-4000-8000-000000000002','illustration-reviewer@local.test'),
  ('a7200000-0000-4000-8000-000000000003','illustration-viewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('b7200000-0000-4000-8000-000000000001','Illustration Org','illustration-org','a7200000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('b7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000001','owner'),
  ('b7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002','member'),
  ('b7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000003','member');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('c7200000-0000-4000-8000-000000000001','b7200000-0000-4000-8000-000000000001','Illustration Workspace','illustration-ws','a7200000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('c7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000001','editor'),
  ('c7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002','reviewer'),
  ('c7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000003','viewer');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('d7200000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001','Illustrated Book','Author','a7200000-0000-4000-8000-000000000001');
insert into public.chapters(id,book_id,order_index,title) values
  ('e7200000-0000-4000-8000-000000000001','d7200000-0000-4000-8000-000000000001',0,'First Chapter');

-- A user cannot mark their own upload approved or opt it out of review.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,requires_approval,created_by)
values ('f7200000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001','illustration','Forest scene',
  'workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000001/v1/forest.png',
  'image/png',128,'pending','approved',false,'a7200000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
values ('f7200000-0000-4000-8000-000000000001',1,
  'workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000001/v1/forest.png',
  'pending','image/png',128,'a7200000-0000-4000-8000-000000000001');
do $$ begin
  assert exists(select 1 from public.assets where id='f7200000-0000-4000-8000-000000000001'
    and status='draft' and requires_approval), 'new user image must be draft and review-required';
  assert exists(select 1 from public.asset_versions where asset_id='f7200000-0000-4000-8000-000000000001'
    and scan_status='pending'), 'new user image must remain quarantined';
  begin
    update public.assets set status='approved' where id='f7200000-0000-4000-8000-000000000001';
    assert false, 'authenticated user changed asset review status';
  exception when insufficient_privilege then null; end;
  perform set_config('bookworm.asset_review_internal','on',true);
  begin
    update public.assets set status='approved' where id='f7200000-0000-4000-8000-000000000001';
    assert false, 'custom review setting bypassed the authenticated column grant';
  exception when insufficient_privilege then null; end;
  perform set_config('bookworm.asset_review_internal','',true);
  begin
    update public.assets set requires_approval=false where id='f7200000-0000-4000-8000-000000000001';
    assert false, 'authenticated user disabled required review';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.approvals(workspace_id,entity_type,entity_id,requested_by,reviewer_id,status,entity_version_number,request_key)
    values ('c7200000-0000-4000-8000-000000000001','asset','f7200000-0000-4000-8000-000000000001',
      auth.uid(),'a7200000-0000-4000-8000-000000000002','approved',1,
      '07200000-0000-4000-8000-000000000001');
    assert false, 'authenticated user directly created an approved asset decision';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Only the service scanner can confirm the upload. Confirmation does not approve it.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.record_asset_scan_verdict(
  'f7200000-0000-4000-8000-000000000001',1,'clean',repeat('a',64),'image/png',128,
  'bookworm-private-clamav','ClamAV/1.4.2/test',null
);
do $$ begin
  assert exists(select 1 from public.assets where id='f7200000-0000-4000-8000-000000000001'
    and checksum=repeat('a',64) and status='draft' and requires_approval),
    'clean scanner verdict must not bypass illustration review';
end $$;
reset role;

-- Unapproved required art cannot enter a document even through direct INSERT.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  begin
    insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values ('e7200000-0000-4000-8000-000000000001',1,
      '{"schemaVersion":"1.0","nodes":[{"id":"node-v1","type":"image","assetId":"f7200000-0000-4000-8000-000000000001","assetVersionNumber":1}]}'::jsonb,
      '',0,auth.uid());
    assert false, 'unapproved illustration entered a manuscript';
  exception when check_violation then null; end;
end $$;
reset role;

-- The service RPC validates distinct eligible members and one clean current version.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$
declare v_approval_id uuid; v_replay_id uuid;
begin
  begin
    perform public.request_asset_approval('c7200000-0000-4000-8000-000000000001',
      'f7200000-0000-4000-8000-000000000001',1,'a7200000-0000-4000-8000-000000000001',
      'a7200000-0000-4000-8000-000000000001','07200000-0000-4000-8000-000000000002','Self review');
    assert false, 'requester assigned review to themself';
  exception when check_violation then null; end;
  begin
    perform public.request_asset_approval('c7200000-0000-4000-8000-000000000001',
      'f7200000-0000-4000-8000-000000000001',2,'a7200000-0000-4000-8000-000000000001',
      'a7200000-0000-4000-8000-000000000002','07200000-0000-4000-8000-000000000003','Stale');
    assert false, 'stale version was submitted for approval';
  exception when check_violation then null; end;
  begin
    perform public.request_asset_approval('c7200000-0000-4000-8000-000000000001',
      'f7200000-0000-4000-8000-000000000001',1,'a7200000-0000-4000-8000-000000000001',
      'a7200000-0000-4000-8000-000000000003','07200000-0000-4000-8000-000000000004','Viewer review');
    assert false, 'viewer was assigned asset review';
  exception when insufficient_privilege then null; end;

  select id into v_approval_id from public.request_asset_approval(
    'c7200000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001',1,
    'a7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002',
    '07200000-0000-4000-8000-000000000005','Check composition');
  select id into v_replay_id from public.request_asset_approval(
    'c7200000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001',1,
    'a7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002',
    '07200000-0000-4000-8000-000000000005','Check composition');
  assert v_approval_id=v_replay_id, 'identical review retry created a duplicate';
  assert (select status from public.assets where id='f7200000-0000-4000-8000-000000000001')='in_review',
    'request did not transition the asset into review';
  begin
    perform public.request_asset_approval('c7200000-0000-4000-8000-000000000001',
      'f7200000-0000-4000-8000-000000000001',1,'a7200000-0000-4000-8000-000000000001',
      'a7200000-0000-4000-8000-000000000002','07200000-0000-4000-8000-000000000005','Different payload');
    assert false, 'idempotency key was reused for a different request';
  exception when unique_violation then null; end;

  begin
    perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000001','approve',null);
    assert false, 'requester resolved their own request';
  exception when insufficient_privilege then null; end;
  begin
    perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000002',null,null);
    assert false, 'null review action was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000002','reject','  ');
    assert false, 'rejection without a note was accepted';
  exception when check_violation then null; end;
  perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000002','reject','Adjust the lighting.');
  perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000002','reject','Adjust the lighting.');
  assert exists(select 1 from public.approvals where id=v_approval_id and status='rejected'
    and resolved_by='a7200000-0000-4000-8000-000000000002' and resolution_note='Adjust the lighting.'),
    'rejection did not persist reviewer and note';
end $$;
reset role;

-- Rejected content cannot re-enter review under a fresh key until its bytes
-- have been uploaded as a new immutable version.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$ begin
  begin
    perform public.request_asset_approval(
      'c7200000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001',1,
      'a7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002',
      '07200000-0000-4000-8000-000000000006','Unchanged rejected art');
    assert false, 'rejected artwork was re-requested without a new version';
  exception when check_violation then null; end;
end $$;
reset role;

-- A new clean version reopens review and can be approved independently.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
values ('f7200000-0000-4000-8000-000000000001',2,
  'workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000001/v2/forest.png',
  repeat('b',64),'image/png',128,'a7200000-0000-4000-8000-000000000001');
update public.assets set storage_path='workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000001/v2/forest.png',
  checksum=repeat('b',64),status='approved'
where id='f7200000-0000-4000-8000-000000000001';
do $$ begin
  assert exists(select 1 from public.assets where id='f7200000-0000-4000-8000-000000000001'
    and status='draft' and requires_approval), 'new version did not reopen review';
  assert exists(select 1 from public.approvals where entity_type='asset' and entity_id='f7200000-0000-4000-8000-000000000001'
    and entity_version_number=1 and status='rejected' and superseded_at is not null),
    'new version did not supersede the rejected decision';
end $$;
do $$
declare v_approval_id uuid;
begin
  select id into v_approval_id from public.request_asset_approval(
    'c7200000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001',2,
    'a7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002',
    '07200000-0000-4000-8000-000000000007','Revised artwork v2');
  perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000002','approve',null);
  perform public.resolve_asset_approval(v_approval_id,'a7200000-0000-4000-8000-000000000002','approve',null);
  assert exists(select 1 from public.assets where id='f7200000-0000-4000-8000-000000000001'
    and status='approved'), 'approval did not set asset status';
  assert exists(select 1 from public.approvals where id=v_approval_id
    and entity_version_number=2 and status='approved' and superseded_at is null),
    'new current version was not approved independently';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by)
values ('e7200000-0000-4000-8000-000000000001',1,
  '{"schemaVersion":"1.0","nodes":[{"id":"node-v2-approved","type":"image","assetId":"f7200000-0000-4000-8000-000000000001","assetVersionNumber":2}]}'::jsonb,
  '',0,auth.uid());
reset role;

-- Revision v3 reopens review, marks v2 decisions superseded, and blocks v2 pins.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
values ('f7200000-0000-4000-8000-000000000001',3,
  'workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000001/v3/forest.png',
  repeat('c',64),'image/png',128,'a7200000-0000-4000-8000-000000000001');
update public.assets set storage_path='workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000001/v3/forest.png',
  checksum=repeat('c',64),status='approved'
where id='f7200000-0000-4000-8000-000000000001';
do $$ begin
  assert exists(select 1 from public.assets where id='f7200000-0000-4000-8000-000000000001'
    and status='draft' and requires_approval), 'revision did not reopen review';
  assert exists(select 1 from public.approvals where entity_type='asset' and entity_id='f7200000-0000-4000-8000-000000000001'
    and entity_version_number=2 and status='approved' and superseded_at is not null),
    'revision did not mark the prior approval superseded';
end $$;
do $$
declare v_recovered public.approvals; v_count integer;
begin
  select count(*) into v_count from public.approvals
  where entity_type='asset' and entity_id='f7200000-0000-4000-8000-000000000001';
  select * into v_recovered from public.request_asset_approval(
    'c7200000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001',1,
    'a7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000002',
    '07200000-0000-4000-8000-000000000005','Check composition');
  assert v_recovered.entity_version_number=1 and v_recovered.status='rejected'
    and v_recovered.superseded_at is not null,
    'accepted request did not recover its original superseded decision after revision';
  assert (select count(*) from public.approvals where entity_type='asset'
    and entity_id='f7200000-0000-4000-8000-000000000001')=v_count,
    'recovery after revision created another approval';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  begin
    insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values ('e7200000-0000-4000-8000-000000000001',2,
      '{"schemaVersion":"1.0","nodes":[{"id":"node-stale","type":"image","assetId":"f7200000-0000-4000-8000-000000000001","assetVersionNumber":2}]}'::jsonb,
      '',0,auth.uid());
    assert false, 'stale illustration version remained placeable';
  exception when check_violation then null; end;
end $$;
reset role;

-- Legacy service-imported references remain valid without version pins or new approval.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
values ('f7200000-0000-4000-8000-000000000002','c7200000-0000-4000-8000-000000000001','illustration','Imported art',
  'workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000002/v1/imported.png',
  'image/png',128,repeat('c',64),'a7200000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
values ('f7200000-0000-4000-8000-000000000002',1,
  'workspaces/c7200000-0000-4000-8000-000000000001/assets/f7200000-0000-4000-8000-000000000002/v1/imported.png',
  repeat('c',64),'image/png',128,'a7200000-0000-4000-8000-000000000001');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by)
values ('e7200000-0000-4000-8000-000000000001',3,
  '{"schemaVersion":"1.0","nodes":[{"id":"node-imported","type":"image","assetId":"f7200000-0000-4000-8000-000000000002"}]}'::jsonb,
  '',0,auth.uid());
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
update public.assets set status='archived'
where id='f7200000-0000-4000-8000-000000000002';
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  begin
    insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values ('e7200000-0000-4000-8000-000000000001',4,
      '{"schemaVersion":"1.0","nodes":[{"id":"archived-art","type":"image","assetId":"f7200000-0000-4000-8000-000000000002"}]}'::jsonb,
      '',0,auth.uid());
    assert false, 'archived imported image remained placeable through direct database write';
  exception when check_violation then null; end;
end $$;
reset role;

rollback;
