begin;
do $$
declare
  v_user uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_ws uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values(v_user,'paid-only@local.test');
  insert into public.organizations(id,name,slug,owner_user_id)
    values(v_org,'Paid only','paid-only-test',v_user);
  insert into public.workspaces(id,organization_id,name,slug,created_by)
    values(v_ws,v_org,'Paid only','paid-only-workspace',v_user);
  insert into public.workspace_members(workspace_id,user_id,role)
    values(v_ws,v_user,'editor');

  begin
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(v_ws,'illustrator','queued','{}','no-subscription',v_user);
    raise exception 'an unpaid organization reserved an image credit';
  exception when check_violation then
    assert sqlerrm='image credit capacity exhausted';
  end;

  assert not exists (
    select 1 from public.ai_jobs
    where workspace_id=v_ws and idempotency_key='no-subscription'
  );
end $$;
rollback;
