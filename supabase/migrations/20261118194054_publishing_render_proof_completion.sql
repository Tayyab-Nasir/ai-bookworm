-- Hold the verified render and its asset versions through the same transaction
-- that records the package, activity and usage. Bytes are checked by the API.
-- This trigger runs after publishing_jobs_artwork_completion, which locks the
-- edition, book, membership, artwork and the package's source jobs.
create function private.guard_publishing_render_proof_completion()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_render_id text; v_preflight public.publishing_jobs; v_render public.publishing_jobs;
  v_selection jsonb; v_descriptors jsonb; v_item jsonb; v_workspace uuid; v_kind text;
  v_asset public.assets; v_version public.asset_versions; v_asset_id uuid;
  v_filename text; v_checksum text; v_mime text; v_type text; v_size bigint; v_path text;
  v_primary_count integer := 0; v_total bigint := 0;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_message constant text := 'publishing render proof is no longer verified';
  v_detail constant text := 'bookworm_publishing_render_proof_changed';
begin
  if old.request_json->>'action' = 'export_package' then
    v_render_id := old.request_json->>'sourceRenderJobId';
    select j.* into v_preflight from public.publishing_jobs j
      where j.id = (old.request_json->>'sourcePreflightJobId')::uuid for share;
    if not found or v_preflight.status <> 'succeeded' or v_preflight.channel <> old.channel
      or v_preflight.request_json->>'action' is distinct from 'validate'
      or v_preflight.request_json->'sourceEpub' is distinct from v_preflight.response_json->'sourceEpub' then
      raise exception '%', v_message using errcode = '40001', detail = v_detail;
    end if;
    v_selection := v_preflight.request_json->'sourceEpub';
  elsif old.request_json->>'action' = 'validate' and old.request_json ? 'sourceEpub' then
    v_selection := old.request_json->'sourceEpub';
    v_render_id := v_selection->>'jobId';
    if new.response_json->'sourceEpub' is distinct from v_selection then
      raise exception '%', v_message using errcode = '40001', detail = v_detail;
    end if;
  else
    return new;
  end if;

  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select b.workspace_id, e.type::text into v_workspace, v_kind
  from public.editions e join public.books b on b.id = e.book_id
  where e.id = old.edition_id and b.id = old.book_id;
  if not found or v_kind not in ('ebook','print') or coalesce(v_render_id,'') !~ v_uuid
    or (v_selection is not null and (v_kind <> 'ebook' or jsonb_typeof(v_selection) <> 'object'
      or v_selection->>'jobId' is distinct from v_render_id or coalesce(v_selection->>'sha256','') !~ '^[0-9a-f]{64}$')) then
    raise exception '%', v_message using errcode = '40001', detail = v_detail;
  end if;

  select j.* into v_render from public.publishing_jobs j where j.id = v_render_id::uuid for share;
  if not found or v_render.status <> 'succeeded' or v_render.channel <> 'render'
    or v_render.request_json->>'action' is distinct from 'render'
    or v_render.edition_id is distinct from old.edition_id or v_render.book_id is distinct from old.book_id
    or v_render.request_json->>'editionUpdatedAt' is distinct from old.request_json->>'editionUpdatedAt'
    or v_render.request_json->>'bookModelSha256' is distinct from old.request_json->>'bookModelSha256'
    or v_render.request_json->>'imageSha256' is distinct from old.request_json->>'imageSha256'
    or v_render.request_json->'artworkSnapshot' is distinct from old.request_json->'artworkSnapshot' then
    raise exception '%', v_message using errcode = '40001', detail = v_detail;
  end if;
  v_descriptors := v_render.response_json->'artifacts';
  if jsonb_typeof(v_descriptors) is distinct from 'array' then
    raise exception '%', v_message using errcode = '40001', detail = v_detail;
  end if;
  if jsonb_array_length(v_descriptors) not between 1 and 2 then
    raise exception '%', v_message using errcode = '40001', detail = v_detail;
  end if;

  -- Asset first, then its version, in the same order as scan and removal.
  for v_item in select value from jsonb_array_elements(v_descriptors) order by value->>'assetId' loop
    v_filename := v_item->>'filename';
    v_mime := v_item->>'mimeType';
    v_type := v_item->>'type';
    v_checksum := lower(v_item->>'checksum');
    if coalesce(v_item->>'assetId','') !~ v_uuid or coalesce(v_checksum,'') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(v_item->'sizeBytes') is distinct from 'number'
      or coalesce(v_item->>'sizeBytes','') !~ '^[1-9][0-9]{0,8}$' then
      raise exception '%', v_message using errcode = '40001', detail = v_detail;
    end if;
    if v_type = 'rendered_book' and (
      (v_kind = 'ebook' and v_item->>'role' = 'rendered_ebook' and v_filename = 'book.epub' and v_mime = 'application/epub+zip')
      or (v_kind = 'print' and v_item->>'role' = 'rendered_print' and v_filename = 'book.pdf' and v_mime = 'application/pdf')) then
      v_primary_count := v_primary_count + 1;
      if v_selection is not null and v_checksum is distinct from v_selection->>'sha256' then
        raise exception '%', v_message using errcode = '40001', detail = v_detail;
      end if;
    elsif v_type is distinct from 'rendered_cover' or v_item->>'role' is distinct from 'rendered_cover'
      or not coalesce((v_filename = 'cover.png' and v_mime = 'image/png')
        or (v_kind = 'print' and v_filename = 'cover.pdf' and v_mime = 'application/pdf'), false) then
      raise exception '%', v_message using errcode = '40001', detail = v_detail;
    end if;

    v_asset_id := (v_item->>'assetId')::uuid;
    v_size := (v_item->>'sizeBytes')::bigint;
    v_total := v_total + v_size;
    v_path := 'workspaces/' || v_workspace || '/assets/' || v_asset_id || '/v1/' || v_filename;
    select a.* into v_asset from public.assets a where a.id = v_asset_id for share;
    if not found or v_size > 157286400 or v_total > 183500800
      or v_item->>'storagePath' is distinct from v_path or v_asset.workspace_id is distinct from v_workspace
      or v_asset.deleted_at is not null or coalesce(v_asset.status::text,'') not in ('draft','in_review','approved')
      or v_asset.type is distinct from v_type or v_asset.storage_path is distinct from v_path
      or lower(v_asset.checksum) is distinct from v_checksum or v_asset.mime_type is distinct from v_mime
      or v_asset.size_bytes is distinct from v_size then
      raise exception '%', v_message using errcode = '40001', detail = v_detail;
    end if;
    select av.* into v_version from public.asset_versions av
    where av.asset_id = v_asset_id and av.version_number = 1 for share;
    if not found or v_version.storage_path is distinct from v_path or lower(v_version.checksum) is distinct from v_checksum
      or v_version.mime_type is distinct from v_mime or v_version.size_bytes is distinct from v_size
      or coalesce(v_version.scan_status,'') not in ('clean','trusted_generated') then
      raise exception '%', v_message using errcode = '40001', detail = v_detail;
    end if;
  end loop;
  if v_primary_count <> 1 then raise exception '%', v_message using errcode = '40001', detail = v_detail; end if;
  return new;
end $$;

revoke all on function private.guard_publishing_render_proof_completion() from public, anon, authenticated;
create trigger publishing_jobs_render_proof_completion
  before update of status on public.publishing_jobs for each row
  when (old.status is distinct from 'succeeded' and new.status = 'succeeded'
    and new.channel in ('kdp','apple','barnesnoble','lulu','googleplay'))
  execute function private.guard_publishing_render_proof_completion();
