-- Deploy the compatible API first. Review hosted grants and function dependencies,
-- then apply atomically and refresh the PostgREST schema cache.
revoke all on public.audiobook_google_play_export_jobs from public, anon, authenticated;
revoke select (id, workspace_id, book_id, edition_id, created_by, idempotency_key,
  identifier, cover_asset_id, snapshot_json, status, attempts, available_at,
  lease_token, lease_expires_at, cancellation_requested_at, progress_chapters,
  progress_total, error_code, output_storage_path, output_sha256, output_size_bytes,
  total_duration_seconds, created_at, started_at, completed_at)
  on public.audiobook_google_play_export_jobs from public, anon, authenticated;

do $$
declare v_role text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if pg_catalog.has_table_privilege(v_role, 'public.audiobook_google_play_export_jobs', 'SELECT')
      or exists(select 1 from pg_catalog.pg_attribute a
        where a.attrelid = 'public.audiobook_google_play_export_jobs'::regclass
          and a.attnum > 0 and not a.attisdropped
          and pg_catalog.has_column_privilege(v_role, a.attrelid, a.attname, 'SELECT')) then
      raise exception 'unexpected inherited audiobook export SELECT privilege for %; review role grants before migration', v_role;
    end if;
  end loop;
end $$;

grant select (id, workspace_id, book_id, edition_id, status, progress_chapters,
  progress_total, error_code, output_size_bytes, total_duration_seconds, created_at, completed_at)
  on public.audiobook_google_play_export_jobs to authenticated;
do $$
begin
  if exists(select 1 from pg_catalog.pg_attribute a
    where a.attrelid='public.audiobook_google_play_export_jobs'::regclass and a.attnum>0 and not a.attisdropped
      and pg_catalog.has_column_privilege('anon', a.attrelid, a.attname, 'SELECT')) then
    raise exception 'anon inherits audiobook export SELECT through another role; review role grants before migration';
  end if;
end $$;

-- Keep prior SECURITY DEFINER implementations privileged and restore their
-- public signatures with sanitized composite return values.
alter function public.queue_audiobook_google_play_export(uuid, text, uuid, text) set schema private;
alter function private.queue_audiobook_google_play_export(uuid, text, uuid, text) rename to audio_export_queue_unredacted_v1;
alter function public.cancel_audiobook_google_play_export(uuid) set schema private;
alter function private.cancel_audiobook_google_play_export(uuid) rename to audio_export_cancel_unredacted_v1;
revoke all on function private.audio_export_queue_unredacted_v1(uuid, text, uuid, text),
  private.audio_export_cancel_unredacted_v1(uuid) from public, anon, authenticated, service_role;

create function private.audio_export_public_v1(p_job public.audiobook_google_play_export_jobs)
returns public.audiobook_google_play_export_jobs
language plpgsql immutable set search_path = '' as $$
declare v_public public.audiobook_google_play_export_jobs;
begin
  -- Start with a blank row. Any future columns remain NULL unless explicitly
  -- included in this allowlist and reviewed.
  v_public.id := p_job.id;
  v_public.workspace_id := p_job.workspace_id;
  v_public.book_id := p_job.book_id;
  v_public.edition_id := p_job.edition_id;
  v_public.status := p_job.status;
  v_public.progress_chapters := p_job.progress_chapters;
  v_public.progress_total := p_job.progress_total;
  v_public.error_code := p_job.error_code;
  v_public.output_size_bytes := p_job.output_size_bytes;
  v_public.total_duration_seconds := p_job.total_duration_seconds;
  v_public.created_at := p_job.created_at;
  v_public.completed_at := p_job.completed_at;
  return v_public;
end $$;
revoke all on function private.audio_export_public_v1(public.audiobook_google_play_export_jobs) from public, anon, authenticated, service_role;

create function public.queue_audiobook_google_play_export(p_edition_id uuid, p_identifier text, p_cover_asset_id uuid, p_idempotency_key text)
returns public.audiobook_google_play_export_jobs language sql security definer set search_path = '' as $$
  select private.audio_export_public_v1(private.audio_export_queue_unredacted_v1(p_edition_id, p_identifier, p_cover_asset_id, p_idempotency_key));
$$;
create function public.cancel_audiobook_google_play_export(p_job_id uuid)
returns public.audiobook_google_play_export_jobs language sql security definer set search_path = '' as $$
  select private.audio_export_public_v1(private.audio_export_cancel_unredacted_v1(p_job_id));
$$;
create or replace function public.get_audiobook_google_play_export(p_job_id uuid)
returns public.audiobook_google_play_export_jobs language plpgsql security invoker set search_path = '' as $$
declare v_public public.audiobook_google_play_export_jobs;
begin
  select j.id, j.workspace_id, j.book_id, j.edition_id, j.status, j.progress_chapters,
    j.progress_total, j.error_code, j.output_size_bytes, j.total_duration_seconds, j.created_at, j.completed_at
  into v_public.id, v_public.workspace_id, v_public.book_id, v_public.edition_id, v_public.status,
    v_public.progress_chapters, v_public.progress_total, v_public.error_code, v_public.output_size_bytes,
    v_public.total_duration_seconds, v_public.created_at, v_public.completed_at
  from public.audiobook_google_play_export_jobs j where j.id = p_job_id;
  if not found then return null; end if;
  return v_public;
end $$;
revoke all on function public.queue_audiobook_google_play_export(uuid,text,uuid,text),
  public.cancel_audiobook_google_play_export(uuid), public.get_audiobook_google_play_export(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_audiobook_google_play_export(uuid,text,uuid,text),
  public.cancel_audiobook_google_play_export(uuid), public.get_audiobook_google_play_export(uuid) to authenticated;

-- Moving the old functions retains their ACLs, including grants inherited
-- through other roles. Fail atomically rather than leaving an unredacted path.
do $$
declare v_role text; v_function regprocedure;
begin
  foreach v_role in array array['anon','authenticated'] loop
    foreach v_function in array array[
      'private.audio_export_queue_unredacted_v1(uuid,text,uuid,text)'::regprocedure,
      'private.audio_export_cancel_unredacted_v1(uuid)'::regprocedure,
      'private.audio_export_public_v1(public.audiobook_google_play_export_jobs)'::regprocedure
    ] loop
      if pg_catalog.has_function_privilege(v_role, v_function, 'EXECUTE') then
        raise exception 'unexpected inherited unredacted audiobook RPC EXECUTE privilege for %; review role grants before migration', v_role;
      end if;
    end loop;
  end loop;
  foreach v_function in array array[
    'public.queue_audiobook_google_play_export(uuid,text,uuid,text)'::regprocedure,
    'public.cancel_audiobook_google_play_export(uuid)'::regprocedure,
    'public.get_audiobook_google_play_export(uuid)'::regprocedure
  ] loop
    if pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE') then
      raise exception 'anon inherits audiobook RPC EXECUTE through another role; review role grants before migration';
    end if;
  end loop;
end $$;
