-- Paid AI Story Blueprint proposals are snapshots for review, never mutations.
-- Requesting or quoting captures no provider output, creates no AI job, and
-- debits no credits. Only acceptance creates a held, quoted job. A later worker
-- must dispatch and persist a private candidate before any separate review/apply
-- flow can call save_story_blueprint.

alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check (
  (billing_mode = 'quoted' and agent_type in ('translator', 'story_blueprint'))
  or (billing_mode = 'operational' and agent_type <> 'story_blueprint')
);

-- Retain the original quoted-translation guard while allowing a Story
-- Blueprint receipt to be leased again strictly for settlement/completion.
-- It does not authorize another provider dispatch; that is separately pinned
-- by funded_usage_quotes.dispatched_at and claim_funded_dispatch.
create or replace function public.guard_job_billing_mode() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.billing_mode is distinct from old.billing_mode then
    raise exception 'job billing mode is immutable' using errcode='23514'; end if;
  if tg_op='INSERT' and new.billing_mode='quoted' and new.status<>'queued' then
    raise exception 'quoted job must enter queued' using errcode='23514'; end if;
  if new.billing_mode='quoted' and new.status='running' then
    if not exists(
      select 1 from public.funded_usage_quotes q
      where q.job_id=new.id and q.user_id=new.created_by and q.workspace_id=new.workspace_id
        and (
          (q.status='held' and ((q.quote_json->>'expiresAt')::timestamptz>clock_timestamp() or q.dispatched_at is not null))
          or (new.agent_type='story_blueprint' and q.status='settled' and q.settlement_json is not null
            and exists (select 1 from public.story_blueprint_generation_results r where r.ai_job_id=new.id))
        )
    ) then
      raise exception 'quoted job requires funded hold' using errcode='23514'; end if;
  end if;
  return new;
end $$;

