-- One SQL statement preserves the migration lock under both CLI batching and outer-transaction runners.
DO $bookworm_asset_migration$
BEGIN
  EXECUTE $bookworm_asset_sql$
-- Install revision and operation identities without enabling lifecycle RPCs.
-- The separate, reviewed cutover must grant execution only after old writers drain.
-- Run only as a single migration transaction; fail instead of queueing writes.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.assets, public.asset_versions in access exclusive mode;
-- Existing rows remain NULL without a table rewrite; new assets receive random revisions.
alter table public.assets add column lifecycle_revision uuid;
alter table public.assets alter column lifecycle_revision set default gen_random_uuid();
create function private.track_asset_lifecycle_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' then new.lifecycle_revision:=pg_catalog.gen_random_uuid(); return new; end if;
  if new.lifecycle_revision is distinct from old.lifecycle_revision and current_user <>
       pg_catalog.pg_get_userbyid((select p.proowner from pg_catalog.pg_proc p
         where p.oid='private.track_asset_version_revision()'::pg_catalog.regprocedure)) then
    raise exception 'asset lifecycle revision is server managed' using errcode='42501';
  end if;
  -- Bind pending lifecycle operations to the file and review state the author saw.
  if row(new.deleted_at,new.workspace_id,new.folder_id,new.type,new.name,new.storage_path,new.mime_type,new.size_bytes,new.checksum,new.status,new.requires_approval,new.created_by)
     is distinct from row(old.deleted_at,old.workspace_id,old.folder_id,old.type,old.name,old.storage_path,old.mime_type,old.size_bytes,old.checksum,old.status,old.requires_approval,old.created_by) then
    new.lifecycle_revision:=pg_catalog.gen_random_uuid();
  end if;
  return new;
end $$;
revoke all on function private.track_asset_lifecycle_revision() from public,anon,authenticated,service_role;
create trigger aa_track_asset_lifecycle_revision before insert or update on public.assets
for each row execute function private.track_asset_lifecycle_revision();
-- Version allocation locks and updates the parent before the new row exists.
-- Confirmed current bytes rotate the revision through the parent trigger.
create function private.track_asset_version_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.assets set lifecycle_revision=pg_catalog.gen_random_uuid()
   where id=new.asset_id;
  return new;
end $$;
revoke all on function private.track_asset_version_revision() from public,anon,authenticated,service_role;
create trigger aa_track_asset_version_revision before insert on public.asset_versions
for each row execute function private.track_asset_version_revision();
create table bookworm_private.asset_lifecycle_receipts (
 actor_id uuid not null,
 operation_id uuid not null,
 workspace_id uuid not null,
 asset_id uuid not null,
 action text not null check (action in ('remove','restore')),
 outcome text not null default 'committed' check (outcome in ('committed','closed')),
 expected_deleted_at timestamptz,
 expected_revision uuid,
 expected_version_id uuid,
 expected_storage_path text,
 expected_checksum text,
 expected_size_bytes bigint,
 committed_at timestamptz not null default clock_timestamp(),
 primary key (actor_id,operation_id)
);
create index asset_lifecycle_closed_actor_time on bookworm_private.asset_lifecycle_receipts(actor_id,committed_at desc) where outcome='closed';
alter table bookworm_private.asset_lifecycle_receipts enable row level security;
revoke all on bookworm_private.asset_lifecycle_receipts from public,anon,authenticated,service_role;

