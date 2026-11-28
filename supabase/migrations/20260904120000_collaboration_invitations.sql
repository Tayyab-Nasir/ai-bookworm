-- Durable workspace invitations and atomic owner-role changes.

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email citext not null,
  role public.member_role not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null,
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists workspace_invitations_pending_email_key
  on public.workspace_invitations(workspace_id, email)
  where status = 'pending';
create index if not exists workspace_invitations_workspace_created_idx
  on public.workspace_invitations(workspace_id, created_at desc);

alter table public.workspace_invitations enable row level security;
revoke all on table public.workspace_invitations from anon, authenticated;

create or replace function public.accept_workspace_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_email citext;
  v_inv public.workspace_invitations;
  v_workspace public.workspaces;
  v_workspace_member public.workspace_members;
  v_org_member public.organization_members;
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation token' using errcode = '22023';
  end if;

  select * into v_inv
  from public.workspace_invitations
  where token_hash = p_token_hash
  for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'invitation is no longer pending' using errcode = '23505';
  end if;
  if v_inv.expires_at <= clock_timestamp() then
    raise exception 'invitation expired' using errcode = '22023';
  end if;

  select lower(email)::citext into v_email from auth.users where id = v_actor;
  if v_email is null or v_email <> lower(v_inv.email)::citext then
    raise exception 'invitation email mismatch' using errcode = '42501';
  end if;

  select * into v_workspace from public.workspaces where id = v_inv.workspace_id;
  if not found then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;

  select * into v_workspace_member
  from public.workspace_members
  where workspace_id = v_inv.workspace_id and user_id = v_actor
  for update;
  if found and v_workspace_member.status = 'suspended' then
    raise exception 'workspace membership suspended' using errcode = '42501';
  elsif found and v_workspace_member.status = 'active' then
    raise exception 'already a workspace member' using errcode = '23505';
  elsif found then
    update public.workspace_members
    set role = v_inv.role, status = 'active', invited_by = v_inv.invited_by
    where workspace_id = v_inv.workspace_id and user_id = v_actor;
  else
    insert into public.workspace_members(workspace_id, user_id, role, status, invited_by)
    values (v_inv.workspace_id, v_actor, v_inv.role, 'active', v_inv.invited_by);
  end if;

  select * into v_org_member
  from public.organization_members
  where organization_id = v_workspace.organization_id and user_id = v_actor
  for update;
  if found and v_org_member.status = 'suspended' then
    raise exception 'organization membership suspended' using errcode = '42501';
  elsif found and v_org_member.status <> 'active' then
    update public.organization_members set status = 'active', invited_by = v_inv.invited_by
    where organization_id = v_workspace.organization_id and user_id = v_actor;
  elsif not found then
    insert into public.organization_members(organization_id, user_id, role, status, invited_by)
    values (v_workspace.organization_id, v_actor, 'member', 'active', v_inv.invited_by);
  end if;

  update public.workspace_invitations
  set status = 'accepted', accepted_by = v_actor, accepted_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_inv.id;

  insert into public.activity_events(workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (v_inv.workspace_id, v_actor, 'invitation_accepted', 'workspace_invitation', v_inv.id,
    jsonb_build_object('role', v_inv.role));

  return jsonb_build_object(
    'workspaceId', v_inv.workspace_id,
    'organizationId', v_workspace.organization_id,
    'role', v_inv.role,
    'status', 'active'
  );
end;
$$;

revoke all on function public.accept_workspace_invitation(text) from public, anon;
grant execute on function public.accept_workspace_invitation(text) to authenticated;

create or replace function public.change_workspace_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.member_role
) returns public.workspace_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.member_role;
  v_target public.workspace_members;
  v_result public.workspace_members;
  v_owner_count integer;
begin
  select role into v_actor_role
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';
  if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
    raise exception 'workspace admin required' using errcode = '42501';
  end if;

  select * into v_target
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id
  for update;
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_actor_role <> 'owner' and (v_target.role = 'owner' or p_role = 'owner') then
    raise exception 'only owners can change owner access' using errcode = '42501';
  end if;

  if v_target.role = 'owner' and p_role <> 'owner' and v_target.status = 'active' then
    perform 1 from public.workspace_members
    where workspace_id = p_workspace_id and role = 'owner' and status = 'active'
    order by user_id for update;
    select count(*) into v_owner_count from public.workspace_members
    where workspace_id = p_workspace_id and role = 'owner' and status = 'active';
    if v_owner_count <= 1 then
      raise exception 'cannot demote last owner' using errcode = '23505';
    end if;
  end if;

  update public.workspace_members set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id
  returning * into v_result;

  insert into public.activity_events(workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
  values (p_workspace_id, v_actor, 'member_role_changed', 'workspace_member', p_user_id,
    jsonb_build_object('from', v_target.role, 'to', p_role));
  return v_result;
end;
$$;

revoke all on function public.change_workspace_member_role(uuid, uuid, public.member_role) from public, anon;
grant execute on function public.change_workspace_member_role(uuid, uuid, public.member_role) to authenticated;
