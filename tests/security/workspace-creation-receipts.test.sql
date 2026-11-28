-- Account-bound creation, replay, closure and rollback. No existing data is kept.
begin;
insert into auth.users(id,email) values
  ('a2000000-0000-0000-0000-000000000001','workspace-receipt-a@local.test'),
  ('b2000000-0000-0000-0000-000000000001','workspace-receipt-b@local.test');

set local role anon;
do $$ begin
  begin
    perform public.workspace_creation_receipt('11111111-1111-4111-8111-111111111111',false);
    assert false, 'anonymous receipt read accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.create_workspace_with_receipt('11111111-1111-4111-8111-111111111111','Anonymous');
    assert false, 'anonymous creation accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a2000000-0000-0000-0000-000000000001"}';
do $$
declare a public.workspaces; b public.workspaces; receipt jsonb;
begin
  receipt := public.workspace_creation_receipt('11111111-1111-4111-8111-111111111111',false);
  assert receipt->>'status' = 'not_found' and receipt->>'workspaceId' is null, 'missing request misreported';
  select * into strict a from public.create_workspace_with_receipt('11111111-1111-4111-8111-111111111111','  Studio  ');
  select * into strict b from public.create_workspace_with_receipt('11111111-1111-4111-8111-111111111111','Studio');
  assert a.id = b.id and a.created_by = auth.uid(), 'replay created another workspace or owner';
  assert (select count(*) from public.workspaces where created_by=auth.uid()) = 1, 'replay duplicated workspace';
  assert (select count(*) from public.organizations where owner_user_id=auth.uid()) = 1, 'replay duplicated organization';
  assert exists(select 1 from public.workspace_members where workspace_id=a.id and user_id=auth.uid() and status='active'), 'workspace owner missing';
  assert exists(select 1 from public.organization_members where organization_id=a.organization_id and user_id=auth.uid() and status='active'), 'organization owner missing';
  receipt := public.workspace_creation_receipt('11111111-1111-4111-8111-111111111111',true);
  assert receipt->>'status' = 'created' and receipt->>'workspaceId' = a.id::text, 'closing a committed request changed its outcome';
  begin
    perform public.create_workspace_with_receipt('11111111-1111-4111-8111-111111111111','Different studio');
    assert false, 'changed payload reused request';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform count(*) from bookworm_private.workspace_creation_receipts;
    assert false, 'client can read private receipts directly';
  exception when insufficient_privilege then null; end;
end $$;

set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000001"}';
do $$
declare receipt jsonb;
begin
  receipt := public.workspace_creation_receipt('11111111-1111-4111-8111-111111111111',false);
  assert receipt->>'status' = 'not_found' and receipt->>'workspaceId' is null, 'another actor can read a receipt';
  receipt := public.workspace_creation_receipt('11111111-1111-4111-8111-111111111111',true);
  assert receipt->>'status' = 'closed', 'missing request was not fenced';
  begin
    perform public.create_workspace_with_receipt('11111111-1111-4111-8111-111111111111','Delayed studio');
    assert false, 'closed request created a workspace';
  exception when sqlstate 'PT409' then null; end;
  assert not exists(select 1 from public.workspaces where created_by=auth.uid()), 'closed request left workspace';
end $$;
reset role;

create function pg_temp.reject_receipt_membership() returns trigger language plpgsql as $$
begin raise exception 'injected membership failure' using errcode='23514'; end $$;
create trigger test_receipt_membership_failure before insert on public.workspace_members
  for each row execute function pg_temp.reject_receipt_membership();
set local role authenticated;
set local request.jwt.claims = '{"sub":"b2000000-0000-0000-0000-000000000001"}';
do $$ begin
  begin
    perform public.create_workspace_with_receipt('22222222-2222-4222-8222-222222222222','Rollback studio');
    assert false, 'injected failure was not raised';
  exception when check_violation then null; end;
  assert public.workspace_creation_receipt('22222222-2222-4222-8222-222222222222',false)->>'status' = 'not_found', 'failed transaction left receipt';
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from public.organizations where owner_user_id='b2000000-0000-0000-0000-000000000001'), 'failed transaction left organization';
  assert not exists(select 1 from public.workspaces where created_by='b2000000-0000-0000-0000-000000000001'), 'failed transaction left workspace';
end $$;
rollback;
