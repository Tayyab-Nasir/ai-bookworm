-- Operator-only release of an aged image hold with no deliverable. This never
-- asserts that OpenAI did not bill Bookworm and never charges the author.
create function public.release_unconfirmed_image_job(
  p_job_id uuid,
  p_actor_id uuid,
  p_incident_ref text,
  p_storage_checked boolean,
  p_provider_reviewed boolean
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_job public.ai_jobs;
  v_org uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  if p_job_id is null or p_actor_id is null or p_incident_ref is null
    or p_incident_ref !~ '^[A-Z0-9][A-Z0-9-]{5,63}$'
    or p_storage_checked is distinct from true
    or p_provider_reviewed is distinct from true then
    raise exception 'image release requires incident reference and review attestations' using errcode='22023';
  end if;

  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'image job not found' using errcode='P0002'; end if;
  if v_job.agent_type not in ('illustrator','cover_designer')
    or v_job.status <> 'running'
    or v_job.started_at is null
    or v_job.started_at > now() - interval '15 minutes'
    or v_job.output_ref is not null
    or exists(select 1 from public.image_completion_receipts where job_id=p_job_id)
    or exists(select 1 from public.usage_events where ai_job_id=p_job_id)
    or exists(select 1 from public.ai_runs where ai_job_id=p_job_id) then
    raise exception 'image job is not eligible for manual hold release' using errcode='22023';
  end if;
  select organization_id into v_org from public.workspaces where id=v_job.workspace_id;
  if v_org is null then raise exception 'image workspace not found' using errcode='P0002'; end if;

  update public.ai_jobs set status='failed', error_code='image_hold_released',
    error_message='Operator reviewed an unresolved image request with no delivered asset.',
    completed_at=now()
    where id=p_job_id returning * into v_job;
  insert into public.audit_logs(organization_id,workspace_id,actor_id,action,entity_type,entity_id,before_json,after_json)
    values(v_org,v_job.workspace_id,p_actor_id,'image.hold_release','ai_job',p_job_id,
      jsonb_build_object('status','running'),
      jsonb_build_object('status','failed','incidentRef',p_incident_ref,
        'storageChecked',true,'providerReviewed',true,'customerDebit',false));
  return v_job;
end $$;

revoke all on function public.release_unconfirmed_image_job(uuid,uuid,text,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.release_unconfirmed_image_job(uuid,uuid,text,boolean,boolean)
  to service_role;
