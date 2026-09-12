-- Role-level regression tests: forged storage pointers, parent moves, immutable
-- versions, attribution and Book Bible permissions. Uses real PostgreSQL RLS.
begin;
create temp table boundary_ids (ws_a uuid, ws_b uuid, book_a uuid, book_a2 uuid,
  bible_a uuid, folder_a uuid, asset_a uuid, asset_b uuid, path_a text) on commit drop;
grant select on boundary_ids to authenticated, service_role;
insert into auth.users(id,email) values
  ('a2000000-0000-0000-0000-000000000001','boundary-a@local.test'),
  ('b2000000-0000-0000-0000-000000000001','boundary-b@local.test'),
  ('c2000000-0000-0000-0000-000000000001','boundary-viewer@local.test');
do $$
declare
  a uuid := 'a2000000-0000-0000-0000-000000000001';
  b uuid := 'b2000000-0000-0000-0000-000000000001';
  org_a uuid; org_b uuid; wa uuid; wb uuid; ba uuid; ba2 uuid; bible uuid; folder uuid;
  asset uuid := gen_random_uuid(); other_asset uuid := gen_random_uuid(); path text;
begin
  insert into public.organizations(name,slug,owner_user_id) values('Boundary A','boundary-a',a) returning id into org_a;
  insert into public.organizations(name,slug,owner_user_id) values('Boundary B','boundary-b',b) returning id into org_b;
  insert into public.workspaces(organization_id,name,slug,created_by) values(org_a,'A','a',a) returning id into wa;
  insert into public.workspaces(organization_id,name,slug,created_by) values(org_b,'B','b',b) returning id into wb;
  insert into public.organization_members(organization_id,user_id,role) values(org_a,a,'owner'),(org_b,b,'owner');
  insert into public.workspace_members(workspace_id,user_id,role) values
    (wa,a,'owner'),(wb,b,'owner'),(wb,a,'editor'),(wa,'c2000000-0000-0000-0000-000000000001','viewer');
  insert into public.books(workspace_id,title,author_name,created_by) values(wa,'Private A','A',a) returning id into ba;
  insert into public.books(workspace_id,title,author_name,created_by) values(wa,'Other A','A',a) returning id into ba2;
  insert into public.book_bible_items(book_id,type,name) values(ba,'character','Private character') returning id into bible;
  insert into public.book_metadata(book_id,description) values(ba,'Private description');
  insert into public.folders(workspace_id,name,created_by) values(wa,'Private folder',a) returning id into folder;
  path := 'workspaces/'||wa||'/assets/'||asset||'/v1/private.png';
  insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,checksum,created_by)
    values(asset,wa,'image','Private',path,'image/png','pending',a);
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
    values(asset,1,path,'pending','image/png',8,a);
  insert into storage.objects(bucket_id,name) values('book-assets',path);
  insert into boundary_ids values(wa,wb,ba,ba2,bible,folder,asset,other_asset,path);
end $$;

set local role service_role;
select public.record_asset_scan_verdict(
  asset_a,1,'clean',repeat('a',64),'image/png',8,
  'fixture-clamav','ClamAV/fixture/1',null
) from boundary_ids;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000001"}';
do $$
declare v boundary_ids; n int; forged_path text;
begin
  select * into strict v from boundary_ids;
  assert not exists(select 1 from public.book_bible_items where id=v.bible_a), 'unrelated user can read Book Bible';
  assert not exists(select 1 from public.book_metadata where book_id=v.book_a), 'unrelated user can read metadata';
  -- The attacker knows the target object path. Own asset metadata must not
  -- confer access to that path by aliasing it into their own workspace.
  insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,checksum,created_by)
    values(v.asset_b,v.ws_b,'image','Alias',v.path_a,'image/png',repeat('b',64),auth.uid());
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,created_by)
    values(v.asset_b,1,v.path_a,'pending',auth.uid());
  assert not exists(select 1 from storage.objects where name=v.path_a), 'forged own asset leaks another tenant storage object';
  forged_path := replace(v.path_a, '/v1/private.png', '/v2/stolen.png');
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,created_by)
    values(v.asset_b,2,forged_path,'pending',auth.uid());
  begin
    insert into storage.objects(bucket_id,name) values('book-assets',forged_path);
    assert false, 'forged asset version allows cross-tenant storage upload';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.folders(workspace_id,parent_folder_id,name,created_by)
      values(v.ws_b,v.folder_a,'Cross-parent',auth.uid());
    assert false, 'folder can attach to another tenant parent';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.books(workspace_id,title,author_name,created_by)
      values(v.ws_b,'Spoofed','B','a2000000-0000-0000-0000-000000000001');
    assert false, 'creator attribution may be spoofed';
  exception when insufficient_privilege then null; end;
  delete from public.book_bible_items where id=v.bible_a;
  get diagnostics n = row_count;
  assert n=0, 'unrelated user can delete Book Bible';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000001"}';
