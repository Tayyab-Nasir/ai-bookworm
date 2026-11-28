-- A lost paid AI-service reply may hide an OpenAI completion. Keep its
-- operational credit reserved and prevent lease expiry from redispatching it.
alter table public.ai_jobs add column if not exists provider_dispatched_at timestamptz;

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
      (status='running' and provider_dispatched_at is null and lease_expires_at<=clock_timestamp())
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

create or replace function public.mark_ai_review_dispatched(p_job_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path = public,pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  update public.ai_jobs set provider_dispatched_at=clock_timestamp()
    where id=p_job_id and agent_type in ('writer','proofreader','copyeditor','consistency')
      and status='running' and lease_token=p_lease_token
      and lease_expires_at>clock_timestamp() and provider_dispatched_at is null;
  return found;
end; $$;

create or replace function public.mark_ai_review_outcome_unconfirmed(p_job_id uuid,p_lease_token uuid)
returns public.ai_jobs language plpgsql security invoker set search_path = public,pg_temp as $$
declare v_job public.ai_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'AI job not found' using errcode='P0002'; end if;
  if v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status<>'running' or p_lease_token is null
    or v_job.lease_token is distinct from p_lease_token
    or v_job.provider_dispatched_at is null then
    raise exception 'AI review lease lost' using errcode='40001'; end if;
  update public.ai_jobs set error_code='ai_provider_outcome_unconfirmed',
    error_message='Provider outcome requires review. Do not generate again.',
    lease_token=null,lease_expires_at=null
    where id=p_job_id returning * into v_job;
  insert into public.dead_letter_jobs(queue,job_type,job_id,payload_json,attempts,error)
    values('jobs.ai','ai_review_unconfirmed',p_job_id,jsonb_build_object('jobId',p_job_id),
      v_job.attempts,'ai_provider_outcome_unconfirmed');
  return v_job;
end; $$;
revoke all on function public.mark_ai_review_dispatched(uuid,uuid),
  public.mark_ai_review_outcome_unconfirmed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.mark_ai_review_dispatched(uuid,uuid),
  public.mark_ai_review_outcome_unconfirmed(uuid,uuid) to service_role;
