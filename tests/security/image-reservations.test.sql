begin;
do $$
declare
  v_user uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_third uuid := gen_random_uuid();
  v_extra uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_ws uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_job uuid;
  v_replacement uuid;
begin
  insert into auth.users(id,email) values(v_user,'reservation@local.test'),
    (v_second,'reservation-second@local.test'),
    (v_third,'reservation-third@local.test'),
    (v_extra,'reservation-extra@local.test');
  insert into public.organizations(id,name,slug,owner_user_id)
    values(v_org,'Reservations','reservation-test',v_user);
  insert into public.workspaces(id,organization_id,name,slug,created_by)
    values(v_ws,v_org,'First','reservation-first',v_user),
      (v_other,v_org,'Second','reservation-second',v_user);
  insert into public.workspace_members(workspace_id,user_id,role)
    values(v_ws,v_user,'editor'),(v_other,v_user,'editor'),
      (v_ws,v_second,'editor'),(v_ws,v_third,'editor'),
      (v_ws,v_extra,'editor');
  insert into public.plans(id,name,billing_period,price_cents,entitlements_json)
    values(gen_random_uuid(),'Reservation test','month',1000,'{"image_credits_monthly":5}')
    returning id into v_job;
  insert into public.subscriptions(organization_id,plan_id,status) values(v_org,v_job,'active');
  insert into public.usage_events(organization_id,workspace_id,user_id,meter,quantity)
    values(v_org,v_ws,v_user,'image_credits',1);
  for i in 1..4 loop
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(case when i<4 then v_ws else v_other end,'illustrator','queued','{}','hold-'||i,
        case i when 2 then v_second when 3 then v_third else v_user end)
      returning id into v_job;
  end loop;
  -- Queued -> running retains, rather than reserves, the existing slot.
  update public.ai_jobs set status='running' where id=v_job;
  begin
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(v_ws,'cover_designer','running','{}','over-capacity',v_extra);
    raise exception 'pending cross-workspace credits were ignored';
  exception when check_violation then
    assert sqlerrm='image credit capacity exhausted';
  end;
  assert (select count(*) from public.ai_jobs where workspace_id in (v_ws,v_other))=4;
  -- A definite failure releases one slot. No timestamp-based expiration.
  update public.ai_jobs set status='failed' where id=v_job;
  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(v_ws,'cover_designer','running','{}','replacement',v_extra) returning id into v_replacement;
  begin
    update public.ai_jobs set status='running' where id=v_job;
    raise exception 'failed-job reactivation bypassed reservation';
  exception when check_violation then
    assert sqlerrm='image credit capacity exhausted';
  end;
  update public.ai_jobs set status='failed' where id=v_replacement;
  update public.workspace_members set role='viewer' where workspace_id=v_ws and user_id=v_user;
  begin
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(v_ws,'illustrator','running','{}','revoked',v_user);
    raise exception 'revoked editor reserved an image';
  exception when insufficient_privilege then
    assert sqlerrm='image reservation requires editing access';
  end;
  assert not has_function_privilege('authenticated','public.reserve_image_job_credit()','execute');
end $$;
rollback;
