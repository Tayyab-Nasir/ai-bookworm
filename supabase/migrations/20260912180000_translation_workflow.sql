-- Durable, paid-only manuscript translation. Jobs keep only immutable source
-- pointers and hashes; the worker rehydrates the canonical saved chapter.
create table public.translation_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  source_language text not null check (length(source_language) between 2 and 35),
  target_language text not null check (length(target_language) between 2 and 35),
  status public.job_status not null default 'queued',
  chapter_count integer not null check (chapter_count between 1 and 500),
  completed_chapter_count integer not null default 0 check (completed_chapter_count between 0 and 500),
  credit_units integer not null check (credit_units between 1 and 16000),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  adopted_book_id uuid unique references public.books(id) on delete set null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  check (lower(source_language) <> lower(target_language))
);

create table public.translation_chapters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.translation_projects(id) on delete cascade,
  ai_job_id uuid not null unique references public.ai_jobs(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id),
  chapter_order integer not null check (chapter_order >= 0),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  credit_units integer not null check (credit_units between 1 and 32),
  translated_text text check (translated_text is null or octet_length(translated_text) between 1 and 128000),
  translated_sha256 text check (translated_sha256 is null or translated_sha256 ~ '^[a-f0-9]{64}$'),
  translated_word_count integer check (translated_word_count is null or translated_word_count >= 0),
  completed_at timestamptz,
  unique(project_id, chapter_id)
);

create table public.translation_completion_receipts (
  ai_job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  completion_json jsonb not null check (
    jsonb_typeof(completion_json) = 'object' and octet_length(completion_json::text) <= 1000000
  ),
  created_at timestamptz not null default now()
);

alter table public.translation_projects enable row level security;
alter table public.translation_chapters enable row level security;
alter table public.translation_completion_receipts enable row level security;

create policy translation_projects_select on public.translation_projects
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy translation_chapters_select on public.translation_chapters
  for select to authenticated using (exists (
    select 1 from public.translation_projects p
    where p.id = project_id and private.is_workspace_member(p.workspace_id)
  ));

revoke all on public.translation_projects, public.translation_chapters,
  public.translation_completion_receipts from public, anon, authenticated, service_role;
grant select on public.translation_projects, public.translation_chapters to authenticated;
grant select, insert, update on public.translation_projects, public.translation_chapters to service_role;
grant select, insert on public.translation_completion_receipts to service_role;

create index translation_projects_book_created on public.translation_projects(book_id, created_at desc);
create index translation_chapters_project_order on public.translation_chapters(project_id, chapter_order);
create index ai_jobs_pending_translation on public.ai_jobs(available_at, created_at)
  where agent_type = 'translator' and status in ('queued', 'running');
create unique index usage_events_translation_credits_job_key on public.usage_events(ai_job_id)
  where ai_job_id is not null and meter = 'translation_credits';

create function public.reserve_translation_job_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text; v_org uuid; v_quota_text text; v_quota numeric := 0;
  v_used numeric; v_pending numeric; v_units integer;
begin
  if new.agent_type <> 'translator' or new.status not in ('queued', 'running') then return new; end if;
  if tg_op = 'UPDATE' and old.agent_type = 'translator' and old.status in ('queued', 'running')
    and old.workspace_id = new.workspace_id and old.created_by = new.created_by then return new; end if;
  if jsonb_typeof(new.input_ref->'creditUnits') is distinct from 'number'
    or new.input_ref->>'creditUnits' !~ '^[1-9][0-9]?$' then
    raise exception 'invalid translation credit reservation' using errcode = '22023'; end if;
  v_units := (new.input_ref->>'creditUnits')::integer;
  if v_units > 32 then raise exception 'invalid translation credit reservation' using errcode = '22023'; end if;
  select role::text into v_role from public.workspace_members
    where workspace_id = new.workspace_id and user_id = new.created_by and status = 'active' for share;
  if not found or v_role not in ('owner', 'admin', 'editor', 'writer') then
    raise exception 'translation reservation requires editing access' using errcode = '42501'; end if;
  select organization_id into v_org from public.workspaces where id = new.workspace_id;
  perform id from public.organizations where id = v_org for update;
  if not found then raise exception 'translation organization missing' using errcode = '22023'; end if;
  select case when p.entitlements_json ? 'translation_credits_monthly'
    then coalesce(p.entitlements_json->>'translation_credits_monthly', '0') else null end into v_quota_text
    from public.subscriptions s left join public.plans p on p.id = s.plan_id
    where s.organization_id = v_org and s.status in ('active', 'trialing')
    order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'invalid translation credit entitlement' using errcode = '22023'; end if;
    v_quota := v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity), 0) into v_used from public.usage_events
    where organization_id = v_org and meter = 'translation_credits'
      and created_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC');
  select coalesce(sum((j.input_ref->>'creditUnits')::numeric), 0) into v_pending
    from public.ai_jobs j join public.workspaces w on w.id = j.workspace_id
    where w.organization_id = v_org and j.agent_type = 'translator'
      and j.status in ('queued', 'running') and j.id <> new.id;
  if v_used + v_pending + v_units > v_quota then
    raise exception 'translation credit capacity exhausted' using errcode = '23514'; end if;
  return new;
