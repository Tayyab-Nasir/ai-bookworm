begin;
insert into auth.users(id,email) values('b7300000-0000-4000-8000-000000000001','bible-release@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('b7300000-0000-4000-8000-000000000002','Review release','bible-release','b7300000-0000-4000-8000-000000000001');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
 ('b7300000-0000-4000-8000-000000000007','Review release plan','month',1000,'{"ai_credits_monthly":4}');
insert into public.subscriptions(organization_id,plan_id,status) values
 ('b7300000-0000-4000-8000-000000000002','b7300000-0000-4000-8000-000000000007','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('b7300000-0000-4000-8000-000000000003','b7300000-0000-4000-8000-000000000002',
  'Workspace','bible-release-ws','b7300000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('b7300000-0000-4000-8000-000000000003','b7300000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('b7300000-0000-4000-8000-000000000004','b7300000-0000-4000-8000-000000000003',
  'Review release','Author','b7300000-0000-4000-8000-000000000001');

insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,idempotency_key,created_by,started_at)
values('b7300000-0000-4000-8000-000000000005','b7300000-0000-4000-8000-000000000003',
'b7300000-0000-4000-8000-000000000004','bookbible','running','bible-release-one',
'b7300000-0000-4000-8000-000000000001',clock_timestamp()-interval '30 minutes');
update public.ai_jobs set input_ref='{"contextSources":[]}' where id='b7300000-0000-4000-8000-000000000005';
insert into public.book_bible_service_receipts(job_id,request_sha256,created_at)
values('b7300000-0000-4000-8000-000000000005',repeat('a',64),clock_timestamp()-interval '30 minutes');
do $$ begin
 assert not has_function_privilege('authenticated','public.release_unconfirmed_book_bible_job(uuid,uuid,text,boolean,boolean)','execute');
 assert not has_function_privilege('anon','public.release_unconfirmed_book_bible_job(uuid,uuid,text,boolean,boolean)','execute');
end $$;
set local role service_role;
do $$
declare j uuid := 'b7300000-0000-4000-8000-000000000005';
 actor uuid := 'b7300000-0000-4000-8000-000000000001';
 result public.ai_jobs; rejected boolean; scenario text;
begin
 foreach scenario in array array['attestation','fresh_job','fresh_receipt','saved_receipt','output','lease','wrong_agent','usage','run','suggestion'] loop
   rejected := false;
   begin
     if scenario='fresh_job' then update public.ai_jobs set started_at=clock_timestamp() where id=j; end if;
     if scenario='fresh_receipt' then update public.book_bible_service_receipts set created_at=clock_timestamp() where job_id=j; end if;
     if scenario='saved_receipt' then update public.book_bible_service_receipts set result_json='{"malformed":true}' where job_id=j; end if;
     if scenario='output' then update public.ai_jobs set output_ref='{}' where id=j; end if;
     if scenario='lease' then update public.ai_jobs set lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 minute' where id=j; end if;
     if scenario='wrong_agent' then update public.ai_jobs set agent_type='metadata' where id=j; end if;
     if scenario='usage' then insert into public.usage_events(ai_job_id,meter,quantity) values(j,'ai_credits',1); end if;
     if scenario='run' then insert into public.ai_runs(ai_job_id,workspace_id,provider,model,status)
       values(j,'b7300000-0000-4000-8000-000000000003','openai','fixture','succeeded'); end if;
     if scenario='suggestion' then insert into public.ai_suggestions(ai_job_id,entity_type,operation_json) values(j,'book','{}'); end if;
     perform public.release_unconfirmed_book_bible_job(j,actor,'INC-BIBLE-123',scenario<>'attestation',true);
   exception when sqlstate '22023' then rejected:=true;
   end;
   assert rejected, 'unsafe release accepted: ' || scenario;
 end loop;
 select * into result from public.release_unconfirmed_book_bible_job(j,actor,'INC-BIBLE-123',true,true);
 assert result.status='failed' and result.error_code='book_bible_hold_released';
 assert (select count(*) from public.audit_logs where entity_id=j and action='book_bible.hold_release'
   and actor_id=actor and after_json->>'incidentRef'='INC-BIBLE-123')=1,'missing audit';
 assert not exists(select 1 from public.usage_events where ai_job_id=j),'unexpected debit';
 assert not exists(select 1 from public.book_bible_items where book_id=result.book_id),'unexpected canon';
 rejected:=false;
 begin
   perform public.release_unconfirmed_book_bible_job(j,actor,'INC-BIBLE-123',true,true);
 exception when sqlstate '22023' then rejected:=true; end;
 assert rejected,'duplicate release';
 -- A late valid empty result must not complete/debit the released job.
 rejected:=false;
 begin
   perform public.complete_book_bible_ai_job(j,'openai','fixture-model',
     '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0.01}', '[]','[]',1);
 exception when sqlstate '55000' then rejected:=true; end;
 assert rejected,'late completion accepted';
 assert not exists(select 1 from public.usage_events where ai_job_id=j),'late debit';
end $$;
rollback;
