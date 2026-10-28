-- Synthetic author metadata, late-write closures and fee safety; no network.
begin;
create temp table author_ai_fixture(u uuid,other_user uuid,org uuid,ws uuid,b uuid,other_book uuid,c uuid,v uuid,
 connection uuid,policy uuid,plan uuid,subscription uuid,op uuid,request jsonb,sources jsonb) on commit drop;
grant select on author_ai_fixture to service_role;
insert into author_ai_fixture(u,other_user,org,ws,b,other_book,c,v,connection,policy,plan,subscription,op)
 values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
 gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
insert into auth.users(id,email) select u,u::text||'@local.test' from author_ai_fixture
 union all select other_user,other_user::text||'@local.test' from author_ai_fixture;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Author recovery',org::text,u from author_ai_fixture;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Author recovery',ws::text,u from author_ai_fixture;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer' from author_ai_fixture;
insert into public.books(id,workspace_id,title,author_name,created_by) select b,ws,'Synthetic book','Test author',u from author_ai_fixture
 union all select other_book,ws,'Other book','Test author',u from author_ai_fixture;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Rain' from author_ai_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select v,c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain fell."}]}','Rain fell.',u from author_ai_fixture;
update public.chapters set current_document_version_id=f.v from author_ai_fixture f where id=f.c;
update author_ai_fixture set request=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(c),
 'chapters',jsonb_build_object(c::text,jsonb_build_object('id',c,'version',1,'documentVersionId',v,
 'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain fell.')))),
 'book',jsonb_build_object('title','Synthetic book'))),
 sources=jsonb_build_array(jsonb_build_object('chapterId',c,'documentVersionId',v,'version',1));
set local request.jwt.claims='{"role":"service_role"}';
do $$ begin perform public.mutate_ai_connection(u,'openai',connection,null,gen_random_uuid(),'save','test','synthetic',
 encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64')) from author_ai_fixture; end $$;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
 'platform_plan',0,true,clock_timestamp()+interval '1 hour' from author_ai_fixture;
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic author plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true from author_ai_fixture;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from author_ai_fixture;
-- A paid plan, not a credit top-up, funds Bookworm access for customer-owned AI.
create function pg_temp.author_prepare(operation uuid) returns jsonb language sql as $$
 select public.prepare_customer_ai_request(operation,u,ws,b,connection,1,policy,repeat('a',64),request,sources,0) from author_ai_fixture;
$$;

-- Native harness commits only the reviewed seed before this exact marker.
do $$ declare f author_ai_fixture; r jsonb; replay jsonb; op uuid; j public.ai_jobs; begin
 select * into strict f from author_ai_fixture;
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_preparation_closures','select');
 assert not has_table_privilege('authenticated','bookworm_credentials.customer_ai_preparation_closures','insert');
 assert (select relrowsecurity from pg_class where oid='bookworm_credentials.customer_ai_preparation_closures'::regclass);
 assert not has_function_privilege('anon','public.close_customer_ai_preparation(uuid,uuid,uuid)','execute');
 assert not has_function_privilege('authenticated','public.close_customer_ai_preparation(uuid,uuid,uuid)','execute');
 assert has_function_privilege('service_role','public.close_customer_ai_preparation(uuid,uuid,uuid)','execute');
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 begin perform public.close_customer_ai_preparation(f.u,f.b,f.op); assert false; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 begin perform public.close_customer_ai_preparation(f.other_user,f.b,f.op); assert false; exception when insufficient_privilege then null; end;
 r:=public.close_customer_ai_preparation(f.u,f.b,f.op);
 assert r=jsonb_build_object('operationId',f.op,'bookId',f.b,'status','closed_before_prepare');
 assert public.customer_ai_request_action(f.u,f.op,'status')=r;
 assert public.close_customer_ai_preparation(f.u,f.b,f.op)=r;
 begin perform public.close_customer_ai_preparation(f.u,f.other_book,f.op); assert false; exception when serialization_failure then null; end;
 begin perform pg_temp.author_prepare(f.op); assert false,'Late preparation accepted'; exception when serialization_failure then null; end;
 assert not exists(select 1 from bookworm_credentials.customer_ai_preparations where owner_id=f.u);
 assert not exists(select 1 from public.ai_jobs where created_by=f.u);
 begin delete from bookworm_credentials.customer_ai_preparation_closures where owner_id=f.u; assert false; exception when check_violation then null; end;
 begin update bookworm_credentials.customer_ai_preparation_closures set book_id=f.other_book where owner_id=f.u; assert false; exception when check_violation then null; end;

 op:=gen_random_uuid(); r:=pg_temp.author_prepare(op);
 assert r->'sourceVersions'=f.sources and r->'upstream'='null' and r->>'chapterCount'='1';
 assert r->'platformFee'='{"mode":"platform_plan","credits":0}'::jsonb;
 assert not(r ?| array['request','requestSha256','apiKey','grantId','keySuffix']);
 assert position('Rain fell' in r::text)=0;
 assert public.close_customer_ai_preparation(f.u,f.b,op)->>'status'='closed';
 assert pg_temp.author_prepare(op)->>'status'='closed','Replay must never reopen a closed request';
 begin perform public.customer_ai_request_action(f.u,op,'confirm',0,true); assert false; exception when serialization_failure then null; end;

 op:=gen_random_uuid(); perform pg_temp.author_prepare(op); r:=public.customer_ai_request_action(f.u,op,'confirm',0,true);
 assert public.close_customer_ai_preparation(f.u,f.b,op)->>'status'='cancelled';
 perform public.close_customer_ai_preparation(f.u,f.b,op);
 assert not exists(select 1 from public.credit_ledger where user_id=f.u), 'Paid-plan request must not reserve or release credits';
 op:=gen_random_uuid(); perform pg_temp.author_prepare(op); r:=public.customer_ai_request_action(f.u,op,'confirm',0,true);
 select * into j from public.claim_customer_ai_job((r->>'jobId')::uuid,180);
 perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));
 begin perform public.close_customer_ai_preparation(f.u,f.b,op); assert false,'Dispatched outcome falsely closed'; exception when serialization_failure then null; end;
 assert not exists(select 1 from public.credit_ledger where user_id=f.u), 'Dispatch must not consume Bookworm credits';
 assert not exists(select 1 from bookworm_credentials.customer_ai_preparation_closures where owner_id=f.u and operation_id=op);

 for i in 1..9 loop perform public.close_customer_ai_preparation(f.u,f.b,gen_random_uuid()); end loop;
 begin perform public.close_customer_ai_preparation(f.u,f.b,gen_random_uuid()); assert false; exception when sqlstate 'P0429' then null; end;
 assert public.close_customer_ai_preparation(f.u,f.b,f.op)->>'status'='closed_before_prepare','Rate gate cannot strand existing recovery';
 update public.workspace_members set status='suspended' where workspace_id=f.ws and user_id=f.u;
 begin perform public.customer_ai_request_action(f.u,f.op,'status'); assert false; exception when insufficient_privilege then null; end;
end $$;
rollback;
