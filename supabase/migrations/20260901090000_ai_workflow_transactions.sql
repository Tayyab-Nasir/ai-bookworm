-- Durable AI job completion and suggestion review. No client may write job
-- accounting or suggestion state directly; these RPCs keep each transition
-- atomic and enforce tenant roles explicitly.

alter table public.ai_runs
  add column if not exists ai_job_id uuid references public.ai_jobs(id) on delete set null;
alter table public.usage_events
  add column if not exists ai_job_id uuid references public.ai_jobs(id) on delete set null;

create unique index if not exists ai_runs_ai_job_id_key
  on public.ai_runs(ai_job_id) where ai_job_id is not null;
create unique index if not exists usage_events_ai_credits_job_key
  on public.usage_events(ai_job_id) where ai_job_id is not null and meter = 'ai_credits';

create or replace function public.complete_ai_job(
  p_job_id uuid,
  p_provider text,
  p_model text,
  p_usage jsonb,
  p_diagnostics jsonb,
  p_suggestions jsonb,
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
  v_confidence numeric;
  v_entity_id uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null
    or coalesce(length(trim(p_provider)), 0) not between 1 and 200
    or coalesce(length(trim(p_model)), 0) not between 1 and 200
    or jsonb_typeof(p_usage) is distinct from 'object'
    or jsonb_typeof(p_diagnostics) is distinct from 'array'
    or jsonb_typeof(p_suggestions) is distinct from 'array'
    or jsonb_array_length(p_diagnostics) > 500
    or jsonb_array_length(p_suggestions) > 500
    or octet_length(p_usage::text) > 100000
    or octet_length(p_diagnostics::text) > 2000000
    or octet_length(p_suggestions::text) > 8000000
    or p_credit_quantity is null
    or p_credit_quantity < 0
    or p_credit_quantity::text = 'NaN'
  then
    raise exception 'invalid AI completion' using errcode = '22023';
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
    raise exception 'invalid AI usage' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_diagnostics) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or coalesce(length(trim(v_item->>'severity')), 0) = 0
      or coalesce(length(trim(v_item->>'code')), 0) = 0
      or coalesce(length(trim(v_item->>'message')), 0) = 0
      or jsonb_typeof(v_item->'location') is distinct from 'object'
    then
      raise exception 'invalid AI diagnostic' using errcode = '22023';
    end if;
  end loop;

  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found then
    raise exception 'AI job not found' using errcode = 'P0002';
  end if;
  if v_job.status = 'succeeded' then
    return v_job;
  end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'AI job cannot be completed from current state' using errcode = '55000';
  end if;
  select organization_id into v_organization_id
    from public.workspaces where id = v_job.workspace_id;
  if v_organization_id is null then
    raise exception 'AI job workspace not found' using errcode = 'P0002';
  end if;

  for v_item in select value from jsonb_array_elements(p_suggestions) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or jsonb_typeof(v_item->'id') is distinct from 'string'
      or v_item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or v_item->>'entityType' is distinct from 'chapter'
      or jsonb_typeof(v_item->'entityId') is distinct from 'string'
      or v_item->>'entityId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(v_item->'operation') is distinct from 'object'
      or v_item->'operation'->>'type' is distinct from 'replace_text'
      or coalesce(length(v_item->'operation'->>'operationId'), 0) not between 1 and 200
      or jsonb_typeof(v_item->'operation'->'target') is distinct from 'object'
      or jsonb_typeof(v_item->'operation'->'payload') is distinct from 'object'
      or coalesce(length(v_item->'operation'->'target'->>'nodeId'), 0) = 0
      or v_item->'operation'->'payload'->>'nodeId' is distinct from v_item->'operation'->'target'->>'nodeId'
      or jsonb_typeof(v_item->'operation'->'payload'->'text') is distinct from 'string'
      or jsonb_typeof(v_item->'operation'->'payload'->'from') is distinct from 'number'
      or jsonb_typeof(v_item->'operation'->'payload'->'to') is distinct from 'number'
      or jsonb_typeof(v_item->'operation'->'expectedVersion') is distinct from 'number'
      or v_item->'operation'->'payload'->>'from' !~ '^[0-9]+$'
      or v_item->'operation'->'payload'->>'to' !~ '^[0-9]+$'
      or v_item->'operation'->>'expectedVersion' !~ '^[0-9]+$'
      or (v_item->'operation'->'payload'->>'to')::numeric < (v_item->'operation'->'payload'->>'from')::numeric
      or jsonb_typeof(v_item->'rationale') is distinct from 'string'
      or coalesce(length(trim(v_item->>'rationale')), 0) not between 1 and 4000
      or not (v_item ? 'confidence')
      or jsonb_typeof(v_item->'confidence') not in ('number', 'null')
    then
      raise exception 'invalid AI suggestion' using errcode = '22023';
    end if;

    v_entity_id := (v_item->>'entityId')::uuid;
    if v_item->'operation'->'target'->>'chapterId' is distinct from v_entity_id::text
      or not exists (
        select 1
        from public.chapters c
        join public.books b on b.id = c.book_id
        where c.id = v_entity_id
          and b.workspace_id = v_job.workspace_id
          and (v_job.book_id is null or b.id = v_job.book_id)
      )
    then
      raise exception 'AI suggestion target is outside job scope' using errcode = '42501';
    end if;
    if jsonb_typeof(v_item->'confidence') = 'number' then
      v_confidence := (v_item->>'confidence')::numeric;
      if v_confidence < 0 or v_confidence > 1 then
        raise exception 'invalid AI suggestion confidence' using errcode = '22023';
      end if;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_suggestions) loop
    insert into public.ai_suggestions(
      id, ai_job_id, entity_type, entity_id, operation_json, rationale, confidence
    ) values (
      (v_item->>'id')::uuid,
      v_job.id,
      v_item->>'entityType',
      (v_item->>'entityId')::uuid,
      v_item->'operation',
      v_item->>'rationale',
      case when jsonb_typeof(v_item->'confidence') = 'number'
        then (v_item->>'confidence')::numeric else null end
    );
  end loop;

  insert into public.ai_runs(
    ai_job_id, workspace_id, provider, model, tokens_in, tokens_out,
    estimated_cost, latency_ms, status
  ) values (
    v_job.id,
    v_job.workspace_id,
    trim(p_provider),
    trim(p_model),
    (p_usage->>'inputTokens')::integer,
    (p_usage->>'outputTokens')::integer,
    (p_usage->>'estimatedCostUsd')::numeric,
    case when p_usage ? 'latencyMs' then (p_usage->>'latencyMs')::integer end,
    'succeeded'
  );

  insert into public.usage_events(
    ai_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json
  ) values (
    v_job.id,
    v_organization_id,
    v_job.created_by,
    v_job.workspace_id,
    'ai_credits',
    p_credit_quantity,
    jsonb_build_object('aiJobId', v_job.id, 'provider', trim(p_provider), 'model', trim(p_model))
  );

  update public.ai_jobs
  set status = 'succeeded',
      output_ref = jsonb_build_object(
        'diagnostics', p_diagnostics,
        'suggestionCount', jsonb_array_length(p_suggestions)
      ),
      model = trim(p_model),
      usage_json = p_usage,
      error_code = null,
      error_message = null,
      started_at = coalesce(started_at, clock_timestamp()),
      completed_at = clock_timestamp()
  where id = v_job.id
  returning * into v_job;
  return v_job;
