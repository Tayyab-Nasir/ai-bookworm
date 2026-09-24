-- Operator-supervised, receipt-only recovery of an unconfirmed manuscript
-- review. The lease can be reclaimed after expiry because this path never
-- dispatches a provider request; regular claim still excludes marked jobs.
create function public.claim_ai_review_receipt_recovery(
  p_job_id uuid,
  p_actor_id uuid,
  p_incident_ref text,
  p_receipt_reviewed boolean,
  p_provider_reviewed boolean,
  p_lease_seconds integer default 300
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.ai_jobs; v_receipt jsonb; v_org uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_job_id is null or p_actor_id is null or p_incident_ref is null
    or p_incident_ref !~ '^[A-Z0-9][A-Z0-9-]{5,63}$'
    or p_receipt_reviewed is distinct from true
    or p_provider_reviewed is distinct from true
    or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'receipt recovery requires incident reference and review attestations' using errcode='22023'; end if;

  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'AI review job not found' using errcode='P0002'; end if;
  if v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status <> 'running'
    or v_job.error_code is distinct from 'ai_provider_outcome_unconfirmed'
    or v_job.provider_dispatched_at is null
    or (v_job.lease_token is not null and
      (v_job.lease_expires_at is null or v_job.lease_expires_at > clock_timestamp()))
    or v_job.output_ref is not null
    or exists(select 1 from public.ai_suggestions where ai_job_id=p_job_id)
    or exists(select 1 from public.ai_runs where ai_job_id=p_job_id)
    or exists(select 1 from public.usage_events where ai_job_id=p_job_id) then
    raise exception 'AI review is not eligible for receipt recovery' using errcode='22023'; end if;
  select result_json into v_receipt from public.ai_review_service_receipts where job_id=p_job_id;
  if jsonb_typeof(v_receipt) is distinct from 'object'
    or v_receipt->>'status' is distinct from 'succeeded'
    or v_receipt->>'jobId' is distinct from v_job.id::text
    or v_receipt->>'workspaceId' is distinct from v_job.workspace_id::text
    or v_receipt->>'bookId' is distinct from v_job.book_id::text
    or v_receipt->>'agentType' is distinct from v_job.agent_type then
    raise exception 'matching successful AI review receipt is unavailable' using errcode='22023'; end if;
  select organization_id into v_org from public.workspaces where id=v_job.workspace_id;
  if v_org is null then raise exception 'AI review workspace not found' using errcode='P0002'; end if;

  update public.ai_jobs set lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id returning * into v_job;
  insert into public.audit_logs(organization_id,workspace_id,actor_id,action,entity_type,entity_id,before_json,after_json)
    values(v_org,v_job.workspace_id,p_actor_id,'ai_review.receipt_recovery_started','ai_job',p_job_id,
      jsonb_build_object('status','running','errorCode','ai_provider_outcome_unconfirmed'),
      jsonb_build_object('incidentRef',p_incident_ref,'receiptReviewed',true,
        'providerReviewed',true,'providerRedispatch',false));
  return v_job;
end $$;
revoke all on function public.claim_ai_review_receipt_recovery(uuid,uuid,text,boolean,boolean,integer)
  from public,anon,authenticated;
grant execute on function public.claim_ai_review_receipt_recovery(uuid,uuid,text,boolean,boolean,integer)
  to service_role;
