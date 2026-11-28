-- Synthetic DB-owned slot/replay and observation lifecycle; no provider I/O.
begin;
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 chapter uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); connection uuid:=gen_random_uuid();
 policy uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid(); job2 uuid:=gen_random_uuid(); manual_attempt uuid:=gen_random_uuid();
 j public.ai_jobs; req jsonb; sources jsonb; raw jsonb; s1 jsonb; s2 jsonb; receipt_slot jsonb; review_slot jsonb; obs jsonb; attempt uuid; attempt2 uuid;
begin
 assert has_function_privilege('service_role','public.open_customer_ai_maintenance_slot(uuid,text)','execute');
 assert has_function_privilege('service_role','public.list_customer_ai_maintenance_slots(integer,uuid,text)','execute');
 assert not has_function_privilege('authenticated','public.open_customer_ai_maintenance_slot(uuid,text)','execute');
 assert not has_function_privilege('anon','public.ack_customer_ai_maintenance_slot(uuid,text,uuid,integer)','execute');
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_maintenance_slots','select');
 assert not has_table_privilege('authenticated','bookworm_credentials.customer_ai_maintenance_observations','select');
 insert into auth.users(id,email) values(u,u::text||'@local.test');
 insert into public.organizations(id,name,slug,owner_user_id) values(org,'Slot test',org::text,u);
 insert into public.workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Slot test',ws::text,u);
 insert into public.workspace_members(workspace_id,user_id,role) values(ws,u,'writer');
 insert into public.books(id,workspace_id,title,author_name,created_by) values(b,ws,'Synthetic','Author',u);
 insert into public.chapters(id,book_id,order_index,title) values(chapter,b,0,'Chapter');
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
  values(version_id,chapter,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain."}]}','Rain.',u);
 update public.chapters set current_document_version_id=version_id where id=chapter;
 insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
  values(plan,'Slot plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true);
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
 assert public.open_customer_ai_maintenance_slot(job_id,'reconcile')->>'status'='not_actionable';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=job_id;
 s1:=public.open_customer_ai_maintenance_slot(job_id,'reconcile');
 assert s1->>'status'='open' and (s1->>'version')::integer=1 and s1#>>'{attempt,state}'='pending';
 attempt:=(s1#>>'{attempt,attemptId}')::uuid;
 assert public.open_customer_ai_maintenance_slot(job_id,'reconcile')=s1,'lost open must return same identity';
 begin perform public.ack_customer_ai_maintenance_slot(job_id,'reconcile',attempt,1); assert false,'pending acknowledged';
  exception when serialization_failure then null; end;
 -- The lease changes after discovery: outcome is unchanged, with no release.
 update public.ai_jobs set lease_expires_at=clock_timestamp()+interval '1 minute' where id=job_id;
 assert public.execute_customer_ai_maintenance(attempt)->>'result'='unchanged';
 obs:=public.ack_customer_ai_maintenance_slot(job_id,'reconcile',attempt,1);
 assert obs->>'result'='unchanged' and public.ack_customer_ai_maintenance_slot(job_id,'reconcile',attempt,1)=obs;
 assert public.open_customer_ai_maintenance_slot(job_id,'reconcile')->>'status'='not_actionable';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=job_id;
 s2:=public.open_customer_ai_maintenance_slot(job_id,'reconcile');attempt2:=(s2#>>'{attempt,attemptId}')::uuid;
 assert (s2->>'version')::integer=2 and attempt2<>attempt;
 assert public.ack_customer_ai_maintenance_slot(job_id,'reconcile',attempt,1)=obs,'old ack must not affect new slot';
 assert public.open_customer_ai_maintenance_slot(job_id,'reconcile')=s2;
 begin perform public.ack_customer_ai_maintenance_slot(job_id,'reconcile',attempt2,1); assert false,'stale version accepted';
  exception when serialization_failure then null; end;
 assert public.execute_customer_ai_maintenance(attempt2)->>'result'='requires_review';
 begin perform public.ack_customer_ai_maintenance_slot(job_id,'reconcile',attempt2,2); assert false,'review outcome dismissed';
  exception when serialization_failure then null; end;
 assert public.open_customer_ai_maintenance_slot(job_id,'recover_receipt')->>'status'='not_actionable';
 raw:=jsonb_build_object('jobId',job_id,'workspaceId',ws,'bookId',b,'agentType','writer',
  'provider','openai','model','synthetic-1','status','succeeded','responseId','synthetic-response',
  'customerDispatchSha256',repeat('b',64),'diagnostics','[]'::jsonb,'suggestions','[]'::jsonb,
  'usage',jsonb_build_object('inputTokens',10,'outputTokens',4,'estimatedCostUsd',null,
   'providerTokenUsage','{"input_tokens":10,"output_tokens":4,"total_tokens":14}'::jsonb));
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(job_id,repeat('b',64),raw);
 receipt_slot:=public.open_customer_ai_maintenance_slot(job_id,'recover_receipt');
 assert receipt_slot->>'status'='open' and (receipt_slot->>'version')::integer=1;
 assert public.execute_customer_ai_maintenance((receipt_slot#>>'{attempt,attemptId}')::uuid)->>'result'='settled';
 obs:=public.ack_customer_ai_maintenance_slot(job_id,'recover_receipt',(receipt_slot#>>'{attempt,attemptId}')::uuid,1);
 assert obs->>'result'='settled';
 assert public.ack_customer_ai_maintenance_slot(job_id,'recover_receipt',(receipt_slot#>>'{attempt,attemptId}')::uuid,1)=obs;
 assert public.open_customer_ai_maintenance_slot(job_id,'recover_receipt')->>'status'='not_actionable';
 assert (select count(*) from public.list_customer_ai_maintenance_observations())=2;
 assert (select count(*) from public.list_customer_ai_maintenance_slots() s where s.job_id=job_id and s.action='reconcile' and s.result='requires_review')=1,
  'review slot must survive even after the underlying job settles';
 assert (select count(*)=1 and sum(amount)=-2 from public.credit_ledger l where l.reference_id=job_id),'post-dispatch refund or debit';
 -- A pre-existing manual intent is adopted without inventing another ID.
 select * into j from public.create_customer_ai_job(job2,gen_random_uuid(),u,ws,b,connection,1,policy,repeat('a',64),req,sources,2,true);
 select * into j from public.claim_customer_ai_job(job2,180);
 perform public.resolve_customer_ai_dispatch(job2,j.lease_token,repeat('c',64));
 perform public.begin_customer_ai_maintenance(manual_attempt,job2,'recover_receipt');
 review_slot:=public.open_customer_ai_maintenance_slot(job2,'recover_receipt');
 assert (review_slot#>>'{attempt,attemptId}')::uuid=manual_attempt;
 assert public.execute_customer_ai_maintenance(manual_attempt)->>'state'='needs_review';
 begin perform public.ack_customer_ai_maintenance_slot(job2,'recover_receipt',manual_attempt,1); assert false,'needs_review dismissed';
  exception when serialization_failure then null; end;
 assert public.open_customer_ai_maintenance_slot(job2,'recover_receipt')#>>'{attempt,state}'='needs_review';
 assert (select count(*) from public.list_customer_ai_maintenance_slots() where attempt_id=manual_attempt and state='needs_review')=1;
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
  values(job2,repeat('c',64),jsonb_set(raw||jsonb_build_object('customerDispatchSha256',repeat('c',64)),'{jobId}',to_jsonb(job2)));
 assert public.open_customer_ai_maintenance_slot(job2,'recover_receipt')#>>'{attempt,state}'='needs_review',
  'late receipt must not silently dismiss a needs-review incident';
 assert (select count(*)=1 and sum(amount)=-2 from public.credit_ledger l where l.reference_id=job2),'post-dispatch refund or debit';
 begin delete from bookworm_credentials.customer_ai_maintenance_observations where attempt_id=attempt;
  assert false,'observation deleted'; exception when check_violation then null; end;
 begin perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  perform public.open_customer_ai_maintenance_slot(job_id,'reconcile'); assert false,'untrusted JWT accepted';
  exception when insufficient_privilege then null; end;
 begin perform public.list_customer_ai_maintenance_slots(10,job_id,null); assert false,'partial cursor accepted';
  exception when invalid_parameter_value then null; end;
end $$;
rollback;
