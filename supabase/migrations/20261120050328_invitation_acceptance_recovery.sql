-- Read an accepted invitation without placing its bearer-equivalent hash in a
-- query URL. Preserve terminal invitation identity against stale rotations.
-- Bound lock acquisition so this additive change will not indefinitely block
-- or wait behind an existing invitation transaction.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare v_accept oid := pg_catalog.to_regprocedure('public.accept_workspace_invitation(text)');
begin
  if v_accept is null or not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = v_accept and p.prosecdef
      and 'search_path=public, auth, pg_temp' = any(p.proconfig)
      and pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = 'd1788b301b0e442d9ab74ab71610e470'
  ) or not pg_catalog.has_function_privilege('authenticated', v_accept, 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', v_accept, 'EXECUTE')
    or pg_catalog.has_table_privilege('authenticated', 'public.workspace_invitations', 'SELECT') then
    raise exception 'Invitation recovery requires the reviewed acceptance function and privileges';
  end if;
end $$;

create function private.preserve_terminal_workspace_invitation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' and (
    new.workspace_id is distinct from old.workspace_id or new.email is distinct from old.email
    or new.role is distinct from old.role or new.token_hash is distinct from old.token_hash
    or new.expires_at is distinct from old.expires_at or new.invited_by is distinct from old.invited_by
  ) then
    raise exception 'terminal invitation cannot be rotated' using errcode = 'PT409';
  end if;
  if old.status <> 'pending' and (
    new.status is distinct from old.status or new.accepted_by is distinct from old.accepted_by
    or new.accepted_at is distinct from old.accepted_at
  ) then
    raise exception 'terminal invitation receipt cannot be changed' using errcode = 'PT409';
  end if;
  return new;
end $$;
revoke all on function private.preserve_terminal_workspace_invitation() from public, anon, authenticated, service_role;
create trigger preserve_terminal_workspace_invitation
  before update on public.workspace_invitations
  for each row execute function private.preserve_terminal_workspace_invitation();

create function private.workspace_invitation_acceptance_status(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_role text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation token' using errcode = '22023';
  end if;
  select i.workspace_id into v_workspace_id from public.workspace_invitations i
    where i.token_hash = p_token_hash and i.status = 'accepted' and i.accepted_by = v_actor;
  if not found then return pg_catalog.jsonb_build_object('viewerId', v_actor, 'state', 'not_confirmed'); end if;
  select m.role::text into v_role from public.workspace_members m
    where m.workspace_id = v_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then return pg_catalog.jsonb_build_object('viewerId', v_actor, 'state', 'accepted_unavailable'); end if;
  return pg_catalog.jsonb_build_object('viewerId', v_actor, 'state', 'accepted', 'workspaceId', v_workspace_id, 'role', v_role);
end $$;

create function public.workspace_invitation_acceptance_status(p_token_hash text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.workspace_invitation_acceptance_status(p_token_hash)
$$;
revoke all on function private.workspace_invitation_acceptance_status(text),
  public.workspace_invitation_acceptance_status(text) from public, anon, service_role;
grant execute on function private.workspace_invitation_acceptance_status(text),
  public.workspace_invitation_acceptance_status(text) to authenticated;