end $$;

revoke all on function public.reserve_translation_job_credit() from public, anon, authenticated;
create trigger translation_job_credit_reservation before insert or update of status, agent_type, workspace_id, created_by
  on public.ai_jobs for each row execute function public.reserve_translation_job_credit();

create function public.queue_translation_project(p_book_id uuid, p_target_language text, p_idempotency_key text)
returns public.translation_projects
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := auth.uid(); v_book public.books; v_existing public.translation_projects;
  v_project public.translation_projects; v_source record; v_job_id uuid; v_chapter_id uuid;
  v_count integer := 0; v_total_units integer := 0; v_units integer; v_target text := lower(trim(p_target_language));
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_book_id is null or p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200
    or v_target !~ '^[a-z]{2,8}(-[a-z0-9]{2,8})*$' then
    raise exception 'invalid translation request' using errcode = '22023'; end if;
  select * into v_existing from public.translation_projects where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.created_by <> v_uid or v_existing.book_id <> p_book_id or v_existing.target_language <> v_target then
      raise exception 'translation request key conflict' using errcode = '23505'; end if;
    return v_existing;
  end if;
  select * into v_book from public.books where id = p_book_id;
  if not found then raise exception 'translation book not found' using errcode = 'P0002'; end if;
  if not private.can_edit_workspace(v_book.workspace_id) then
    raise exception 'editing access required' using errcode = '42501'; end if;
  if lower(v_book.language) !~ '^[a-z]{2,8}(-[a-z0-9]{2,8})*$' then
    raise exception 'source book language is invalid' using errcode = '22023'; end if;
  if lower(v_book.language) = v_target then
    raise exception 'target language must differ from the source language' using errcode = '22023'; end if;
  for v_source in
    select c.id as chapter_id, c.order_index, dv.id as document_version_id, dv.plain_text
      from public.chapters c left join public.document_versions dv on dv.id = c.current_document_version_id
      where c.book_id = p_book_id order by c.order_index
  loop
    if v_source.document_version_id is null or length(trim(coalesce(v_source.plain_text, ''))) = 0 then
      raise exception 'every chapter needs saved text before translation' using errcode = '22023'; end if;
    if length(v_source.plain_text) > 32000 then
      raise exception 'translation chapter exceeds 32000 characters; split it before translation' using errcode = '22023'; end if;
    v_count := v_count + 1;
    v_units := ceil(length(v_source.plain_text)::numeric / 1000)::integer;
    v_total_units := v_total_units + v_units;
  end loop;
  if v_count not between 1 and 500 then raise exception 'translation needs between one and 500 saved chapters' using errcode = '22023'; end if;
  insert into public.translation_projects(workspace_id, book_id, source_language, target_language, chapter_count, credit_units, idempotency_key, created_by)
    values(v_book.workspace_id, v_book.id, lower(v_book.language), v_target, v_count, v_total_units, p_idempotency_key, v_uid)
    returning * into v_project;
  for v_source in
    select c.id as chapter_id, c.order_index, dv.id as document_version_id, dv.plain_text
      from public.chapters c join public.document_versions dv on dv.id = c.current_document_version_id
      where c.book_id = p_book_id order by c.order_index
  loop
    v_units := ceil(length(v_source.plain_text)::numeric / 1000)::integer;
    v_job_id := gen_random_uuid();
    v_chapter_id := gen_random_uuid();
    insert into public.ai_jobs(id, workspace_id, book_id, agent_type, status, input_ref, idempotency_key, created_by)
      values(v_job_id, v_book.workspace_id, v_book.id, 'translator', 'queued', jsonb_build_object(
        'translationProjectId', v_project.id, 'translationChapterId', v_chapter_id,
        'chapterId', v_source.chapter_id, 'documentVersionId', v_source.document_version_id,
        'sourceSha256', encode(digest(convert_to(v_source.plain_text, 'UTF8'), 'sha256'), 'hex'),
        'sourceLanguage', lower(v_book.language), 'targetLanguage', v_target, 'creditUnits', v_units
      ), 'translation:' || v_project.id::text || ':' || v_source.chapter_id::text, v_uid);
    insert into public.translation_chapters(id, project_id, ai_job_id, chapter_id, document_version_id, chapter_order, source_sha256, credit_units)
      values(v_chapter_id, v_project.id, v_job_id, v_source.chapter_id, v_source.document_version_id, v_source.order_index,
        encode(digest(convert_to(v_source.plain_text, 'UTF8'), 'sha256'), 'hex'), v_units);
  end loop;
  return v_project;
