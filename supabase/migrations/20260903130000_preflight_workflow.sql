-- Persist deterministic preflight findings and job status in one transaction.
create or replace function public.complete_preflight_job(
  p_job_id uuid,
  p_result jsonb
) returns public.publishing_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.publishing_jobs;
  v_book public.books;
  v_finding jsonb;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_result) is distinct from 'object'
    or jsonb_typeof(p_result->'findings') is distinct from 'array'
    or jsonb_array_length(p_result->'findings') > 500
    or octet_length(p_result::text) > 2000000
    or coalesce(length(p_result->>'ruleVersion'), 0) not between 1 and 200
    or coalesce((p_result->>'errors') ~ '^[0-9]+$', false) is false
    or coalesce((p_result->>'warnings') ~ '^[0-9]+$', false) is false
  then
    raise exception 'invalid preflight completion' using errcode = '22023';
  end if;

  select p.* into v_job from public.publishing_jobs p where p.id = p_job_id for update;
  if not found then raise exception 'preflight job not found' using errcode = 'P0002'; end if;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.status <> 'running' or v_job.created_by is null
    or v_job.channel not in ('export','kdp','apple','barnesnoble','lulu')
    or v_job.request_json->>'action' <> 'validate'
  then
    raise exception 'preflight job cannot be completed' using errcode = '40001';
  end if;
  select b.* into v_book from public.books b where b.id = v_job.book_id;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;

  for v_finding in select value from jsonb_array_elements(p_result->'findings')
  loop
    if jsonb_typeof(v_finding) is distinct from 'object'
      or v_finding->>'severity' not in ('error','warning','info')
      or coalesce(length(v_finding->>'code'), 0) not between 1 and 120
      or coalesce(length(v_finding->>'message'), 0) not between 1 and 2000
      or coalesce(length(v_finding->>'rule_id'), 0) not between 1 and 200
      or coalesce(length(v_finding->>'rule_version'), 0) not between 1 and 200
      or coalesce(length(v_finding->>'location'), 0) > 1000
    then
      raise exception 'invalid preflight finding' using errcode = '22023';
    end if;
    insert into public.publishing_validations(
      publishing_job_id, rule_version, severity, code, message, location_json
    ) values (
      v_job.id, v_finding->>'rule_version', v_finding->>'severity', v_finding->>'code',
      v_finding->>'message', jsonb_build_object('path', coalesce(v_finding->>'location',''))
    );
  end loop;

  insert into public.activity_events(workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (v_book.workspace_id, v_job.created_by, 'edition_validated', 'edition', v_job.edition_id,
          jsonb_build_object('publishingJobId', v_job.id, 'channel', v_job.channel,
                             'errors', (p_result->>'errors')::integer,
                             'warnings', (p_result->>'warnings')::integer));
  update public.publishing_jobs
  set status='succeeded', response_json=p_result, completed_at=now()
  where id=v_job.id returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.complete_preflight_job(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.complete_preflight_job(uuid,jsonb) to service_role;
