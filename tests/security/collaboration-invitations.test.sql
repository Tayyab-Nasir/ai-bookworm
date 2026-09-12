-- Invitation acceptance is email-bound and owner changes are atomic/privileged.
begin;

insert into auth.users(id,email) values
  ('a7000000-0000-0000-0000-000000000001','owner@local.test'),
  ('a7000000-0000-0000-0000-000000000002','admin@local.test'),
  ('a7000000-0000-0000-0000-000000000003','invitee@local.test'),
  ('a7000000-0000-0000-0000-000000000004','wrong@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('b7000000-0000-4000-8000-000000000001','Collaboration Org','collaboration-org','a7000000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role,status) values
  ('b7000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000001','owner','active'),
  ('b7000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000002','admin','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('c7000000-0000-4000-8000-000000000001','b7000000-0000-4000-8000-000000000001','Collaboration Workspace','collaboration-ws','a7000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
  ('c7000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000001','owner','active'),
  ('c7000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000002','admin','active');

set local role service_role;
insert into public.workspace_invitations(
  id,workspace_id,email,role,token_hash,status,expires_at,invited_by
) values (
  'd7000000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001',
  'invitee@local.test','writer',repeat('a',64),'pending',now() + interval '7 days',
  'a7000000-0000-0000-0000-000000000001'
);
reset role;

do $$
begin
  assert not has_table_privilege('authenticated', 'public.workspace_invitations', 'select'),
    'authenticated users can read invitation hashes';
  assert not has_function_privilege('anon', 'public.accept_workspace_invitation(text)', 'execute'),
    'anonymous users can accept invitations';
  assert has_function_privilege('authenticated', 'public.accept_workspace_invitation(text)', 'execute'),
    'authenticated users cannot accept invitations';
  assert has_function_privilege('authenticated', 'public.change_workspace_member_role(uuid,uuid,public.member_role)', 'execute'),
    'workspace role transaction is unavailable';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7000000-0000-0000-0000-000000000004","role":"authenticated"}';
do $$ begin
  begin
    perform public.accept_workspace_invitation(repeat('a',64));
    assert false, 'another email accepted the invitation';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare result jsonb;
begin
  result := public.accept_workspace_invitation(repeat('a',64));
  assert result->>'workspaceId'='c7000000-0000-4000-8000-000000000001', 'accept returned another workspace';
  assert result->>'role'='writer' and result->>'status'='active', 'accept returned wrong membership';
  assert exists(select 1 from public.workspace_members where workspace_id='c7000000-0000-4000-8000-000000000001'
    and user_id=auth.uid() and role='writer' and status='active'), 'workspace membership not activated';
  assert exists(select 1 from public.organization_members where organization_id='b7000000-0000-4000-8000-000000000001'
    and user_id=auth.uid() and role='member' and status='active'), 'organization membership not activated';
  assert exists(select 1 from public.activity_events where event_type='invitation_accepted'
    and actor_id=auth.uid()), 'acceptance activity missing';
  begin
    perform public.accept_workspace_invitation(repeat('a',64));
    assert false, 'accepted token was reusable';
  exception when unique_violation then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7000000-0000-0000-0000-000000000002","role":"authenticated"}';
do $$ begin
  begin
    perform public.change_workspace_member_role(
      'c7000000-0000-4000-8000-000000000001',auth.uid(),'owner');
    assert false, 'admin promoted itself to owner';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare changed public.workspace_members;
begin
  begin
    perform public.change_workspace_member_role(
      'c7000000-0000-4000-8000-000000000001',auth.uid(),'admin');
    assert false, 'last active owner was demoted';
  exception when unique_violation then null; end;

  select * into changed from public.change_workspace_member_role(
    'c7000000-0000-4000-8000-000000000001','a7000000-0000-0000-0000-000000000003','owner');
  assert changed.role='owner', 'owner could not promote another active member';
  select * into changed from public.change_workspace_member_role(
    'c7000000-0000-4000-8000-000000000001',auth.uid(),'admin');
  assert changed.role='admin', 'owner transfer did not allow the previous owner to demote itself';
  assert exists(select 1 from public.activity_events where event_type='member_role_changed'
    and payload_json->>'to'='owner'), 'role-change activity missing';
end $$;
reset role;

rollback;
