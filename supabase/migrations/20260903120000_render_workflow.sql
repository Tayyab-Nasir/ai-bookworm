-- A render is a durable publishing job. Artifact metadata and metered usage are
-- committed together after the private objects have been uploaded.

alter table public.publishing_jobs
  add column if not exists created_by uuid references auth.users(id);
alter table public.usage_events
  add column if not exists publishing_job_id uuid references public.publishing_jobs(id) on delete set null;

create unique index if not exists usage_events_rendering_job_key
  on public.usage_events(publishing_job_id)
  where publishing_job_id is not null and meter = 'rendering';

create or replace function public.complete_render_job(
  p_job_id uuid,
  p_artifacts jsonb,
  p_renderer_version text,
  p_usage jsonb
) returns public.publishing_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.publishing_jobs;
  v_book public.books;
  v_organization_id uuid;
  v_item jsonb;
  v_asset_id uuid;
  v_path text;
  v_type text;
  v_mime text;
  v_role text;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_artifacts) is distinct from 'array'
    or jsonb_array_length(p_artifacts) not between 1 and 2
    or octet_length(p_artifacts::text) > 100000
    or coalesce(length(trim(p_renderer_version)), 0) not between 1 and 200
    or jsonb_typeof(p_usage) is distinct from 'object'
    or octet_length(p_usage::text) > 100000
  then
    raise exception 'invalid render completion' using errcode = '22023';
  end if;

  select p.* into v_job from public.publishing_jobs p where p.id = p_job_id for update;
  if not found then raise exception 'render job not found' using errcode = 'P0002'; end if;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.status <> 'running' or v_job.channel <> 'render' or v_job.created_by is null then
    raise exception 'render job cannot be completed' using errcode = '40001';
  end if;
  select b.* into v_book from public.books b where b.id = v_job.book_id;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;
  select w.organization_id into v_organization_id from public.workspaces w where w.id = v_book.workspace_id;

  for v_item in select value from jsonb_array_elements(p_artifacts)
  loop
    begin
      v_asset_id := (v_item->>'assetId')::uuid;
    exception when others then
      raise exception 'invalid artifact asset id' using errcode = '22023';
    end;
    v_path := v_item->>'storagePath';
    v_type := v_item->>'type';
    v_mime := v_item->>'mimeType';
    v_role := v_item->>'role';
    if coalesce(length(v_item->>'name'), 0) not between 1 and 256
      or v_type not in ('rendered_book', 'rendered_cover')
      or v_role not in ('rendered_ebook', 'rendered_print', 'rendered_cover')
      or v_mime not in ('application/epub+zip', 'application/pdf', 'image/png')
      or (v_item->>'sizeBytes') !~ '^[0-9]+$'
      or (v_item->>'sizeBytes')::numeric not between 1 and 157286400
      or (v_item->>'checksum') !~ '^[a-f0-9]{64}$'
      or v_path <> format('workspaces/%s/assets/%s/v1/%s', v_book.workspace_id, v_asset_id, v_item->>'filename')
      or (v_item->>'filename') !~ '^[a-zA-Z0-9._-]{1,128}$'
    then
      raise exception 'invalid render artifact' using errcode = '22023';
    end if;

    insert into public.assets(
      id, workspace_id, type, name, storage_path, mime_type, size_bytes, checksum, status, created_by
    ) values (
      v_asset_id, v_book.workspace_id, v_type, v_item->>'name', v_path, v_mime,
      (v_item->>'sizeBytes')::bigint, v_item->>'checksum', 'draft', v_job.created_by
    );
    insert into public.asset_versions(
      asset_id, version_number, storage_path, checksum, mime_type, size_bytes, created_by
    ) values (
      v_asset_id, 1, v_path, v_item->>'checksum', v_mime,
      (v_item->>'sizeBytes')::bigint, v_job.created_by
    );
    insert into public.asset_links(asset_id, entity_type, entity_id, usage_role)
    values (v_asset_id, 'book', v_job.book_id, v_role);
  end loop;

  insert into public.usage_events(
    publishing_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json
  ) values (
    v_job.id, v_organization_id, v_job.created_by, v_book.workspace_id, 'rendering', 1,
    jsonb_build_object('publishingJobId', v_job.id, 'editionId', v_job.edition_id, 'rendererVersion', trim(p_renderer_version))
  );
  insert into public.activity_events(workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (v_book.workspace_id, v_job.created_by, 'edition_rendered', 'edition', v_job.edition_id,
          jsonb_build_object('publishingJobId', v_job.id, 'artifactCount', jsonb_array_length(p_artifacts)));

  update public.publishing_jobs
  set status='succeeded', response_json=jsonb_build_object(
        'artifacts', p_artifacts, 'rendererVersion', trim(p_renderer_version), 'usage', p_usage
      ), completed_at=now()
  where id=v_job.id returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.complete_render_job(uuid,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.complete_render_job(uuid,jsonb,text,jsonb) to service_role;
