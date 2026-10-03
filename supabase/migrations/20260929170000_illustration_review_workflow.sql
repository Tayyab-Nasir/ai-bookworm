-- Human approval is version-bound and enforced at both the API and database
-- boundary. Legacy imported images remain usable; new user/AI artwork requires
-- review before manuscript placement or cover rendering.

alter table public.assets
  add column if not exists requires_approval boolean not null default false;

alter table public.approvals
  add column if not exists entity_version_number integer,
  add column if not exists request_key uuid,
  add column if not exists resolved_by uuid references auth.users(id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_note text,
  add column if not exists superseded_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'approvals_entity_version_number_positive'
      and conrelid = 'public.approvals'::regclass
  ) then
    alter table public.approvals
      add constraint approvals_entity_version_number_positive
      check (entity_version_number is null or entity_version_number > 0) not valid;
  end if;
end;
$$;

create unique index if not exists approvals_asset_request_key_unique
  on public.approvals (workspace_id, requested_by, request_key)
  where entity_type = 'asset' and request_key is not null;
create unique index if not exists approvals_one_pending_asset_version
  on public.approvals (entity_id, entity_version_number)
  where entity_type = 'asset' and status = 'pending' and superseded_at is null;
create index if not exists approvals_asset_version_status_idx
  on public.approvals (entity_id, entity_version_number, status)
  where entity_type = 'asset';
create index if not exists asset_versions_current_clean_lookup
  on public.asset_versions (asset_id, storage_path, checksum, version_number desc)
  where scan_status in ('clean', 'trusted_generated');