end;
$$;

create or replace function public.accept_ai_suggestion(
  p_suggestion_id uuid,
  p_content_json jsonb,
  p_plain_text text,
  p_word_count integer
) returns public.document_versions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_suggestion public.ai_suggestions;
  v_job public.ai_jobs;
  v_chapter public.chapters;
  v_book public.books;
  v_expected_version integer;
  v_operation_id text := 'ai-suggestion:' || p_suggestion_id::text;
  v_result public.document_versions;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_suggestion from public.ai_suggestions
    where id = p_suggestion_id for update;
  if not found then
    raise exception 'AI suggestion not found' using errcode = 'P0002';
  end if;
  select * into strict v_job from public.ai_jobs where id = v_suggestion.ai_job_id;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = v_job.workspace_id
      and user_id = auth.uid()
      and status = 'active'
      and role::text in ('owner', 'admin', 'editor', 'writer')
  ) then
    raise exception 'role cannot review AI suggestion' using errcode = '42501';
  end if;

  if v_suggestion.status = 'accepted' then
    select * into v_result from public.document_versions
      where chapter_id = v_suggestion.entity_id and operation_id = v_operation_id;
    if not found or v_result.content_json <> p_content_json
      or v_result.plain_text <> p_plain_text or v_result.word_count <> p_word_count
    then
      raise exception 'accepted suggestion retry does not match saved version' using errcode = '40001';
    end if;
    return v_result;
  end if;
  if v_suggestion.status <> 'pending' then
    raise exception 'AI suggestion is not pending' using errcode = '55000';
  end if;
  if v_suggestion.entity_type <> 'chapter'
    or v_suggestion.entity_id is null
    or v_suggestion.operation_json->>'type' is distinct from 'replace_text'
    or v_suggestion.operation_json->'target'->>'chapterId' is distinct from v_suggestion.entity_id::text
    or jsonb_typeof(v_suggestion.operation_json->'expectedVersion') is distinct from 'number'
    or v_suggestion.operation_json->>'expectedVersion' !~ '^[0-9]+$'
    or (v_suggestion.operation_json->>'expectedVersion')::numeric > 2147483647
  then
    raise exception 'invalid replace_text suggestion' using errcode = '22023';
  end if;
  select * into v_chapter from public.chapters where id = v_suggestion.entity_id;
  if not found then
    raise exception 'suggestion chapter not found' using errcode = 'P0002';
  end if;
  select * into strict v_book from public.books where id = v_chapter.book_id;
  if v_book.workspace_id <> v_job.workspace_id
    or (v_job.book_id is not null and v_book.id <> v_job.book_id)
  then
    raise exception 'AI suggestion target is outside job scope' using errcode = '42501';
  end if;

  v_expected_version := (v_suggestion.operation_json->>'expectedVersion')::integer;
  select * into v_result from public.append_chapter_version(
    v_chapter.id,
    v_expected_version,
    p_content_json,
    p_plain_text,
    p_word_count,
    'Accepted AI suggestion',
    v_operation_id
  );
  update public.ai_suggestions
    set status = 'accepted', reviewed_by = auth.uid(), reviewed_at = clock_timestamp()
    where id = v_suggestion.id;
  return v_result;
