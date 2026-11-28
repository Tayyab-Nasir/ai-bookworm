-- Synthetic actors and rows; all mutations roll back. A status read is never a fence.
begin;
insert into auth.users(id,email) values
  ('a9000000-0000-4000-8000-000000000001','recovery-owner@local.test'),
  ('a9000000-0000-4000-8000-000000000002','recovery-invitee@local.test'),
  ('a9000000-0000-4000-8000-000000000003','recovery-other@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('b9000000-0000-4000-8000-000000000001','Recovery Org','recovery-org','a9000000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('c9000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000001',
   'Recovery Workspace','recovery-workspace','a9000000-0000-4000-8000-000000000001');
insert into public.workspace_invitations(id,workspace_id,email,role,token_hash,status,expires_at,invited_by) values
  ('d9000000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000001',
   'recovery-invitee@local.test','writer',repeat('a',64),'pending',now()+interval '7 days','a9000000-0000-4000-8000-000000000001'),
  ('d9000000-0000-4000-8000-000000000002','c9000000-0000-4000-8000-000000000001',
   'revoked@local.test','writer',repeat('b',64),'revoked',now()+interval '7 days','a9000000-0000-4000-8000-000000000001'),
  ('d9000000-0000-4000-8000-000000000003','c9000000-0000-4000-8000-000000000001',
   'pending@local.test','writer',repeat('c',64),'pending',now()+interval '7 days','a9000000-0000-4000-8000-000000000001');

do $$ begin
  assert not has_table_privilege('authenticated','public.workspace_invitations','select');
  assert has_function_privilege('authenticated','public.workspace_invitation_acceptance_status(text)','execute');
  assert not has_function_privilege('anon','public.workspace_invitation_acceptance_status(text)','execute');
  assert not has_function_privilege('service_role','public.workspace_invitation_acceptance_status(text)','execute');
  assert not (select prosecdef from pg_proc where oid='public.workspace_invitation_acceptance_status(text)'::regprocedure);
  assert (select prosecdef and 'search_path=""'=any(proconfig)
    from pg_proc where oid='private.workspace_invitation_acceptance_status(text)'::regprocedure);
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a9000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$ declare result jsonb; begin
  result := public.workspace_invitation_acceptance_status(repeat('a',64));
  assert result = jsonb_build_object('viewerId',auth.uid(),'state','not_confirmed');
  begin
    perform public.workspace_invitation_acceptance_status('bad');
    assert false, 'malformed token was accepted';
  exception when invalid_parameter_value then null; end;
  perform public.accept_workspace_invitation(repeat('a',64));
  result := public.workspace_invitation_acceptance_status(repeat('a',64));
  assert result = jsonb_build_object('viewerId',auth.uid(),'state','accepted',
    'workspaceId','c9000000-0000-4000-8000-000000000001','role','writer');
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a9000000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$ begin
  assert public.workspace_invitation_acceptance_status(repeat('a',64)) =
    jsonb_build_object('viewerId',auth.uid(),'state','not_confirmed'), 'another actor learned acceptance';
end $$;
reset role;

update public.workspace_members set role='reviewer' where workspace_id='c9000000-0000-4000-8000-000000000001'
  and user_id='a9000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a9000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$ begin
  assert public.workspace_invitation_acceptance_status(repeat('a',64))->>'role'='reviewer', 'status returned stale role';
end $$;
reset role;
update public.workspace_members set status='suspended' where workspace_id='c9000000-0000-4000-8000-000000000001'
  and user_id='a9000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a9000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$ begin
  assert public.workspace_invitation_acceptance_status(repeat('a',64)) =
    jsonb_build_object('viewerId',auth.uid(),'state','accepted_unavailable'), 'inactive membership leaked workspace';
end $$;
reset role;

set local role service_role;
do $$ begin
  begin
    update public.workspace_invitations set token_hash=repeat('d',64) where id='d9000000-0000-4000-8000-000000000001';
    assert false, 'accepted token rotated';
  exception when sqlstate 'PT409' then null; end;
  begin
    update public.workspace_invitations set status='pending' where id='d9000000-0000-4000-8000-000000000001';
    assert false, 'accepted status reverted';
  exception when sqlstate 'PT409' then null; end;
  begin
    update public.workspace_invitations set accepted_by=null where id='d9000000-0000-4000-8000-000000000001';
    assert false, 'accepted actor changed';
  exception when sqlstate 'PT409' then null; end;
  begin
    update public.workspace_invitations set accepted_at=null where id='d9000000-0000-4000-8000-000000000001';
    assert false, 'accepted time changed';
  exception when sqlstate 'PT409' then null; end;
  begin
    update public.workspace_invitations set status='pending' where id='d9000000-0000-4000-8000-000000000002';
    assert false, 'revoked invitation revived';
  exception when sqlstate 'PT409' then null; end;
  update public.workspace_invitations set token_hash=repeat('e',64),role='editor'
    where id='d9000000-0000-4000-8000-000000000003';
end $$;
reset role;
rollback;
