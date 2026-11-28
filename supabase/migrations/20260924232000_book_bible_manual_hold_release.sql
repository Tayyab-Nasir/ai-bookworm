-- Reviewed no-result release only. Age alone never proves a provider failure.
-- Completion locks the same job, so a released job cannot later debit the author.
create function public.release_unconfirmed_book_bible_job(
  p_job_id uuid, p_actor_id uuid, p_incident_ref text,
  p_receipt_reviewed boolean, p_provider_reviewed boolean
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.ai_jobs; v_org uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_job_id is null or p_actor_id is null or p_incident_ref is null
    or p_incident_ref !~ '^[A-Z0-9][A-Z0-9-]{5,63}$'
    or p_receipt_reviewed is distinct from true or p_provider_reviewed is distinct from true then
    raise exception 'Book Bible release requires incident and review attestations' using errcode='22023'; end if;

  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'Book Bible job not found' using errcode='P0002'; end if;
  if v_job.agent_type is distinct from 'bookbible' or v_job.status <> 'running'
    or v_job.started_at is null or v_job.started_at > clock_timestamp() - interval '15 minutes'
    or v_job.lease_token is not null or v_job.lease_expires_at is not null
    or v_job.output_ref is not null
    or exists(select 1 from public.book_bible_service_receipts r where r.job_id=p_job_id
      and (r.result_json is not null or r.created_at > clock_timestamp() - interval '15 minutes'))
    or exists(select 1 from public.ai_suggestions where ai_job_id=p_job_id)
    or exists(select 1 from public.ai_runs where ai_job_id=p_job_id)
    or exists(select 1 from public.usage_events where ai_job_id=p_job_id) then
    raise exception 'Book Bible job is not eligible for no-result release' using errcode='22023'; end if;
  select organization_id into v_org from public.workspaces where id=v_job.workspace_id;
  if v_org is null then raise exception 'Book Bible workspace not found' using errcode='P0002'; end if;

  update public.ai_jobs set status='failed',error_code='book_bible_hold_released',
    error_message='Operator reviewed an unresolved Book Bible request with no saved result.',
    completed_at=clock_timestamp() where id=p_job_id returning * into v_job;
  insert into public.audit_logs(organization_id,workspace_id,actor_id,action,entity_type,entity_id,before_json,after_json)
    values(v_org,v_job.workspace_id,p_actor_id,'book_bible.hold_release','ai_job',p_job_id,
      jsonb_build_object('status','running'),
      jsonb_build_object('status','failed','incidentRef',p_incident_ref,
        'receiptReviewed',true,'providerReviewed',true,'customerDebit',false));
  return v_job;
end $$;
revoke all on function public.release_unconfirmed_book_bible_job(uuid,uuid,text,boolean,boolean)
  from public,anon,authenticated;
grant execute on function public.release_unconfirmed_book_bible_job(uuid,uuid,text,boolean,boolean)
  to service_role;
