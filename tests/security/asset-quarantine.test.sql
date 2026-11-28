-- Upload scan state is service-mediated, fail-closed, retryable after outage,
-- and terminal after a clean or infected verdict.
begin;

insert into auth.users(id,email) values
  ('a7200000-0000-4000-8000-000000000001','scan-editor@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('a7200000-0000-4000-8000-000000000002','Scan Org','scan-org','a7200000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('a7200000-0000-4000-8000-000000000002','a7200000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('a7200000-0000-4000-8000-000000000003','a7200000-0000-4000-8000-000000000002','Scan Workspace','scan-workspace','a7200000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('a7200000-0000-4000-8000-000000000003','a7200000-0000-4000-8000-000000000001','editor');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values
  ('a7200000-0000-4000-8000-000000000004','a7200000-0000-4000-8000-000000000003','manuscript','draft.txt',
   'workspaces/a7200000-0000-4000-8000-000000000003/assets/a7200000-0000-4000-8000-000000000004/v1/draft.txt',
   'text/plain',12,'pending','a7200000-0000-4000-8000-000000000001'),
  ('a7200000-0000-4000-8000-000000000005','a7200000-0000-4000-8000-000000000003','manuscript','infected.txt',
   'workspaces/a7200000-0000-4000-8000-000000000003/assets/a7200000-0000-4000-8000-000000000005/v1/infected.txt',
   'text/plain',13,'pending','a7200000-0000-4000-8000-000000000001');
insert into storage.objects(bucket_id,name) values
  ('book-assets','workspaces/a7200000-0000-4000-8000-000000000003/assets/a7200000-0000-4000-8000-000000000004/v1/draft.txt'),
  ('book-assets','workspaces/a7200000-0000-4000-8000-000000000003/assets/a7200000-0000-4000-8000-000000000005/v1/infected.txt');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,scan_status,created_by) values
  ('a7200000-0000-4000-8000-000000000004',1,
   'workspaces/a7200000-0000-4000-8000-000000000003/assets/a7200000-0000-4000-8000-000000000004/v1/draft.txt',
   'pending','text/plain',12,'clean','a7200000-0000-4000-8000-000000000001'),
  ('a7200000-0000-4000-8000-000000000005',1,
   'workspaces/a7200000-0000-4000-8000-000000000003/assets/a7200000-0000-4000-8000-000000000005/v1/infected.txt',
   'pending','text/plain',13,'clean','a7200000-0000-4000-8000-000000000001');
do $$
begin
  assert (select scan_status from public.asset_versions where asset_id='a7200000-0000-4000-8000-000000000004')='pending',
    'authenticated insert escaped quarantine';
  assert not exists(
    select 1 from storage.objects where name like '%a7200000-0000-4000-8000-000000000004%'
  ), 'pending upload is directly readable from storage';
  begin
    perform public.record_asset_scan_verdict(
      'a7200000-0000-4000-8000-000000000004',1,'clean',repeat('a',64),'text/plain',12,
      'clamav/1','engine-1',null
    );
    assert false, 'authenticated user recorded a clean verdict';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.asset_versions set scan_status='clean'
    where asset_id='a7200000-0000-4000-8000-000000000004';
    assert false, 'authenticated user directly marked an upload clean';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  assert not has_function_privilege('anon','public.record_asset_scan_verdict(uuid,integer,text,text,text,bigint,text,text,text)','execute'),
    'anon can record asset scans';
  assert not has_function_privilege('authenticated','public.record_asset_scan_verdict(uuid,integer,text,text,text,bigint,text,text,text)','execute'),
    'authenticated can record asset scans';
  assert has_function_privilege('service_role','public.record_asset_scan_verdict(uuid,integer,text,text,text,bigint,text,text,text)','execute'),
    'service role cannot record asset scans';
end $$;

set local role service_role;
do $$
declare
  result public.asset_versions;
begin
  select * into result from public.record_asset_scan_verdict(
    'a7200000-0000-4000-8000-000000000004',1,'error',repeat('a',64),'text/plain',12,
    'bookworm-private-clamav',null,'scanner_unavailable'
  );
  assert result.scan_status='error' and result.checksum='pending',
    'scanner outage did not remain quarantined and retryable';
  assert (select checksum from public.assets where id=result.asset_id)='pending',
    'scanner outage finalized the asset';

  select * into result from public.record_asset_scan_verdict(
    result.asset_id,1,'clean',repeat('a',64),'text/plain',12,
    'bookworm-private-clamav','ClamAV/1.4.2/27888',null
  );
  assert result.scan_status='clean' and result.checksum=repeat('a',64),
    'clean retry did not finalize the version';
  assert exists(
    select 1 from public.assets where id=result.asset_id and checksum=repeat('a',64)
      and mime_type='text/plain' and size_bytes=12
  ), 'clean verdict did not promote the scanned version';

  select * into result from public.record_asset_scan_verdict(
    'a7200000-0000-4000-8000-000000000005',1,'infected',repeat('b',64),'text/plain',13,
    'bookworm-private-clamav','Win.Test.EICAR_HDB-1','malware_detected'
  );
  assert result.scan_status='infected' and result.checksum=repeat('b',64),
    'infected verdict was not terminal';
  assert (select checksum from public.assets where id=result.asset_id)='pending',
    'infected version became downloadable';
  begin
    perform public.record_asset_scan_verdict(
      result.asset_id,1,'clean',repeat('b',64),'text/plain',13,
      'bookworm-private-clamav','ClamAV/1.4.2/27888',null
    );
    assert false, 'infected verdict was overwritten';
  exception when serialization_failure then null;
  end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
begin
  assert exists(
    select 1 from storage.objects where name like '%a7200000-0000-4000-8000-000000000004%'
  ), 'clean upload is not readable to its workspace';
  assert not exists(
    select 1 from storage.objects where name like '%a7200000-0000-4000-8000-000000000005%'
  ), 'infected upload is directly readable from storage';
end $$;
reset role;

rollback;
