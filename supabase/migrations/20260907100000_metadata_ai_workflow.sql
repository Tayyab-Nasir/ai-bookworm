-- Review-first AI metadata generation. Completion stores a structured draft on
-- the AI job and meters it atomically; canonical book_metadata is never changed
-- by this service-only transition.

create or replace function public.complete_metadata_ai_job(
  p_job_id uuid,
  p_provider text,
  p_model text,
  p_usage jsonb,
  p_diagnostics jsonb,
  p_candidate jsonb,
  p_credit_quantity numeric
) returns public.ai_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_jobs;
  v_organization_id uuid;
  v_item jsonb;
  v_source jsonb;
  v_confidence numeric;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null
    or coalesce(length(trim(p_provider)), 0) not between 1 and 200
    or coalesce(length(trim(p_model)), 0) not between 1 and 200
    or jsonb_typeof(p_usage) is distinct from 'object'
    or jsonb_typeof(p_diagnostics) is distinct from 'array'
    or jsonb_array_length(p_diagnostics) > 500
    or octet_length(p_usage::text) > 100000
    or octet_length(p_diagnostics::text) > 2000000
    or jsonb_typeof(p_candidate) is distinct from 'object'
    or octet_length(p_candidate::text) > 100000
    or p_credit_quantity is null
    or p_credit_quantity < 0
    or p_credit_quantity::text = 'NaN'
  then
    raise exception 'invalid metadata AI completion' using errcode = '22023';
  end if;

  if jsonb_typeof(p_usage->'inputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'outputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'estimatedCostUsd') is distinct from 'number'
    or p_usage->>'inputTokens' !~ '^[0-9]+$'
    or p_usage->>'outputTokens' !~ '^[0-9]+$'
    or (p_usage->>'inputTokens')::numeric > 2147483647
    or (p_usage->>'outputTokens')::numeric > 2147483647
    or (p_usage->>'estimatedCostUsd')::numeric < 0
    or (p_usage ? 'latencyMs' and (
      jsonb_typeof(p_usage->'latencyMs') is distinct from 'number'
      or p_usage->>'latencyMs' !~ '^[0-9]+$'
      or (p_usage->>'latencyMs')::numeric > 2147483647
    ))
  then
    raise exception 'invalid metadata AI usage' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_diagnostics) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or coalesce(length(trim(v_item->>'severity')), 0) = 0
      or coalesce(length(trim(v_item->>'code')), 0) = 0
      or coalesce(length(trim(v_item->>'message')), 0) = 0
      or jsonb_typeof(v_item->'location') is distinct from 'object'
    then
      raise exception 'invalid metadata AI diagnostic' using errcode = '22023';
    end if;
  end loop;

  if not (p_candidate ?& array['suggestionKind','description','keywords','categories','audience','rationale','confidence','sourceRefs','status'])
    or p_candidate - array['suggestionKind','description','keywords','categories','audience','rationale','confidence','sourceRefs','status'] <> '{}'::jsonb
    or p_candidate->>'suggestionKind' is distinct from 'metadata_candidate'
    or p_candidate->>'status' is distinct from 'pending'
    or jsonb_typeof(p_candidate->'description') is distinct from 'string'
    or coalesce(length(trim(p_candidate->>'description')), 0) not between 40 and 4000
    or jsonb_typeof(p_candidate->'keywords') is distinct from 'array'
    or jsonb_array_length(p_candidate->'keywords') not between 1 and 30
    or jsonb_typeof(p_candidate->'categories') is distinct from 'array'
    or jsonb_array_length(p_candidate->'categories') not between 1 and 20
    or jsonb_typeof(p_candidate->'audience') is distinct from 'string'
    or coalesce(length(trim(p_candidate->>'audience')), 0) not between 1 and 500
    or jsonb_typeof(p_candidate->'rationale') is distinct from 'string'
    or coalesce(length(trim(p_candidate->>'rationale')), 0) not between 1 and 2000
    or jsonb_typeof(p_candidate->'confidence') not in ('number','null')
    or jsonb_typeof(p_candidate->'sourceRefs') is distinct from 'array'
    or jsonb_array_length(p_candidate->'sourceRefs') not between 1 and 30
  then
    raise exception 'invalid metadata candidate' using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate->'confidence') = 'number' then
    v_confidence := (p_candidate->>'confidence')::numeric;
    if v_confidence < 0 or v_confidence > 1 then
      raise exception 'invalid metadata confidence' using errcode = '22023';
    end if;
  end if;
  for v_item in select value from jsonb_array_elements(p_candidate->'keywords') loop
    if jsonb_typeof(v_item) is distinct from 'string'
      or coalesce(length(trim(v_item #>> '{}')), 0) not between 1 and 100
    then raise exception 'invalid metadata keyword' using errcode = '22023'; end if;
  end loop;
  for v_item in select value from jsonb_array_elements(p_candidate->'categories') loop
    if jsonb_typeof(v_item) is distinct from 'string'
      or coalesce(length(trim(v_item #>> '{}')), 0) not between 1 and 180
    then raise exception 'invalid metadata category' using errcode = '22023'; end if;
  end loop;

  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found then raise exception 'AI job not found' using errcode = 'P0002'; end if;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.status not in ('queued','running') then
    raise exception 'AI job cannot be completed from current state' using errcode = '55000';
  end if;
  if v_job.agent_type is distinct from 'metadata' or v_job.book_id is null then
    raise exception 'not a metadata AI job' using errcode = '22023';
  end if;
  if jsonb_typeof(v_job.input_ref->'contextSources') is distinct from 'array' then
    raise exception 'metadata job has no trusted sources' using errcode = '22023';
  end if;

  for v_source in select value from jsonb_array_elements(p_candidate->'sourceRefs') loop
    if jsonb_typeof(v_source) is distinct from 'object'
      or not (v_source ?& array['chapterId','nodeId'])
      or v_source - array['chapterId','documentVersionId','nodeId','textHash'] <> '{}'::jsonb
      or jsonb_typeof(v_source->'chapterId') is distinct from 'string'
      or v_source->>'chapterId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (v_source ? 'documentVersionId' and (
        jsonb_typeof(v_source->'documentVersionId') is distinct from 'string'
        or v_source->>'documentVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ))
      or jsonb_typeof(v_source->'nodeId') is distinct from 'string'
      or coalesce(length(v_source->>'nodeId'), 0) not between 1 and 200
      or (v_source ? 'textHash' and (
        jsonb_typeof(v_source->'textHash') is distinct from 'string'
        or v_source->>'textHash' !~ '^[a-f0-9]{64}$'
      ))
      or not exists (
        select 1 from jsonb_array_elements(v_job.input_ref->'contextSources') trusted
        where trusted @> v_source
      )
      or not exists (
        select 1 from public.chapters c
        where c.id = (v_source->>'chapterId')::uuid
          and c.book_id = v_job.book_id
          and (not (v_source ? 'documentVersionId') or exists (
            select 1 from public.document_versions d
            where d.id = (v_source->>'documentVersionId')::uuid
              and d.chapter_id = c.id
              and c.current_document_version_id = d.id
          ))
      )
    then
      raise exception 'metadata citation outside trusted job sources' using errcode = '42501';
    end if;
  end loop;

  select organization_id into v_organization_id from public.workspaces where id = v_job.workspace_id;
  if v_organization_id is null then raise exception 'AI job workspace not found' using errcode = 'P0002'; end if;

  insert into public.ai_runs(
    ai_job_id, workspace_id, provider, model, tokens_in, tokens_out,
    estimated_cost, latency_ms, status
  ) values (
    v_job.id, v_job.workspace_id, trim(p_provider), trim(p_model),
    (p_usage->>'inputTokens')::integer, (p_usage->>'outputTokens')::integer,
    (p_usage->>'estimatedCostUsd')::numeric,
    case when p_usage ? 'latencyMs' then (p_usage->>'latencyMs')::integer end,
    'succeeded'
  );

  insert into public.usage_events(
    ai_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json
  ) values (
    v_job.id, v_organization_id, v_job.created_by, v_job.workspace_id,
    'ai_credits', p_credit_quantity,
    jsonb_build_object('aiJobId',v_job.id,'provider',trim(p_provider),'model',trim(p_model),'kind','metadata_candidate')
  );

  update public.ai_jobs
  set status = 'succeeded',
      output_ref = jsonb_build_object(
        'candidate',p_candidate,
        'diagnostics',p_diagnostics,
        'reviewRequired',true,
        'savedMetadataUpdated',false
      ),
      model = trim(p_model),
      usage_json = p_usage,
      error_code = null,
      error_message = null,
      started_at = coalesce(started_at,clock_timestamp()),
      completed_at = clock_timestamp()
  where id = v_job.id
  returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)
  from public, anon, authenticated;
grant execute on function public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)
  to service_role;

comment on function public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) is
  'Atomically audits and meters a review-only metadata candidate; never updates book_metadata.';
