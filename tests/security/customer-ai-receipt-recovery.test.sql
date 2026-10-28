-- Synthetic late receipts only. No network or provider invocation.
begin;
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 chapter uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); connection uuid:=gen_random_uuid();
 policy uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid();
 j public.ai_jobs; req jsonb; sources jsonb; raw jsonb;
begin
 assert has_function_privilege('service_role','public.recover_customer_ai_receipt(uuid)','execute');
 assert not has_function_privilege('anon','public.recover_customer_ai_receipt(uuid)','execute');
 assert not has_function_privilege('authenticated','public.recover_customer_ai_receipt(uuid)','execute');
 insert into auth.users(id,email) values(u,u::text||'@local.test');
 insert into public.organizations(id,name,slug,owner_user_id) values(org,'Receipt recovery',org::text,u);
 insert into public.workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Receipt recovery',ws::text,u);
 insert into public.workspace_members(workspace_id,user_id,role) values(ws,u,'writer');
 insert into public.books(id,workspace_id,title,author_name,created_by) values(b,ws,'Synthetic','Author',u);
 insert into public.chapters(id,book_id,order_index,title) values(chapter,b,0,'Chapter');
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
  values(version_id,chapter,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain."}]}','Rain.',u);
 update public.chapters set current_document_version_id=version_id where id=chapter;
 insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
  values(plan,'Receipt plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true);
 insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
  values(gen_random_uuid(),org,plan,'active',clock_timestamp()+interval '1 day');
 -- Exercise a historical per-request policy as well as the current paid-plan path elsewhere.
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
 begin perform public.recover_customer_ai_receipt(job_id); assert false,'undispatched job recovered';
  exception when serialization_failure then null; end;
 select * into j from public.claim_customer_ai_job(job_id,180);
 perform public.resolve_customer_ai_dispatch(job_id,j.lease_token,repeat('b',64));
 begin perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  perform public.recover_customer_ai_receipt(job_id); assert false,'untrusted JWT recovered';
  exception when insufficient_privilege then null; end;
 begin perform public.recover_customer_ai_receipt(job_id); assert false,'missing receipt recovered';
  exception when serialization_failure then null; end;
 begin perform public.recover_customer_ai_receipt(null); assert false,'null job accepted';
  exception when invalid_parameter_value then null; end;
 raw:=jsonb_build_object('jobId',job_id,'workspaceId',ws,'bookId',b,'agentType','writer',
  'provider','openai','model','synthetic-1','status','succeeded','responseId','synthetic-response',
  'customerDispatchSha256',repeat('b',64),'diagnostics','[]'::jsonb,'suggestions','[]'::jsonb,
  'usage',jsonb_build_object('inputTokens',10,'outputTokens',4,'estimatedCostUsd',null,
   'providerTokenUsage','{"input_tokens":10,"output_tokens":4,"total_tokens":14}'::jsonb));
 begin
  insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(job_id,repeat('c',64),raw);
  begin perform public.recover_customer_ai_receipt(job_id); assert false,'mismatched fingerprint recovered';
   exception when serialization_failure then null; end;
  raise exception using errcode='P7777',message='rollback wrong fingerprint fixture';
 exception when sqlstate 'P7777' then null; end;
 begin
  insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(job_id,repeat('b',64),raw||'{"provider":"anthropic"}');
  perform public.recover_customer_ai_receipt(job_id); assert false,'invalid receipt recovered';
  exception when check_violation then null; end;
 assert not exists(select 1 from public.ai_review_service_receipts r where r.job_id=job_id);
 assert not exists(select 1 from public.ai_runs r where r.ai_job_id=job_id);
 -- The first worker can disappear and the lease expire before the late receipt.
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=job_id;
 assert public.reconcile_customer_ai_job(job_id)='requires_review';
 -- Revocation after dispatch must not erase an already incurred result.
 update public.workspace_members set status='suspended' where workspace_id=ws and user_id=u;
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(job_id,repeat('b',64),raw);
 assert public.recover_customer_ai_receipt(job_id)='settled';
 assert public.recover_customer_ai_receipt(job_id)='settled','duplicate recovery must be idempotent';
 assert (select status='succeeded' from public.ai_jobs where id=job_id);
 assert (select count(*) from public.ai_runs r where r.ai_job_id=job_id)=1;
 assert (select count(*) from public.usage_events e where e.ai_job_id=job_id)=1;
 assert (select count(*)=1 and sum(amount)=-2 from public.credit_ledger l where l.reference_id=job_id),
  'recovery must not debit or refund the existing reservation';
 begin perform public.recover_customer_ai_receipt(gen_random_uuid()); assert false,'unknown job recovered';
  exception when no_data_found then null; end;
end $$;
rollback;
