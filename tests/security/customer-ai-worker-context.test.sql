-- Non-secret context access, role isolation and reauthorization. Rolled back.
begin;
create temp table customer_context_fixture(u uuid,org uuid,ws uuid,b uuid,c uuid,v uuid,connection uuid,policy uuid,plan uuid,subscription uuid,job uuid,lease uuid,request jsonb,sources jsonb) on commit drop;
insert into customer_context_fixture(u,org,ws,b,c,v,connection,policy,plan,subscription)
 values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
insert into auth.users(id,email) select u,'worker-context@local.test' from customer_context_fixture;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Context fixture',org::text,u from customer_context_fixture;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Context fixture',ws::text,u from customer_context_fixture;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer' from customer_context_fixture;
insert into public.books(id,workspace_id,title,author_name,created_by) select b,ws,'Synthetic book','Test author',u from customer_context_fixture;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Synthetic chapter' from customer_context_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select v,c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain fell."}]}','Rain fell.',u from customer_context_fixture;
update public.chapters set current_document_version_id=f.v from customer_context_fixture f where id=f.c;
update customer_context_fixture set request=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(c),
 'chapters',jsonb_build_object(c::text,jsonb_build_object('id',c,'version',1,'documentVersionId',v,
 'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain fell.')))))),
 sources=jsonb_build_array(jsonb_build_object('chapterId',c,'documentVersionId',v,'version',1));
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic worker plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":10}',true from customer_context_fixture;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from customer_context_fixture;
insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) select u,ws,'admin_adjustment',1000,0 from customer_context_fixture;
set local request.jwt.claims='{"role":"service_role"}';
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
 'per_request_credits',2,true,clock_timestamp()+interval '1 hour' from customer_context_fixture;
do $$ declare f customer_context_fixture; j public.ai_jobs; begin
 select * into strict f from customer_context_fixture;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 j:=public.create_customer_ai_job(gen_random_uuid(),gen_random_uuid(),f.u,f.ws,f.b,f.connection,1,f.policy,repeat('a',64),f.request,f.sources,2,true);
 j:=public.claim_customer_ai_job(j.id,300);
 update customer_context_fixture set job=j.id,lease=j.lease_token;
 assert has_function_privilege('service_role','public.prepare_customer_ai_dispatch(uuid,uuid)','execute');
 assert not has_function_privilege('anon','public.prepare_customer_ai_dispatch(uuid,uuid)','execute');
 assert not has_function_privilege('authenticated','public.prepare_customer_ai_dispatch(uuid,uuid)','execute');
 assert not has_schema_privilege('service_role','bookworm_credentials','usage');
 assert not has_table_privilege('service_role','bookworm_credentials.ai_connection_secrets','select');
end $$;
grant select on customer_context_fixture to service_role;
set local role service_role;
do $$ declare f customer_context_fixture; before public.ai_jobs; after public.ai_jobs; context jsonb; begin
 select * into strict f from customer_context_fixture;
 select * into before from public.ai_jobs where id=f.job;
 context:=public.prepare_customer_ai_dispatch(f.job,f.lease);
 assert context=public.prepare_customer_ai_dispatch(f.job,f.lease),'safe read changed';
 assert (select count(*) from jsonb_object_keys(context))=2 and context ?& array['scope','request'];
 assert context->'request'=f.request and context#>>'{scope,jobId}'=f.job::text
  and context#>>'{scope,ownerId}'=f.u::text and context#>>'{scope,connectionId}'=f.connection::text;
 assert not context ? 'credential' and not context ? 'secret';
 assert not public.customer_ai_dispatch_authorized(context->'scope'),'prepare silently authorized sending';
 select * into after from public.ai_jobs where id=f.job;
 assert before=after,'prepare mutated canonical job';
 assert (select count(*) from public.credit_ledger where reference_id=f.job)=1,'prepare charged twice';
 begin perform public.prepare_customer_ai_dispatch(f.job,gen_random_uuid()); assert false,'foreign lease accepted'; exception when serialization_failure then null; end;
 begin perform public.prepare_customer_ai_dispatch(f.job,null); assert false,'missing lease accepted'; exception when serialization_failure then null; end;
 begin perform public.prepare_customer_ai_dispatch(gen_random_uuid(),f.lease); assert false,'missing job accepted'; exception when no_data_found then null; end;
end $$;
reset role;
-- Each attempted change rolls back after rejection, preserving the exact seed.
create function pg_temp.reject_context(change_sql text, expected text) returns void language plpgsql as $$
declare f customer_context_fixture;
begin
 select * into strict f from customer_context_fixture;
 begin
  execute change_sql;
  perform public.prepare_customer_ai_dispatch(f.job,f.lease);
 exception when others then assert sqlstate=expected,format('Expected %s, got %s',expected,sqlstate); return; end;
 assert false,'changed authorization exposed context';
end $$;
do $$ declare f customer_context_fixture; prepared jsonb; resolved jsonb; begin
 select * into strict f from customer_context_fixture;
 perform pg_temp.reject_context(format('update public.subscriptions set status=''past_due'' where id=%L',f.subscription),'23514');
 perform pg_temp.reject_context(format('update public.subscriptions set current_period_end=clock_timestamp()-interval ''1 second'' where id=%L',f.subscription),'23514');
 perform pg_temp.reject_context(format('update public.workspace_members set role=''viewer'' where user_id=%L',f.u),'42501');
 perform pg_temp.reject_context(format('update public.workspace_members set status=''suspended'' where user_id=%L',f.u),'42501');
 perform pg_temp.reject_context(format('update public.plans set is_active=false where id=%L',f.plan),'23514');
 perform pg_temp.reject_context(format('update bookworm_credentials.customer_ai_policies set enabled=false where id=%L',f.policy),'40001');
 perform pg_temp.reject_context(format('update public.ai_jobs set lease_expires_at=clock_timestamp()-interval ''1 second'' where id=%L',f.job),'40001');
 perform pg_temp.reject_context(format('update public.chapters set current_document_version_id=null where id=%L',f.c),'40001');
 perform pg_temp.reject_context(format('select public.mutate_ai_connection(%L,''openai'',%L,1,gen_random_uuid(),''revoke'')',f.u,f.connection),'42501');
 prepared:=public.prepare_customer_ai_dispatch(f.job,f.lease);
 -- Successful preparation must not bypass the later resolver's fresh check.
 begin
  perform public.mutate_ai_connection(f.u,'openai',f.connection,1,gen_random_uuid(),'revoke');
  perform public.resolve_customer_ai_dispatch(f.job,f.lease,repeat('b',64));
  assert false,'revocation between preparation and dispatch ignored';
 exception when insufficient_privilege then null; end;
 resolved:=public.resolve_customer_ai_dispatch(f.job,f.lease,repeat('b',64));
 assert resolved-'credential'=prepared,'read and resolver disagree on identity/source';
 assert public.customer_ai_dispatch_authorized(prepared->'scope');
 begin perform public.prepare_customer_ai_dispatch(f.job,f.lease); assert false,'dispatched context reopened'; exception when serialization_failure then null; end;
 assert (select count(*) from public.credit_ledger where reference_id=f.job)=1;
 assert (select state='held' and receipt_fingerprint=repeat('b',64) from bookworm_credentials.customer_ai_jobs where job_id=f.job);
end $$;
set local request.jwt.claims='{"role":"authenticated"}';
do $$ declare f customer_context_fixture; begin
 select * into strict f from customer_context_fixture;
 begin perform public.prepare_customer_ai_dispatch(f.job,f.lease); assert false,'role check missing'; exception when insufficient_privilege then null; end;
end $$;
rollback;
