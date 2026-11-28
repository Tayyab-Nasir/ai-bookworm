alter table public.funded_usage_quotes drop constraint funded_usage_quotes_status_check;
alter table public.funded_usage_quotes add constraint funded_usage_quotes_status_check
  check(status in ('held','settled','requires_review','cancelled'));
alter table public.translation_projects add column cancellation_json jsonb;

do $$
declare v_definition text;
begin
  select pg_get_functiondef('public.guard_funded_quote_transition()'::regprocedure) into v_definition;
  if position('  return new;' in v_definition)=0 then raise exception 'unexpected quote transition guard'; end if;
  execute replace(v_definition,'  return new;', $fragment$
  if new.status='cancelled' and new.dispatched_at is not null then
    raise exception 'dispatched quote cannot be cancelled' using errcode='23514'; end if;
  return new;
$fragment$);
end $$;

create function public.cancel_quoted_translation(p_project_id uuid,p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_project public.translation_projects; v_job public.ai_jobs; v_quote public.funded_usage_quotes;
  v_role text; v_total bigint:=0; v_count integer:=0; v_result jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_project from public.translation_projects where id=p_project_id;
  if not found then raise exception 'translation project missing' using errcode='P0002'; end if;
  if p_user_id is null or v_project.created_by<>p_user_id then
    raise exception 'only the translation creator may cancel' using errcode='42501'; end if;
  select role into v_role from public.workspace_members where workspace_id=v_project.workspace_id
    and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer') then
    raise exception 'translation editing access required' using errcode='42501'; end if;
  -- Do not wait while partially holding a project-wide job set. A busy worker
  -- returns a retryable conflict before any refunds or status changes.
  perform j.id from public.ai_jobs j join public.translation_chapters c on c.ai_job_id=j.id
    where c.project_id=p_project_id order by j.id for update of j nowait;
  select * into v_project from public.translation_projects where id=p_project_id for update;
  if v_project.cancellation_json is not null then return v_project.cancellation_json; end if;
  if v_project.status='succeeded' then raise exception 'completed translation cannot cancel' using errcode='23514'; end if;
  for v_job in select j.* from public.ai_jobs j join public.translation_chapters c on c.ai_job_id=j.id
    where c.project_id=p_project_id order by j.id
  loop
    if v_job.billing_mode<>'quoted' or v_job.created_by<>p_user_id or v_job.status='succeeded' then
      raise exception 'translation is not cancellable before dispatch' using errcode='23514'; end if;
    select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
    if found then
      if v_quote.status<>'held' or v_quote.dispatched_at is not null then
        raise exception 'translation may already have provider usage' using errcode='23514'; end if;
      insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
        values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',v_job.id);
      update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),
        settlement_json=jsonb_build_object('status','cancelled','reason','user_request','releaseCredits',v_quote.reserved_credits::text)
        where job_id=v_job.id;
      v_total:=v_total+v_quote.reserved_credits;
    end if;
    update public.ai_jobs set status='cancelled',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
      error_code='translation_cancelled_before_dispatch',error_message='Cancelled before provider dispatch.' where id=v_job.id;
    v_count:=v_count+1;
  end loop;
  if v_count=0 then raise exception 'translation has no jobs' using errcode='23514'; end if;
  v_result:=jsonb_build_object('projectId',p_project_id,'status','cancelled','releasedCredits',v_total::text,'cancelledChapters',v_count);
  update public.translation_projects set status='cancelled',completed_at=clock_timestamp(),cancellation_json=v_result where id=p_project_id;
  return v_result;
end $$;
revoke all on function public.cancel_quoted_translation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_quoted_translation(uuid,uuid) to service_role;
