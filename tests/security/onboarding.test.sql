-- Behavioral test of the actual onboarding transaction and database privileges.
begin;
insert into auth.users(id,email) values
  ('a1000000-0000-0000-0000-000000000001','onboard-a@local.test'),
  ('b1000000-0000-0000-0000-000000000001','onboard-b@local.test');

set local role anon;
do $$ begin
  begin
    perform public.create_workspace_with_owner('Anonymous');
    assert false, 'anonymous user invoked privileged onboarding';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001"}';
do $$
declare v_ws public.workspaces; v_count int;
begin
  select * into strict v_ws from public.create_workspace_with_owner(' My Book ', ' My Imprint ', 'my-book');
  assert v_ws.name = 'My Book' and v_ws.slug = 'my-book', 'onboarding normalization failed';
  assert v_ws.created_by = auth.uid(), 'onboarding created spoofed owner';
  assert exists(select 1 from public.organization_members where organization_id=v_ws.organization_id and user_id=auth.uid() and role='owner' and status='active'), 'new owner cannot read billing membership';
  assert exists(select 1 from public.workspace_members where workspace_id=v_ws.id and user_id=auth.uid() and role='owner' and status='active'), 'new owner cannot read workspace membership';
  assert exists(select 1 from public.profiles where id=auth.uid()), 'onboarding failed to create own profile';
  assert exists(select 1 from public.workspaces where id=v_ws.id), 'new owner cannot read workspace';
  insert into public.books(workspace_id,title,author_name,created_by) values(v_ws.id,'First Book','Author',auth.uid());

  select count(*) into v_count from public.organizations;
  begin
    perform public.create_workspace_with_owner('   ');
    assert false, 'blank name accepted by RPC';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.create_workspace_with_owner('Book', null, '--');
    assert false, 'invalid slug accepted by RPC';
  exception when invalid_parameter_value then null; end;
  assert v_count = (select count(*) from public.organizations), 'invalid onboarding left an organization';
  begin
    insert into public.organization_members(organization_id,user_id,role) values(v_ws.organization_id, 'b1000000-0000-0000-0000-000000000001', 'owner');
    assert false, 'client can bypass membership administration';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Failure at the LAST insert must roll back tenant rows. The Auth-created
-- profile predates onboarding and must remain.
create function pg_temp.reject_final_membership() returns trigger language plpgsql as $$
begin raise exception 'injected membership failure' using errcode='23514'; end $$;
create trigger test_onboarding_failure before insert on public.workspace_members
  for each row execute function pg_temp.reject_final_membership();
set local role authenticated;
set local request.jwt.claims = '{"sub":"b1000000-0000-0000-0000-000000000001"}';
do $$ begin
  begin
    perform public.create_workspace_with_owner('Rollback Me');
    assert false, 'fault injection did not abort onboarding';
  exception when check_violation then null; end;
  assert not exists(select 1 from public.organizations), 'failed onboarding left a visible organization';
  assert not exists(select 1 from public.workspaces), 'failed onboarding left a visible workspace';
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from public.organizations where owner_user_id='b1000000-0000-0000-0000-000000000001'), 'rollback left organization';
  assert not exists(select 1 from public.workspaces where created_by='b1000000-0000-0000-0000-000000000001'), 'rollback left workspace';
  assert not exists(select 1 from public.organization_members where user_id='b1000000-0000-0000-0000-000000000001'), 'rollback left org membership';
  assert exists(select 1 from public.profiles where id='b1000000-0000-0000-0000-000000000001'), 'onboarding rollback removed auth profile';
end $$;
rollback;