end;
$$;

create or replace function public.reject_ai_suggestion(p_suggestion_id uuid)
returns public.ai_suggestions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_suggestion public.ai_suggestions;
  v_workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_suggestion from public.ai_suggestions
    where id = p_suggestion_id for update;
  if not found then
    raise exception 'AI suggestion not found' using errcode = 'P0002';
  end if;
  select workspace_id into strict v_workspace_id
    from public.ai_jobs where id = v_suggestion.ai_job_id;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = v_workspace_id
      and user_id = auth.uid()
      and status = 'active'
      and role::text in ('owner', 'admin', 'editor', 'writer')
  ) then
    raise exception 'role cannot review AI suggestion' using errcode = '42501';
  end if;
  if v_suggestion.status = 'rejected' then
    return v_suggestion;
  end if;
  if v_suggestion.status <> 'pending' then
    raise exception 'AI suggestion is not pending' using errcode = '55000';
  end if;
  update public.ai_suggestions
    set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = clock_timestamp()
    where id = v_suggestion.id
    returning * into v_suggestion;
  return v_suggestion;
end;
$$;

revoke all on function public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)
  from public, anon, authenticated;
grant execute on function public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)
  to service_role;

revoke all on function public.accept_ai_suggestion(uuid,jsonb,text,integer)
  from public, anon;
revoke all on function public.reject_ai_suggestion(uuid)
  from public, anon;
grant execute on function public.accept_ai_suggestion(uuid,jsonb,text,integer)
  to authenticated;
grant execute on function public.reject_ai_suggestion(uuid)
  to authenticated;

grant select, update on public.ai_jobs to service_role;
grant select, insert on public.ai_suggestions, public.ai_runs, public.usage_events to service_role;
grant usage, select on sequence public.usage_events_id_seq to service_role;
