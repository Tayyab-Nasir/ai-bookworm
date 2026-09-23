-- Durable author-requested Google Play audiobook package preparation.
-- The snapshot contains identity/hash pointers only: no manuscript or audio bytes.
create table public.audiobook_google_play_export_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  identifier text not null check (identifier ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  cover_asset_id uuid not null references public.assets(id),
  snapshot_json jsonb not null check (
    jsonb_typeof(snapshot_json)='object'
    and octet_length(snapshot_json::text)<=262144
    and jsonb_typeof(snapshot_json->'chapters')='array'
    and jsonb_array_length(snapshot_json->'chapters') between 1 and 250
  ),
  status public.job_status not null default 'queued',
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  cancellation_requested_at timestamptz,
  progress_chapters integer not null default 0 check (progress_chapters between 0 and 250),
  progress_total integer not null check (progress_total between 1 and 250),
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  output_storage_path text,
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[a-f0-9]{64}$'),
  output_size_bytes bigint check (output_size_bytes is null or output_size_bytes between 1 and 4026531840),
  total_duration_seconds integer check (total_duration_seconds is null or total_duration_seconds between 300 and 360000),
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  unique(created_by,idempotency_key),
  check ((status='succeeded') = (output_storage_path is not null and output_sha256 is not null and output_size_bytes is not null)),
  check (progress_chapters<=progress_total),
  check ((lease_token is null)=(lease_expires_at is null))
);

create index audiobook_google_play_export_poll
  on public.audiobook_google_play_export_jobs(available_at,created_at)
  where status in ('queued','running');
create index audiobook_google_play_export_workspace
  on public.audiobook_google_play_export_jobs(workspace_id,created_at desc);

alter table public.audiobook_google_play_export_jobs enable row level security;
create policy audiobook_google_play_export_member_read
  on public.audiobook_google_play_export_jobs for select to authenticated
  using (private.is_workspace_member(workspace_id));
revoke all on public.audiobook_google_play_export_jobs from public,anon,authenticated,service_role;
grant select on public.audiobook_google_play_export_jobs to authenticated;
grant select,insert,update on public.audiobook_google_play_export_jobs to service_role;

create function public.queue_audiobook_google_play_export(
  p_edition_id uuid,p_identifier text,p_cover_asset_id uuid,p_idempotency_key text
) returns public.audiobook_google_play_export_jobs
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_workspace uuid; v_book uuid; v_title text; v_author text;
  v_job public.audiobook_google_play_export_jobs; v_cover public.assets; v_chapters jsonb;
  v_count integer; v_active integer; v_numeric text; v_sum integer; v_index integer;
begin
  if v_actor is null or p_edition_id is null or p_cover_asset_id is null
    or p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200
    or p_identifier is null or p_identifier !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' then
    raise exception 'invalid audiobook export request' using errcode='22023';
  end if;
  v_numeric:=case when p_identifier ~ '^97[89][0-9]{10}$' then p_identifier else null end;
  if v_numeric is not null then
    v_sum:=0;
    for v_index in 1..12 loop
      v_sum:=v_sum+substring(v_numeric from v_index for 1)::integer*case when v_index%2=0 then 3 else 1 end;
    end loop;
    if (10-v_sum%10)%10<>substring(v_numeric from 13 for 1)::integer then
      raise exception 'invalid audiobook identifier' using errcode='22023';
    end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bookworm-audio-export:'||v_actor::text||':'||p_idempotency_key,0));
  select * into v_job from public.audiobook_google_play_export_jobs
    where created_by=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if not private.can_approve_workspace(v_job.workspace_id) then
      raise exception 'workspace approver required' using errcode='42501';
    end if;
    if v_job.edition_id<>p_edition_id or v_job.identifier<>p_identifier or v_job.cover_asset_id<>p_cover_asset_id then
      raise exception 'audiobook export idempotency conflict' using errcode='23505';
    end if;
    return v_job;
  end if;
  select b.workspace_id,b.id,b.title,b.author_name into v_workspace,v_book,v_title,v_author
    from public.editions e join public.books b on b.id=e.book_id
    where e.id=p_edition_id and e.type='audiobook' for share of e,b;
  if not found then raise exception 'audiobook edition not found' using errcode='P0002'; end if;
  if not private.can_approve_workspace(v_workspace) then
    raise exception 'workspace approver required' using errcode='42501';
  end if;
  perform 1 from public.workspaces where id=v_workspace for update;
  select count(*) into v_active from public.audiobook_google_play_export_jobs
    where workspace_id=v_workspace and status in ('queued','running');
  if v_active>=2 then raise exception 'workspace export queue is full' using errcode='54000'; end if;
  select * into v_cover from public.assets a where a.id=p_cover_asset_id and a.workspace_id=v_workspace
    and a.deleted_at is null and a.mime_type in ('image/jpeg','image/png')
    and a.size_bytes between 1 and 26214400
    and a.storage_path like ('workspaces/'||v_workspace::text||'/%')
    and a.checksum ~ '^[a-f0-9]{64}$' for share;
  if not found then raise exception 'invalid audiobook cover' using errcode='22023'; end if;
  select count(*) into v_count from public.chapters c where c.book_id=v_book;
  if v_count not between 1 and 250 or exists(
    select 1 from public.chapters c where c.book_id=v_book and c.current_document_version_id is null
  ) then raise exception 'saved audiobook chapters required' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'chapterId',c.id,'orderIndex',c.order_index,'title',c.title,
    'documentVersionId',c.current_document_version_id,
    'projectId',p.id,'reportId',r.id,
    'sourceManifestSha256',r.source_manifest_sha256,'audioSha256',r.audio_sha256
  ) order by c.order_index,c.id),'[]'::jsonb) into v_chapters
  from public.chapters c
  join lateral (
    select ap.id from public.audiobook_projects ap
    where ap.chapter_id=c.id and ap.edition_id=p_edition_id and ap.book_id=v_book
      and ap.workspace_id=v_workspace and ap.document_version_id=c.current_document_version_id and ap.status='succeeded'
    order by ap.created_at desc,ap.id limit 1
  ) p on true
  join lateral (
    select qr.id,qr.source_manifest_sha256,qr.audio_sha256 from public.audiobook_qc_reports qr
    where qr.project_id=p.id and qr.document_version_id=c.current_document_version_id
      and exists(select 1 from public.audiobook_qc_signoffs qs where qs.report_id=qr.id)
    order by qr.created_at desc,qr.id limit 1
  ) r on true
  where c.book_id=v_book;
  if jsonb_array_length(v_chapters)<>v_count then
    raise exception 'current narration and signed quality review required for every chapter' using errcode='22023';
  end if;
  insert into public.audiobook_google_play_export_jobs(
    workspace_id,book_id,edition_id,created_by,idempotency_key,identifier,cover_asset_id,
    snapshot_json,progress_total
  ) values (
    v_workspace,v_book,p_edition_id,v_actor,p_idempotency_key,p_identifier,p_cover_asset_id,
    jsonb_build_object('title',left(v_title,500),'author',left(coalesce(v_author,''),300),
      'coverMimeType',v_cover.mime_type,'coverStoragePath',v_cover.storage_path,
      'coverSizeBytes',v_cover.size_bytes,'coverSha256',lower(v_cover.checksum),'chapters',v_chapters),v_count
  ) returning * into v_job;
  return v_job;
