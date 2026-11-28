-- Durable intent and exact action replay, disposable synthetic state only.
begin;
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 chapter uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); connection uuid:=gen_random_uuid();
 policy uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid();
 attempt uuid:=gen_random_uuid(); later_attempt uuid:=gen_random_uuid(); missing_attempt uuid:=gen_random_uuid(); receipt_attempt uuid:=gen_random_uuid();
 j public.ai_jobs; req jsonb; sources jsonb; raw jsonb; first jsonb; final jsonb;
begin
 assert has_function_privilege('service_role','public.begin_customer_ai_maintenance(uuid,uuid,text)','execute');
 assert has_function_privilege('service_role','public.execute_customer_ai_maintenance(uuid)','execute');
 assert has_function_privilege('service_role','public.list_customer_ai_maintenance_attempts(integer,timestamptz,uuid)','execute');
 assert not has_function_privilege('authenticated','public.begin_customer_ai_maintenance(uuid,uuid,text)','execute');
 assert not has_function_privilege('anon','public.execute_customer_ai_maintenance(uuid)','execute');
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_maintenance_attempts','select');
 assert not has_table_privilege('authenticated','bookworm_credentials.customer_ai_maintenance_attempts','insert');
 assert (select relrowsecurity from pg_class where oid='bookworm_credentials.customer_ai_maintenance_attempts'::regclass);
 insert into auth.users(id,email) values(u,u::text||'@local.test');
 insert into public.organizations(id,name,slug,owner_user_id) values(org,'Journal test',org::text,u);
 insert into public.workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Journal test',ws::text,u);
 insert into public.workspace_members(workspace_id,user_id,role) values(ws,u,'writer');
 insert into public.books(id,workspace_id,title,author_name,created_by) values(b,ws,'Synthetic','Author',u);
 insert into public.chapters(id,book_id,order_index,title) values(chapter,b,0,'Chapter');
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
  values(version_id,chapter,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain."}]}','Rain.',u);
 update public.chapters set current_document_version_id=version_id where id=chapter;
 insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
  values(plan,'Journal plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true);
 insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
  values(gen_random_uuid(),org,plan,'active',clock_timestamp()+interval '1 day');
 insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values(u,ws,'admin_adjustment',10,0);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform public.mutate_ai_connection(u,'openai',connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
  values(policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
   'per_request_credits',2,true,clock_timestamp()+interval '1 hour');
 req:=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(chapter),
  'chapters',jsonb_build_object(chapter::text,jsonb_build_object('id',chapter,'version',1,'documentVersionId',version_id,
   'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain.')))),
  'book',jsonb_build_object('title','Synthetic')));
 sources:=jsonb_build_array(jsonb_build_object('chapterId',chapter,'documentVersionId',version_id,'version',1));
 select * into j from public.create_customer_ai_job(job_id,gen_random_uuid(),u,ws,b,connection,1,policy,repeat('a',64),req,sources,2,true);
 select * into j from public.claim_customer_ai_job(job_id,180);
 perform public.resolve_customer_ai_dispatch(job_id,j.lease_token,repeat('b',64));
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=job_id;
 begin perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  perform public.begin_customer_ai_maintenance(attempt,job_id,'reconcile'); assert false,'untrusted JWT accepted';
  exception when insufficient_privilege then null; end;
 first:=public.begin_customer_ai_maintenance(attempt,job_id,'reconcile');
 assert first->>'state'='pending' and first->>'result' is null;
 assert public.begin_customer_ai_maintenance(attempt,job_id,'reconcile')=first;
 assert (select count(*) from public.list_customer_ai_maintenance_attempts() where attempt_id=attempt)=1;
 begin perform public.begin_customer_ai_maintenance(attempt,job_id,'recover_receipt'); assert false,'changed action accepted';
  exception when serialization_failure then null; end;
 begin perform public.begin_customer_ai_maintenance(gen_random_uuid(),job_id,'reconcile'); assert false,'duplicate pending action accepted';
  exception when serialization_failure then null; end;
 begin perform public.list_customer_ai_maintenance_attempts(0); assert false,'bad limit accepted';
  exception when invalid_parameter_value then null; end;
 begin perform public.list_customer_ai_maintenance_attempts(10,clock_timestamp(),null); assert false,'partial cursor accepted';
  exception when invalid_parameter_value then null; end;
 -- A crash/rollback during execution must roll back both domain action and journal outcome.
 begin
  assert public.execute_customer_ai_maintenance(attempt)->>'result'='requires_review';
  raise exception using errcode='P7777',message='simulate transaction rollback';
 exception when sqlstate 'P7777' then null; end;
 assert (select state='pending' from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=attempt);
 assert (select status='running' from public.ai_jobs where id=job_id);
 final:=public.execute_customer_ai_maintenance(attempt);
 assert final->>'state'='completed' and final->>'result'='requires_review';
 assert public.execute_customer_ai_maintenance(attempt)=final,'lost response replay changed';
 assert (select count(*) from public.list_customer_ai_maintenance_attempts() where attempt_id=attempt)=0;
 perform public.begin_customer_ai_maintenance(later_attempt,job_id,'reconcile');
 assert public.begin_customer_ai_maintenance(attempt,job_id,'reconcile')=final,'later intent must not block exact replay';
 assert public.execute_customer_ai_maintenance(later_attempt)->>'result'='requires_review';
 begin delete from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=attempt;
  assert false,'journal deletion accepted'; exception when check_violation then null; end;
 begin update bookworm_credentials.customer_ai_maintenance_attempts set result='settled' where attempt_id=attempt;
  assert false,'terminal journal changed'; exception when check_violation then null; end;
 perform public.begin_customer_ai_maintenance(missing_attempt,job_id,'recover_receipt');
 final:=public.execute_customer_ai_maintenance(missing_attempt);
 assert final->>'state'='needs_review' and final->>'result' is null;
 assert public.execute_customer_ai_maintenance(missing_attempt)=final;
 assert (select count(*) from public.list_customer_ai_maintenance_attempts() where attempt_id=missing_attempt)=1;
 raw:=jsonb_build_object('jobId',job_id,'workspaceId',ws,'bookId',b,'agentType','writer',
  'provider','openai','model','synthetic-1','status','succeeded','responseId','synthetic-response',
  'customerDispatchSha256',repeat('b',64),'diagnostics','[]'::jsonb,'suggestions','[]'::jsonb,
  'usage',jsonb_build_object('inputTokens',10,'outputTokens',4,'estimatedCostUsd',null,
   'providerTokenUsage','{"input_tokens":10,"output_tokens":4,"total_tokens":14}'::jsonb));
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(job_id,repeat('b',64),raw);
 perform public.begin_customer_ai_maintenance(receipt_attempt,job_id,'recover_receipt');
 final:=public.execute_customer_ai_maintenance(receipt_attempt);
 assert final->>'state'='completed' and final->>'result'='settled';
 assert public.execute_customer_ai_maintenance(receipt_attempt)=final;
 assert (select count(*) from public.ai_runs r where r.ai_job_id=job_id)=1;
 assert (select count(*) from public.usage_events e where e.ai_job_id=job_id)=1;
 assert (select count(*)=1 and sum(amount)=-2 from public.credit_ledger l where l.reference_id=job_id),'post-dispatch refund or debit';
end $$;
rollback;
