-- A retailer export package is derived only from a successful render and a
-- zero-error preflight for the same saved BookModel + edition configuration.
-- The private ZIP asset and durable job completion commit atomically.

create unique index if not exists usage_events_publishing_job_key
  on public.usage_events(publishing_job_id)
  where publishing_job_id is not null and meter = 'publishing';

create or replace function public.complete_publishing_package_job(
  p_job_id uuid,
  p_artifact jsonb,
  p_rule_version text,
  p_source_render_job_id uuid,
  p_source_preflight_job_id uuid
) returns public.publishing_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.publishing_jobs;
  v_render public.publishing_jobs;
  v_preflight public.publishing_jobs;
  v_book public.books;
  v_edition public.editions;
  v_organization_id uuid;
  v_asset_id uuid;
  v_path text;
  v_filename text;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_artifact) is distinct from 'object'
    or octet_length(p_artifact::text) > 100000
    or coalesce(length(trim(p_rule_version)), 0) not between 1 and 200
    or p_source_render_job_id is null
    or p_source_preflight_job_id is null
  then
    raise exception 'invalid publishing package completion' using errcode = '22023';
  end if;

  select p.* into v_job from public.publishing_jobs p where p.id = p_job_id for update;
  if not found then raise exception 'publishing package job not found' using errcode = 'P0002'; end if;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.status <> 'running' or v_job.created_by is null
    or v_job.channel not in ('kdp','apple','barnesnoble','lulu')
    or v_job.request_json->>'action' <> 'export_package'
    or v_job.edition_id is null
    or v_job.request_json->>'sourceRenderJobId' <> p_source_render_job_id::text
    or v_job.request_json->>'sourcePreflightJobId' <> p_source_preflight_job_id::text
    or coalesce(v_job.request_json->>'bookModelSha256','') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'publishing package job cannot be completed' using errcode = '40001';
  end if;

  select b.* into v_book from public.books b where b.id = v_job.book_id;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;
  select e.* into v_edition from public.editions e where e.id = v_job.edition_id and e.book_id = v_job.book_id;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  begin
    if (v_job.request_json->>'editionUpdatedAt')::timestamptz <> v_edition.updated_at then
      raise exception 'edition changed after package request' using errcode = '40001';
    end if;
  exception when invalid_datetime_format then
    raise exception 'invalid edition version' using errcode = '22023';
  end;

  select p.* into v_render from public.publishing_jobs p where p.id = p_source_render_job_id;
  select p.* into v_preflight from public.publishing_jobs p where p.id = p_source_preflight_job_id;
  if v_render.id is null or v_preflight.id is null
    or v_render.status <> 'succeeded' or v_preflight.status <> 'succeeded'
    or v_render.book_id <> v_job.book_id or v_preflight.book_id <> v_job.book_id
    or v_render.edition_id <> v_job.edition_id or v_preflight.edition_id <> v_job.edition_id
    or v_render.channel <> 'render' or v_preflight.channel <> v_job.channel
    or v_render.request_json->>'action' <> 'render'
    or v_preflight.request_json->>'action' <> 'validate'
    or v_render.request_json->>'editionUpdatedAt' <> v_job.request_json->>'editionUpdatedAt'
    or v_preflight.request_json->>'editionUpdatedAt' <> v_job.request_json->>'editionUpdatedAt'
    or v_render.request_json->>'bookModelSha256' <> v_job.request_json->>'bookModelSha256'
    or v_preflight.request_json->>'bookModelSha256' <> v_job.request_json->>'bookModelSha256'
    or coalesce((v_preflight.response_json->>'errors') ~ '^[0-9]+$', false) is false
    or (v_preflight.response_json->>'errors')::integer <> 0
    or v_preflight.response_json->>'requestedChannel' <> v_job.channel
  then
    raise exception 'source render or preflight is not publishable' using errcode = '22023';
  end if;

  begin
    v_asset_id := (p_artifact->>'assetId')::uuid;
  exception when others then
    raise exception 'invalid package asset id' using errcode = '22023';
  end;
  v_path := p_artifact->>'storagePath';
  v_filename := p_artifact->>'filename';
  if coalesce(length(p_artifact->>'name'), 0) not between 1 and 256
    or p_artifact->>'type' <> 'publishing_package'
    or p_artifact->>'role' <> 'publishing_package'
    or p_artifact->>'mimeType' <> 'application/zip'
    or (p_artifact->>'sizeBytes') !~ '^[0-9]+$'
    or (p_artifact->>'sizeBytes')::numeric not between 1 and 209715200
    or (p_artifact->>'checksum') !~ '^[a-f0-9]{64}$'
    or v_filename <> (v_job.channel || '-export.zip')
    or v_path <> format('workspaces/%s/assets/%s/v1/%s', v_book.workspace_id, v_asset_id, v_filename)
  then
    raise exception 'invalid publishing package artifact' using errcode = '22023';
  end if;

  select w.organization_id into v_organization_id from public.workspaces w where w.id = v_book.workspace_id;
  insert into public.assets(
    id, workspace_id, type, name, storage_path, mime_type, size_bytes, checksum, status, created_by
  ) values (
    v_asset_id, v_book.workspace_id, 'publishing_package', p_artifact->>'name', v_path,
    'application/zip', (p_artifact->>'sizeBytes')::bigint, p_artifact->>'checksum', 'draft', v_job.created_by
  );
  insert into public.asset_versions(
    asset_id, version_number, storage_path, checksum, mime_type, size_bytes, created_by
  ) values (
    v_asset_id, 1, v_path, p_artifact->>'checksum', 'application/zip',
    (p_artifact->>'sizeBytes')::bigint, v_job.created_by
  );
  insert into public.asset_links(asset_id, entity_type, entity_id, usage_role)
  values (v_asset_id, 'edition', v_job.edition_id, 'publishing_package');
  insert into public.usage_events(
    publishing_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json
  ) values (
    v_job.id, v_organization_id, v_job.created_by, v_book.workspace_id, 'publishing', 1,
    jsonb_build_object('publishingJobId', v_job.id, 'editionId', v_job.edition_id,
      'channel', v_job.channel, 'ruleVersion', trim(p_rule_version))
  );
  insert into public.activity_events(workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (v_book.workspace_id, v_job.created_by, 'publishing_package_created', 'edition', v_job.edition_id,
    jsonb_build_object('publishingJobId', v_job.id, 'channel', v_job.channel, 'assetId', v_asset_id));

  update public.publishing_jobs
  set status = 'succeeded', response_json = jsonb_build_object(
      'artifact', p_artifact,
      'ruleVersion', trim(p_rule_version),
      'sourceRenderJobId', p_source_render_job_id,
      'sourcePreflightJobId', p_source_preflight_job_id,
      'submissionMode', 'manual'
    ), completed_at = now()
  where id = v_job.id returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.complete_publishing_package_job(uuid,jsonb,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.complete_publishing_package_job(uuid,jsonb,text,uuid,uuid) to service_role;