end $$;

create function public.claim_audiobook_google_play_export(p_lease_seconds integer default 300)
returns setof public.audiobook_google_play_export_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.audiobook_google_play_export_jobs;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds not between 60 and 900 then raise exception 'invalid lease duration' using errcode='22023'; end if;
  update public.audiobook_google_play_export_jobs set status='cancelled',completed_at=clock_timestamp(),
    lease_token=null,lease_expires_at=null,error_code=null
    where cancellation_requested_at is not null and (
      status='queued' or (status='running' and lease_expires_at<=clock_timestamp())
    );
  for v_job in select j.* from public.audiobook_google_play_export_jobs j
    where j.cancellation_requested_at is null and j.attempts<5 and (
      (j.status='queued' and j.available_at<=clock_timestamp()) or
      (j.status='running' and j.lease_expires_at<=clock_timestamp())
    ) order by j.available_at,j.created_at,j.id for update skip locked limit 1
  loop
    update public.audiobook_google_play_export_jobs set status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      started_at=coalesce(started_at,clock_timestamp()),completed_at=null,error_code=null,progress_chapters=0
      where id=v_job.id returning * into v_job;
    return next v_job; return;
  end loop;
  update public.audiobook_google_play_export_jobs set status='failed',error_code='export_attempts_exhausted',
    completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null
    where status in ('queued','running') and attempts>=5 and cancellation_requested_at is null
      and (status='queued' or lease_expires_at<=clock_timestamp());
end $$;

