-- Clients cannot hard-delete assets and their version history. Server cleanup
-- remains available; the test operates only on synthetic rows and rolls back.
begin;

insert into auth.users(id, email) values
  ('f5100000-0000-4000-8000-000000000001', 'delete-owner@local.test'),
  ('f5100000-0000-4000-8000-000000000002', 'delete-editor@local.test');

insert into public.organizations(id, name, slug, owner_user_id) values
  ('f5200000-0000-4000-8000-000000000001', 'Delete guard', 'delete-guard', 'f5100000-0000-4000-8000-000000000001');
insert into public.workspaces(id, organization_id, name, slug, created_by) values
  ('f5300000-0000-4000-8000-000000000001', 'f5200000-0000-4000-8000-000000000001', 'Delete guard', 'delete-guard', 'f5100000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id, user_id, role) values
  ('f5200000-0000-4000-8000-000000000001', 'f5100000-0000-4000-8000-000000000001', 'owner');
insert into public.workspace_members(workspace_id, user_id, role) values
  ('f5300000-0000-4000-8000-000000000001', 'f5100000-0000-4000-8000-000000000001', 'owner'),
  ('f5300000-0000-4000-8000-000000000001', 'f5100000-0000-4000-8000-000000000002', 'editor');
insert into public.assets(id, workspace_id, type, name, storage_path, mime_type, checksum, created_by) values
  ('f5400000-0000-4000-8000-000000000001', 'f5300000-0000-4000-8000-000000000001', 'image', 'Protected', 'fixture/protected.png', 'image/png', 'pending', 'f5100000-0000-4000-8000-000000000001'),
  ('f5400000-0000-4000-8000-000000000002', 'f5300000-0000-4000-8000-000000000001', 'image', 'Failed upload', 'fixture/cleanup.png', 'image/png', 'pending', 'f5100000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id, version_number, storage_path, checksum, created_by) values
  ('f5400000-0000-4000-8000-000000000001', 1, 'fixture/protected.png', 'pending', 'f5100000-0000-4000-8000-000000000001'),
  ('f5400000-0000-4000-8000-000000000002', 1, 'fixture/cleanup.png', 'pending', 'f5100000-0000-4000-8000-000000000001');

do $$ begin
  assert not has_table_privilege('anon', 'public.assets', 'delete'), 'anonymous DELETE privilege remains';
  assert not has_table_privilege('authenticated', 'public.assets', 'delete'), 'authenticated DELETE privilege remains';
  assert has_table_privilege('service_role', 'public.assets', 'delete'), 'service cleanup privilege removed';
  assert not exists (select 1 from pg_policies where schemaname='public' and tablename='assets' and policyname='assets_delete'), 'legacy hard-delete policy remains';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"f5100000-0000-4000-8000-000000000002"}';
do $$ begin
  assert exists(select 1 from public.assets where id='f5400000-0000-4000-8000-000000000001'), 'editor cannot read fixture';
  begin
    delete from public.assets where id='f5400000-0000-4000-8000-000000000001';
    assert false, 'editor can directly hard-delete asset';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims = '{"sub":"f5100000-0000-4000-8000-000000000001"}';
do $$ begin
  begin
    delete from public.assets where id='f5400000-0000-4000-8000-000000000001';
    assert false, 'owner can directly hard-delete asset';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ begin
  assert exists(select 1 from public.assets where id='f5400000-0000-4000-8000-000000000001'), 'asset disappeared';
  assert exists(select 1 from public.asset_versions where asset_id='f5400000-0000-4000-8000-000000000001'), 'asset version disappeared';
end $$;

set local role service_role;
delete from public.assets where id='f5400000-0000-4000-8000-000000000002';
reset role;
do $$ begin
  assert not exists(select 1 from public.assets where id='f5400000-0000-4000-8000-000000000002'), 'service cleanup failed';
  assert not exists(select 1 from public.asset_versions where asset_id='f5400000-0000-4000-8000-000000000002'), 'service cleanup did not cascade';
end $$;

rollback;
