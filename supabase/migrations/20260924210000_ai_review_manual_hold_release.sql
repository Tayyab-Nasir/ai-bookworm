-- Reviewed release of an unconfirmed paid manuscript review with no saved
-- result. This ends the customer credit hold but never claims provider cost
-- was zero. A late result cannot complete or charge the failed job.
create function public.release_unconfirmed_ai_review_job(
  p_job_id uuid,
  p_actor_id uuid,
  p_incident_ref text,
  p_receipt_reviewed boolean,
  p_provider_reviewed boolean
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.ai_jobs; v_org uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_job_id is null or p_actor_id is null or p_incident_ref is null
    or p_incident_ref !~ '^[A-Z0-9][A-Z0-9-]{5,63}$'
    or p_receipt_reviewed is distinct from true
    or p_provider_reviewed is distinct from true then
    raise exception 'AI review release requires incident reference and review attestations' using errcode='22023'; end if;

  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'AI review job not found' using errcode='P0002'; end if;
  if v_job.agent_type not in ('writer','proofreader','copyeditor','consistency')
    or v_job.status <> 'running'
    or v_job.error_code is distinct from 'ai_provider_outcome_unconfirmed'
    or v_job.provider_dispatched_at is null
    or v_job.provider_dispatched_at > clock_timestamp() - interval '15 minutes'
    or v_job.lease_token is not null or v_job.lease_expires_at is not null
    or v_job.output_ref is not null
    or exists(select 1 from public.ai_review_service_receipts r
      where r.job_id=p_job_id and r.result_json is not null)
    or exists(select 1 from public.ai_suggestions where ai_job_id=p_job_id)
    or exists(select 1 from public.ai_runs where ai_job_id=p_job_id)
    or exists(select 1 from public.usage_events where ai_job_id=p_job_id) then
    raise exception 'AI review job is not eligible for manual hold release' using errcode='22023'; end if;
  select organization_id into v_org from public.workspaces where id=v_job.workspace_id;
  if v_org is null then raise exception 'AI review workspace not found' using errcode='P0002'; end if;

  update public.ai_jobs set status='failed', error_code='ai_review_hold_released',
    error_message='Operator reviewed an unresolved AI review with no saved result.',
    completed_at=clock_timestamp()
    where id=p_job_id returning * into v_job;
  insert into public.audit_logs(organization_id,workspace_id,actor_id,action,entity_type,entity_id,before_json,after_json)
    values(v_org,v_job.workspace_id,p_actor_id,'ai_review.hold_release','ai_job',p_job_id,
      jsonb_build_object('status','running','errorCode','ai_provider_outcome_unconfirmed'),
      jsonb_build_object('status','failed','incidentRef',p_incident_ref,
        'receiptReviewed',true,'providerReviewed',true,'customerDebit',false));
  return v_job;
end $$;
revoke all on function public.release_unconfirmed_ai_review_job(uuid,uuid,text,boolean,boolean)
  from public,anon,authenticated;
grant execute on function public.release_unconfirmed_ai_review_job(uuid,uuid,text,boolean,boolean)
  to service_role;
