begin;
do $$
declare
  v_author uuid := gen_random_uuid();
  v_other_author uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_first_ws uuid := gen_random_uuid();
  v_second_ws uuid := gen_random_uuid();
  v_plan uuid := gen_random_uuid();
  v_first_job uuid;
  v_other_job uuid;
begin
  insert into auth.users(id,email) values
    (v_author,'image-single-flight@local.test'),
    (v_other_author,'image-single-flight-other@local.test');
  insert into public.organizations(id,name,slug,owner_user_id)
    values(v_org,'Image single flight','image-single-flight-test',v_author);
  insert into public.workspaces(id,organization_id,name,slug,created_by)
    values(v_first_ws,v_org,'First','image-single-first',v_author),
      (v_second_ws,v_org,'Second','image-single-second',v_author);
  insert into public.workspace_members(workspace_id,user_id,role)
    values(v_first_ws,v_author,'editor'),(v_second_ws,v_author,'editor'),
      (v_first_ws,v_other_author,'editor');
  insert into public.plans(id,name,billing_period,price_cents,entitlements_json)
    values(v_plan,'Single-flight fixture','month',1000,'{"image_credits_monthly":5}');
  insert into public.subscriptions(organization_id,plan_id,status)
    values(v_org,v_plan,'active');

  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(v_first_ws,'illustrator','running','{}','single-first',v_author)
    returning id into v_first_job;
  begin
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(v_first_ws,'cover_designer','running','{}','single-second',v_author);
    raise exception 'second pending image reserved by the same author and workspace';
  exception when check_violation then
    assert sqlerrm='image request already pending';
  end;
  assert (select count(*) from public.ai_jobs where workspace_id=v_first_ws and created_by=v_author)=1;
  update public.ai_jobs set status='queued' where id=v_first_job;
  update public.ai_jobs set status='running' where id=v_first_job;

  -- A different author and a different workspace may still use funded slots.
  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(v_first_ws,'illustrator','queued','{}','other-author',v_other_author)
    returning id into v_other_job;
  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(v_second_ws,'illustrator','running','{}','other-workspace',v_author);
  update public.ai_jobs set status='failed' where id=v_first_job;
  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(v_first_ws,'cover_designer','running','{}','after-release',v_author);
  begin
    update public.ai_jobs set status='running' where id=v_first_job;
    raise exception 'failed image reactivated alongside a pending replacement';
  exception when check_violation then
    assert sqlerrm='image request already pending';
  end;
  assert (select count(*) from public.ai_jobs where workspace_id=v_first_ws and created_by=v_author and status in ('queued','running'))=1;
  assert not has_function_privilege('authenticated','public.reserve_image_job_credit()','execute');
end $$;
rollback;
