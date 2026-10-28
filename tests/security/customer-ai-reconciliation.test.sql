-- Synthetic, transactional service-only reconciliation proofs.
begin;
create temp table reconcile_account(u uuid,org uuid,ws uuid,connection uuid,policy uuid,legacy_policy uuid,short_policy uuid,plan uuid,subscription uuid) on commit drop;
create temp table reconcile_books(i integer,b uuid,c uuid,v uuid,j uuid) on commit drop;
grant select on reconcile_account,reconcile_books to service_role;
insert into reconcile_account select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid();
insert into reconcile_books select i,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid() from generate_series(1,4) i;
insert into auth.users(id,email) select u,'customer-reconciliation@local.test' from reconcile_account;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Reconcile',org::text,u from reconcile_account;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Reconcile',ws::text,u from reconcile_account;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer'::public.member_role from reconcile_account;
insert into public.books(id,workspace_id,title,author_name,created_by) select x.b,f.ws,'Synthetic','Author',f.u from reconcile_books x cross join reconcile_account f;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Chapter' from reconcile_books;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select x.v,x.c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain."}]}','Rain.',f.u from reconcile_books x cross join reconcile_account f;
update public.chapters c set current_document_version_id=x.v from reconcile_books x where c.id=x.c;
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic paid plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":20}',true from reconcile_account;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from reconcile_account;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
  'platform_plan',0,true,clock_timestamp()+interval '1 hour' from reconcile_account;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select legacy_policy,provider,agent_type,model_policy,'per_request_credits',2,true,expires_at from bookworm_credentials.customer_ai_policies cross join reconcile_account;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select short_policy,provider,agent_type,model_policy,'platform_plan',0,true,clock_timestamp()+interval '2 seconds'
 from bookworm_credentials.customer_ai_policies cross join reconcile_account where id=policy;
do $$ begin
 assert has_function_privilege('service_role','public.reconcile_customer_ai_job(uuid)','execute');
 assert not has_function_privilege('authenticated','public.reconcile_customer_ai_job(uuid)','execute');
 assert not has_function_privilege('anon','public.reconcile_customer_ai_job(uuid)','execute');
end $$;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) select u,ws,'admin_adjustment',10,0 from reconcile_account;
do $$ declare f reconcile_account; x reconcile_books; req jsonb; sources jsonb; policy uuid; fee integer; begin
 select * into strict f from reconcile_account;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 for x in select * from reconcile_books order by i loop
  req:=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(x.c),
   'chapters',jsonb_build_object(x.c::text,jsonb_build_object('id',x.c,'version',1,'documentVersionId',x.v,
    'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain.')))),
   'book',jsonb_build_object('title','Synthetic')));
  sources:=jsonb_build_array(jsonb_build_object('chapterId',x.c,'documentVersionId',x.v,'version',1));
  policy:=case x.i when 1 then f.legacy_policy when 4 then f.short_policy else f.policy end;
  fee:=case x.i when 1 then 2 else 0 end;
  perform public.create_customer_ai_job(x.j,gen_random_uuid(),f.u,f.ws,x.b,f.connection,1,policy,repeat('a',64),req,sources,fee,true);
 end loop;
end $$;
set local request.jwt.claims='{"role":"authenticated"}';
do $$ begin
 begin perform public.reconcile_customer_ai_job((select j from reconcile_books where i=1)); assert false,'non-service JWT accepted'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare jid uuid; j public.ai_jobs; owner uuid; receipt jsonb; begin
 jid:=(select x.j from reconcile_books x where i=1);
 assert public.reconcile_customer_ai_job(jid)='unchanged';
 update public.ai_jobs set attempts=5 where public.ai_jobs.id=jid;
 assert public.reconcile_customer_ai_job(jid)='released';
 assert public.reconcile_customer_ai_job(jid)='released';
 assert (select count(*) from public.credit_ledger where reference_id=jid)=2,'legacy fee release must occur once';
 assert (select sum(amount) from public.credit_ledger where reference_id=jid)=0;
 jid:=(select x.j from reconcile_books x where i=2);
 j:=public.claim_customer_ai_job(jid,180);
 update public.ai_jobs set attempts=5 where public.ai_jobs.id=jid;
 assert public.reconcile_customer_ai_job(jid)='unchanged','active exhausted lease cancelled';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where public.ai_jobs.id=jid;
 assert public.reconcile_customer_ai_job(jid)='released';
 assert not exists(select 1 from public.credit_ledger where reference_id=jid),'platform-plan job created fee';
 jid:=(select x.j from reconcile_books x where i=3);
 j:=public.claim_customer_ai_job(jid,180);
 perform public.resolve_customer_ai_dispatch(jid,j.lease_token,repeat('b',64));
 assert public.reconcile_customer_ai_job(jid)='unchanged','active dispatched lease held early';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where public.ai_jobs.id=jid;
 assert public.reconcile_customer_ai_job(jid)='requires_review';
 assert public.reconcile_customer_ai_job(jid)='requires_review';
 assert not exists(select 1 from public.credit_ledger where reference_id=jid),'post-dispatch fee changed';
 begin perform public.claim_customer_ai_job(jid); assert false,'dispatched job reclaimed'; exception when serialization_failure then null; end;
 select * into strict j from public.ai_jobs where public.ai_jobs.id=jid;
 select u into strict owner from reconcile_account;
 receipt:=jsonb_build_object('jobId',j.id,'workspaceId',j.workspace_id,'bookId',j.book_id,'agentType','writer',
  'provider','openai','model','synthetic-1','status','succeeded','responseId','synthetic-response',
  'customerDispatchSha256',repeat('b',64),'diagnostics','[]'::jsonb,'suggestions','[]'::jsonb,
  'usage',jsonb_build_object('inputTokens',10,'outputTokens',4,'estimatedCostUsd',null,
   'providerTokenUsage','{"input_tokens":10,"output_tokens":4,"total_tokens":14}'::jsonb));
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(jid,repeat('b',64),receipt);
 j:=public.complete_customer_ai_job(jid,owner,repeat('b',64));
 assert j.status='succeeded' and public.reconcile_customer_ai_job(jid)='settled','late receipt did not settle review';
 assert (select count(*) from public.ai_runs where ai_job_id=jid)=1;
 assert (select count(*) from public.usage_events where ai_job_id=jid)=1;
end $$;
select pg_sleep(2.1);
do $$ declare id uuid; begin
 id:=(select j from reconcile_books where i=4);
 assert public.reconcile_customer_ai_job(id)='released','expired undispatched job not released';
 assert public.reconcile_customer_ai_job(id)='released';
 begin perform public.reconcile_customer_ai_job(gen_random_uuid()); assert false,'unknown job accepted'; exception when no_data_found then null; end;
end $$;
reset role;
rollback;
