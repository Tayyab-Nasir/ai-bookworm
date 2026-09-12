-- Atomically create the tenant and both owner memberships. This is an exposed
-- application RPC, not a general-purpose RLS helper: the owner is always the
-- authenticated caller and no user/organization identifiers are accepted.
create or replace function public.create_workspace_with_owner(
  p_name text,
  p_org_name text default null,
  p_slug text default null
)
returns setof public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(p_name);
  v_org_name text := coalesce(btrim(p_org_name), btrim(p_name) || ' Org');
  v_slug text := coalesce(p_slug, trim(both '-' from left(trim(both '-' from regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '-', 'g')), 48)));
  v_org uuid;
  v_workspace public.workspaces;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if v_name is null or length(v_name) not between 1 and 120
     or length(v_org_name) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid workspace or organization name';
  end if;
  if v_slug = '' and p_slug is null then v_slug := 'workspace'; end if;
  if v_slug is null or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 64 then
    raise exception using errcode = '22023', message = 'invalid workspace slug';
  end if;

  insert into public.profiles (id) values (v_user) on conflict (id) do nothing;
  insert into public.organizations (name, slug, owner_user_id)
    values (v_org_name, 'org-' || gen_random_uuid()::text, v_user)
    returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role, status)
    values (v_org, v_user, 'owner', 'active');
  insert into public.workspaces (organization_id, name, slug, created_by)
    values (v_org, v_name, v_slug, v_user)
    returning * into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role, status)
    values (v_workspace.id, v_user, 'owner', 'active');
  return next v_workspace;
end;
$$;

revoke all on function public.create_workspace_with_owner(text, text, text) from public, anon, service_role;
grant execute on function public.create_workspace_with_owner(text, text, text) to authenticated;

-- Earlier API versions created organization owners without their billing
-- membership. Repair only absent owner rows; do not undo suspensions/role edits.
insert into public.organization_members (organization_id, user_id, role, status)
  select id, owner_user_id, 'owner', 'active' from public.organizations
  on conflict (organization_id, user_id) do nothing;