create function private.mutate_asset_lifecycle_internal(
 p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_action text,p_expected_deleted_at timestamptz,p_expected_revision uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid := auth.uid();
 v_role text;
 v_asset public.assets;
 v_receipt bookworm_private.asset_lifecycle_receipts;
 v_previous_setting text;
 v_event text;
begin
 if current_setting('role',true) is distinct from 'authenticated'
   or auth.role() is distinct from 'authenticated' or v_actor is null then
   raise exception 'authenticated actor required' using errcode='42501';
 end if;
 if p_workspace_id is null or p_asset_id is null or p_operation_id is null
   or p_action not in ('remove','restore') or p_action is null
   or (p_action='remove' and p_expected_deleted_at is not null)
   or (p_action='restore' and (p_expected_deleted_at is null or not isfinite(p_expected_deleted_at))) then
   raise exception 'invalid asset lifecycle request' using errcode='22023';
 end if;
 -- Only the server may restore after verifying the actual private object bytes.
 if p_action='restore' then raise exception 'verified server restore required' using errcode='42501'; end if;
 select wm.role::text into v_role from public.workspace_members wm
 where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' for share;
 if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
   raise exception 'asset editing access required' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('asset-lifecycle:'||v_actor::text||':'||p_operation_id::text,0));
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r
 where r.actor_id=v_actor and r.operation_id=p_operation_id;
 if found then
   if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.asset_id is distinct from p_asset_id
      or v_receipt.action is distinct from p_action or v_receipt.expected_deleted_at is distinct from p_expected_deleted_at or v_receipt.expected_revision is distinct from p_expected_revision then
     raise exception 'asset lifecycle operation conflict' using errcode='23505';
   end if;
   if v_receipt.outcome='closed' then raise exception 'asset operation was closed' using errcode='40001'; end if;
   return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',p_action,'expectedRevision',p_expected_revision,'replayed',true);
 end if;
 select a.* into v_asset from public.assets a where a.id=p_asset_id and a.workspace_id=p_workspace_id for update;
 if not found then raise exception 'asset not found' using errcode='P0002'; end if;
 if v_asset.lifecycle_revision is distinct from p_expected_revision then raise exception 'asset lifecycle revision changed' using errcode='40001'; end if;
 if p_action='remove' and v_asset.deleted_at is not null then
   raise exception 'asset already removed' using errcode='40001';
 end if;
 if p_action='restore' and v_asset.deleted_at is distinct from p_expected_deleted_at then
   raise exception 'asset state changed' using errcode='40001';
 end if;
 if p_action='restore' then
   perform av.id from public.asset_versions av
   where av.asset_id=v_asset.id and av.storage_path=v_asset.storage_path and av.checksum=v_asset.checksum
     and av.scan_status in ('clean','trusted_generated') for share;
   if not found or v_asset.checksum is null or v_asset.checksum !~ '^[a-fA-F0-9]{64}$' then
     raise exception 'asset cannot be restored without a confirmed clean current version' using errcode='23514';
   end if;
 end if;
 -- Review decisions predating removal/restoration must never authorize the restored asset.
 update public.approvals a set superseded_at=clock_timestamp(),
   status=case when a.status='pending' then 'cancelled'::public.approval_status else a.status end,
   resolved_at=case when a.status='pending' then clock_timestamp() else a.resolved_at end,
   resolved_by=case when a.status='pending' then null else a.resolved_by end,
   resolution_note=case when a.status='pending' then 'Superseded by asset removal or restoration.' else a.resolution_note end,
   updated_at=clock_timestamp()
 where a.entity_type='asset' and a.entity_id=v_asset.id and a.workspace_id=p_workspace_id and a.superseded_at is null;
 v_previous_setting := current_setting('bookworm.asset_review_internal',true);
 perform set_config('bookworm.asset_review_internal','on',true);
 if p_action='remove' then
   update public.assets set deleted_at=clock_timestamp(),status='archived' where id=v_asset.id;
   v_event:='asset_deleted';
 else
   update public.assets set deleted_at=null,status='draft' where id=v_asset.id;
   v_event:='asset_restored';
 end if;
 perform set_config('bookworm.asset_review_internal',coalesce(v_previous_setting,''),true);
 insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id)
 values(p_workspace_id,v_actor,v_event,'asset',v_asset.id);
 insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,expected_deleted_at,expected_revision)
 values(v_actor,p_operation_id,p_workspace_id,p_asset_id,p_action,p_expected_deleted_at,p_expected_revision);
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',p_action,'expectedRevision',p_expected_revision,'replayed',false);
end $$;
revoke all on function private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid) from public,anon,authenticated,service_role;