end $$;

create function public.claim_translation_job(p_lease_seconds integer default 600)
returns setof public.ai_jobs language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.ai_jobs; v_project_id uuid;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode = '22023'; end if;
  for v_job in select j.* from public.ai_jobs j join public.translation_chapters tc on tc.ai_job_id = j.id
    join public.translation_projects p on p.id = tc.project_id
    where j.agent_type = 'translator' and p.status in ('queued', 'running') and (
      (j.status = 'queued' and j.available_at <= clock_timestamp()) or
      (j.status = 'running' and j.lease_expires_at <= clock_timestamp())
    ) order by j.available_at, j.created_at, j.id for update of j skip locked limit 100
  loop
    v_project_id := (v_job.input_ref->>'translationProjectId')::uuid;
    if v_job.attempts >= 5 then
      update public.ai_jobs set status = 'failed', error_code = 'translation_attempts_exhausted',
        error_message = 'Translation attempts exhausted', lease_token = null, lease_expires_at = null,
        completed_at = clock_timestamp() where id = v_job.id;
      update public.translation_projects set status = 'failed', completed_at = clock_timestamp() where id = v_project_id;
      update public.ai_jobs j set status = 'cancelled', error_code = 'translation_project_failed',
        error_message = 'Another translation chapter failed', lease_token = null, lease_expires_at = null, completed_at = clock_timestamp()
        from public.translation_chapters tc where tc.ai_job_id = j.id and tc.project_id = v_project_id
          and j.id <> v_job.id and j.status in ('queued', 'running');
      continue;
    end if;
    update public.ai_jobs set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, clock_timestamp()),
      completed_at = null, error_code = null, error_message = null, lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
      where id = v_job.id returning * into v_job;
    update public.translation_projects set status = 'running', started_at = coalesce(started_at, clock_timestamp()) where id = v_project_id;
    return next v_job; return;
  end loop;
end $$;

create function public.renew_translation_lease(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer default 600)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode = '22023'; end if;
  update public.ai_jobs set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = p_job_id and agent_type = 'translator' and status = 'running' and lease_token = p_lease_token
      and lease_expires_at > clock_timestamp();
  return found;
end $$;