create table public.story_blueprint_quote_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  workspace_id uuid not null references public.workspaces(id),
  book_id uuid not null references public.books(id) on delete cascade,
  blueprint_id uuid not null references public.story_blueprints(id) on delete cascade,
  source_revision integer not null check (source_revision >= 1),
  source_snapshot_json jsonb not null check (
    jsonb_typeof(source_snapshot_json) = 'object'
    and octet_length(source_snapshot_json::text) <= 300000
  ),
  -- The book identity is part of the provider prompt. Pin it separately from
  -- the manual Blueprint snapshot so later metadata edits cannot change an
  -- accepted paid request.
  book_snapshot_json jsonb not null check (
    jsonb_typeof(book_snapshot_json) = 'object'
    and octet_length(book_snapshot_json::text) <= 4096
    and jsonb_typeof(book_snapshot_json->'title') = 'string'
    and length(trim(book_snapshot_json->>'title')) between 1 and 500
    and jsonb_typeof(book_snapshot_json->'author') = 'string'
    and length(trim(book_snapshot_json->>'author')) <= 500
    and jsonb_typeof(book_snapshot_json->'language') = 'string'
    and length(trim(book_snapshot_json->>'language')) between 1 and 40
  ),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  catalog_json jsonb not null check (
    jsonb_typeof(catalog_json) = 'object'
    and octet_length(catalog_json::text) <= 65536
  ),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  generation_job_id uuid not null unique,
  status text not null default 'queued' check (status in ('queued', 'counting', 'ready', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  check ((lease_token is null) = (lease_expires_at is null)),
  unique (user_id, idempotency_key)
);

create table public.story_blueprint_quote_proposals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.story_blueprint_quote_requests(id) on delete restrict,
  user_id uuid not null references auth.users(id),
  workspace_id uuid not null references public.workspaces(id),
  book_id uuid not null references public.books(id) on delete cascade,
  blueprint_id uuid not null references public.story_blueprints(id) on delete cascade,
  source_revision integer not null check (source_revision >= 1),
  source_snapshot_json jsonb not null check (
    jsonb_typeof(source_snapshot_json) = 'object'
    and octet_length(source_snapshot_json::text) <= 300000
  ),
  book_snapshot_json jsonb not null check (
    jsonb_typeof(book_snapshot_json) = 'object'
    and octet_length(book_snapshot_json::text) <= 4096
    and jsonb_typeof(book_snapshot_json->'title') = 'string'
    and length(trim(book_snapshot_json->>'title')) between 1 and 500
    and jsonb_typeof(book_snapshot_json->'author') = 'string'
    and length(trim(book_snapshot_json->>'author')) <= 500
    and jsonb_typeof(book_snapshot_json->'language') = 'string'
    and length(trim(book_snapshot_json->>'language')) between 1 and 40
  ),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  -- This is the canonical, server-computed provider request fingerprint from
  -- UsageQuote.scope.inputSha256. It is intentionally distinct from the
  -- source snapshot hash above: the latter guards stale manual revisions.
  generation_request_sha256 text not null check (generation_request_sha256 ~ '^[a-f0-9]{64}$'),
  catalog_json jsonb not null check (
    jsonb_typeof(catalog_json) = 'object'
    and octet_length(catalog_json::text) <= 65536
  ),
  generation_job_id uuid not null unique,
  usage_quote_json jsonb not null check (
    jsonb_typeof(usage_quote_json) = 'object'
    and octet_length(usage_quote_json::text) <= 65536
  ),
  reserved_credits integer not null check (reserved_credits > 0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_job_id uuid unique references public.ai_jobs(id) on delete restrict,
  check (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
  check ((accepted_at is null) = (accepted_job_id is null))
);

create table public.story_blueprint_generation_results (
  ai_job_id uuid primary key references public.ai_jobs(id) on delete restrict,
  proposal_id uuid not null unique references public.story_blueprint_quote_proposals(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id),
  book_id uuid not null references public.books(id) on delete cascade,
  source_revision integer not null check (source_revision >= 1),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  provider_receipt_json jsonb not null check (
    jsonb_typeof(provider_receipt_json) = 'object'
    and octet_length(provider_receipt_json::text) <= 65536
  ),
  candidate_json jsonb not null check (
    jsonb_typeof(candidate_json) = 'object'
    and octet_length(candidate_json::text) <= 524288
  ),
  candidate_sha256 text not null check (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);

create index story_blueprint_quote_requests_book_created
  on public.story_blueprint_quote_requests(book_id, created_at desc);
create index story_blueprint_quote_requests_claim
  on public.story_blueprint_quote_requests(created_at, id)
  where status in ('queued', 'counting');
-- A different idempotency key must not turn one book into a concurrent token
-- counting fan-out. Terminal requests remain in history and may be retried
-- with a new key, subject to the server-side hourly ceiling below.
create unique index story_blueprint_quote_requests_active
  on public.story_blueprint_quote_requests(user_id, book_id)
  where status in ('queued', 'counting');
create index story_blueprint_quote_proposals_book_created
  on public.story_blueprint_quote_proposals(book_id, created_at desc);
create index ai_jobs_pending_story_blueprint_quote
  on public.ai_jobs(available_at, created_at, id)
  where agent_type = 'story_blueprint' and billing_mode = 'quoted'
    and status in ('queued', 'running');

alter table public.story_blueprint_quote_requests enable row level security;
alter table public.story_blueprint_quote_proposals enable row level security;
alter table public.story_blueprint_generation_results enable row level security;
revoke all on public.story_blueprint_quote_requests,
  public.story_blueprint_quote_proposals,
  public.story_blueprint_generation_results from public, anon, authenticated, service_role;
grant select, insert, update on public.story_blueprint_quote_requests,
  public.story_blueprint_quote_proposals to service_role;
grant select, insert on public.story_blueprint_generation_results to service_role;

create function public.guard_story_blueprint_quote_request() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - array['status', 'attempts', 'lease_token', 'lease_expires_at', 'error_code'])
      is distinct from (to_jsonb(old) - array['status', 'attempts', 'lease_token', 'lease_expires_at', 'error_code'])
    or old.status in ('ready', 'failed')
    or new.status not in ('queued', 'counting', 'ready', 'failed')
    or new.attempts < old.attempts
    or new.attempts > old.attempts + 1
    or ((new.lease_token is null) is distinct from (new.lease_expires_at is null)) then
    raise exception 'story blueprint quote request is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger story_blueprint_quote_request_immutable
before update on public.story_blueprint_quote_requests
for each row execute function public.guard_story_blueprint_quote_request();

create function public.guard_story_blueprint_quote_proposal() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - array['accepted_at', 'accepted_job_id'])
      is distinct from (to_jsonb(old) - array['accepted_at', 'accepted_job_id'])
    or (old.accepted_at is not null and new is distinct from old) then
    raise exception 'story blueprint quote proposal is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger story_blueprint_quote_proposal_immutable
before update on public.story_blueprint_quote_proposals
for each row execute function public.guard_story_blueprint_quote_proposal();

create function public.guard_story_blueprint_job_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_proposal public.story_blueprint_quote_proposals;
begin
  if tg_op = 'INSERT' and new.agent_type = 'story_blueprint' then
    select * into v_proposal from public.story_blueprint_quote_proposals
      where generation_job_id = new.id for share;
    if not found
      or new.billing_mode <> 'quoted'
      or new.status <> 'queued'
      or new.workspace_id <> v_proposal.workspace_id
      or new.book_id <> v_proposal.book_id
      or new.created_by <> v_proposal.user_id
      or new.idempotency_key <> 'story-blueprint:' || v_proposal.id::text
      or new.input_ref is distinct from jsonb_build_object(
        'proposalId', v_proposal.id,
        'requestId', v_proposal.request_id,
        'blueprintId', v_proposal.blueprint_id,
        'sourceRevision', v_proposal.source_revision,
        'sourceSha256', v_proposal.source_sha256,
        'generationRequestSha256', v_proposal.generation_request_sha256
      )
      or new.output_ref is not null then
      raise exception 'story blueprint quoted job does not match accepted proposal' using errcode = '23514';
    end if;
  elsif tg_op = 'UPDATE' and (old.agent_type = 'story_blueprint' or new.agent_type = 'story_blueprint') then
    if new.agent_type is distinct from old.agent_type
      or new.billing_mode is distinct from old.billing_mode
      or new.input_ref is distinct from old.input_ref
      or new.workspace_id is distinct from old.workspace_id
      or new.book_id is distinct from old.book_id
      or new.created_by is distinct from old.created_by
      or new.idempotency_key is distinct from old.idempotency_key
      -- A completed review-only generation may report success, but its
      -- private candidate must never be copied into the broadly readable job.
      or new.output_ref is not null then
      raise exception 'story blueprint generation request is immutable' using errcode = '23514';
    end if;
    if new.status = 'succeeded' and old.status is distinct from 'succeeded'
      and not exists (
        select 1
        from public.story_blueprint_generation_results r
        join public.funded_usage_quotes q on q.job_id = r.ai_job_id
        where r.ai_job_id = new.id
          and q.status = 'settled'
          and q.settlement_json is not null
      ) then
      raise exception 'story blueprint success requires settled private result' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger ac_story_blueprint_job_identity
before insert or update on public.ai_jobs
for each row execute function public.guard_story_blueprint_job_identity();

create function public.guard_story_blueprint_generation_result() returns trigger
language plpgsql set search_path = public, extensions, pg_temp as $$
begin
  if new.candidate_sha256 is distinct from encode(digest(convert_to(new.candidate_json::text, 'UTF8'), 'sha256'), 'hex')
    or not exists (
      select 1
      from public.story_blueprint_quote_proposals p
      join public.ai_jobs j on j.id = p.accepted_job_id
      join public.funded_usage_quotes q on q.job_id = j.id
      where p.id = new.proposal_id
        and p.accepted_job_id = new.ai_job_id
        and p.workspace_id = new.workspace_id
        and p.book_id = new.book_id
        and p.source_revision = new.source_revision
        and p.source_sha256 = new.source_sha256
        and j.agent_type = 'story_blueprint'
        and j.billing_mode = 'quoted'
        and q.status = 'held'
        and q.dispatched_at is not null
    ) then
    raise exception 'story blueprint result scope or funding mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger story_blueprint_generation_result_validate
before insert on public.story_blueprint_generation_results
for each row execute function public.guard_story_blueprint_generation_result();

create function public.story_blueprint_generation_result_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'story blueprint generation result is immutable' using errcode = '23514';
end;
$$;

create trigger story_blueprint_generation_result_immutable
before update or delete on public.story_blueprint_generation_results
for each row execute function public.story_blueprint_generation_result_immutable();

create function public.request_story_blueprint_quote(
  p_book_id uuid,
  p_user_id uuid,
  p_catalog_json jsonb,
  p_idempotency_key text
) returns public.story_blueprint_quote_requests
language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare
  v_book public.books;
  v_blueprint public.story_blueprints;
  v_existing public.story_blueprint_quote_requests;
  v_role text;
  v_snapshot jsonb;
  v_book_snapshot jsonb;
  v_catalog_expires timestamptz;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_book_id is null or p_user_id is null
    or coalesce(length(trim(p_idempotency_key)), 0) not between 8 and 200
    or jsonb_typeof(p_catalog_json) is distinct from 'object'
    or octet_length(p_catalog_json::text) > 65536
    or p_catalog_json->'approved' is distinct from 'true'::jsonb
    or coalesce(length(trim(p_catalog_json->>'version')), 0) not between 1 and 128
    or coalesce(length(trim(p_catalog_json->>'model')), 0) not between 1 and 200
    or p_catalog_json->>'provider' is distinct from 'openai'
    or p_catalog_json->>'expiresAt' is null then
    raise exception 'invalid story blueprint quote request' using errcode = '22023';
  end if;
  begin
    v_catalog_expires := (p_catalog_json->>'expiresAt')::timestamptz;
  exception when others then
    raise exception 'invalid story blueprint catalog expiry' using errcode = '22023';
  end;
  if v_catalog_expires <= clock_timestamp() then
    raise exception 'story blueprint catalog expired' using errcode = '22023';
  end if;

  -- Serialize both idempotency replay and the one-active-request decision.
  -- The partial unique index below remains the authoritative race boundary.
  perform pg_advisory_xact_lock(hashtextextended(
    'story-blueprint-quote:' || p_user_id::text || ':' || p_book_id::text, 0
  ));
  select * into v_book from public.books where id = p_book_id for share;
  if not found then raise exception 'story blueprint book missing' using errcode = 'P0002'; end if;
  if coalesce(length(trim(v_book.title)), 0) not between 1 and 500
    or coalesce(length(trim(v_book.author_name)), 0) > 500
    or coalesce(length(trim(v_book.language)), 0) not between 1 and 40 then
    raise exception 'story blueprint book identity invalid' using errcode = '22023';
  end if;
  v_book_snapshot := jsonb_build_object(
    'title', trim(v_book.title),
    'author', trim(v_book.author_name),
    'language', trim(v_book.language)
  );
  select role::text into v_role from public.workspace_members
    where workspace_id = v_book.workspace_id and user_id = p_user_id and status = 'active' for share;
  if not found or v_role not in ('owner', 'admin', 'editor', 'writer') then
    raise exception 'story blueprint editing access required' using errcode = '42501';
  end if;
  select * into v_existing from public.story_blueprint_quote_requests
    where user_id = p_user_id and idempotency_key = trim(p_idempotency_key) for update;
  if found then
    if v_existing.book_id <> p_book_id or v_existing.catalog_json is distinct from p_catalog_json then
      raise exception 'story blueprint quote key conflict' using errcode = '23505';
    end if;
    return v_existing;
  end if;
  if exists (
    select 1 from public.story_blueprint_quote_requests r
      where r.user_id = p_user_id and r.book_id = p_book_id
        and r.status in ('queued', 'counting')
  ) then
    raise exception 'story blueprint quote already preparing' using errcode = '23505';
  end if;
  -- Counting is a paid-provider-adjacent request even though it produces no
  -- model output. Keep a durable per-author/book ceiling so random keys cannot
  -- turn token counting into an unbounded external-cost endpoint.
  if (select count(*) from public.story_blueprint_quote_requests r
      where r.user_id = p_user_id and r.book_id = p_book_id
        and r.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    raise exception 'story blueprint quote request limit reached' using errcode = '54000';
  end if;
  select * into v_blueprint from public.story_blueprints where book_id = p_book_id for share;
  if not found then raise exception 'saved story blueprint required' using errcode = 'P0002'; end if;
  v_snapshot := jsonb_build_object(
    'details', v_blueprint.details_json,
    'chapterPlan', v_blueprint.chapter_plan_json
  );
  insert into public.story_blueprint_quote_requests(
    user_id, workspace_id, book_id, blueprint_id, source_revision, source_snapshot_json, book_snapshot_json,
    source_sha256, catalog_json, idempotency_key, generation_job_id
  ) values (
    p_user_id, v_book.workspace_id, v_book.id, v_blueprint.id, v_blueprint.revision, v_snapshot, v_book_snapshot,
    encode(digest(convert_to(v_snapshot::text, 'UTF8'), 'sha256'), 'hex'), p_catalog_json,
    trim(p_idempotency_key), gen_random_uuid()
  ) returning * into v_existing;
  return v_existing;
end;
$$;

create function public.claim_story_blueprint_quote_request(
  p_lease_seconds integer default 180
) returns setof public.story_blueprint_quote_requests
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_request public.story_blueprint_quote_requests;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  -- Token-counting may have already reached an external provider before a
  -- worker dies. Its outcome is unknown, so never re-lease or recount it.
  update public.story_blueprint_quote_requests
    set status = 'failed', error_code = 'counting_outcome_unknown',
      lease_token = null, lease_expires_at = null
    where status = 'counting' and lease_expires_at <= clock_timestamp();

  -- This is defensive only: normal claim flow enters counting before attempts
  -- reaches five. Do not let malformed service data remain an active slot.
  update public.story_blueprint_quote_requests
    set status = 'failed', error_code = 'quote_count_attempts_exhausted',
      lease_token = null, lease_expires_at = null
    where status = 'queued' and attempts >= 5;

  select * into v_request
    from public.story_blueprint_quote_requests
    where status = 'queued' and attempts < 5
    order by created_at, id
    for update skip locked
    limit 1;
  if not found then return; end if;

  if not exists (
    select 1 from public.workspace_members
      where workspace_id = v_request.workspace_id and user_id = v_request.user_id
        and status = 'active' and role in ('owner', 'admin', 'editor', 'writer')
  ) then
    update public.story_blueprint_quote_requests
      set status = 'failed', error_code = 'editing_access_revoked',
        lease_token = null, lease_expires_at = null
      where id = v_request.id;
    return;
  end if;

  update public.story_blueprint_quote_requests
    set status = 'counting', attempts = attempts + 1, error_code = null,
      lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = v_request.id
    returning * into v_request;
  return next v_request;
end;
$$;

create function public.fail_story_blueprint_quote_request(
  p_request_id uuid,
  p_lease_token uuid
) returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null or p_lease_token is null then
    raise exception 'story blueprint quote request and lease required' using errcode = '22023';
  end if;
  update public.story_blueprint_quote_requests
    set status = 'failed', error_code = 'story_blueprint_quote_count_failed',
      lease_token = null, lease_expires_at = null
    where id = p_request_id and status = 'counting'
      and lease_token = p_lease_token and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.create_story_blueprint_quote_proposal(
  p_request_id uuid,
  p_lease_token uuid,
  p_usage_quote jsonb
) returns public.story_blueprint_quote_proposals
language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare
  v_request public.story_blueprint_quote_requests;
  v_existing public.story_blueprint_quote_proposals;
  v_created timestamptz;
  v_expires timestamptz;
  v_catalog_expires timestamptz;
  v_credits integer;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null or p_lease_token is null or jsonb_typeof(p_usage_quote) is distinct from 'object'
    or octet_length(p_usage_quote::text) > 65536 then
    raise exception 'invalid story blueprint usage quote' using errcode = '22023';
  end if;
  select * into v_request from public.story_blueprint_quote_requests where id = p_request_id for update;
  if not found then raise exception 'story blueprint quote request missing' using errcode = 'P0002'; end if;
  select * into v_existing from public.story_blueprint_quote_proposals where request_id = p_request_id for update;
  if found then
    if v_existing.usage_quote_json is distinct from p_usage_quote then
      raise exception 'story blueprint quote proposal conflict' using errcode = '23505';
    end if;
    return v_existing;
  end if;
  if v_request.status <> 'counting' or v_request.lease_token is distinct from p_lease_token
    or v_request.lease_expires_at is null or v_request.lease_expires_at <= clock_timestamp() then
    raise exception 'story blueprint quote request lease lost' using errcode = '40001';
  end if;
  if coalesce(p_usage_quote->>'reservedCredits', '') !~ '^[1-9][0-9]{0,9}$'
    or (p_usage_quote->>'reservedCredits')::bigint > 2147483647
    or coalesce(p_usage_quote->>'fingerprint', '') !~ '^[a-f0-9]{64}$'
    or p_usage_quote#>'{policy,approved}' is distinct from 'true'::jsonb
    or coalesce(length(trim(p_usage_quote#>>'{policy,version}')), 0) not between 1 and 128
    or p_usage_quote#>>'{scope,jobId}' is distinct from v_request.generation_job_id::text
    or p_usage_quote#>>'{scope,userId}' is distinct from v_request.user_id::text
    or p_usage_quote#>>'{scope,workspaceId}' is distinct from v_request.workspace_id::text
    or coalesce(p_usage_quote#>>'{scope,inputSha256}', '') !~ '^[a-f0-9]{64}$'
    or p_usage_quote#>>'{price,version}' is distinct from v_request.catalog_json->>'version'
    or p_usage_quote#>>'{price,model}' is distinct from v_request.catalog_json->>'model'
    or p_usage_quote#>>'{price,provider}' is distinct from v_request.catalog_json->>'provider'
    or p_usage_quote->>'createdAt' is null
    or p_usage_quote->>'expiresAt' is null then
    raise exception 'story blueprint quote scope mismatch' using errcode = '22023';
  end if;
  begin
    v_created := (p_usage_quote->>'createdAt')::timestamptz;
    v_expires := (p_usage_quote->>'expiresAt')::timestamptz;
    v_catalog_expires := (v_request.catalog_json->>'expiresAt')::timestamptz;
  exception when others then
    raise exception 'invalid story blueprint quote expiry' using errcode = '22023';
  end;
  if v_created > clock_timestamp()
    or v_expires <= clock_timestamp()
    or v_expires > v_created + interval '1 hour'
    or v_expires > v_catalog_expires then
    raise exception 'story blueprint quote expired or invalid' using errcode = '22023';
  end if;
  v_credits := (p_usage_quote->>'reservedCredits')::integer;
  insert into public.story_blueprint_quote_proposals(
    request_id, user_id, workspace_id, book_id, blueprint_id, source_revision,
    source_snapshot_json, book_snapshot_json, source_sha256, generation_request_sha256, catalog_json, generation_job_id,
    usage_quote_json, reserved_credits, expires_at
  ) values (
    v_request.id, v_request.user_id, v_request.workspace_id, v_request.book_id,
    v_request.blueprint_id, v_request.source_revision, v_request.source_snapshot_json, v_request.book_snapshot_json,
    v_request.source_sha256, p_usage_quote#>>'{scope,inputSha256}', v_request.catalog_json, v_request.generation_job_id,
    p_usage_quote, v_credits, v_expires
  ) returning * into v_existing;
  update public.story_blueprint_quote_requests set status = 'ready', lease_token = null,
    lease_expires_at = null, error_code = null where id = v_request.id;
  return v_existing;
end;
$$;

create function public.accept_story_blueprint_quote(
  p_proposal_id uuid,
  p_user_id uuid,
  p_expected_credits integer
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare
  v_proposal public.story_blueprint_quote_proposals;
  v_job public.ai_jobs;
  v_book public.books;
  v_blueprint public.story_blueprints;
  v_role text;
  v_snapshot jsonb;
  v_hash text;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_proposal from public.story_blueprint_quote_proposals where id = p_proposal_id for update;
  if not found then raise exception 'story blueprint quote proposal missing' using errcode = 'P0002'; end if;
  if p_user_id is null or v_proposal.user_id <> p_user_id then
    raise exception 'story blueprint proposal payer mismatch' using errcode = '42501';
  end if;
  select role::text into v_role from public.workspace_members
    where workspace_id = v_proposal.workspace_id and user_id = p_user_id and status = 'active' for share;
  if not found or v_role not in ('owner', 'admin', 'editor', 'writer') then
    raise exception 'story blueprint editing access required' using errcode = '42501';
  end if;
  if p_expected_credits is distinct from v_proposal.reserved_credits then
    raise exception 'story blueprint proposal credit confirmation mismatch' using errcode = '23514';
  end if;
  -- A lost response must replay the original funded job, not re-evaluate a
  -- later blueprint edit and accidentally create another paid generation.
  if v_proposal.accepted_job_id is not null then
    select * into v_job from public.ai_jobs where id = v_proposal.accepted_job_id;
    if not found then raise exception 'accepted story blueprint job missing' using errcode = 'P0002'; end if;
    return v_job;
  end if;
  if v_proposal.expires_at <= clock_timestamp() or v_proposal.created_at > clock_timestamp() then
    raise exception 'story blueprint proposal expired' using errcode = '22023';
  end if;
  -- Match save_story_blueprint's parent-first lock order.
  select * into v_book from public.books where id = v_proposal.book_id for share;
  if not found or v_book.workspace_id <> v_proposal.workspace_id then
    raise exception 'story blueprint proposal scope changed' using errcode = '23514';
  end if;
  select * into v_blueprint from public.story_blueprints where id = v_proposal.blueprint_id
    and book_id = v_proposal.book_id for share;
  if not found then raise exception 'story blueprint source unavailable or changed' using errcode = '23514'; end if;
  v_snapshot := jsonb_build_object(
    'details', v_blueprint.details_json,
    'chapterPlan', v_blueprint.chapter_plan_json
  );
  v_hash := encode(digest(convert_to(v_snapshot::text, 'UTF8'), 'sha256'), 'hex');
  if v_blueprint.revision <> v_proposal.source_revision
    or v_snapshot is distinct from v_proposal.source_snapshot_json
    or v_hash is distinct from v_proposal.source_sha256 then
    raise exception 'story blueprint source unavailable or changed' using errcode = '23514';
  end if;
  if exists (select 1 from public.ai_jobs where id = v_proposal.generation_job_id) then
    raise exception 'story blueprint generation job already exists' using errcode = '23505';
  end if;
  insert into public.ai_jobs(
    id, workspace_id, book_id, agent_type, billing_mode, status, input_ref,
    idempotency_key, created_by
  ) values (
    v_proposal.generation_job_id, v_proposal.workspace_id, v_proposal.book_id,
    'story_blueprint', 'quoted', 'queued', jsonb_build_object(
      'proposalId', v_proposal.id,
      'requestId', v_proposal.request_id,
      'blueprintId', v_proposal.blueprint_id,
      'sourceRevision', v_proposal.source_revision,
      'sourceSha256', v_proposal.source_sha256,
      'generationRequestSha256', v_proposal.generation_request_sha256
    ), 'story-blueprint:' || v_proposal.id::text, v_proposal.user_id
  ) returning * into v_job;
  perform public.reserve_funded_usage_quote(v_proposal.usage_quote_json);
  update public.story_blueprint_quote_proposals
    set accepted_at = clock_timestamp(), accepted_job_id = v_job.id
    where id = v_proposal.id;
  return v_job;
end;
$$;

create function public.claim_quoted_story_blueprint_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_job public.ai_jobs;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;
  for v_job in
    select j.*
    from public.ai_jobs j
    join public.story_blueprint_quote_proposals p on p.accepted_job_id = j.id
    join public.funded_usage_quotes q on q.job_id = j.id
    left join public.story_blueprint_generation_results r on r.ai_job_id = j.id
    where j.agent_type = 'story_blueprint'
      and j.billing_mode = 'quoted'
      and j.created_by = p.user_id
      and j.workspace_id = p.workspace_id
      and j.book_id = p.book_id
      and (
        -- A new job may dispatch only once, while its quote is still valid.
        (q.status = 'held' and q.settlement_json is null
          and q.dispatched_at is null and r.ai_job_id is null
          and (q.quote_json->>'expiresAt')::timestamptz > clock_timestamp())
        -- A private receipt is durable. It may be leased again solely to
        -- settle/completed it after a worker dies between those RPCs; it can
        -- never reach the provider dispatch branch a second time.
        or (r.ai_job_id is not null and q.dispatched_at is not null
          and ((q.status = 'held' and q.settlement_json is null)
            or (q.status = 'settled' and q.settlement_json is not null)))
      )
      and ((j.status = 'queued' and j.available_at <= clock_timestamp())
        or (j.status = 'running' and j.lease_expires_at <= clock_timestamp()))
    order by j.available_at, j.created_at, j.id
    for update of j skip locked
    limit 100
  loop
    -- No automatic release after repeated pre-dispatch failures. A held quote
    -- needs an explicit reconciliation path; silently refunding is unsafe.
    if not exists (select 1 from public.story_blueprint_generation_results r where r.ai_job_id = v_job.id)
      and v_job.attempts >= 5 then
      update public.ai_jobs set status = 'failed', error_code = 'story_blueprint_attempts_exhausted',
        error_message = 'Story Blueprint generation attempts exhausted', lease_token = null,
        lease_expires_at = null, completed_at = clock_timestamp() where id = v_job.id;
      continue;
    end if;
    update public.ai_jobs set status = 'running', attempts = attempts + case
        when exists (select 1 from public.story_blueprint_generation_results r where r.ai_job_id = v_job.id) then 0 else 1 end,
      started_at = coalesce(started_at, clock_timestamp()), completed_at = null,
      error_code = null, error_message = null, lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
      where id = v_job.id returning * into v_job;
    return next v_job;
    return;
  end loop;
end;
$$;

create function public.renew_story_blueprint_generation_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 180
) returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or p_lease_token is null or p_lease_seconds is null
    or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;
  update public.ai_jobs j set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where j.id = p_job_id
      and j.agent_type = 'story_blueprint'
      and j.billing_mode = 'quoted'
      and j.status = 'running'
      and j.lease_token = p_lease_token
      and j.lease_expires_at > clock_timestamp()
      and exists (
        select 1 from public.funded_usage_quotes q
        where q.job_id = j.id and (
          (q.status = 'held' and q.settlement_json is null
            and ((q.quote_json->>'expiresAt')::timestamptz > clock_timestamp()
              or q.dispatched_lease = p_lease_token))
          or (q.status = 'settled' and q.settlement_json is not null
            and exists (select 1 from public.story_blueprint_generation_results r where r.ai_job_id = j.id))
        )
      );
  return found;
end;
$$;

create function public.record_story_blueprint_generation_result(
  p_job_id uuid,
  p_lease_token uuid,
  p_provider_receipt_json jsonb,
  p_candidate_json jsonb
) returns public.story_blueprint_generation_results
language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare
  v_existing public.story_blueprint_generation_results;
  v_job public.ai_jobs;
  v_proposal public.story_blueprint_quote_proposals;
  v_quote public.funded_usage_quotes;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or p_lease_token is null
    or jsonb_typeof(p_provider_receipt_json) is distinct from 'object'
    or jsonb_typeof(p_candidate_json) is distinct from 'object'
    or octet_length(p_provider_receipt_json::text) > 65536
    or octet_length(p_candidate_json::text) > 524288 then
    raise exception 'invalid story blueprint generation result' using errcode = '22023';
  end if;
  select * into v_existing from public.story_blueprint_generation_results where ai_job_id = p_job_id;
  if found then
    if v_existing.provider_receipt_json is distinct from p_provider_receipt_json
      or v_existing.candidate_json is distinct from p_candidate_json then
      raise exception 'story blueprint generation result conflict' using errcode = '23505';
    end if;
    return v_existing;
  end if;
  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found or v_job.agent_type <> 'story_blueprint' or v_job.billing_mode <> 'quoted'
    or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'story blueprint generation lease lost' using errcode = '40001';
  end if;
  -- A concurrent worker cannot pass this point before its job-row lock is
  -- released. Recheck after that serialization point so an exact retry
  -- returns the immutable receipt instead of surfacing a unique violation.
  select * into v_existing from public.story_blueprint_generation_results where ai_job_id = p_job_id;
  if found then
    if v_existing.provider_receipt_json is distinct from p_provider_receipt_json
      or v_existing.candidate_json is distinct from p_candidate_json then
      raise exception 'story blueprint generation result conflict' using errcode = '23505';
    end if;
    return v_existing;
  end if;
  select * into v_quote from public.funded_usage_quotes where job_id = p_job_id for update;
  if not found or v_quote.status <> 'held' or v_quote.settlement_json is not null
    or v_quote.dispatched_at is null or v_quote.dispatched_lease is distinct from p_lease_token then
    raise exception 'story blueprint result requires dispatched funded quote' using errcode = '23514';
  end if;
  select * into v_proposal from public.story_blueprint_quote_proposals
    where accepted_job_id = p_job_id for share;
  if not found then raise exception 'story blueprint accepted proposal missing' using errcode = 'P0002'; end if;
  insert into public.story_blueprint_generation_results(
    ai_job_id, proposal_id, workspace_id, book_id, source_revision, source_sha256,
    provider_receipt_json, candidate_json, candidate_sha256
  ) values (
    p_job_id, v_proposal.id, v_proposal.workspace_id, v_proposal.book_id,
    v_proposal.source_revision, v_proposal.source_sha256,
    p_provider_receipt_json, p_candidate_json,
    encode(digest(convert_to(p_candidate_json::text, 'UTF8'), 'sha256'), 'hex')
  ) returning * into v_existing;
  -- Deliberately no ai_jobs completion, source update, chapter creation, or
  -- publication here. Settlement and explicit author review are future steps.
  return v_existing;
end;
$$;

create function public.complete_quoted_story_blueprint_generation(
  p_job_id uuid,
  p_lease_token uuid
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_job public.ai_jobs;
  v_quote public.funded_usage_quotes;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_job_id is null or p_lease_token is null then
    raise exception 'story blueprint job and lease required' using errcode = '22023';
  end if;
  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found or v_job.agent_type <> 'story_blueprint' or v_job.billing_mode <> 'quoted' then
    raise exception 'quoted story blueprint job missing' using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'story blueprint generation lease lost' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.story_blueprint_generation_results r where r.ai_job_id = v_job.id
  ) then
    raise exception 'story blueprint generation result missing' using errcode = '23514';
  end if;
  select * into v_quote from public.funded_usage_quotes where job_id = v_job.id for update;
  if not found or v_quote.status <> 'settled' or v_quote.settlement_json is null then
    -- `requires_review` intentionally retains its reservation and can only be
    -- reconciled through an explicit financial-review path.
    raise exception 'story blueprint completion requires settled funded quote' using errcode = '23514';
  end if;
  update public.ai_jobs set status = 'succeeded', output_ref = null,
    error_code = null, error_message = null, lease_token = null,
    lease_expires_at = null, completed_at = clock_timestamp()
    where id = v_job.id returning * into v_job;
  return v_job;
end;
$$;

create function public.mark_story_blueprint_generation_requires_review(
  p_job_id uuid,
  p_lease_token uuid,
  p_request_id text,
  p_reason text
) returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_job public.ai_jobs;
  v_quote public.funded_usage_quotes;
  v_settlement jsonb;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  -- Persist only bounded, machine-readable audit values. Provider bodies and
  -- exception text must never become job-visible errors or settlement data.
  if p_job_id is null or p_lease_token is null
    or coalesce(length(trim(p_request_id)), 0) not between 1 and 256
    or p_request_id ~ '[[:cntrl:]]'
    or coalesce(trim(p_reason), '') !~ '^[a-z][a-z0-9_]{0,79}$' then
    raise exception 'invalid story blueprint review marker' using errcode = '22023';
  end if;

  select * into v_job from public.ai_jobs where id = p_job_id for update;
  if not found or v_job.agent_type <> 'story_blueprint' or v_job.billing_mode <> 'quoted' then
    raise exception 'quoted story blueprint job missing' using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    raise exception 'story blueprint generation lease lost' using errcode = '40001';
  end if;
  if exists (
    select 1 from public.story_blueprint_generation_results r where r.ai_job_id = v_job.id
  ) then
    raise exception 'story blueprint result already persisted' using errcode = '23514';
  end if;
  select * into v_quote from public.funded_usage_quotes where job_id = v_job.id for update;
  if not found or v_quote.status <> 'held' or v_quote.settlement_json is not null
    or v_quote.dispatched_at is null or v_quote.dispatched_lease is distinct from p_lease_token then
    raise exception 'story blueprint review requires dispatched held quote' using errcode = '23514';
  end if;

  v_settlement := jsonb_build_object(
    'status', 'requires_review',
    'requestId', trim(p_request_id),
    'reason', trim(p_reason),
    'heldCredits', v_quote.reserved_credits::text,
    'fingerprint', v_quote.quote_json->>'fingerprint'
  );
  -- settle_funded_usage_quote enforces the one-way dispatched hold transition
  -- and makes no ledger release for `requires_review`.
  perform public.settle_funded_usage_quote(v_job.id, v_settlement);
  update public.ai_jobs
    set status = 'failed', error_code = 'story_blueprint_generation_requires_review',
      error_message = 'Story Blueprint generation requires review',
      lease_token = null, lease_expires_at = null, completed_at = clock_timestamp()
    where id = v_job.id;
  return true;
end;
$$;

revoke all on function public.guard_story_blueprint_quote_request(),
  public.guard_story_blueprint_quote_proposal(),
  public.guard_story_blueprint_job_identity(),
  public.guard_story_blueprint_generation_result(),
  public.story_blueprint_generation_result_immutable() from public, anon, authenticated;
revoke all on function public.request_story_blueprint_quote(uuid,uuid,jsonb,text),
  public.claim_story_blueprint_quote_request(integer),
  public.fail_story_blueprint_quote_request(uuid,uuid),
  public.create_story_blueprint_quote_proposal(uuid,uuid,jsonb),
  public.accept_story_blueprint_quote(uuid,uuid,integer),
  public.claim_quoted_story_blueprint_job(integer),
  public.renew_story_blueprint_generation_lease(uuid,uuid,integer),
  public.record_story_blueprint_generation_result(uuid,uuid,jsonb,jsonb),
  public.complete_quoted_story_blueprint_generation(uuid,uuid),
  public.mark_story_blueprint_generation_requires_review(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.request_story_blueprint_quote(uuid,uuid,jsonb,text),
  public.claim_story_blueprint_quote_request(integer),
  public.fail_story_blueprint_quote_request(uuid,uuid),
  public.create_story_blueprint_quote_proposal(uuid,uuid,jsonb),
  public.accept_story_blueprint_quote(uuid,uuid,integer),
  public.claim_quoted_story_blueprint_job(integer),
  public.renew_story_blueprint_generation_lease(uuid,uuid,integer),
  public.record_story_blueprint_generation_result(uuid,uuid,jsonb,jsonb),
  public.complete_quoted_story_blueprint_generation(uuid,uuid),
  public.mark_story_blueprint_generation_requires_review(uuid,uuid,text,text)
  to service_role;

comment on table public.story_blueprint_quote_requests is
  'Service-only, immutable snapshot capture for a paid Story Blueprint proposal. One active user/book request has a short counting lease; an expired count is terminalized as unknown rather than repeated. No provider generation or credit reservation occurs during quote preparation.';
comment on table public.story_blueprint_quote_proposals is
  'Immutable server-owned UsageQuote offers; acceptance creates one funded quoted job only.';
comment on table public.story_blueprint_generation_results is
  'Private immutable provider receipt and candidate; it never applies to story_blueprints.';
comment on function public.claim_quoted_story_blueprint_job(integer) is
  'Claims a new accepted held quote before one provider dispatch, or a private-receipt recovery solely for settlement/completion; it never automatically redispatches.';
comment on function public.complete_quoted_story_blueprint_generation(uuid,uuid) is
  'Marks a private-candidate Story Blueprint job succeeded only after an immutable receipt and settled funded quote; it clears the lease and never writes candidate data to ai_jobs.output_ref.';
comment on function public.claim_story_blueprint_quote_request(integer) is
  'Claims one queued Story Blueprint quote count with a short service-only lease. Expired counting leases terminalize as counting_outcome_unknown and are never counted again.';
comment on function public.fail_story_blueprint_quote_request(uuid,uuid) is
  'Lease-fenced service-only terminal failure for a Story Blueprint quote count.';
comment on function public.create_story_blueprint_quote_proposal(uuid,uuid,jsonb) is
  'Persists one immutable trusted UsageQuote only while the request has a live counting lease, then atomically marks the request ready. A byte-identical already-persisted offer replays without creating another proposal.';
comment on function public.mark_story_blueprint_generation_requires_review(uuid,uuid,text,text) is
  'Lease-fenced post-dispatch recovery for an uncertain Story Blueprint provider outcome without a saved receipt. It retains the full funded hold, marks the job failed with a safe constant error, and never authorizes a second dispatch.';