create function public.mutate_asset_lifecycle(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_action text,p_expected_deleted_at timestamptz,p_expected_revision uuid) returns jsonb language sql security invoker set search_path='' as $$
 select private.mutate_asset_lifecycle_internal(p_workspace_id,p_asset_id,p_operation_id,p_action,p_expected_deleted_at,p_expected_revision)
$$;
revoke all on function public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid) from public,anon,authenticated,service_role;

-- The API verifies the actual object bytes before invoking this service-only
-- function. Database metadata alone is not evidence that Storage has bytes.
create function private.restore_verified_asset_internal(
 p_actor_id uuid,p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_expected_deleted_at timestamptz,p_expected_revision uuid,
 p_version_id uuid,p_storage_path text,p_checksum text,p_size_bytes bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_role text;
 v_asset public.assets;
 v_version public.asset_versions;
 v_receipt bookworm_private.asset_lifecycle_receipts;
 v_previous_setting text;
begin
 if current_setting('role',true) is distinct from 'service_role' or auth.role() is distinct from 'service_role' then
   raise exception 'service role required' using errcode='42501';
 end if;
 if p_actor_id is null or p_workspace_id is null or p_asset_id is null or p_operation_id is null
   or p_expected_deleted_at is null or not isfinite(p_expected_deleted_at) or p_version_id is null
   or p_storage_path is null or p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 104857600 then
   raise exception 'invalid verified restore' using errcode='22023';
 end if;
 select wm.role::text into v_role from public.workspace_members wm
 where wm.workspace_id=p_workspace_id and wm.user_id=p_actor_id and wm.status='active' for share;
 if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
   raise exception 'asset editing access required' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('asset-lifecycle:'||p_actor_id::text||':'||p_operation_id::text,0));
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r where r.actor_id=p_actor_id and r.operation_id=p_operation_id;
 if found then
   if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.asset_id is distinct from p_asset_id
      or v_receipt.action is distinct from 'restore' or v_receipt.expected_deleted_at is distinct from p_expected_deleted_at or v_receipt.expected_revision is distinct from p_expected_revision then
     raise exception 'asset lifecycle operation conflict' using errcode='23505';
   end if;
   if v_receipt.outcome='closed' then raise exception 'asset operation was closed' using errcode='40001'; end if;
   if v_receipt.expected_version_id is distinct from p_version_id or v_receipt.expected_storage_path is distinct from p_storage_path
      or v_receipt.expected_checksum is distinct from p_checksum or v_receipt.expected_size_bytes is distinct from p_size_bytes then
     raise exception 'asset lifecycle operation conflict' using errcode='23505';
   end if;
   return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action','restore','expectedRevision',p_expected_revision,'replayed',true);
 end if;
 select * into v_asset from public.assets where id=p_asset_id and workspace_id=p_workspace_id for update;
 if not found then raise exception 'asset not found' using errcode='P0002'; end if;
 if v_asset.lifecycle_revision is distinct from p_expected_revision or v_asset.deleted_at is distinct from p_expected_deleted_at or v_asset.storage_path is distinct from p_storage_path
    or lower(v_asset.checksum) is distinct from p_checksum or v_asset.size_bytes is distinct from p_size_bytes then
   raise exception 'asset state changed during verification' using errcode='40001';
 end if;
 select * into v_version from public.asset_versions where id=p_version_id and asset_id=p_asset_id for share;
 if not found or v_version.storage_path is distinct from p_storage_path or lower(v_version.checksum) is distinct from p_checksum
    or v_version.size_bytes is distinct from p_size_bytes or v_version.mime_type is distinct from v_asset.mime_type
    or coalesce(v_version.scan_status, '') not in ('clean','trusted_generated')
    or not private.asset_path_matches(p_storage_path,p_workspace_id,p_asset_id) then
   raise exception 'asset does not have a confirmed clean current version' using errcode='23514';
 end if;
 update public.approvals a set superseded_at=clock_timestamp(),
   status=case when a.status='pending' then 'cancelled'::public.approval_status else a.status end,
   resolved_at=case when a.status='pending' then clock_timestamp() else a.resolved_at end,
   resolved_by=case when a.status='pending' then null else a.resolved_by end,
   resolution_note=case when a.status='pending' then 'Superseded by asset restoration.' else a.resolution_note end,
   updated_at=clock_timestamp()
 where a.entity_type='asset' and a.entity_id=v_asset.id and a.workspace_id=p_workspace_id and a.superseded_at is null;
 v_previous_setting:=current_setting('bookworm.asset_review_internal',true);
 perform set_config('bookworm.asset_review_internal','on',true);
 update public.assets set deleted_at=null,status='draft' where id=v_asset.id;
 perform set_config('bookworm.asset_review_internal',coalesce(v_previous_setting,''),true);
 insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id)
 values(p_workspace_id,p_actor_id,'asset_restored','asset',p_asset_id);
 insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,expected_deleted_at,expected_revision,
  expected_version_id,expected_storage_path,expected_checksum,expected_size_bytes)
 values(p_actor_id,p_operation_id,p_workspace_id,p_asset_id,'restore',p_expected_deleted_at,p_expected_revision,p_version_id,p_storage_path,p_checksum,p_size_bytes);
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action','restore','expectedRevision',p_expected_revision,'replayed',false);
end $$;
revoke all on function private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint) from public,anon,authenticated,service_role;

