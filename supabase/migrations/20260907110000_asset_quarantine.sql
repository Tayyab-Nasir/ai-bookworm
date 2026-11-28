-- User uploads remain quarantined until a private scanner records a clean
-- verdict. Internal service artifacts are marked trusted at insert time.

alter table public.asset_versions
  add column if not exists scan_status text not null default 'pending',
  add column if not exists detected_mime_type text,
  add column if not exists scan_scanner text,
  add column if not exists scan_signature text,
  add column if not exists scan_error_code text,
  add column if not exists scanned_at timestamptz;

alter table public.asset_versions
  drop constraint if exists asset_versions_scan_status_check;
alter table public.asset_versions
  add constraint asset_versions_scan_status_check
  check (scan_status in ('pending', 'clean', 'infected', 'error', 'trusted_generated'));

create or replace function private.enforce_asset_version_scan_state()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_service boolean := current_user = 'service_role'
    or auth.role() is not distinct from 'service_role';
begin
  if tg_op = 'INSERT' then
    if v_service and new.checksum ~ '^[a-f0-9]{64}$' then
      new.scan_status := 'trusted_generated';
      new.detected_mime_type := new.mime_type;
      new.scan_scanner := 'bookworm-internal-service';
      new.scan_signature := 'trusted-generated-v1';
      new.scan_error_code := null;
      new.scanned_at := now();
    else
      new.scan_status := 'pending';
      new.detected_mime_type := null;
      new.scan_scanner := null;
      new.scan_signature := null;
      new.scan_error_code := null;
      new.scanned_at := null;
    end if;
    return new;
  end if;

  if not v_service and (
    new.scan_status is distinct from old.scan_status
    or new.detected_mime_type is distinct from old.detected_mime_type
    or new.scan_scanner is distinct from old.scan_scanner
    or new.scan_signature is distinct from old.scan_signature
    or new.scan_error_code is distinct from old.scan_error_code
    or new.scanned_at is distinct from old.scanned_at
  ) then
    raise exception 'asset scan state is server-mediated' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_asset_version_scan_state() from public;

-- Existing confirmed internal artifacts were produced inside trusted workers.
-- Existing user-originated objects stay pending until explicitly re-scanned.
drop trigger if exists asset_versions_finalize_once on public.asset_versions;
update public.asset_versions av
set scan_status = 'trusted_generated',
    detected_mime_type = av.mime_type,
    scan_scanner = 'bookworm-internal-service',
    scan_signature = 'trusted-generated-v1',
    scan_error_code = null,
    scanned_at = coalesce(av.created_at, now())
from public.assets a
where a.id = av.asset_id
  and av.checksum ~ '^[a-f0-9]{64}$'
  and (
    a.type in ('rendered_ebook', 'rendered_print', 'rendered_cover', 'publishing_package')
    or exists (
      select 1 from public.ai_jobs j
      where j.status = 'succeeded'
        and j.output_ref->>'assetId' = av.asset_id::text
        and j.agent_type in ('illustrator', 'cover_designer')
    )
  );

create or replace function private.finalize_asset_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_service boolean := current_user = 'service_role'
    or auth.role() is not distinct from 'service_role';
begin
  if new.asset_id is distinct from old.asset_id
     or new.version_number is distinct from old.version_number
     or new.storage_path is distinct from old.storage_path
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'asset version identity is immutable' using errcode = '42501';
  end if;

  if old.checksum <> 'pending' then
    raise exception 'an asset version may only be finalized once' using errcode = '42501';
  end if;

  if new.checksum = 'pending' then
    if not v_service or new.scan_status <> 'error' then
      raise exception 'only a scanner error may keep an asset version pending' using errcode = '42501';
    end if;
  elsif new.checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'asset versions require a SHA-256 checksum' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.finalize_asset_version() from public;

create trigger asset_versions_finalize_once
  before update on public.asset_versions
  for each row execute function private.finalize_asset_version();
drop trigger if exists asset_versions_scan_state on public.asset_versions;
create trigger asset_versions_scan_state
  before insert or update on public.asset_versions
  for each row execute function private.enforce_asset_version_scan_state();

