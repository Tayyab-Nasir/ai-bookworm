begin;
insert into auth.users(id,email) values('a9200000-0000-4000-8000-000000000001','review-hold@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('a9200000-0000-4000-8000-000000000002','Review hold','review-hold','a9200000-0000-4000-8000-000000000001');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
  ('a9200000-0000-4000-8000-000000000003','Review test','month',1000,'{"ai_credits_monthly":2}');
insert into public.subscriptions(organization_id,plan_id,status) values
  ('a9200000-0000-4000-8000-000000000002','a9200000-0000-4000-8000-000000000003','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('a9200000-0000-4000-8000-000000000004','a9200000-0000-4000-8000-000000000002','Workspace','review-hold-ws','a9200000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('a9200000-0000-4000-8000-000000000004','a9200000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('a9200000-0000-4000-8000-000000000005','a9200000-0000-4000-8000-000000000004','Uncertain review','Author','a9200000-0000-4000-8000-000000000001');
insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,idempotency_key,created_by) values
  ('a9200000-0000-4000-8000-000000000006','a9200000-0000-4000-8000-000000000004',
   'a9200000-0000-4000-8000-000000000005','proofreader','queued','review-uncertain','a9200000-0000-4000-8000-000000000001');

do $$ begin
  assert not has_function_privilege('authenticated','public.mark_ai_review_dispatched(uuid,uuid)','execute');
  assert not has_function_privilege('authenticated','public.mark_ai_review_outcome_unconfirmed(uuid,uuid)','execute');
end $$;
set local role service_role;
do $$
declare j public.ai_jobs; reclaimed public.ai_jobs; held public.ai_jobs;
begin
  select * into j from public.claim_ai_review_job(180);
  assert j.id='a9200000-0000-4000-8000-000000000006'::uuid,'review job was not claimed';
  assert public.mark_ai_review_dispatched(j.id,j.lease_token),'dispatch marker failed';
  assert not public.mark_ai_review_dispatched(j.id,j.lease_token),'dispatch marker repeated';
  update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j.id;
  select * into reclaimed from public.claim_ai_review_job(180);
  assert reclaimed.id is null,'expired dispatched job was redispatched';
  select * into held from public.mark_ai_review_outcome_unconfirmed(j.id,j.lease_token);
  assert held.status='running' and held.provider_dispatched_at is not null
    and held.lease_token is null and held.lease_expires_at is null
    and held.error_code='ai_provider_outcome_unconfirmed','uncertain review was not held';
  assert (select count(*) from public.dead_letter_jobs where job_id=j.id and job_type='ai_review_unconfirmed')=1,
    'operator incident was not recorded';
  assert (select count(*) from public.usage_events where ai_job_id=j.id)=0,
    'uncertain provider result charged the author';
end $$;
rollback;