create function public.restore_verified_asset(p_actor_id uuid,p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_expected_deleted_at timestamptz,p_expected_revision uuid,p_version_id uuid,p_storage_path text,p_checksum text,p_size_bytes bigint) returns jsonb language sql security invoker set search_path='' as $$
 select private.restore_verified_asset_internal(p_actor_id,p_workspace_id,p_asset_id,p_operation_id,p_expected_deleted_at,p_expected_revision,p_version_id,p_storage_path,p_checksum,p_size_bytes)
$$;
revoke all on function public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint) from public,anon,authenticated,service_role;

-- Read-only lost-reply recovery. An absent row is not proof that an earlier
-- request has stopped; callers must not replace its operation identity.
create function private.asset_lifecycle_status_internal(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_receipt bookworm_private.asset_lifecycle_receipts;
begin
 if current_setting('role',true) is distinct from 'authenticated' or auth.role() is distinct from 'authenticated' or v_actor is null then
   raise exception 'authenticated actor required' using errcode='42501';
 end if;
 if p_workspace_id is null or p_asset_id is null or p_operation_id is null then
   raise exception 'invalid asset lifecycle request' using errcode='22023';
 end if;
 perform wm.user_id from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' for share;
 if not found then raise exception 'workspace unavailable' using errcode='42501'; end if;
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r
 where r.actor_id=v_actor and r.workspace_id=p_workspace_id and r.asset_id=p_asset_id and r.operation_id=p_operation_id;
 if not found then return null; end if;
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',v_receipt.action,
  'expectedDeletedAt',v_receipt.expected_deleted_at,'expectedRevision',v_receipt.expected_revision,'committedAt',case when v_receipt.outcome='committed' then v_receipt.committed_at else null end,'closedAt',case when v_receipt.outcome='closed' then v_receipt.committed_at else null end,'outcome',v_receipt.outcome);
end $$;
revoke all on function private.asset_lifecycle_status_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.asset_lifecycle_status(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid) returns jsonb language sql security invoker set search_path='' as $$
 select private.asset_lifecycle_status_internal(p_workspace_id,p_asset_id,p_operation_id)
$$;
revoke all on function public.asset_lifecycle_status(uuid,uuid,uuid) from public,anon,authenticated,service_role;