create or replace function public.record_asset_scan_verdict(
  p_asset_id uuid,
  p_version_number integer,
  p_verdict text,
  p_checksum text,
  p_detected_mime_type text,
  p_size_bytes bigint,
  p_scanner text,
  p_signature text default null,
  p_error_code text default null
) returns public.asset_versions
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_version public.asset_versions;
  v_asset public.assets;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_asset_id is null
    or p_version_number is null or p_version_number < 1
    or p_verdict not in ('clean', 'infected', 'error')
    or p_checksum !~ '^[a-f0-9]{64}$'
    or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 104857600
    or coalesce(length(trim(p_scanner)), 0) not between 1 and 100
    or p_scanner ~ '[[:cntrl:]]'
    or length(coalesce(p_signature, '')) > 200
    or coalesce(p_signature, '') ~ '[[:cntrl:]]'
    or length(coalesce(p_error_code, '')) > 100
    or coalesce(p_error_code, '') ~ '[^a-z0-9_]'
    or (p_verdict in ('clean', 'infected') and (
      p_detected_mime_type is null
      or p_detected_mime_type !~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$'
      or coalesce(length(trim(p_signature)), 0) < 1
      or (p_verdict = 'clean' and p_error_code is not null)
      or (p_verdict = 'infected' and p_error_code is distinct from 'malware_detected')
    ))
    or (p_verdict = 'error' and (
      p_error_code is null or p_error_code not in (
        'size_mismatch', 'checksum_mismatch', 'unsupported_content',
        'content_type_mismatch', 'scanner_unavailable'
      )
    ))
  then
    raise exception 'invalid asset scan verdict' using errcode = '22023';
  end if;

  select * into v_asset from public.assets where id = p_asset_id for update;
  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;
  select * into v_version
  from public.asset_versions
  where asset_id = p_asset_id and version_number = p_version_number
  for update;
  if not found then
    raise exception 'asset version not found' using errcode = 'P0002';
  end if;
  if v_version.checksum <> 'pending'
     or v_version.scan_status not in ('pending', 'error') then
    raise exception 'asset scan verdict is already terminal' using errcode = '40001';
  end if;

  if p_verdict = 'error' then
    update public.asset_versions
    set scan_status = 'error',
        detected_mime_type = p_detected_mime_type,
        scan_scanner = trim(p_scanner),
        scan_signature = nullif(trim(coalesce(p_signature, '')), ''),
        scan_error_code = p_error_code,
        scanned_at = now()
    where id = v_version.id
    returning * into v_version;
    return v_version;
  end if;

  update public.asset_versions
  set checksum = p_checksum,
      mime_type = p_detected_mime_type,
      size_bytes = p_size_bytes,
      scan_status = p_verdict,
      detected_mime_type = p_detected_mime_type,
      scan_scanner = trim(p_scanner),
      scan_signature = trim(p_signature),
      scan_error_code = p_error_code,
      scanned_at = now()
  where id = v_version.id
  returning * into v_version;

  if p_verdict = 'clean' then
    update public.assets
    set storage_path = v_version.storage_path,
        checksum = p_checksum,
        mime_type = p_detected_mime_type,
        size_bytes = p_size_bytes,
        updated_at = now()
    where id = p_asset_id
      and p_version_number = (
        select max(av.version_number) from public.asset_versions av where av.asset_id = p_asset_id
      );
  end if;
  return v_version;
end;
$$;

revoke all on function public.record_asset_scan_verdict(
  uuid, integer, text, text, text, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_asset_scan_verdict(
  uuid, integer, text, text, text, bigint, text, text, text
) to service_role;

drop policy if exists asset_object_read on storage.objects;
create policy asset_object_read on storage.objects for select to authenticated
  using (
    bucket_id = 'book-assets'
    and exists (
      select 1
      from public.asset_versions av
      join public.assets a on a.id = av.asset_id
      where av.storage_path = storage.objects.name
        and private.asset_path_matches(storage.objects.name, a.workspace_id, a.id)
        and a.deleted_at is null
        and av.scan_status in ('clean', 'trusted_generated')
        and private.is_workspace_member(a.workspace_id)
    )
  );
