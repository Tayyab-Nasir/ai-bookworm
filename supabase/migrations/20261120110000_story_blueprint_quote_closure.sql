-- A missing quote is not proof that its original POST will never arrive.
-- A unique service-only identity and the same per-author/book advisory lock
-- fence a late insert, including under older transaction snapshots.
create table public.story_blueprint_quote_identities (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  kind text not null check (kind in ('requested', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, idempotency_key)
);
alter table public.story_blueprint_quote_identities enable row level security;
revoke all on public.story_blueprint_quote_identities from public, anon, authenticated, service_role;
grant select, insert on public.story_blueprint_quote_identities to service_role;
create index story_blueprint_quote_identities_closed_author_book_created
  on public.story_blueprint_quote_identities(user_id, book_id, created_at) where kind = 'closed';

create function public.guard_closed_story_blueprint_quote() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'story-blueprint-quote:' || new.user_id::text || ':' || new.book_id::text, 0
  ));
  -- The unique index is the final fence even when a transaction snapshot was
  -- taken before a competing closure committed. Both inserts roll back together.
  insert into public.story_blueprint_quote_identities(user_id, book_id, idempotency_key, kind)
    values (new.user_id, new.book_id, new.idempotency_key, 'requested')
    on conflict (user_id, idempotency_key) do nothing;
  if not found then raise exception 'story blueprint quote identity already claimed' using errcode = '23505'; end if;
  return new;
end;
$$;
revoke all on function public.guard_closed_story_blueprint_quote() from public, anon, authenticated;
grant execute on function public.guard_closed_story_blueprint_quote() to service_role;
create trigger story_blueprint_quote_closed_before_insert
  before insert on public.story_blueprint_quote_requests
  for each row execute function public.guard_closed_story_blueprint_quote();

create function public.close_story_blueprint_quote_request(p_book_id uuid, p_user_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
  v_request public.story_blueprint_quote_requests;
  v_identity public.story_blueprint_quote_identities;
  v_key text := trim(p_idempotency_key);
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_book_id is null or p_user_id is null or coalesce(length(v_key), 0) not between 8 and 200 then
    raise exception 'invalid story blueprint quote request identity' using errcode = '22023';
  end if;
  -- Match request_story_blueprint_quote's lock order, including book/member locks.
  perform pg_advisory_xact_lock(hashtextextended(
    'story-blueprint-quote:' || p_user_id::text || ':' || p_book_id::text, 0
  ));
  select workspace_id into v_workspace from public.books where id = p_book_id for share;
  if not found then raise exception 'story blueprint book missing' using errcode = 'P0002'; end if;
  perform 1 from public.workspace_members
    where workspace_id = v_workspace and user_id = p_user_id and status = 'active' for share;
  if not found then raise exception 'active book access required' using errcode = '42501'; end if;

  select * into v_request from public.story_blueprint_quote_requests
    where user_id = p_user_id and idempotency_key = v_key for update;
  if found then
    if v_request.book_id <> p_book_id then raise exception 'quote identity belongs to another book' using errcode = '23505'; end if;
    return jsonb_build_object('state', 'exists', 'requestId', v_request.id);
  end if;
  select * into v_identity from public.story_blueprint_quote_identities
    where user_id = p_user_id and idempotency_key = v_key;
  if found then
    if v_identity.book_id <> p_book_id then raise exception 'quote identity belongs to another book' using errcode = '23505'; end if;
    if v_identity.kind <> 'closed' then raise exception 'quote identity needs another status check' using errcode = '40001'; end if;
    return jsonb_build_object('state', 'closed');
  end if;
  if (select count(*) from public.story_blueprint_quote_identities
      where user_id = p_user_id and book_id = p_book_id and kind = 'closed' and created_at > clock_timestamp() - interval '1 hour') >= 20 then
    raise exception 'story blueprint quote closure limit reached' using errcode = '54000';
  end if;
  insert into public.story_blueprint_quote_identities(user_id, book_id, idempotency_key, kind)
    values (p_user_id, p_book_id, v_key, 'closed') on conflict (user_id, idempotency_key) do nothing;
  if not found then raise exception 'quote identity needs another status check' using errcode = '40001'; end if;
  return jsonb_build_object('state', 'closed');
end;
$$;
revoke all on function public.close_story_blueprint_quote_request(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.close_story_blueprint_quote_request(uuid,uuid,text) to service_role;

-- Serialize with acceptance on the original proposal row. A quote can be
-- discarded only after acceptance is known or the same database checks used
-- by acceptance make that proposal permanently unusable.
create function public.resolve_story_blueprint_quote(p_proposal_id uuid, p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, extensions, pg_temp as $$
declare
  v_proposal public.story_blueprint_quote_proposals;
  v_blueprint public.story_blueprints;
  v_snapshot jsonb;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_proposal from public.story_blueprint_quote_proposals where id = p_proposal_id for update;
  if not found then raise exception 'story blueprint quote missing' using errcode = 'P0002'; end if;
  if p_user_id is null or v_proposal.user_id <> p_user_id then
    raise exception 'story blueprint quote payer mismatch' using errcode = '42501';
  end if;
  perform 1 from public.workspace_members
    where workspace_id = v_proposal.workspace_id and user_id = p_user_id and status = 'active' for share;
  if not found then raise exception 'active book access required' using errcode = '42501'; end if;
  if v_proposal.accepted_job_id is not null then return jsonb_build_object('state','accepted'); end if;
  if v_proposal.expires_at <= clock_timestamp() then return jsonb_build_object('state','unusable'); end if;
  -- Match the acceptance lock order and source test. Authors cannot restore an
  -- old revision through the save RPC, so a stale snapshot cannot be accepted.
  perform 1 from public.books where id = v_proposal.book_id and workspace_id = v_proposal.workspace_id for share;
  if not found then raise exception 'story blueprint book missing' using errcode = 'P0002'; end if;
  select * into v_blueprint from public.story_blueprints
    where id = v_proposal.blueprint_id and book_id = v_proposal.book_id for share;
  if not found then return jsonb_build_object('state','unusable'); end if;
  v_snapshot := jsonb_build_object('details',v_blueprint.details_json,'chapterPlan',v_blueprint.chapter_plan_json);
  if v_blueprint.revision <> v_proposal.source_revision
    or v_snapshot is distinct from v_proposal.source_snapshot_json
    or encode(digest(convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex') is distinct from v_proposal.source_sha256 then
    return jsonb_build_object('state','unusable');
  end if;
  return jsonb_build_object('state','open');
end;
$$;
revoke all on function public.resolve_story_blueprint_quote(uuid,uuid) from public, anon, authenticated;
grant execute on function public.resolve_story_blueprint_quote(uuid,uuid) to service_role;
