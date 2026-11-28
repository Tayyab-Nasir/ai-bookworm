-- A join result and its receipt commit together. A closed identity fences a
-- delayed request, including requests that began under an older snapshot.
-- The community ID intentionally has no foreign key: a deleted community must
-- not erase a closure while an old request is still travelling to the server.
create table public.community_join_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  community_id uuid not null,
  state text not null check (state in ('joined', 'rejected', 'closed')),
  reason text check (reason in ('not_found', 'not_open', 'inactive')),
  joined_role text,
  already_member boolean,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, operation_id),
  check (
    (state = 'joined' and reason is null and joined_role is not null and already_member is not null)
    or (state = 'rejected' and reason is not null and joined_role is null and already_member is null)
    or (state = 'closed' and reason is null and joined_role is null and already_member is null)
  )
);
alter table public.community_join_operations enable row level security;
revoke all on public.community_join_operations from public, anon, authenticated, service_role;
grant select, insert on public.community_join_operations to service_role;
create index community_join_operations_user_created
  on public.community_join_operations(user_id, created_at);

create function public.request_community_join(p_community_id uuid, p_user_id uuid, p_operation_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_operation public.community_join_operations;
  v_visibility text;
  v_status text;
  v_role text;
  v_state text;
  v_reason text;
  v_already_member boolean;
  v_inserted boolean;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_community_id is null or p_user_id is null then
    raise exception 'community and user required' using errcode = '22023';
  end if;
  if p_operation_id is not null then
    -- Serializes both the rate limit and each request/closure for this actor.
    perform pg_advisory_xact_lock(hashtextextended('community-join:' || p_user_id::text, 0));
    select * into v_operation from public.community_join_operations
      where user_id = p_user_id and operation_id = p_operation_id;
    if found then
      if v_operation.community_id <> p_community_id then
        raise exception 'community join identity belongs to another community' using errcode = '23505';
      end if;
      return jsonb_strip_nulls(jsonb_build_object('state', v_operation.state, 'reason', v_operation.reason,
        'role', v_operation.joined_role, 'alreadyMember', v_operation.already_member));
    end if;
    if (select count(*) from public.community_join_operations
        where user_id = p_user_id and state <> 'closed' and created_at > clock_timestamp() - interval '1 hour') >= 50 then
      raise exception 'community join request limit reached' using errcode = '54000';
    end if;
  end if;

  -- Holding the community row prevents a public-to-private update from
  -- committing between the visibility decision and a new membership insert.
  select visibility into v_visibility from public.communities where id = p_community_id for share;
  if not found then
    v_state := 'rejected'; v_reason := 'not_found';
  else
    select status, role into v_status, v_role from public.community_members
      where community_id = p_community_id and user_id = p_user_id for update;
    if found then
      if v_status = 'active' then
        v_state := 'joined'; v_already_member := true;
      else
        v_state := 'rejected'; v_reason := 'inactive'; v_role := null;
      end if;
    elsif v_visibility <> 'public' then
      v_state := 'rejected'; v_reason := 'not_open'; v_role := null;
    else
      insert into public.community_members(community_id, user_id, role, status)
        values (p_community_id, p_user_id, 'member', 'active')
        on conflict (community_id, user_id) do nothing;
      v_inserted := found;
      select status, role into v_status, v_role from public.community_members
        where community_id = p_community_id and user_id = p_user_id for update;
      if not found then raise exception 'community membership needs another check' using errcode = '40001'; end if;
      if v_status = 'active' then
        v_state := 'joined'; v_already_member := not v_inserted;
      else
        v_state := 'rejected'; v_reason := 'inactive'; v_role := null;
      end if;
    end if;
  end if;
  if p_operation_id is not null then
    insert into public.community_join_operations(user_id, operation_id, community_id, state, reason, joined_role, already_member)
      values (p_user_id, p_operation_id, p_community_id, v_state, v_reason, v_role, v_already_member)
      on conflict (user_id, operation_id) do nothing;
    if not found then raise exception 'community join identity needs another check' using errcode = '40001'; end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('state', v_state, 'reason', v_reason,
    'role', v_role, 'alreadyMember', v_already_member));
end;
$$;

create function public.read_community_join_operation(p_community_id uuid, p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_operation public.community_join_operations;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_community_id is null or p_user_id is null or p_operation_id is null then
    raise exception 'community join identity required' using errcode = '22023';
  end if;
  select * into v_operation from public.community_join_operations
    where user_id = p_user_id and operation_id = p_operation_id;
  if not found then return jsonb_build_object('state', 'not_seen'); end if;
  if v_operation.community_id <> p_community_id then
    raise exception 'community join identity belongs to another community' using errcode = '23505';
  end if;
  return jsonb_strip_nulls(jsonb_build_object('state', v_operation.state, 'reason', v_operation.reason,
    'role', v_operation.joined_role, 'alreadyMember', v_operation.already_member));
end;
$$;

create function public.close_community_join_operation(p_community_id uuid, p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_operation public.community_join_operations;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_community_id is null or p_user_id is null or p_operation_id is null then
    raise exception 'community join identity required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('community-join:' || p_user_id::text, 0));
  select * into v_operation from public.community_join_operations
    where user_id = p_user_id and operation_id = p_operation_id;
  if found then
    if v_operation.community_id <> p_community_id then
      raise exception 'community join identity belongs to another community' using errcode = '23505';
    end if;
    return jsonb_strip_nulls(jsonb_build_object('state', v_operation.state, 'reason', v_operation.reason,
      'role', v_operation.joined_role, 'alreadyMember', v_operation.already_member));
  end if;
  if (select count(*) from public.community_join_operations
      where user_id = p_user_id and state = 'closed' and created_at > clock_timestamp() - interval '1 hour') >= 50 then
    raise exception 'community join closure limit reached' using errcode = '54000';
  end if;
  insert into public.community_join_operations(user_id, operation_id, community_id, state)
    values (p_user_id, p_operation_id, p_community_id, 'closed')
    on conflict (user_id, operation_id) do nothing;
  if not found then raise exception 'community join identity needs another check' using errcode = '40001'; end if;
  return jsonb_build_object('state', 'closed');
end;
$$;

revoke all on function public.request_community_join(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.read_community_join_operation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.close_community_join_operation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_community_join(uuid, uuid, uuid) to service_role;
grant execute on function public.read_community_join_operation(uuid, uuid, uuid) to service_role;
grant execute on function public.close_community_join_operation(uuid, uuid, uuid) to service_role;
