begin;
do $$ declare r text; f text; begin
  assert (select relrowsecurity from pg_class where oid='bookworm_private.asset_lifecycle_receipts'::regclass);
  foreach r in array array['anon','authenticated','service_role'] loop
    assert not has_table_privilege(r,'bookworm_private.asset_lifecycle_receipts','select');
    assert not has_table_privilege(r,'bookworm_private.asset_lifecycle_receipts','insert');
    foreach f in array array['public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','public.asset_lifecycle_status(uuid,uuid,uuid)','public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'] loop
      assert not has_function_privilege(r,f,'execute'), 'Additive stage must not activate lifecycle RPCs';
    end loop;
  end loop;
end $$;
insert into auth.users(id,email) values ('aa920000-0000-4000-8000-000000000001','asset-additive@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values ('bb920000-0000-4000-8000-000000000001','Fixture','asset-additive','aa920000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values ('cc920000-0000-4000-8000-000000000001','bb920000-0000-4000-8000-000000000001','Fixture','asset-additive','aa920000-0000-4000-8000-000000000001');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by,lifecycle_revision)
values ('dd920000-0000-4000-8000-000000000001','cc920000-0000-4000-8000-000000000001','illustration','image','workspaces/cc920000-0000-4000-8000-000000000001/assets/dd920000-0000-4000-8000-000000000001/v1/a.png','image/png',10,repeat('a',64),'draft','aa920000-0000-4000-8000-000000000001','ee920000-0000-4000-8000-000000000001');
do $$ begin
  assert (select lifecycle_revision is not null and lifecycle_revision <> 'ee920000-0000-4000-8000-000000000001'::uuid from public.assets where id='dd920000-0000-4000-8000-000000000001');
end $$;
select set_config('test.before_revision',(select lifecycle_revision::text from public.assets where id='dd920000-0000-4000-8000-000000000001'),true);
set local role service_role;
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,created_by)
values ('dd920000-0000-4000-8000-000000000001',1,'workspaces/cc920000-0000-4000-8000-000000000001/assets/dd920000-0000-4000-8000-000000000001/v1/a.png','pending','aa920000-0000-4000-8000-000000000001');
reset role;
do $$ begin
  assert (select lifecycle_revision::text <> current_setting('test.before_revision') from public.assets where id='dd920000-0000-4000-8000-000000000001'), 'Allocating a version must invalidate pending removals';
end $$;
select set_config('test.before_revision',(select lifecycle_revision::text from public.assets where id='dd920000-0000-4000-8000-000000000001'),true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.record_asset_scan_verdict('dd920000-0000-4000-8000-000000000001',1,'clean',repeat('b',64),'image/png',10,'fixture','fixture-signature',null);
reset role;
do $$ begin
  assert (select lifecycle_revision::text <> current_setting('test.before_revision') from public.assets where id='dd920000-0000-4000-8000-000000000001'), 'Finalizing a version must invalidate pending removals';
end $$;
select set_config('test.before_revision',(select lifecycle_revision::text from public.assets where id='dd920000-0000-4000-8000-000000000001'),true);
set local role service_role;
update public.assets set checksum=repeat('c',64) where id='dd920000-0000-4000-8000-000000000001';
reset role;
do $$ begin
  assert (select lifecycle_revision::text <> current_setting('test.before_revision') from public.assets where id='dd920000-0000-4000-8000-000000000001'), 'Changing current bytes must invalidate pending removals';
end $$;
select set_config('test.before_revision',(select lifecycle_revision::text from public.assets where id='dd920000-0000-4000-8000-000000000001'),true);
set local role service_role;
update public.assets set status='archived', deleted_at=now() where id='dd920000-0000-4000-8000-000000000001';
reset role;
do $$ begin
  assert (select lifecycle_revision::text <> current_setting('test.before_revision') from public.assets where id='dd920000-0000-4000-8000-000000000001');
end $$;
select set_config('test.deleted_revision',(select lifecycle_revision::text from public.assets where id='dd920000-0000-4000-8000-000000000001'),true);
set local role service_role;
update public.assets set status='draft', deleted_at=null where id='dd920000-0000-4000-8000-000000000001';
do $$ begin
  begin
    update public.assets set lifecycle_revision='ee920000-0000-4000-8000-000000000001' where id='dd920000-0000-4000-8000-000000000001';
    raise exception 'Direct lifecycle revision reset succeeded';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select lifecycle_revision::text <> current_setting('test.deleted_revision') from public.assets where id='dd920000-0000-4000-8000-000000000001');
end $$;
set local role service_role;
delete from public.assets where id='dd920000-0000-4000-8000-000000000001';
reset role;
do $$ begin
  assert not exists(select 1 from public.asset_versions where asset_id='dd920000-0000-4000-8000-000000000001'), 'Legacy cleanup cascade must still work';
end $$;
rollback;