do $$
declare v boundary_ids; n int; pending uuid := gen_random_uuid(); path text;
begin
  select * into strict v from boundary_ids;
  assert exists(select 1 from storage.objects where name=v.path_a), 'owner cannot read actual storage object';
  -- A can edit both workspaces but cannot migrate a book and expose its contents.
  begin
    update public.books set workspace_id=v.ws_b where id=v.book_a;
    assert false, 'dual-member can move book to another workspace';
  exception when insufficient_privilege then null; end;
  begin
    update public.book_bible_items set book_id=v.book_a2 where id=v.bible_a;
    assert false, 'Book Bible can silently change books';
  exception when insufficient_privilege then null; end;
  begin
    update public.book_metadata set book_id=v.book_a2 where book_id=v.book_a;
    assert false, 'metadata can silently change books';
  exception when insufficient_privilege then null; end;
  begin
    update public.assets set created_by='b2000000-0000-0000-0000-000000000001' where id=v.asset_a;
    assert false, 'asset attribution can be overwritten';
  exception when insufficient_privilege then null; end;
  begin
    update storage.objects set name='overwritten.png' where name=v.path_a;
    assert false, 'client can overwrite immutable storage objects';
  exception when insufficient_privilege then null; end;
  begin
    delete from storage.objects where name=v.path_a;
    assert false, 'client can delete immutable originals';
  exception when insufficient_privilege then null; end;

  path := 'workspaces/'||v.ws_a||'/assets/'||pending||'/v1/upload.png';
  insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,checksum,created_by)
    values(pending,v.ws_a,'image','Upload',path,'image/png','pending',auth.uid());
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,created_by)
    values(pending,1,path,'pending',auth.uid());
  insert into storage.objects(bucket_id,name) values('book-assets',path);
  update public.asset_versions set checksum=repeat('c',64) where asset_id=pending;
  get diagnostics n = row_count;
  assert n=1, 'own pending asset cannot finalize';
  update public.asset_versions set checksum=repeat('d',64) where asset_id=pending;
  get diagnostics n = row_count;
  assert n=0, 'confirmed immutable asset version can be rewritten';
  assert exists(select 1 from public.asset_versions where asset_id=pending and checksum=repeat('c',64)), 'original checksum changed';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c2000000-0000-0000-0000-000000000001"}';
do $$
declare v boundary_ids; n int;
begin
  select * into strict v from boundary_ids;
  assert exists(select 1 from public.book_bible_items where id=v.bible_a), 'viewer cannot read own Book Bible';
  delete from public.book_bible_items where id=v.bible_a;
  get diagnostics n = row_count;
  assert n=0, 'viewer can delete Book Bible';
  begin
    insert into public.book_bible_items(book_id,type,name) values(v.book_a,'character','Forbidden');
    assert false, 'viewer can write Book Bible';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000001"}';
do $$
declare v boundary_ids; n int;
begin
  select * into strict v from boundary_ids;
  delete from public.book_bible_items where id=v.bible_a;
  get diagnostics n = row_count;
  assert n=1, 'owner cannot delete Book Bible';
end $$;
reset role;
do $$ begin
  assert to_regprocedure('public.community_visible(uuid)') is null, 'legacy exposed security-definer helper remains';
  assert to_regprocedure('public.is_workspace_member(uuid)') is null, 'legacy workspace helper remains';
end $$;
rollback;