-- User-supplied image bytes always enter draft/review state. Service-generated
-- images are marked by the successful illustrator/cover_designer job below;
-- legacy import/render artifacts are deliberately grandfathered.
create or replace function private.enforce_asset_review_state()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_authenticated boolean := current_user = 'authenticated'
    or auth.role() is not distinct from 'authenticated';
  v_internal_review_update boolean := coalesce(current_setting('bookworm.asset_review_internal', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if v_authenticated then
      new.status := 'draft'::public.asset_status;
      new.requires_approval := coalesce(new.mime_type, '') like 'image/%';
    end if;
    return new;
  end if;

  if v_authenticated and not v_internal_review_update and (
    new.status is distinct from old.status
    or new.requires_approval is distinct from old.requires_approval
  ) then
    raise exception 'asset review state is server-mediated' using errcode = '42501';
  end if;

  if new.storage_path is distinct from old.storage_path
    or new.checksum is distinct from old.checksum
    or new.mime_type is distinct from old.mime_type
  then
    if (v_authenticated or old.requires_approval or new.requires_approval)
      and (coalesce(new.mime_type, '') like 'image/%' or old.requires_approval or new.requires_approval)
    then
      new.requires_approval := true;
      new.status := 'draft'::public.asset_status;
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_asset_review_state() from public, anon, authenticated;

drop trigger if exists assets_enforce_review_state on public.assets;
create trigger assets_enforce_review_state
  before insert or update on public.assets
  for each row execute function private.enforce_asset_review_state();

create or replace function private.require_review_for_user_image_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authenticated boolean := current_user = 'authenticated'
    or auth.role() is not distinct from 'authenticated';
  v_previous_setting text := coalesce(current_setting('bookworm.asset_review_internal', true), '');
begin
  if not v_authenticated or coalesce(new.mime_type, '') not like 'image/%' then
    return new;
  end if;
  perform set_config('bookworm.asset_review_internal', 'on', true);
  update public.assets a
  set requires_approval = true,
      status = 'draft'::public.asset_status,
      updated_at = clock_timestamp()
  where a.id = new.asset_id;
  perform set_config('bookworm.asset_review_internal', v_previous_setting, true);
  return new;
end;
$$;
revoke all on function private.require_review_for_user_image_version() from public, anon, authenticated;
drop trigger if exists asset_versions_require_review on public.asset_versions;
create trigger asset_versions_require_review
  before insert on public.asset_versions
  for each row execute function private.require_review_for_user_image_version();

-- Authenticated users may rename/move assets, but never set moderation fields.
-- Version uploads and finalization use asset_versions plus the private scanner.
revoke update on table public.assets from authenticated;
grant update (name, folder_id, updated_at) on table public.assets to authenticated;

-- Asset approvals are created/resolved only by the following service RPCs.
-- Keep the existing generic book/chapter/edition approval API intact.
drop policy if exists approvals_insert on public.approvals;
create policy approvals_insert on public.approvals for insert to authenticated
  with check (
    entity_type <> 'asset'
    and status = 'pending'
    and requested_by = (select auth.uid())
    and private.can_edit_workspace(workspace_id)
    and (
      reviewer_id is null
      or exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = approvals.workspace_id
          and wm.user_id = approvals.reviewer_id
          and wm.status = 'active'
          and wm.role::text in ('owner','admin','editor','writer','illustrator','designer','reviewer')
      )
    )
  );

create or replace function private.guard_approval_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' or auth.role() is not distinct from 'authenticated' then
    if new.entity_type = 'asset' or new.status <> 'pending'
      or new.entity_version_number is not null or new.request_key is not null
      or new.resolved_by is not null or new.resolved_at is not null
      or new.resolution_note is not null or new.superseded_at is not null
    then
      raise exception 'asset review decisions are server-mediated' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_approval_insert() from public, anon, authenticated;
drop trigger if exists approvals_guard_insert on public.approvals;
create trigger approvals_guard_insert
  before insert on public.approvals
  for each row execute function private.guard_approval_insert();

create or replace function private.supersede_stale_asset_approvals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_version integer;
begin
  if new.storage_path is not distinct from old.storage_path
    and new.checksum is not distinct from old.checksum
    and new.mime_type is not distinct from old.mime_type
  then
    return new;
  end if;

  select av.version_number into v_current_version
  from public.asset_versions av
  where av.asset_id = new.id
    and av.storage_path = new.storage_path
    and av.checksum = new.checksum
    and av.scan_status in ('clean', 'trusted_generated')
  order by av.version_number desc
  limit 1;

  if v_current_version is null then
    return new;
  end if;

  update public.approvals a
  set superseded_at = clock_timestamp(),
      status = case when a.status = 'pending' then 'cancelled'::public.approval_status else a.status end,
      resolved_at = case when a.status = 'pending' then clock_timestamp() else a.resolved_at end,
      resolved_by = case when a.status = 'pending' then null else a.resolved_by end,
      resolution_note = case when a.status = 'pending' then 'Superseded by a new asset version.' else a.resolution_note end,
      updated_at = clock_timestamp()
  where a.entity_type = 'asset'
    and a.entity_id = new.id
    and a.entity_version_number is distinct from v_current_version
    and a.superseded_at is null;
  return new;
end;
$$;
revoke all on function private.supersede_stale_asset_approvals() from public, anon, authenticated;
drop trigger if exists assets_supersede_stale_approvals on public.assets;
create trigger assets_supersede_stale_approvals
  after update of storage_path, checksum, mime_type on public.assets
  for each row execute function private.supersede_stale_asset_approvals();

create or replace function private.require_review_for_generated_artwork()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  if new.status <> 'succeeded' or new.agent_type not in ('illustrator', 'cover_designer')
    or coalesce(new.output_ref->>'assetId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    return new;
  end if;
  v_asset_id := (new.output_ref->>'assetId')::uuid;
  update public.assets a
  set requires_approval = true,
      status = 'draft'::public.asset_status,
      updated_at = clock_timestamp()
  where a.id = v_asset_id
    and a.workspace_id = new.workspace_id
    and a.deleted_at is null
    and a.mime_type like 'image/%';
  return new;
end;
$$;
revoke all on function private.require_review_for_generated_artwork() from public, anon, authenticated;
drop trigger if exists ai_jobs_require_artwork_review on public.ai_jobs;
create trigger ai_jobs_require_artwork_review
  after update of status, output_ref on public.ai_jobs
  for each row execute function private.require_review_for_generated_artwork();

create or replace function public.request_asset_approval(
  p_workspace_id uuid,
  p_asset_id uuid,
  p_entity_version_number integer,
  p_requested_by uuid,
  p_reviewer_id uuid,
  p_request_key uuid,
  p_comment text
) returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.assets;
  v_version public.asset_versions;
  v_approval public.approvals;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_workspace_id is null or p_asset_id is null or p_entity_version_number is null
    or p_entity_version_number < 1 or p_requested_by is null or p_reviewer_id is null
    or p_request_key is null or length(coalesce(p_comment, '')) > 2000
  then
    raise exception 'invalid asset review request' using errcode = '22023';
  end if;
  if p_requested_by = p_reviewer_id then
    raise exception 'reviewer cannot request their own asset' using errcode = '23514';
  end if;

  select a.* into v_asset
  from public.assets a
  where a.id = p_asset_id and a.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'asset not found in workspace' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = p_requested_by
      and wm.status = 'active'
      and wm.role::text in ('owner','admin','editor','writer','illustrator','designer')
  ) then
    raise exception 'requester cannot edit this workspace' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = p_reviewer_id
      and wm.status = 'active'
      and wm.role::text in ('owner','admin','editor','writer','illustrator','designer','reviewer')
  ) then
    raise exception 'reviewer is not eligible in this workspace' using errcode = '42501';
  end if;

  -- Return a previously accepted request before current-version checks so a
  -- lost client response is replay-safe and never creates a second decision.
  select a.* into v_approval
  from public.approvals a
  where a.workspace_id = p_workspace_id and a.requested_by = p_requested_by
    and a.entity_type = 'asset' and a.request_key = p_request_key
  for update;
  if found then
    if v_approval.entity_id <> p_asset_id
      or v_approval.entity_version_number <> p_entity_version_number
      or v_approval.reviewer_id <> p_reviewer_id
      or v_approval.comment is distinct from v_comment
    then
      raise exception 'idempotency key belongs to different review details' using errcode = '23505';
    end if;
    return v_approval;
  end if;

  if v_asset.deleted_at is not null or v_asset.requires_approval is distinct from true
    or v_asset.mime_type not like 'image/%'
  then
    raise exception 'asset is not eligible for human review' using errcode = '23514';
  end if;
  select av.* into v_version
  from public.asset_versions av
  where av.asset_id = p_asset_id and av.version_number = p_entity_version_number
  for update;
  if not found or v_version.storage_path is distinct from v_asset.storage_path
    or v_version.checksum is distinct from v_asset.checksum
    or v_version.scan_status not in ('clean', 'trusted_generated')
    or v_asset.checksum = 'pending'
  then
    raise exception 'asset version is stale or not clean' using errcode = '23514';
  end if;
  if v_asset.status = 'rejected' then
    raise exception 'rejected artwork must be revised before review' using errcode = '23514';
  end if;
  if v_asset.status <> 'draft' then
    raise exception 'asset is not awaiting review' using errcode = '40001';
  end if;

  insert into public.approvals (
    workspace_id, entity_type, entity_id, entity_version_number,
    requested_by, reviewer_id, request_key, status, comment
  ) values (
    p_workspace_id, 'asset', p_asset_id, p_entity_version_number,
    p_requested_by, p_reviewer_id, p_request_key, 'pending', v_comment
  )
  on conflict (workspace_id, requested_by, request_key)
    where entity_type = 'asset' and request_key is not null
    do nothing
  returning * into v_approval;

  if not found then
    select a.* into v_approval
    from public.approvals a
    where a.workspace_id = p_workspace_id and a.requested_by = p_requested_by
      and a.entity_type = 'asset' and a.request_key = p_request_key
    for update;
    if not found or v_approval.entity_id <> p_asset_id
      or v_approval.entity_version_number <> p_entity_version_number
      or v_approval.reviewer_id <> p_reviewer_id
      or v_approval.comment is distinct from v_comment
    then
      raise exception 'idempotency key belongs to different review details' using errcode = '23505';
    end if;
    return v_approval;
  end if;

  update public.assets a
  set status = 'in_review'::public.asset_status, updated_at = clock_timestamp()
  where a.id = p_asset_id;
  insert into public.activity_events (workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (p_workspace_id, p_requested_by, 'asset_review_requested', 'approval', v_approval.id,
    jsonb_build_object('assetId', p_asset_id, 'version', p_entity_version_number));
  return v_approval;
end;
$$;
revoke all on function public.request_asset_approval(uuid, uuid, integer, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.request_asset_approval(uuid, uuid, integer, uuid, uuid, uuid, text) to service_role;

create or replace function public.resolve_asset_approval(
  p_approval_id uuid,
  p_actor_id uuid,
  p_action text,
  p_comment text
) returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.approvals;
  v_asset public.assets;
  v_version public.asset_versions;
  v_status public.approval_status;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_approval_id is null or p_actor_id is null or p_action is null
    or p_action not in ('approve', 'reject')
    or length(coalesce(p_comment, '')) > 2000
  then
    raise exception 'invalid asset review decision' using errcode = '22023';
  end if;
  if p_action = 'reject' and v_comment is null then
    raise exception 'a rejection note is required' using errcode = '23514';
  end if;

  select a.* into v_approval from public.approvals a where a.id = p_approval_id;
  if not found or v_approval.entity_type <> 'asset' then
    raise exception 'asset approval not found' using errcode = 'P0002';
  end if;
  select a.* into v_asset from public.assets a where a.id = v_approval.entity_id for update;
  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;
  select a.* into v_approval from public.approvals a where a.id = p_approval_id for update;
  if not found then
    raise exception 'asset approval not found' using errcode = 'P0002';
  end if;

  v_status := case when p_action = 'approve' then 'approved'::public.approval_status
    else 'rejected'::public.approval_status end;
  if v_approval.status in ('approved', 'rejected') then
    if v_approval.status = v_status and v_approval.resolved_by = p_actor_id
      and v_approval.resolution_note is not distinct from v_comment
      and v_approval.superseded_at is null
    then
      return v_approval;
    end if;
    raise exception 'asset approval already resolved or superseded' using errcode = '40001';
  end if;
  if v_approval.status <> 'pending' or v_approval.superseded_at is not null then
    raise exception 'asset approval is no longer pending' using errcode = '40001';
  end if;
  if p_actor_id = v_approval.requested_by or v_approval.reviewer_id is distinct from p_actor_id then
    raise exception 'only the assigned reviewer may decide this request' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = v_approval.workspace_id and wm.user_id = p_actor_id
      and wm.status = 'active'
      and wm.role::text in ('owner','admin','editor','writer','illustrator','designer','reviewer')
  ) then
    raise exception 'reviewer is not active in this workspace' using errcode = '42501';
  end if;
  if v_asset.deleted_at is not null or v_asset.requires_approval is distinct from true
    or v_asset.status <> 'in_review' or v_approval.entity_version_number is null
  then
    raise exception 'asset approval no longer matches review state' using errcode = '40001';
  end if;
  select av.* into v_version from public.asset_versions av
  where av.asset_id = v_asset.id and av.version_number = v_approval.entity_version_number
  for update;
  if not found or v_version.storage_path is distinct from v_asset.storage_path
    or v_version.checksum is distinct from v_asset.checksum
    or v_version.scan_status not in ('clean', 'trusted_generated')
  then
    raise exception 'asset version is stale or not clean' using errcode = '40001';
  end if;

  update public.approvals a
  set status = v_status,
      resolved_by = p_actor_id,
      resolved_at = clock_timestamp(),
      resolution_note = v_comment,
      updated_at = clock_timestamp()
  where a.id = p_approval_id
  returning * into v_approval;
  update public.assets a
  set status = case when p_action = 'approve' then 'approved'::public.asset_status
      else 'rejected'::public.asset_status end,
      updated_at = clock_timestamp()
  where a.id = v_asset.id;
  insert into public.activity_events (workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (v_approval.workspace_id, p_actor_id, 'asset_review_' || p_action, 'approval', v_approval.id,
    jsonb_build_object('assetId', v_asset.id, 'version', v_approval.entity_version_number));
  return v_approval;
end;
$$;
revoke all on function public.resolve_asset_approval(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_asset_approval(uuid, uuid, text, text) to service_role;

create or replace function private.enforce_document_artwork_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_node jsonb;
  v_asset_id uuid;
  v_asset public.assets;
  v_version public.asset_versions;
begin
  if jsonb_typeof(new.content_json->'nodes') is distinct from 'array' then
    return new;
  end if;
  select b.workspace_id into v_workspace_id
  from public.chapters c join public.books b on b.id = c.book_id
  where c.id = new.chapter_id;
  if v_workspace_id is null then
    raise exception 'chapter not found for artwork validation' using errcode = '23514';
  end if;

  for v_node in select n.value from jsonb_array_elements(new.content_json->'nodes') as n(value)
  loop
    if v_node->>'type' <> 'image' or coalesce(v_node->>'assetId', '') = '' then
      continue;
    end if;
    begin
      v_asset_id := (v_node->>'assetId')::uuid;
    exception when invalid_text_representation then
      raise exception 'manuscript image reference is invalid' using errcode = '23514';
    end;
    select a.* into v_asset from public.assets a where a.id = v_asset_id;
    if not found or v_asset.workspace_id <> v_workspace_id or v_asset.deleted_at is not null
      or v_asset.status in ('archived', 'rejected')
      or v_asset.checksum = 'pending' or v_asset.mime_type not like 'image/%'
    then
      raise exception 'manuscript image is missing, unconfirmed, or outside the workspace' using errcode = '23514';
    end if;
    select av.* into v_version from public.asset_versions av
    where av.asset_id = v_asset.id and av.storage_path = v_asset.storage_path
      and av.checksum = v_asset.checksum
      and av.scan_status in ('clean', 'trusted_generated')
    order by av.version_number desc limit 1;
    if not found then
      raise exception 'manuscript image is not clean and current' using errcode = '23514';
    end if;
    if v_asset.requires_approval then
      if v_asset.status <> 'approved'
        or v_node->>'assetVersionNumber' is distinct from v_version.version_number::text
        or not exists (
          select 1 from public.approvals a
          where a.entity_type = 'asset' and a.entity_id = v_asset.id
            and a.entity_version_number = v_version.version_number
            and a.status = 'approved' and a.superseded_at is null
        )
      then
        raise exception 'illustration must be approved for its exact current version' using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.enforce_document_artwork_approval() from public, anon, authenticated;
drop trigger if exists document_versions_enforce_artwork_review on public.document_versions;
create trigger document_versions_enforce_artwork_review
  before insert or update on public.document_versions
  for each row execute function private.enforce_document_artwork_approval();
