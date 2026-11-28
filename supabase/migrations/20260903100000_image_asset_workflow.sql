-- Generated images use the existing durable AI job ledger. The provider call
-- happens before this RPC; this function atomically records the private asset,
-- immutable version, book link, model run, metered usage, and succeeded job.

alter table public.asset_versions
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint;

update public.asset_versions av
set mime_type = a.mime_type,
    size_bytes = a.size_bytes
from public.assets a
where a.id = av.asset_id
  and (av.mime_type is null or av.size_bytes is null);

create unique index if not exists usage_events_image_credits_job_key
  on public.usage_events(ai_job_id)
  where ai_job_id is not null and meter = 'image_credits';

create or replace function public.complete_image_job(
  p_job_id uuid,
  p_asset_id uuid,
  p_asset_name text,
  p_asset_type text,
  p_folder_id uuid,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum text,
  p_link_role text,
  p_provider text,
  p_model text,
  p_usage jsonb
) returns public.ai_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_jobs;
  v_organization_id uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_job_id is null
    or p_asset_id is null
    or coalesce(length(trim(p_asset_name)), 0) not between 1 and 256
    or p_asset_type not in ('illustration', 'cover')
    or p_link_role not in ('illustration', 'front_cover')
    or p_mime_type <> 'image/png'
    or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400
    or p_checksum !~ '^[a-f0-9]{64}$'
    or coalesce(length(trim(p_provider)), 0) not between 1 and 200
    or coalesce(length(trim(p_model)), 0) not between 1 and 200
    or jsonb_typeof(p_usage) is distinct from 'object'
    or octet_length(p_usage::text) > 100000
    or jsonb_typeof(p_usage->'inputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'outputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'estimatedCostUsd') is distinct from 'number'
    or jsonb_typeof(p_usage->'latencyMs') is distinct from 'number'
    or p_usage->>'inputTokens' !~ '^[0-9]+$'
    or p_usage->>'outputTokens' !~ '^[0-9]+$'
    or p_usage->>'latencyMs' !~ '^[0-9]+$'
    or (p_usage->>'inputTokens')::numeric > 2147483647
    or (p_usage->>'outputTokens')::numeric > 2147483647
    or (p_usage->>'latencyMs')::numeric > 2147483647
    or (p_usage->>'estimatedCostUsd')::numeric < 0
    or (p_usage->>'estimatedCostUsd')::numeric > 99999999
  then
    raise exception 'invalid image completion' using errcode = '22023';
  end if;

  select j.* into v_job
  from public.ai_jobs j
  where j.id = p_job_id
  for update;
  if not found then
    raise exception 'image job not found' using errcode = 'P0002';
  end if;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.status <> 'running' or v_job.agent_type not in ('illustrator', 'cover_designer') then
    raise exception 'image job cannot be completed' using errcode = '40001';
  end if;

  if p_storage_path <> format(
    'workspaces/%s/assets/%s/v1/generated.png', v_job.workspace_id, p_asset_id
  ) then
    raise exception 'invalid asset path' using errcode = '22023';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.folders f where f.id = p_folder_id and f.workspace_id = v_job.workspace_id
  ) then
    raise exception 'folder does not belong to workspace' using errcode = '22023';
  end if;
  if v_job.book_id is not null and not exists (
    select 1 from public.books b where b.id = v_job.book_id and b.workspace_id = v_job.workspace_id
  ) then
    raise exception 'book does not belong to workspace' using errcode = '22023';
  end if;

  select w.organization_id into v_organization_id
  from public.workspaces w where w.id = v_job.workspace_id;
  if v_organization_id is null then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;

  insert into public.assets(
    id, workspace_id, folder_id, type, name, storage_path, mime_type,
    size_bytes, checksum, status, created_by
  ) values (
    p_asset_id, v_job.workspace_id, p_folder_id, p_asset_type, trim(p_asset_name),
    p_storage_path, p_mime_type, p_size_bytes, p_checksum, 'draft', v_job.created_by
  );

  insert into public.asset_versions(
    asset_id, version_number, storage_path, checksum, mime_type, size_bytes, created_by
  ) values (
    p_asset_id, 1, p_storage_path, p_checksum, p_mime_type, p_size_bytes, v_job.created_by
  );

  if v_job.book_id is not null then
    insert into public.asset_links(asset_id, entity_type, entity_id, usage_role)
    values (p_asset_id, 'book', v_job.book_id, p_link_role);
  end if;

  insert into public.ai_runs(
    ai_job_id, workspace_id, provider, model, tokens_in, tokens_out,
    estimated_cost, latency_ms, status
  ) values (
    v_job.id, v_job.workspace_id, trim(p_provider), trim(p_model),
    greatest(coalesce((p_usage->>'inputTokens')::integer, 0), 0),
    greatest(coalesce((p_usage->>'outputTokens')::integer, 0), 0),
    greatest(coalesce((p_usage->>'estimatedCostUsd')::numeric, 0), 0),
    greatest(coalesce((p_usage->>'latencyMs')::integer, 0), 0),
    'succeeded'
  );

  insert into public.usage_events(
    ai_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json
  ) values (
    v_job.id, v_organization_id, v_job.created_by, v_job.workspace_id,
    'image_credits', 1,
    jsonb_build_object(
      'aiJobId', v_job.id,
      'assetId', p_asset_id,
      'provider', trim(p_provider),
      'model', trim(p_model),
      'size', v_job.input_ref->>'size',
      'quality', v_job.input_ref->>'quality'
    )
  );

  insert into public.activity_events(
    workspace_id, actor_id, event_type, entity_type, entity_id, payload_json
  ) values (
    v_job.workspace_id, v_job.created_by, 'asset_generated', 'asset', p_asset_id,
    jsonb_build_object('aiJobId', v_job.id, 'assetType', p_asset_type)
  );

  update public.ai_jobs
  set status = 'succeeded',
      output_ref = jsonb_build_object('assetId', p_asset_id, 'provider', trim(p_provider)),
      model = trim(p_model),
      usage_json = p_usage,
      completed_at = now(),
      error_code = null,
      error_message = null
  where id = v_job.id
  returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.complete_image_job(
  uuid, uuid, text, text, uuid, text, text, bigint, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_image_job(
  uuid, uuid, text, text, uuid, text, text, bigint, text, text, text, text, jsonb
) to service_role;
