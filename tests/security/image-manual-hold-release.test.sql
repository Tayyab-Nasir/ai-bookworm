begin;
do $$
declare
  v_user uuid := 'a9000000-0000-4000-8000-000000000231';
  v_admin uuid := 'a9000000-0000-4000-8000-000000000232';
  v_org uuid := 'a9000000-0000-4000-8000-000000000233';
  v_ws uuid := 'a9000000-0000-4000-8000-000000000234';
  v_plan uuid := 'a9000000-0000-4000-8000-000000000235';
begin
  insert into auth.users(id,email) values(v_user,'image-release-author@local.test'),(v_admin,'image-release-admin@local.test');
  insert into public.organizations(id,name,slug,owner_user_id)
    values(v_org,'Image Release','image-release-test',v_user);
  insert into public.workspaces(id,organization_id,name,slug,created_by)
    values(v_ws,v_org,'Image Studio','image-release-studio',v_user);
  insert into public.workspace_members(workspace_id,user_id,role) values(v_ws,v_user,'editor');
  insert into public.workspace_members(workspace_id,user_id,role) values(v_ws,v_admin,'editor');
  insert into public.plans(id,name,billing_period,price_cents,entitlements_json)
    values(v_plan,'Release fixture','month',1000,'{"image_credits_monthly":5}');
  insert into public.subscriptions(organization_id,plan_id,status) values(v_org,v_plan,'active');
  insert into public.ai_jobs(id,workspace_id,agent_type,status,input_ref,idempotency_key,created_by,started_at)
    values('a9000000-0000-4000-8000-000000000236',v_ws,'illustrator','running','{}','image-release-old',v_user,now()-interval '16 minutes');
end $$;

do $$ begin
  assert not has_function_privilege('authenticated',
    'public.release_unconfirmed_image_job(uuid,uuid,text,boolean,boolean)','execute');
end $$;
set local role service_role;
do $$
declare
  v_job uuid := 'a9000000-0000-4000-8000-000000000236';
  v_admin uuid := 'a9000000-0000-4000-8000-000000000232';
  v_result public.ai_jobs;
begin
  begin
    perform public.release_unconfirmed_image_job(v_job,v_admin,'INC-123456',false,true);
    raise exception 'release without storage review was accepted';
  exception when invalid_parameter_value then
    assert sqlerrm='image release requires incident reference and review attestations';
  end;
  begin
    perform public.release_unconfirmed_image_job(v_job,v_admin,null,true,true);
    raise exception 'release without incident reference was accepted';
  exception when invalid_parameter_value then
    assert sqlerrm='image release requires incident reference and review attestations';
  end;
  v_result := public.release_unconfirmed_image_job(v_job,v_admin,'INC-123456',true,true);
  assert v_result.status='failed' and v_result.error_code='image_hold_released';
  assert (select count(*) from public.audit_logs where entity_id=v_job and action='image.hold_release')=1;
  assert (select after_json->>'incidentRef' from public.audit_logs where entity_id=v_job and action='image.hold_release')='INC-123456';
  assert not exists(select 1 from public.usage_events where ai_job_id=v_job);
  begin
    perform public.complete_image_job(v_job,'a9000000-0000-4000-8000-000000000239',
      'Late image','illustration',null,
      'workspaces/a9000000-0000-4000-8000-000000000234/assets/a9000000-0000-4000-8000-000000000239/v1/generated.png',
      'image/png',8,repeat('a',64),'illustration','openai','gpt-image-2.5-sunburst',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0.001,"latencyMs":1}');
    raise exception 'late image completion charged a released hold';
  exception when serialization_failure then
    assert sqlerrm='image job cannot be completed';
  end;
  assert not exists(select 1 from public.usage_events where ai_job_id=v_job);
  begin
    perform public.release_unconfirmed_image_job(v_job,v_admin,'INC-123456',true,true);
    raise exception 'released job changed twice';
  exception when invalid_parameter_value then
    assert sqlerrm='image job is not eligible for manual hold release';
  end;
  assert (select count(*) from public.audit_logs where entity_id=v_job and action='image.hold_release')=1;
  insert into public.ai_jobs(id,workspace_id,agent_type,status,input_ref,idempotency_key,created_by,started_at)
    values('a9000000-0000-4000-8000-000000000237','a9000000-0000-4000-8000-000000000234',
      'cover_designer','running','{}','image-release-recent','a9000000-0000-4000-8000-000000000231',now());
  begin
    perform public.release_unconfirmed_image_job('a9000000-0000-4000-8000-000000000237',v_admin,'INC-123456',true,true);
    raise exception 'recent image job was released';
  exception when invalid_parameter_value then
    assert sqlerrm='image job is not eligible for manual hold release';
  end;
  insert into public.ai_jobs(id,workspace_id,agent_type,status,input_ref,idempotency_key,created_by,started_at)
    values('a9000000-0000-4000-8000-000000000238','a9000000-0000-4000-8000-000000000234',
      'illustrator','running','{}','image-release-receipt','a9000000-0000-4000-8000-000000000232',now()-interval '16 minutes');
  insert into public.image_completion_receipts(job_id,completion_json)
    values('a9000000-0000-4000-8000-000000000238','{}');
  begin
    perform public.release_unconfirmed_image_job('a9000000-0000-4000-8000-000000000238',v_admin,'INC-123456',true,true);
    raise exception 'saved image receipt was ignored';
  exception when invalid_parameter_value then
    assert sqlerrm='image job is not eligible for manual hold release';
  end;
end $$;
reset role;
rollback;
