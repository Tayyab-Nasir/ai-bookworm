-- Direct database access must not bypass collaboration role/state rules.
begin;

insert into auth.users(id,email) values
  ('a7100000-0000-0000-0000-000000000001','owner-authz@local.test'),
  ('a7100000-0000-0000-0000-000000000002','editor-authz@local.test'),
  ('a7100000-0000-0000-0000-000000000003','reviewer-authz@local.test'),
  ('a7100000-0000-0000-0000-000000000004','viewer-authz@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('b7100000-0000-4000-8000-000000000001','Approval Authz Org','approval-authz-org','a7100000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role,status) values
  ('b7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000001','owner','active'),
  ('b7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000002','member','active'),
  ('b7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000003','member','active'),
  ('b7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000004','member','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('c7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001','Approval Authz Workspace','approval-authz-ws','a7100000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
  ('c7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000001','owner','active'),
  ('c7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000002','editor','active'),
  ('c7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000003','reviewer','active'),
  ('c7100000-0000-4000-8000-000000000001','a7100000-0000-0000-0000-000000000004','viewer','active');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7100000-0000-0000-0000-000000000004","role":"authenticated"}';
do $$ begin
  begin
    insert into public.approvals(workspace_id,entity_type,entity_id,requested_by)
    values ('c7100000-0000-4000-8000-000000000001','book','d7100000-0000-4000-8000-000000000001',auth.uid());
    assert false, 'viewer directly created an approval';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7100000-0000-0000-0000-000000000002","role":"authenticated"}';
insert into public.approvals(id,workspace_id,entity_type,entity_id,requested_by,reviewer_id)
values (
  'e7100000-0000-4000-8000-000000000001','c7100000-0000-4000-8000-000000000001',
  'book','d7100000-0000-4000-8000-000000000001',auth.uid(),
  'a7100000-0000-0000-0000-000000000003'
);
do $$ begin
  assert exists(select 1 from public.approvals where id='e7100000-0000-4000-8000-000000000001'),
    'editor could not request approval from eligible reviewer';
  begin
    update public.approvals set status='approved'
    where id='e7100000-0000-4000-8000-000000000001';
    assert false, 'direct client bypassed approval state machine';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
