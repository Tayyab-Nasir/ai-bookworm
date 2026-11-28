-- All render/preflight/package completion RPCs update this row inside their
-- artifact/findings/usage transaction. This shared trigger closes their final
-- metadata check-to-completion race without duplicating those RPC bodies.
-- Storage bytes are verified by the API/worker; SQL locks their saved identity.
create or replace function private.guard_publishing_artwork_completion()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_snapshot jsonb; v_item jsonb; v_book public.books; v_edition public.editions;
  v_asset public.assets; v_version public.asset_versions; v_approval public.approvals;
  v_source public.publishing_jobs; v_source_id uuid; v_member public.workspace_members;
  v_ids uuid[]; v_used uuid[]; v_total bigint := 0;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if old.channel not in ('render','export','kdp','apple','barnesnoble','lulu','googleplay')
    and new.channel not in ('render','export','kdp','apple','barnesnoble','lulu','googleplay') then
    return new;
  end if;
  if new.id is distinct from old.id or new.idempotency_key is distinct from old.idempotency_key
    or new.book_id is distinct from old.book_id or new.edition_id is distinct from old.edition_id
    or new.channel is distinct from old.channel or new.created_by is distinct from old.created_by
    or new.request_json is distinct from old.request_json then
    raise exception 'publishing input snapshot is immutable' using errcode='22023';
  end if;
  if new.status <> 'succeeded' or old.status = 'succeeded' then return new; end if;
  if old.status <> 'running' then raise exception 'publishing job is not running' using errcode='40001'; end if;
  if (old.channel='render' and old.request_json->>'action' is distinct from 'render')
    or (old.channel<>'render' and coalesce(old.request_json->>'action','') not in ('validate','export_package'))
    or (old.channel='export' and old.request_json->>'action' is distinct from 'validate') then
    raise exception 'invalid publishing completion action' using errcode='22023';
  end if;
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;

  v_snapshot := old.request_json->'artworkSnapshot';
  if jsonb_typeof(v_snapshot) is distinct from 'object' or v_snapshot->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(v_snapshot->'assets') is distinct from 'array'
    or jsonb_typeof(v_snapshot->'illustrationAssetIds') is distinct from 'array'
    or not (v_snapshot ? 'coverAssetId')
    or coalesce(old.request_json->>'imageSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(old.request_json->>'bookModelSha256','') !~ '^[a-f0-9]{64}$' then
    raise exception 'publishing artwork snapshot missing or invalid; render and run preflight again' using errcode='22023';
  end if;
  if jsonb_array_length(v_snapshot->'assets') > 100 or jsonb_array_length(v_snapshot->'illustrationAssetIds') > 100
    or octet_length(v_snapshot::text) > 200000
    or (v_snapshot->'coverAssetId' <> 'null'::jsonb and
      (jsonb_typeof(v_snapshot->'coverAssetId') <> 'string' or coalesce(v_snapshot->>'coverAssetId','') !~ v_uuid)) then
    raise exception 'invalid publishing artwork snapshot' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(v_snapshot->'illustrationAssetIds') loop
    if jsonb_typeof(v_item) <> 'string' or coalesce(v_item#>>'{}','') !~ v_uuid then
      raise exception 'invalid publishing illustration id' using errcode='22023';
    end if;
  end loop;
  if jsonb_array_length(v_snapshot->'illustrationAssetIds') <>
    (select count(distinct value) from jsonb_array_elements(v_snapshot->'illustrationAssetIds')) then
    raise exception 'duplicate publishing illustration id' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(v_snapshot->'assets') loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or coalesce(v_item->>'assetId','') !~ v_uuid
      or jsonb_typeof(v_item->'versionNumber') is distinct from 'number'
      or coalesce(v_item->>'versionNumber','') !~ '^[1-9][0-9]{0,9}$'
      or jsonb_typeof(v_item->'sizeBytes') is distinct from 'number'
      or coalesce(v_item->>'sizeBytes','') !~ '^[1-9][0-9]{0,8}$'
      or coalesce(v_item->>'checksum','') !~ '^[a-f0-9]{64}$'
      or coalesce(v_item->>'mimeType','') not in ('image/png','image/jpeg','image/gif','image/webp')
      or coalesce(length(v_item->>'storagePath'),0) not between 1 and 1024
      or jsonb_typeof(v_item->'requiresApproval') is distinct from 'boolean'
      or not (v_item ? 'approvalId') then
      raise exception 'invalid publishing artwork identity' using errcode='22023';
    end if;
    if (v_item->>'versionNumber')::bigint > 2147483647 or (v_item->>'sizeBytes')::bigint > 26214400
      or ((v_item->>'requiresApproval')::boolean and coalesce(v_item->>'approvalId','') !~ v_uuid)
      or (not (v_item->>'requiresApproval')::boolean and v_item->'approvalId' <> 'null'::jsonb) then
      raise exception 'invalid publishing artwork identity' using errcode='22023';
    end if;
    v_total := v_total + (v_item->>'sizeBytes')::bigint;
  end loop;
  if v_total > 104857600 then raise exception 'publishing artwork exceeds byte limit' using errcode='22023'; end if;
  select coalesce(array_agg((value->>'assetId')::uuid order by (value->>'assetId')::uuid),'{}'::uuid[]) into v_ids
    from jsonb_array_elements(v_snapshot->'assets');
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_used from (
    select value::uuid as id from jsonb_array_elements_text(v_snapshot->'illustrationAssetIds')
    union select (v_snapshot->>'coverAssetId')::uuid where v_snapshot->'coverAssetId' <> 'null'::jsonb
  ) ids;
  if v_ids is distinct from v_used then
    raise exception 'publishing artwork snapshot does not match used images' using errcode='22023';
  end if;

  -- Match the leased wrapper's edition-first lock order. Row locks stay held
  -- until artifacts, usage, findings and succeeded status commit or roll back.
  select e.* into v_edition from public.editions e where e.id=old.edition_id and e.book_id=old.book_id for share;
  if not found then raise exception 'publishing edition changed' using errcode='40001', detail='bookworm_publishing_snapshot_changed'; end if;
  begin
    if (old.request_json->>'editionUpdatedAt')::timestamptz is distinct from v_edition.updated_at
      or (v_snapshot->>'coverAssetId') is distinct from nullif(v_edition.edition_metadata_json#>>'{cover,asset_id}','') then
      raise exception 'publishing edition changed' using errcode='40001', detail='bookworm_publishing_snapshot_changed';
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid publishing edition version' using errcode='22023';
  end;
  select b.* into v_book from public.books b where b.id=old.book_id for share;
  if not found then raise exception 'publishing book missing' using errcode='40001', detail='bookworm_publishing_snapshot_changed'; end if;
  select m.* into v_member from public.workspace_members m where m.workspace_id=v_book.workspace_id
    and m.user_id=old.created_by for share;
  if not found or v_member.status <> 'active' or v_member.role::text not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'publishing creator can no longer edit book' using errcode='42501';
  end if;

  -- Deterministic asset order, then version and approval, matches scan/review
  -- RPCs' asset-first order. Also protects against operator deletion of versions.
  for v_item in select value from jsonb_array_elements(v_snapshot->'assets') order by (value->>'assetId')::uuid loop
    select a.* into v_asset from public.assets a where a.id=(v_item->>'assetId')::uuid for share;
    if not found or v_asset.workspace_id is distinct from v_book.workspace_id or v_asset.deleted_at is not null
      or v_asset.status::text in ('archived','rejected')
      or v_asset.storage_path is distinct from v_item->>'storagePath'
      or lower(v_asset.checksum) is distinct from v_item->>'checksum'
      or v_asset.mime_type is distinct from v_item->>'mimeType'
      or v_asset.size_bytes is distinct from (v_item->>'sizeBytes')::bigint
      or v_asset.requires_approval is distinct from (v_item->>'requiresApproval')::boolean then
      raise exception 'publishing artwork changed' using errcode='40001', detail='bookworm_publishing_snapshot_changed';
    end if;
    select av.* into v_version from public.asset_versions av where av.asset_id=v_asset.id
      and av.version_number=(v_item->>'versionNumber')::integer for share;
    if not found or v_version.storage_path is distinct from v_asset.storage_path
      or lower(v_version.checksum) is distinct from v_item->>'checksum'
      or v_version.mime_type is distinct from v_asset.mime_type or v_version.size_bytes is distinct from v_asset.size_bytes
      or v_version.scan_status is null or v_version.scan_status not in ('clean','trusted_generated') then
      raise exception 'publishing artwork version changed or unavailable' using errcode='40001', detail='bookworm_publishing_snapshot_changed';
    end if;
    if v_asset.requires_approval then
      select a.* into v_approval from public.approvals a where a.id=(v_item->>'approvalId')::uuid for share;
      if not found or v_asset.status::text <> 'approved'
        or v_approval.workspace_id is distinct from v_book.workspace_id or v_approval.entity_type <> 'asset'
        or v_approval.entity_id is distinct from v_asset.id or v_approval.entity_version_number is distinct from v_version.version_number
        or v_approval.status <> 'approved' or v_approval.superseded_at is not null then
        raise exception 'publishing artwork review changed' using errcode='40001', detail='bookworm_publishing_snapshot_changed';
      end if;
    end if;
  end loop;
  if old.request_json->>'action' = 'export_package' then
    if coalesce(old.request_json->>'sourceRenderJobId','') !~ v_uuid or coalesce(old.request_json->>'sourcePreflightJobId','') !~ v_uuid then
      raise exception 'invalid publishing source proofs' using errcode='22023';
    end if;
    for v_source_id in select id from (values ((old.request_json->>'sourceRenderJobId')::uuid),
      ((old.request_json->>'sourcePreflightJobId')::uuid)) ids(id) order by id loop
      select j.* into v_source from public.publishing_jobs j where j.id=v_source_id for share;
      if not found or v_source.status <> 'succeeded'
        or v_source.book_id is distinct from old.book_id or v_source.edition_id is distinct from old.edition_id
        or v_source.request_json->>'editionUpdatedAt' is distinct from old.request_json->>'editionUpdatedAt'
        or v_source.request_json->>'bookModelSha256' is distinct from old.request_json->>'bookModelSha256'
        or v_source.request_json->'artworkSnapshot' is distinct from v_snapshot
        or v_source.request_json->>'imageSha256' is distinct from old.request_json->>'imageSha256' then
        raise exception 'publishing source artwork proof changed; render and run preflight again' using errcode='40001', detail='bookworm_publishing_snapshot_changed';
      end if;
    end loop;
  end if;
  return new;
end $$;
revoke all on function private.guard_publishing_artwork_completion() from public, anon, authenticated;
create trigger publishing_jobs_artwork_completion
  before update on public.publishing_jobs for each row
  execute function private.guard_publishing_artwork_completion();
