-- Recover queued render/preflight/export jobs with native PostgreSQL leases.
-- Synchronous API jobs have no lease and are never automatically reclaimed.
alter table public.publishing_jobs
  add column available_at timestamptz not null default now(),
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column max_attempts integer not null default 5 check (max_attempts between 1 and 20);

create index publishing_jobs_worker_poll on public.publishing_jobs(available_at, created_at)
  where status in ('queued', 'running');

create or replace function public.claim_publishing_job(
  p_actions text[] default array['render','validate','export_package'],
  p_lease_seconds integer default 180
) returns setof public.publishing_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.publishing_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900
    or p_actions is null or cardinality(p_actions) not between 1 and 3
    or not p_actions <@ array['render','validate','export_package']::text[]
    or array_position(p_actions, null) is not null then
    raise exception 'invalid worker claim' using errcode = '22023';
  end if;
  for v_job in
    select j.* from public.publishing_jobs j
    where j.request_json->>'action' = any(p_actions)
      and ((j.status = 'queued' and j.available_at <= clock_timestamp())
        or (j.status = 'running' and j.lease_token is not null and j.lease_expires_at <= clock_timestamp()))
    order by j.available_at, j.created_at, j.id
    for update skip locked
    limit 100
  loop
    if v_job.attempts >= v_job.max_attempts then
      update public.publishing_jobs set status = 'failed', completed_at = clock_timestamp(),
        lease_expires_at = null, response_json = '{"error":"worker_attempts_exhausted","deadLettered":true}'
      where id = v_job.id;
      insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
      values ('jobs.publishing',v_job.request_json->>'action',v_job.id,
        jsonb_build_object('jobId',v_job.id),v_job.attempts,'worker_attempts_exhausted');
      continue;
    end if;
    update public.publishing_jobs set status = 'running', attempts = attempts + 1,
      lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, clock_timestamp()), completed_at = null, response_json = null
    where id = v_job.id returning * into v_job;
    return next v_job;
    return;
  end loop;
end;
$$;

create or replace function public.renew_publishing_job_lease(
  p_job_id uuid, p_lease_token uuid, p_lease_seconds integer default 180
) returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;
  update public.publishing_jobs set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  where id = p_job_id and lease_token = p_lease_token and status = 'running'
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.fail_leased_publishing_job(
  p_job_id uuid, p_lease_token uuid, p_error_code text, p_retryable boolean default true
) returns public.publishing_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.publishing_jobs; v_terminal boolean;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  -- Only stable codes enter durable errors/DLQ, never provider bodies or text.
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' or p_retryable is null then
    raise exception 'invalid worker failure' using errcode = '22023';
  end if;
  select j.* into v_job from public.publishing_jobs j where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or p_lease_token is null or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'worker lease lost' using errcode = '40001';
  end if;
  v_terminal := not p_retryable or v_job.attempts >= v_job.max_attempts;
  update public.publishing_jobs
  set status = (case when v_terminal then 'failed' else 'queued' end)::public.job_status,
    completed_at = case when v_terminal then clock_timestamp() else null end,
    available_at = clock_timestamp() + make_interval(secs => least(3600, (5 * power(2, least(v_job.attempts - 1, 10)))::integer)),
    lease_token = null, lease_expires_at = null,
    response_json = jsonb_build_object('error',p_error_code,'deadLettered',v_terminal)
  where id = p_job_id returning * into v_job;
  if v_terminal then
    insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
    values ('jobs.publishing',v_job.request_json->>'action',v_job.id,
      jsonb_build_object('jobId',v_job.id),v_job.attempts,p_error_code);
  end if;
  return v_job;
end;
$$;

create or replace function public.complete_leased_publishing_job(
  p_job_id uuid, p_lease_token uuid, p_result jsonb
) returns public.publishing_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.publishing_jobs; v_edition public.editions; v_workspace_id uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select j.* into v_job from public.publishing_jobs j where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if p_lease_token is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'worker lease lost' using errcode = '40001';
  end if;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.status <> 'running' or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'worker lease lost' using errcode = '40001';
  end if;
  if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text) > 2000000 then
    raise exception 'invalid worker output' using errcode = '22023';
  end if;
  select e.* into v_edition from public.editions e where e.id = v_job.edition_id and e.book_id = v_job.book_id for share;
  if not found or (v_job.request_json->>'editionUpdatedAt')::timestamptz is distinct from v_edition.updated_at then
    raise exception 'edition changed since queued request' using errcode = '22023';
  end if;
  select b.workspace_id into v_workspace_id from public.books b where b.id = v_job.book_id;
  if not exists(select 1 from public.workspace_members m where m.workspace_id = v_workspace_id
    and m.user_id = v_job.created_by and m.status = 'active'
    and m.role in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'job creator can no longer edit book' using errcode = '42501';
  end if;
  case v_job.request_json->>'action'
    when 'render' then
      select * into v_job from public.complete_render_job(p_job_id, p_result->'artifacts', p_result->>'rendererVersion', p_result->'usage');
    when 'validate' then
      select * into v_job from public.complete_preflight_job(p_job_id, p_result);
    when 'export_package' then
      select * into v_job from public.complete_publishing_package_job(p_job_id, p_result->'artifact', p_result->>'ruleVersion',
        (v_job.request_json->>'sourceRenderJobId')::uuid, (v_job.request_json->>'sourcePreflightJobId')::uuid);
    else raise exception 'unsupported worker action' using errcode = '22023';
  end case;
  update public.publishing_jobs set lease_expires_at = null where id = p_job_id returning * into v_job;
  return v_job;
end;
$$;

create or replace function public.retry_publishing_job(p_job_id uuid, p_actor_id uuid)
returns public.publishing_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.publishing_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_actor_id is null then raise exception 'retry actor required' using errcode = '22023'; end if;
  select j.* into v_job from public.publishing_jobs j where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if v_job.status <> 'failed' or coalesce(v_job.request_json->>'action','') not in ('render','validate','export_package') then
    raise exception 'only supported failed jobs can retry' using errcode = '22023';
  end if;
  update public.publishing_jobs set status = 'queued', attempts = 0, available_at = clock_timestamp(),
    lease_token = null, lease_expires_at = null, started_at = null, completed_at = null, response_json = null
  where id = p_job_id returning * into v_job;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,after_json)
  values(p_actor_id,'job.retry','publishing_job',p_job_id,jsonb_build_object('status','queued'));
  return v_job;
end;
$$;

revoke all on function public.claim_publishing_job(text[],integer), public.renew_publishing_job_lease(uuid,uuid,integer),
  public.fail_leased_publishing_job(uuid,uuid,text,boolean), public.complete_leased_publishing_job(uuid,uuid,jsonb),
  public.retry_publishing_job(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_publishing_job(text[],integer), public.renew_publishing_job_lease(uuid,uuid,integer),
  public.fail_leased_publishing_job(uuid,uuid,text,boolean), public.complete_leased_publishing_job(uuid,uuid,jsonb),
  public.retry_publishing_job(uuid,uuid) to service_role;
