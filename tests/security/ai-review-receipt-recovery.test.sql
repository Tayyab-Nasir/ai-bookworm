begin;
insert into auth.users(id,email) values('a9400000-0000-4000-8000-000000000001','review-recover@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('a9400000-0000-4000-8000-000000000002','Review recovery','review-recovery','a9400000-0000-4000-8000-000000000001');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
 ('a9400000-0000-4000-8000-000000000007','Recovery plan','month',1000,'{"ai_credits_monthly":4}');
insert into public.subscriptions(organization_id,plan_id,status) values
 ('a9400000-0000-4000-8000-000000000002','a9400000-0000-4000-8000-000000000007','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('a9400000-0000-4000-8000-000000000003','a9400000-0000-4000-8000-000000000002',
  'Workspace','review-recovery-ws','a9400000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('a9400000-0000-4000-8000-000000000003','a9400000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('a9400000-0000-4000-8000-000000000004','a9400000-0000-4000-8000-000000000003',
  'Recovered review','Author','a9400000-0000-4000-8000-000000000001');
insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,idempotency_key,created_by,
  started_at,provider_dispatched_at,error_code) values
 ('a9400000-0000-4000-8000-000000000005','a9400000-0000-4000-8000-000000000003',
  'a9400000-0000-4000-8000-000000000004','proofreader','running','recover-review-one',
  'a9400000-0000-4000-8000-000000000001',clock_timestamp()-interval '30 minutes',
  clock_timestamp()-interval '30 minutes','ai_provider_outcome_unconfirmed'),
 ('a9400000-0000-4000-8000-000000000006','a9400000-0000-4000-8000-000000000003',
  'a9400000-0000-4000-8000-000000000004','proofreader','running','recover-review-two',
  'a9400000-0000-4000-8000-000000000001',clock_timestamp()-interval '30 minutes',
  clock_timestamp()-interval '30 minutes','ai_provider_outcome_unconfirmed');
insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values
 ('a9400000-0000-4000-8000-000000000005',repeat('a',64),
  '{"jobId":"a9400000-0000-4000-8000-000000000005","workspaceId":"a9400000-0000-4000-8000-000000000003","bookId":"a9400000-0000-4000-8000-000000000004","agentType":"proofreader","status":"succeeded","provider":"mock","model":"mock-1","usage":{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0},"suggestions":[],"diagnostics":[]}'),
 ('a9400000-0000-4000-8000-000000000006',repeat('b',64),null);

do $$ begin
 assert not has_function_privilege('authenticated',
   'public.claim_ai_review_receipt_recovery(uuid,uuid,text,boolean,boolean,integer)','execute');
end $$;
set local role service_role;
do $$
declare j public.ai_jobs; completed public.ai_jobs; rejected boolean := false;
begin
  begin
    perform public.claim_ai_review_receipt_recovery(
      'a9400000-0000-4000-8000-000000000006',
      'a9400000-0000-4000-8000-000000000001','INC-RECOVER-2',true,true,300);
  exception when sqlstate '22023' then rejected := true; end;
  assert rejected,'a null result receipt was accepted for settlement';

  select * into j from public.claim_ai_review_receipt_recovery(
    'a9400000-0000-4000-8000-000000000005',
    'a9400000-0000-4000-8000-000000000001','INC-RECOVER-1',true,true,300);
  assert j.lease_token is not null and j.lease_expires_at>clock_timestamp();
  assert (select count(*) from public.audit_logs where entity_id=j.id
    and action='ai_review.receipt_recovery_started')=1,'recovery audit missing';
  rejected := false;
  begin
    perform public.claim_ai_review_receipt_recovery(j.id,
      'a9400000-0000-4000-8000-000000000001','INC-RECOVER-1',true,true,300);
  exception when sqlstate '22023' then rejected := true; end;
  assert rejected,'active receipt-recovery lease was claimed twice';

  select * into completed from public.complete_leased_ai_review_job(
    j.id,j.lease_token,'mock','mock-1',
    '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}', '[]','[]',0);
  assert completed.status='succeeded' and completed.lease_token is null;
  assert (select count(*) from public.usage_events where ai_job_id=j.id)=1,
    'recovered review did not settle a single usage event';
end $$;
rollback;
