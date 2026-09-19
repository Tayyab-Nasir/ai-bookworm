begin;
do $$
declare
  u uuid := gen_random_uuid(); org uuid := gen_random_uuid(); ws uuid := gen_random_uuid();
  other_ws uuid := gen_random_uuid(); plan uuid; first_job uuid; second_job uuid;
begin
  insert into auth.users(id,email) values(u,'metadata-reservation@local.test');
  insert into public.organizations(id,name,slug,owner_user_id) values(org,'Metadata holds','metadata-holds',u);
  insert into public.workspaces(id,organization_id,name,slug,created_by)
    values(ws,org,'First','meta-first',u),(other_ws,org,'Second','meta-second',u);
  insert into public.workspace_members(workspace_id,user_id,role) values(ws,u,'editor'),(other_ws,u,'editor');
  begin
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(ws,'metadata','running','{}','unfunded-metadata',u);
    raise exception 'unfunded metadata was allowed';
  exception when check_violation then assert sqlerrm='metadata credit capacity exhausted'; end;
  insert into public.plans(name,billing_period,price_cents,entitlements_json)
    values('Metadata capacity test','month',1000,'{"ai_credits_monthly":2}') returning id into plan;
  insert into public.subscriptions(organization_id,plan_id,status) values(org,plan,'active');
  insert into public.usage_events(organization_id,workspace_id,user_id,meter,quantity) values(org,ws,u,'ai_credits',1);
  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(ws,'metadata','queued','{}','metadata-hold',u) returning id into first_job;
  update public.ai_jobs set status='running' where id=first_job;
  begin
    insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(other_ws,'metadata','running','{}','metadata-over-capacity',u);
    raise exception 'cross-workspace pending metadata ignored';
  exception when check_violation then assert sqlerrm='metadata credit capacity exhausted'; end;
  update public.ai_jobs set status='failed' where id=first_job;
  insert into public.ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(other_ws,'metadata','running','{}','metadata-replacement',u) returning id into second_job;
  begin
    update public.ai_jobs set status='running' where id=first_job;
    raise exception 'reactivation bypassed metadata capacity';
  exception when check_violation then assert sqlerrm='metadata credit capacity exhausted'; end;
  update public.ai_jobs set status='failed' where id=second_job;
  update public.workspace_members set role='viewer' where workspace_id=ws and user_id=u;
  begin
    update public.ai_jobs set status='running' where id=first_job;
    raise exception 'viewer reserved metadata credits';
  exception when insufficient_privilege then assert sqlerrm='metadata reservation requires editing access'; end;
end $$;
rollback;
