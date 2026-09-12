-- Durable execution for the four manuscript-review agents. Jobs retain only
-- canonical source pointers; the worker reconstructs manuscript context.
alter table public.ai_jobs
  add column if not exists attempts integer not null default 0 check (attempts between 0 and 5),
  add column if not exists available_at timestamptz not null default now(),
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

create index if not exists ai_review_job_poll on public.ai_jobs(available_at, created_at)
  where agent_type in ('writer','proofreader','copyeditor','consistency')
    and status in ('queued','running');

create or replace function public.claim_ai_review_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.ai_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  for v_job in select * from public.ai_jobs
    where agent_type in ('writer','proofreader','copyeditor','consistency') and (
      (status='queued' and available_at<=clock_timestamp()) or
      (status='running' and lease_expires_at<=clock_timestamp())
    ) order by available_at,created_at,id for update skip locked limit 100
  loop
    if v_job.attempts >= 5 then
      update public.ai_jobs set status='failed',error_code='ai_attempts_exhausted',
        error_message='AI review attempts exhausted',lease_token=null,lease_expires_at=null,
        completed_at=clock_timestamp() where id=v_job.id;
      insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
        values('jobs.ai','ai_review',v_job.id,jsonb_build_object('jobId',v_job.id),v_job.attempts,'ai_attempts_exhausted');
      continue;
    end if;
    update public.ai_jobs set status='running',attempts=attempts+1,
      started_at=coalesce(started_at,clock_timestamp()),completed_at=null,error_code=null,error_message=null,
      lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
      where id=v_job.id returning * into v_job;
    return next v_job; return;
  end loop;
end; $$;

create or replace function public.renew_ai_review_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path = public,pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and agent_type in ('writer','proofreader','copyeditor','consistency')
      and status='running' and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end; $$;

create or replace function public.complete_leased_ai_review_job(
  p_job_id uuid,p_lease_token uuid,p_provider text,p_model text,p_usage jsonb,
  p_diagnostics jsonb,p_suggestions jsonb,p_credit_quantity numeric
) returns public.ai_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.ai_jobs; v_result public.ai_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'AI job not found' using errcode='P0002'; end if;
  if p_lease_token is null or v_job.lease_token is distinct from p_lease_token
    or v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status<>'running' or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'lease lost' using errcode='40001'; end if;
  select * into v_result from public.complete_ai_job(p_job_id,p_provider,p_model,p_usage,p_diagnostics,p_suggestions,p_credit_quantity);
  update public.ai_jobs set lease_token=null,lease_expires_at=null where id=p_job_id returning * into v_result;
  return v_result;
end; $$;

create or replace function public.fail_ai_review_job(p_job_id uuid,p_lease_token uuid,p_error_code text,p_error_message text,p_retryable boolean)
returns public.ai_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.ai_jobs; v_terminal boolean;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' or p_error_message is null
    or length(p_error_message)>2000 or p_retryable is null then
    raise exception 'invalid AI failure' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'AI job not found' using errcode='P0002'; end if;
  if p_lease_token is null or v_job.lease_token is distinct from p_lease_token
    or v_job.agent_type not in ('writer','proofreader','copyeditor','consistency') or v_job.status<>'running'
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'lease lost' using errcode='40001'; end if;
  v_terminal := not p_retryable or v_job.attempts>=5;
  update public.ai_jobs set status=(case when v_terminal then 'failed' else 'queued' end)::public.job_status,
    error_code=p_error_code,error_message=p_error_message,lease_token=null,lease_expires_at=null,
    available_at=clock_timestamp()+make_interval(secs=>(5*power(2,v_job.attempts-1))::integer),
    completed_at=case when v_terminal then clock_timestamp() else null end
    where id=p_job_id returning * into v_job;
  if v_terminal then insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
    values('jobs.ai','ai_review',v_job.id,jsonb_build_object('jobId',v_job.id),v_job.attempts,p_error_code); end if;
  return v_job;
end; $$;

revoke all on function public.claim_ai_review_job(integer),public.renew_ai_review_lease(uuid,uuid,integer),
  public.complete_leased_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,numeric),
  public.fail_ai_review_job(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_ai_review_job(integer),public.renew_ai_review_lease(uuid,uuid,integer),
  public.complete_leased_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,numeric),
  public.fail_ai_review_job(uuid,uuid,text,text,boolean) to service_role;
