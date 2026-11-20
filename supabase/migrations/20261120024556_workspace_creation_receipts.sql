-- A request receipt makes a retried initial workspace creation safe. The old
-- create_workspace_with_owner RPC stays available to existing clients.
do $$
declare v_legacy oid := pg_catalog.to_regprocedure('public.create_workspace_with_owner(text,text,text)');
begin
  -- This wrapper delegates all tenant writes to the reviewed atomic function.
  -- Refuse an unfamiliar definition or privileges instead of assuming safety.
  if v_legacy is null or not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = v_legacy and p.prosecdef
      and 'search_path=""' = any(p.proconfig)
      and pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = '08f24cec4b041f80e3ef3dede1b0d779'
  ) or not pg_catalog.has_function_privilege('authenticated', v_legacy, 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', v_legacy, 'EXECUTE')
    or pg_catalog.has_function_privilege('service_role', v_legacy, 'EXECUTE') then
    raise exception 'Workspace onboarding requires the reviewed legacy function and privileges';
  end if;
end $$;

create table bookworm_private.workspace_creation_receipts (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  request_digest text check (request_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('pending', 'created', 'closed')),
  workspace_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_id, operation_id),
  check ((status = 'pending' and request_digest is not null and workspace_id is null)
    or (status = 'created' and request_digest is not null and workspace_id is not null)
    or (status = 'closed' and request_digest is null and workspace_id is null))
);
alter table bookworm_private.workspace_creation_receipts enable row level security;
revoke all on bookworm_private.workspace_creation_receipts from public, anon, authenticated, service_role;

create function private.create_workspace_with_receipt(
  p_operation_id uuid, p_name text, p_org_name text default null, p_slug text default null
) returns setof public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_name text := pg_catalog.btrim(p_name);
  v_org_name text := pg_catalog.btrim(p_org_name);
  v_digest text;
  v_inserted boolean := false;
  v_receipt bookworm_private.workspace_creation_receipts;
  v_workspace public.workspaces;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_operation_id is null or v_name is null or pg_catalog.length(v_name) not between 1 and 120
    or (v_org_name is not null and pg_catalog.length(v_org_name) not between 1 and 160)
    or (p_slug is not null and (pg_catalog.length(p_slug) > 64 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$')) then
    raise exception 'invalid workspace details' using errcode = '22023';
  end if;
  v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(v_name, v_org_name, p_slug)::text, 'UTF8')), 'hex');

  -- The unique insert serializes retries and closure. A transaction that fails
  -- while creating memberships rolls its pending receipt back with the tenant.
  insert into bookworm_private.workspace_creation_receipts(actor_id, operation_id, request_digest, status)
    values (v_actor, p_operation_id, v_digest, 'pending')
    on conflict (actor_id, operation_id) do nothing returning true into v_inserted;
  if coalesce(v_inserted, false) then
    select * into strict v_workspace from public.create_workspace_with_owner(v_name, v_org_name, p_slug);
    update bookworm_private.workspace_creation_receipts set status = 'created', workspace_id = v_workspace.id
      where actor_id = v_actor and operation_id = p_operation_id;
    return next v_workspace;
    return;
  end if;

  select * into strict v_receipt from bookworm_private.workspace_creation_receipts
    where actor_id = v_actor and operation_id = p_operation_id for update;
  if v_receipt.status = 'closed' or v_receipt.request_digest is distinct from v_digest then
    raise exception 'workspace request is closed or differs' using errcode = 'PT409';
  end if;
  if v_receipt.status <> 'created' then raise exception 'workspace request is unresolved' using errcode = '55000'; end if;
  -- A replay must not expose a workspace after the actor loses membership.
  select w.* into v_workspace from public.workspaces w
    where w.id = v_receipt.workspace_id and exists (
      select 1 from public.workspace_members m
        where m.workspace_id = w.id and m.user_id = v_actor and m.status = 'active'
    );
  if v_workspace.id is null then raise exception 'workspace unavailable' using errcode = '42501'; end if;
  return next v_workspace;
end $$;

create function private.workspace_creation_receipt(p_operation_id uuid, p_close boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_receipt bookworm_private.workspace_creation_receipts;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_operation_id is null or p_close is null then raise exception 'invalid workspace request' using errcode = '22023'; end if;
  if p_close then
    -- The conflicting insert waits for any in-flight create. If it wins first,
    -- the closed receipt fences a delayed create with this operation identity.
    insert into bookworm_private.workspace_creation_receipts(actor_id, operation_id, status)
      values (v_actor, p_operation_id, 'closed') on conflict (actor_id, operation_id) do nothing;
    select * into strict v_receipt from bookworm_private.workspace_creation_receipts
      where actor_id = v_actor and operation_id = p_operation_id for update;
  else
    select * into v_receipt from bookworm_private.workspace_creation_receipts
      where actor_id = v_actor and operation_id = p_operation_id;
  end if;
  return pg_catalog.jsonb_build_object('operationId', p_operation_id,
    'status', coalesce(v_receipt.status, 'not_found'), 'workspaceId', v_receipt.workspace_id);
end $$;

create function public.create_workspace_with_receipt(
  p_operation_id uuid, p_name text, p_org_name text default null, p_slug text default null
) returns setof public.workspaces language sql security invoker set search_path = '' as $$
  select * from private.create_workspace_with_receipt(p_operation_id, p_name, p_org_name, p_slug)
$$;
create function public.workspace_creation_receipt(p_operation_id uuid, p_close boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.workspace_creation_receipt(p_operation_id, p_close)
$$;
revoke all on function private.create_workspace_with_receipt(uuid,text,text,text),
  private.workspace_creation_receipt(uuid,boolean), public.create_workspace_with_receipt(uuid,text,text,text),
  public.workspace_creation_receipt(uuid,boolean) from public, anon, service_role;
grant execute on function private.create_workspace_with_receipt(uuid,text,text,text),
  private.workspace_creation_receipt(uuid,boolean), public.create_workspace_with_receipt(uuid,text,text,text),
  public.workspace_creation_receipt(uuid,boolean) to authenticated;
