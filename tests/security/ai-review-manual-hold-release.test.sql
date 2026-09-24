begin;
insert into auth.users(id,email) values('a9300000-0000-4000-8000-000000000001','review-release@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('a9300000-0000-4000-8000-000000000002','Review release','review-release','a9300000-0000-4000-8000-000000000001');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
 ('a9300000-0000-4000-8000-000000000007','Review release plan','month',1000,'{"ai_credits_monthly":4}');
insert into public.subscriptions(organization_id,plan_id,status) values
 ('a9300000-0000-4000-8000-000000000002','a9300000-0000-4000-8000-000000000007','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('a9300000-0000-4000-8000-000000000003','a9300000-0000-4000-8000-000000000002',
  'Workspace','review-release-ws','a9300000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('a9300000-0000-4000-8000-000000000003','a9300000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('a9300000-0000-4000-8000-000000000004','a9300000-0000-4000-8000-000000000003',
  'Review release','Author','a9300000-0000-4000-8000-000000000001');
insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,idempotency_key,created_by,
  started_at,provider_dispatched_at,error_code) values
 ('a9300000-0000-4000-8000-000000000005','a9300000-0000-4000-8000-000000000003',
  'a9300000-0000-4000-8000-000000000004','proofreader','running','release-review-one',
  'a9300000-0000-4000-8000-000000000001',clock_timestamp()-interval '30 minutes',
  clock_timestamp()-interval '30 minutes','ai_provider_outcome_unconfirmed'),
 ('a9300000-0000-4000-8000-000000000006','a9300000-0000-4000-8000-000000000003',
  'a9300000-0000-4000-8000-000000000004','proofreader','running','release-review-two',
  'a9300000-0000-4000-8000-000000000001',clock_timestamp()-interval '30 minutes',
  clock_timestamp()-interval '30 minutes','ai_provider_outcome_unconfirmed');
insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values
 ('a9300000-0000-4000-8000-000000000005',repeat('a',64),null),
 ('a9300000-0000-4000-8000-000000000006',repeat('b',64),'{"status":"succeeded"}');

do $$ begin
 assert not has_function_privilege('authenticated',
   'public.release_unconfirmed_ai_review_job(uuid,uuid,text,boolean,boolean)','execute');
end $$;
set local role service_role;
do $$
declare v_job public.ai_jobs; rejected boolean := false;
begin
  begin
    perform public.release_unconfirmed_ai_review_job(
      'a9300000-0000-4000-8000-000000000005',
      'a9300000-0000-4000-8000-000000000001','INC-REVIEW-1',false,true);
  exception when sqlstate '22023' then rejected := true; end;
  assert rejected,'missing review attestation was accepted';

  rejected := false;
  begin
    perform public.release_unconfirmed_ai_review_job(
      'a9300000-0000-4000-8000-000000000006',
      'a9300000-0000-4000-8000-000000000001','INC-REVIEW-2',true,true);
  exception when sqlstate '22023' then rejected := true; end;
  assert rejected,'a saved provider result was released instead of recovered';

  update public.ai_jobs set provider_dispatched_at=clock_timestamp()
    where id='a9300000-0000-4000-8000-000000000005';
  rejected := false;
  begin
    perform public.release_unconfirmed_ai_review_job(
      'a9300000-0000-4000-8000-000000000005',
      'a9300000-0000-4000-8000-000000000001','INC-REVIEW-1',true,true);
  exception when sqlstate '22023' then rejected := true; end;
  assert rejected,'a fresh provider dispatch was released';
  update public.ai_jobs set provider_dispatched_at=clock_timestamp()-interval '30 minutes'
    where id='a9300000-0000-4000-8000-000000000005';

  select * into v_job from public.release_unconfirmed_ai_review_job(
    'a9300000-0000-4000-8000-000000000005',
    'a9300000-0000-4000-8000-000000000001','INC-REVIEW-1',true,true);
  assert v_job.status='failed' and v_job.error_code='ai_review_hold_released';
  assert (select count(*) from public.audit_logs where entity_id=v_job.id
    and action='ai_review.hold_release')=1,'release audit missing';
  assert (select count(*) from public.usage_events where ai_job_id=v_job.id)=0,
    'released hold charged the author';
  rejected := false;
  begin
    perform public.release_unconfirmed_ai_review_job(v_job.id,
      'a9300000-0000-4000-8000-000000000001','INC-REVIEW-1',true,true);
  exception when sqlstate '22023' then rejected := true; end;
  assert rejected,'released hold was released twice';
end $$;
rollback;
