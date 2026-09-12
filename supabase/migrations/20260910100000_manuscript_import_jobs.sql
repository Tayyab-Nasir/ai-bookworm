-- PostgreSQL-backed document execution; no browser token or manuscript in jobs.
create table public.manuscript_import_jobs (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  source_asset_id uuid not null references public.assets(id),
  source_checksum text not null check (source_checksum ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references auth.users(id),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(book_id, source_asset_id)
);
alter table public.manuscript_import_jobs enable row level security;
revoke all on public.manuscript_import_jobs from anon, authenticated;
grant select(id,book_id,source_asset_id,status,attempts,error_code,created_at,available_at,completed_at)
  on public.manuscript_import_jobs to authenticated;
grant all on public.manuscript_import_jobs to service_role;
create policy manuscript_import_job_read on public.manuscript_import_jobs for select to authenticated
  using (exists(select 1 from public.books b where b.id = book_id));
create index manuscript_import_job_poll on public.manuscript_import_jobs(available_at,created_at)
  where status in ('queued','running');

create function public.enqueue_manuscript_import(p_actor_id uuid,p_book_id uuid,p_source_asset_id uuid)
returns public.manuscript_import_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_source public.assets; v_job public.manuscript_import_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if not exists(select 1 from public.books b join public.workspace_members m on m.workspace_id=b.workspace_id
    where b.id=p_book_id and m.user_id=p_actor_id and m.status='active'
      and m.role::text in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'actor cannot import book' using errcode='42501'; end if;
  select a.* into v_source from public.assets a join public.books b on b.workspace_id=a.workspace_id
    where b.id=p_book_id and a.id=p_source_asset_id and a.deleted_at is null;
  if not found or v_source.checksum !~ '^[a-f0-9]{64}$' or v_source.size_bytes not between 1 and 20971520
    or lower(v_source.name) !~ '\.(txt|docx|epub|pdf)$'
    or not exists(select 1 from public.asset_versions av where av.asset_id=v_source.id
      and av.storage_path=v_source.storage_path and av.checksum=v_source.checksum and av.scan_status='clean') then
    raise exception 'source must be a verified clean manuscript' using errcode='22023'; end if;
  insert into public.manuscript_import_jobs(book_id,source_asset_id,source_checksum,created_by)
    values(p_book_id,p_source_asset_id,v_source.checksum,p_actor_id)
    on conflict(book_id,source_asset_id) do nothing;
  select * into v_job from public.manuscript_import_jobs where book_id=p_book_id and source_asset_id=p_source_asset_id;
  if v_job.source_checksum is distinct from v_source.checksum then
    raise exception 'source changed since job creation' using errcode='40001'; end if;
  if exists(select 1 from public.book_import_receipts r where r.book_id=p_book_id
    and r.source_asset_id=p_source_asset_id and r.source_checksum=v_source.checksum) then
    update public.manuscript_import_jobs set status='succeeded',completed_at=coalesce(completed_at,clock_timestamp()),
      lease_token=null,lease_expires_at=null,error_code=null where id=v_job.id returning * into v_job;
  end if;
  return v_job;
end; $$;

create function public.claim_manuscript_import(p_lease_seconds integer default 180)
returns setof public.manuscript_import_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.manuscript_import_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  for v_job in select * from public.manuscript_import_jobs
    where (status='queued' and available_at<=clock_timestamp())
      or (status='running' and lease_expires_at<=clock_timestamp())
    order by available_at,created_at,id for update skip locked limit 100
  loop
    if v_job.attempts>=5 then
      update public.manuscript_import_jobs set status='failed',error_code='document_attempts_exhausted',
        lease_token=null,lease_expires_at=null,completed_at=clock_timestamp() where id=v_job.id;
      insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
        values('jobs.document','manuscript_import',v_job.id,jsonb_build_object('jobId',v_job.id),v_job.attempts,'document_attempts_exhausted');
      continue;
    end if;
    update public.manuscript_import_jobs set status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      error_code=null,completed_at=null where id=v_job.id returning * into v_job;
    return next v_job; return;
  end loop;
end; $$;

create function public.renew_manuscript_import_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path = public,pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  update public.manuscript_import_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and lease_token=p_lease_token and status='running' and lease_expires_at>clock_timestamp();
  return found;
end; $$;

create function public.complete_leased_manuscript_import(p_job_id uuid,p_lease_token uuid,p_chapters jsonb,p_images jsonb,p_report jsonb)
returns jsonb language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.manuscript_import_jobs; v_result jsonb;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.manuscript_import_jobs where id=p_job_id for update;
  if not found then raise exception 'job missing' using errcode='P0002'; end if;
  if p_lease_token is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'lease lost' using errcode='40001'; end if;
  if v_job.status='succeeded' then
    select result into v_result from public.book_import_receipts where book_id=v_job.book_id and source_asset_id=v_job.source_asset_id;
    if v_result is null then raise exception 'completed job receipt missing' using errcode='P0002'; end if;
    return v_result;
  end if;
  if v_job.status<>'running' or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'lease lost' using errcode='40001'; end if;
  v_result := public.complete_manuscript_import(v_job.created_by,v_job.book_id,v_job.source_asset_id,
    v_job.source_checksum,p_chapters,p_images,p_report);
  -- Recheck after waiting for the book lock. Expiry rolls back ALL nested writes.
  if v_job.lease_expires_at<=clock_timestamp() then raise exception 'lease expired during commit' using errcode='40001'; end if;
  update public.manuscript_import_jobs set status='succeeded',completed_at=clock_timestamp(),
    lease_expires_at=null,error_code=null where id=p_job_id;
  return v_result;
end; $$;

create function public.fail_manuscript_import(p_job_id uuid,p_lease_token uuid,p_error_code text,p_retryable boolean)
returns public.manuscript_import_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.manuscript_import_jobs; v_terminal boolean;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' or p_retryable is null then
    raise exception 'invalid failure code' using errcode='22023'; end if;
  select * into v_job from public.manuscript_import_jobs where id=p_job_id for update;
  if not found then raise exception 'job missing' using errcode='P0002'; end if;
  if p_lease_token is null or v_job.lease_token is distinct from p_lease_token or v_job.status<>'running'
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'lease lost' using errcode='40001'; end if;
  v_terminal := not p_retryable or v_job.attempts>=5;
  update public.manuscript_import_jobs set status=case when v_terminal then 'failed' else 'queued' end,
    error_code=p_error_code,lease_token=null,lease_expires_at=null,
    available_at=clock_timestamp()+make_interval(secs=>(5*power(2,v_job.attempts-1))::integer),
    completed_at=case when v_terminal then clock_timestamp() else null end where id=p_job_id returning * into v_job;
  if v_terminal then
    insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
      values('jobs.document','manuscript_import',v_job.id,jsonb_build_object('jobId',v_job.id),v_job.attempts,p_error_code);
  end if;
  return v_job;
end; $$;

create function public.retry_manuscript_import(p_job_id uuid,p_actor_id uuid)
returns public.manuscript_import_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.manuscript_import_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.manuscript_import_jobs where id=p_job_id for update;
  if not found then raise exception 'job missing' using errcode='P0002'; end if;
  if not exists(select 1 from public.books b join public.workspace_members m on m.workspace_id=b.workspace_id
    where b.id=v_job.book_id and m.user_id=p_actor_id and m.status='active'
    and m.role::text in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'actor cannot retry import' using errcode='42501'; end if;
  if v_job.status<>'failed' then raise exception 'only failed imports can retry' using errcode='22023'; end if;
  -- Original source identity cannot change, including during a manual retry.
  if not exists(select 1 from public.assets a join public.asset_versions av on av.asset_id=a.id and av.storage_path=a.storage_path
    where a.id=v_job.source_asset_id and a.deleted_at is null and a.checksum=v_job.source_checksum
      and av.checksum=a.checksum and av.scan_status='clean') then
    raise exception 'original source is no longer clean and unchanged' using errcode='22023'; end if;
  update public.manuscript_import_jobs set status='queued',attempts=0,available_at=clock_timestamp(),
    created_by=p_actor_id,lease_token=null,lease_expires_at=null,error_code=null,completed_at=null
    where id=p_job_id returning * into v_job;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,after_json)
    values(p_actor_id,'job.retry','manuscript_import',p_job_id,jsonb_build_object('status','queued'));
  return v_job;
end; $$;

revoke all on function public.enqueue_manuscript_import(uuid,uuid,uuid), public.claim_manuscript_import(integer),
  public.renew_manuscript_import_lease(uuid,uuid,integer), public.complete_leased_manuscript_import(uuid,uuid,jsonb,jsonb,jsonb),
  public.fail_manuscript_import(uuid,uuid,text,boolean), public.retry_manuscript_import(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_manuscript_import(uuid,uuid,uuid), public.claim_manuscript_import(integer),
  public.renew_manuscript_import_lease(uuid,uuid,integer), public.complete_leased_manuscript_import(uuid,uuid,jsonb,jsonb,jsonb),
  public.fail_manuscript_import(uuid,uuid,text,boolean), public.retry_manuscript_import(uuid,uuid) to service_role;