create function public.complete_translation_chapter(
  p_job_id uuid, p_lease_token uuid, p_translated_text text, p_provider text, p_model text,
  p_request_id text, p_usage jsonb
) returns public.ai_jobs language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare v_job public.ai_jobs; v_chapter public.translation_chapters; v_project public.translation_projects;
  v_org uuid; v_remaining integer; v_completed integer; v_result public.ai_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501'; end if;
  if p_translated_text is null or length(trim(p_translated_text)) = 0 or octet_length(p_translated_text) > 128000
    or length(trim(p_provider)) not between 1 and 100 or length(trim(p_model)) not between 1 and 200
    or (p_request_id is not null and length(p_request_id) > 500) or jsonb_typeof(p_usage) is distinct from 'object'
    or jsonb_typeof(p_usage->'inputTokens') is distinct from 'number' or jsonb_typeof(p_usage->'outputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'estimatedCostUsd') is distinct from 'number' or jsonb_typeof(p_usage->'latencyMs') is distinct from 'number'
    or p_usage->>'inputTokens' !~ '^[0-9]+$' or p_usage->>'outputTokens' !~ '^[0-9]+$'
    or p_usage->>'latencyMs' !~ '^[0-9]+$' or (p_usage->>'estimatedCostUsd')::numeric < 0 then
    raise exception 'invalid translation completion' using errcode = '22023'; end if;
  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found then raise exception 'translation job not found' using errcode = 'P0002'; end if;
  select * into strict v_chapter from public.translation_chapters where ai_job_id = v_job.id;
  select * into strict v_project from public.translation_projects where id = v_chapter.project_id for update;
  if v_job.status = 'succeeded' then return v_job; end if;
  if v_job.agent_type <> 'translator' or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'lease lost' using errcode = '40001'; end if;
  select organization_id into strict v_org from public.workspaces where id = v_job.workspace_id;
  insert into public.ai_runs(ai_job_id, workspace_id, provider, model, tokens_in, tokens_out, estimated_cost, latency_ms, status)
    values(v_job.id, v_job.workspace_id, trim(p_provider), trim(p_model), (p_usage->>'inputTokens')::integer,
      (p_usage->>'outputTokens')::integer, (p_usage->>'estimatedCostUsd')::numeric, (p_usage->>'latencyMs')::integer, 'succeeded');
  insert into public.usage_events(ai_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json)
    values(v_job.id, v_org, v_job.created_by, v_job.workspace_id, 'translation_credits', v_chapter.credit_units,
      jsonb_build_object('translationProjectId', v_project.id, 'translationChapterId', v_chapter.id,
        'provider', trim(p_provider), 'model', trim(p_model), 'requestId', p_request_id));
  update public.translation_chapters set translated_text = p_translated_text,
    translated_sha256 = encode(digest(convert_to(p_translated_text, 'UTF8'), 'sha256'), 'hex'),
    translated_word_count = cardinality(regexp_split_to_array(trim(p_translated_text), '\s+')),
    completed_at = clock_timestamp() where id = v_chapter.id;
  update public.ai_jobs set status = 'succeeded', output_ref = jsonb_build_object(
      'translationProjectId', v_project.id, 'translationChapterId', v_chapter.id), model = trim(p_model), usage_json = p_usage,
    error_code = null, error_message = null, lease_token = null, lease_expires_at = null, completed_at = clock_timestamp()
    where id = v_job.id returning * into v_result;
  select count(*) into v_remaining from public.translation_chapters tc join public.ai_jobs j on j.id = tc.ai_job_id
    where tc.project_id = v_project.id and j.status <> 'succeeded';
  select count(*) into v_completed from public.translation_chapters tc join public.ai_jobs j on j.id = tc.ai_job_id
    where tc.project_id = v_project.id and j.status = 'succeeded';
  update public.translation_projects set completed_chapter_count = v_completed,
    status = case when v_remaining = 0 then 'succeeded'::public.job_status else 'running'::public.job_status end,
    completed_at = case when v_remaining = 0 then clock_timestamp() else null end where id = v_project.id;
  return v_result;
end $$;

create function public.fail_translation_job(p_job_id uuid, p_lease_token uuid, p_error_code text, p_error_message text, p_retryable boolean)
returns public.ai_jobs language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.ai_jobs; v_project_id uuid; v_terminal boolean;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' or p_error_message is null
    or length(p_error_message) > 2000 or p_retryable is null then
    raise exception 'invalid translation failure' using errcode = '22023'; end if;
  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found then raise exception 'translation job not found' using errcode = 'P0002'; end if;
  if v_job.agent_type <> 'translator' or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'lease lost' using errcode = '40001'; end if;
  v_terminal := not p_retryable or v_job.attempts >= 5;
  update public.ai_jobs set status = (case when v_terminal then 'failed' else 'queued' end)::public.job_status,
    error_code = p_error_code, error_message = p_error_message, lease_token = null, lease_expires_at = null,
    available_at = clock_timestamp() + make_interval(secs => (5 * power(2, v_job.attempts - 1))::integer),
    completed_at = case when v_terminal then clock_timestamp() else null end where id = p_job_id returning * into v_job;
  if v_terminal then
    select project_id into strict v_project_id from public.translation_chapters where ai_job_id = p_job_id;
    update public.translation_projects set status = 'failed', completed_at = clock_timestamp() where id = v_project_id;
    update public.ai_jobs j set status = 'cancelled', error_code = 'translation_project_failed',
      error_message = 'Another translation chapter failed', lease_token = null, lease_expires_at = null, completed_at = clock_timestamp()
      from public.translation_chapters tc where tc.ai_job_id = j.id and tc.project_id = v_project_id
        and j.id <> p_job_id and j.status in ('queued', 'running');
  end if;
  return v_job;
end $$;

create function public.adopt_translation_project(p_project_id uuid, p_title text)
returns public.books language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_project public.translation_projects; v_source public.books;
  v_book public.books; v_row record; v_chapter public.chapters; v_version uuid; v_nodes jsonb;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_project_id is null or p_title is null or length(trim(p_title)) not between 1 and 500 then
    raise exception 'invalid translated book title' using errcode = '22023'; end if;
  select * into v_project from public.translation_projects where id = p_project_id for update;
  if not found then raise exception 'translation project not found' using errcode = 'P0002'; end if;
  select * into strict v_source from public.books where id = v_project.book_id;
  if not private.can_edit_workspace(v_source.workspace_id) then
    raise exception 'editing access required' using errcode = '42501'; end if;
  if v_project.adopted_book_id is not null then
    select * into strict v_book from public.books where id = v_project.adopted_book_id;
    return v_book;
  end if;
  if v_project.status <> 'succeeded' or v_project.completed_chapter_count <> v_project.chapter_count
    or exists(select 1 from public.translation_chapters where project_id = v_project.id and translated_text is null) then
    raise exception 'translation is not ready to adopt' using errcode = '22023'; end if;
  insert into public.books(workspace_id, title, subtitle, author_name, language, genre, status, created_by)
    values(v_source.workspace_id, trim(p_title), v_source.subtitle, v_source.author_name, v_project.target_language,
      v_source.genre, 'draft', v_uid) returning * into v_book;
  for v_row in select tc.translated_text, c.title, c.order_index from public.translation_chapters tc
    join public.chapters c on c.id = tc.chapter_id where tc.project_id = v_project.id order by tc.chapter_order
  loop
    v_nodes := jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'type', 'paragraph', 'text', v_row.translated_text));
    insert into public.chapters(book_id, order_index, title) values(v_book.id, v_row.order_index, v_row.title) returning * into v_chapter;
    insert into public.document_versions(chapter_id, version_number, content_json, plain_text, word_count, created_by, change_summary)
      values(v_chapter.id, 1, jsonb_build_object('schemaVersion', '1.0', 'nodes', v_nodes), v_row.translated_text,
        cardinality(regexp_split_to_array(trim(v_row.translated_text), '\s+')), v_uid, 'AI translation draft adopted for author review')
      returning id into v_version;
    update public.chapters set current_document_version_id = v_version where id = v_chapter.id;
  end loop;
  update public.translation_projects set adopted_book_id = v_book.id where id = v_project.id;
  return v_book;
end $$;

revoke all on function public.queue_translation_project(uuid, text, text), public.adopt_translation_project(uuid, text),
  public.claim_translation_job(integer), public.renew_translation_lease(uuid, uuid, integer),
  public.complete_translation_chapter(uuid, uuid, text, text, text, text, jsonb),
  public.fail_translation_job(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.queue_translation_project(uuid, text, text), public.adopt_translation_project(uuid, text) to authenticated;
grant execute on function public.claim_translation_job(integer), public.renew_translation_lease(uuid, uuid, integer),
  public.complete_translation_chapter(uuid, uuid, text, text, text, text, jsonb),
  public.fail_translation_job(uuid, uuid, text, text, boolean) to service_role;