create function public.heartbeat_audiobook_google_play_export(
  p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 300
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.audiobook_google_play_export_jobs;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds not between 60 and 900 then raise exception 'invalid lease duration' using errcode='22023'; end if;
  update public.audiobook_google_play_export_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>clock_timestamp()
    returning * into v_job;
  if not found then return jsonb_build_object('leased',false,'cancelled',false); end if;
  return jsonb_build_object('leased',true,'cancelled',v_job.cancellation_requested_at is not null);
end $$;

create function public.progress_audiobook_google_play_export(
  p_job_id uuid,p_lease_token uuid,p_progress integer
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.audiobook_google_play_export_jobs;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.audiobook_google_play_export_jobs where id=p_job_id for update;
  if not found or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at<=clock_timestamp() then raise exception 'worker lease lost' using errcode='40001'; end if;
  if v_job.cancellation_requested_at is not null then return false; end if;
  if p_progress not between v_job.progress_chapters and v_job.progress_total then raise exception 'invalid export progress' using errcode='22023'; end if;
  update public.audiobook_google_play_export_jobs set progress_chapters=p_progress where id=p_job_id;
  return true;
end $$;

create function public.cancel_audiobook_google_play_export(p_job_id uuid)
returns public.audiobook_google_play_export_jobs
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_job public.audiobook_google_play_export_jobs;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into v_job from public.audiobook_google_play_export_jobs where id=p_job_id for update;
  if not found or not private.is_workspace_member(v_job.workspace_id) then raise exception 'export job not found' using errcode='P0002'; end if;
  if not private.can_approve_workspace(v_job.workspace_id) then
    raise exception 'workspace approver required' using errcode='42501';
  end if;
  if v_job.status='queued' then
    update public.audiobook_google_play_export_jobs set status='cancelled',completed_at=clock_timestamp(),
      error_code=null where id=p_job_id returning * into v_job;
  elsif v_job.status='running' then
    update public.audiobook_google_play_export_jobs set cancellation_requested_at=coalesce(cancellation_requested_at,clock_timestamp())
      where id=p_job_id returning * into v_job;
  end if;
  return v_job;
end $$;

create function public.fail_audiobook_google_play_export(
  p_job_id uuid,p_lease_token uuid,p_error_code text,p_retryable boolean default true
) returns public.audiobook_google_play_export_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.audiobook_google_play_export_jobs; v_terminal boolean;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' or p_retryable is null then raise exception 'invalid failure' using errcode='22023'; end if;
  select * into v_job from public.audiobook_google_play_export_jobs where id=p_job_id for update;
  if not found then raise exception 'job not found' using errcode='P0002'; end if;
  if v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'worker lease lost' using errcode='40001'; end if;
  if v_job.cancellation_requested_at is not null then
    update public.audiobook_google_play_export_jobs set status='cancelled',completed_at=clock_timestamp(),
      lease_token=null,lease_expires_at=null,error_code=null where id=p_job_id returning * into v_job;
    return v_job;
  end if;
  v_terminal:=not p_retryable or v_job.attempts>=5;
  update public.audiobook_google_play_export_jobs set status=(case when v_terminal then 'failed' else 'queued' end)::public.job_status,
    completed_at=case when v_terminal then clock_timestamp() else null end,
    available_at=clock_timestamp()+make_interval(secs=>least(3600,(5*power(2,least(v_job.attempts-1,10)))::integer)),
    lease_token=null,lease_expires_at=null,error_code=p_error_code where id=p_job_id returning * into v_job;
  return v_job;
end $$;

create function public.complete_audiobook_google_play_export(
  p_job_id uuid,p_lease_token uuid,p_storage_path text,p_size_bytes bigint,p_sha256 text,p_duration_seconds integer
) returns public.audiobook_google_play_export_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.audiobook_google_play_export_jobs;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.audiobook_google_play_export_jobs where id=p_job_id for update;
  if not found then raise exception 'job not found' using errcode='P0002'; end if;
  if v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp() then raise exception 'worker lease lost' using errcode='40001'; end if;
  if v_job.cancellation_requested_at is not null then raise exception 'export cancelled' using errcode='57014'; end if;
  if p_storage_path<>format('workspaces/%s/audiobook-exports/%s/%s.zip',v_job.workspace_id,v_job.id,p_lease_token)
    or p_size_bytes not between 1 and 4026531840 or p_sha256 !~ '^[a-f0-9]{64}$'
    or p_duration_seconds not between 300 and 360000 or v_job.progress_chapters<>v_job.progress_total then
    raise exception 'invalid audiobook export completion' using errcode='22023';
  end if;
  update public.audiobook_google_play_export_jobs set status='succeeded',output_storage_path=p_storage_path,
    output_size_bytes=p_size_bytes,output_sha256=p_sha256,total_duration_seconds=p_duration_seconds,
    completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,error_code=null
    where id=p_job_id returning * into v_job;
  return v_job;
end $$;

create function public.get_audiobook_google_play_export(p_job_id uuid)
returns public.audiobook_google_play_export_jobs
language sql security invoker set search_path=public,pg_temp as $$
  select j.* from public.audiobook_google_play_export_jobs j where j.id=p_job_id
$$;

revoke all on function public.queue_audiobook_google_play_export(uuid,text,uuid,text),
  public.cancel_audiobook_google_play_export(uuid),public.get_audiobook_google_play_export(uuid)
  from public,anon;
grant execute on function public.queue_audiobook_google_play_export(uuid,text,uuid,text),
  public.cancel_audiobook_google_play_export(uuid),public.get_audiobook_google_play_export(uuid)
  to authenticated;
revoke all on function public.claim_audiobook_google_play_export(integer),
  public.heartbeat_audiobook_google_play_export(uuid,uuid,integer),
  public.progress_audiobook_google_play_export(uuid,uuid,integer),
  public.fail_audiobook_google_play_export(uuid,uuid,text,boolean),
  public.complete_audiobook_google_play_export(uuid,uuid,text,bigint,text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_audiobook_google_play_export(integer),
  public.heartbeat_audiobook_google_play_export(uuid,uuid,integer),
  public.progress_audiobook_google_play_export(uuid,uuid,integer),
  public.fail_audiobook_google_play_export(uuid,uuid,text,boolean),
  public.complete_audiobook_google_play_export(uuid,uuid,text,bigint,text,integer)
  to service_role;