-- Close an uncertain actor-bound operation under the same lock as mutation.
create function private.close_asset_lifecycle_internal(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_action text,p_expected_deleted_at timestamptz,p_expected_revision uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_receipt bookworm_private.asset_lifecycle_receipts; v_count bigint; v_role text;
begin
 if current_setting('role',true) is distinct from 'authenticated' or auth.role() is distinct from 'authenticated' or v_actor is null then raise exception 'authenticated actor required' using errcode='42501'; end if;
 if p_workspace_id is null or p_asset_id is null or p_operation_id is null or p_action not in ('remove','restore') or p_action is null
   or (p_action='remove' and p_expected_deleted_at is not null) or (p_action='restore' and (p_expected_deleted_at is null or not isfinite(p_expected_deleted_at))) then raise exception 'invalid asset lifecycle request' using errcode='22023'; end if;
 select wm.role::text into v_role from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' for share;
 if not found then raise exception 'workspace unavailable' using errcode='42501'; end if;
 if v_role not in ('owner','admin','editor','writer','illustrator','designer') then raise exception 'asset editing access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('asset-close:'||v_actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended('asset-lifecycle:'||v_actor::text||':'||p_operation_id::text,0));
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r where r.actor_id=v_actor and r.operation_id=p_operation_id;
 if found then
   if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.asset_id is distinct from p_asset_id or v_receipt.action is distinct from p_action or v_receipt.expected_deleted_at is distinct from p_expected_deleted_at or v_receipt.expected_revision is distinct from p_expected_revision then raise exception 'asset lifecycle operation conflict' using errcode='23505'; end if;
 else
   select count(*) into v_count from bookworm_private.asset_lifecycle_receipts r where r.actor_id=v_actor and r.outcome='closed' and r.committed_at > clock_timestamp()-interval '1 hour';
   if v_count >= 60 then raise exception 'asset close limit reached' using errcode='54000'; end if;
   insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,expected_deleted_at,expected_revision,outcome) values(v_actor,p_operation_id,p_workspace_id,p_asset_id,p_action,p_expected_deleted_at,p_expected_revision,'closed') returning * into v_receipt;
 end if;
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',p_action,'outcome',v_receipt.outcome,'expectedDeletedAt',v_receipt.expected_deleted_at,'expectedRevision',v_receipt.expected_revision,'committedAt',case when v_receipt.outcome='committed' then v_receipt.committed_at else null end,'closedAt',case when v_receipt.outcome='closed' then v_receipt.committed_at else null end);
end $$;
revoke all on function private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid) from public,anon,authenticated,service_role;
create function public.close_asset_lifecycle(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_action text,p_expected_deleted_at timestamptz,p_expected_revision uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.close_asset_lifecycle_internal(p_workspace_id,p_asset_id,p_operation_id,p_action,p_expected_deleted_at,p_expected_revision) $$;
revoke all on function public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid) from public,anon,authenticated,service_role;

-- Unexpected default grants must not expose dormant helpers or receipts.
do $asset_additive_acl$
declare fn oid; owner_id oid; receipt_owner oid;
begin
  foreach fn in array array[
    'private.track_asset_lifecycle_revision()'::regprocedure::oid,
    'private.track_asset_version_revision()'::regprocedure::oid,
    'private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure::oid,
    'public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure::oid,
    'private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'::regprocedure::oid,
    'public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'::regprocedure::oid,
    'private.asset_lifecycle_status_internal(uuid,uuid,uuid)'::regprocedure::oid,
    'public.asset_lifecycle_status(uuid,uuid,uuid)'::regprocedure::oid,
    'private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure::oid,
    'public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure::oid
  ] loop
    select p.proowner into owner_id from pg_catalog.pg_proc p where p.oid=fn;
    if owner_id is distinct from (select oid from pg_catalog.pg_roles where rolname=current_user)
       or exists (select 1 from pg_catalog.pg_proc p
         cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
         where p.oid=fn and a.grantee<>p.proowner) then
      raise exception 'unexpected default function grant in asset lifecycle' using errcode='55000';
    end if;
  end loop;
  select c.relowner into receipt_owner from pg_catalog.pg_class c where c.oid='bookworm_private.asset_lifecycle_receipts'::regclass;
  if receipt_owner is distinct from owner_id
     or exists (select 1 from pg_catalog.pg_class c
       cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
       where c.oid='bookworm_private.asset_lifecycle_receipts'::regclass and a.grantee<>c.relowner) then
    raise exception 'unexpected default receipt grant in asset lifecycle' using errcode='55000';
  end if;
end $asset_additive_acl$;

$bookworm_asset_sql$;
END
$bookworm_asset_migration$;
