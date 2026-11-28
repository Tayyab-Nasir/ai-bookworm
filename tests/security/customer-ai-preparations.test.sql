-- Synthetic durable confirmation/recovery. Whole fixture rolls back; no I/O.
begin;
create temp table customer_preparation_fixture(u uuid,other_user uuid,org uuid,ws uuid,b uuid,c uuid,v uuid,
 connection uuid,policy uuid,plan uuid,subscription uuid,op uuid,request jsonb,sources jsonb) on commit drop;
grant select,update on customer_preparation_fixture to service_role;
insert into customer_preparation_fixture(u,other_user,org,ws,b,c,v,connection,policy,plan,subscription,op)
 values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
 gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
insert into auth.users(id,email) select u,'prepare-owner@local.test' from customer_preparation_fixture
 union all select other_user,'prepare-other@local.test' from customer_preparation_fixture;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Preparation tests',org::text,u from customer_preparation_fixture;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Preparation tests',ws::text,u from customer_preparation_fixture;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer'::public.member_role from customer_preparation_fixture
 union all select ws,other_user,'owner'::public.member_role from customer_preparation_fixture;
insert into public.books(id,workspace_id,title,author_name,created_by) select b,ws,'Synthetic book','Test author',u from customer_preparation_fixture;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Rain' from customer_preparation_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select v,c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain fell."}]}','Rain fell.',u from customer_preparation_fixture;
update public.chapters set current_document_version_id=f.v from customer_preparation_fixture f where id=f.c;
update customer_preparation_fixture set request=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(c),
 'chapters',jsonb_build_object(c::text,jsonb_build_object('id',c,'version',1,'documentVersionId',v,
 'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain fell.')))),
 'book',jsonb_build_object('title','Synthetic book'))),
 sources=jsonb_build_array(jsonb_build_object('chapterId',c,'documentVersionId',v,'version',1));

create function pg_temp.prepare_request(changes jsonb default '{}') returns jsonb language plpgsql as $$
declare f customer_preparation_fixture; a jsonb;
begin
 select * into strict f from customer_preparation_fixture;
 a:=jsonb_build_object('operation',f.op,'owner',f.u,'workspace',f.ws,'book',f.b,'connection',f.connection,
  'revision',1,'policy',f.policy,'hash',repeat('a',64),'request',f.request,'sources',f.sources,'omitted',0)||changes;
 return public.prepare_customer_ai_request((a->>'operation')::uuid,(a->>'owner')::uuid,(a->>'workspace')::uuid,
  (a->>'book')::uuid,(a->>'connection')::uuid,(a->>'revision')::integer,(a->>'policy')::uuid,a->>'hash',a->'request',a->'sources',(a->>'omitted')::integer);
end $$;
create function pg_temp.request_action(action text,fee integer default null,consent boolean default false,operation uuid default null)
returns jsonb language sql as $$
 select public.customer_ai_request_action(u,coalesce(operation,op),action,fee,consent) from customer_preparation_fixture;
$$;
create function pg_temp.reject_prepare(changes jsonb,code text) returns void language plpgsql as $$
begin
 begin perform pg_temp.prepare_request(changes);
 exception when others then assert sqlstate=code,format('Expected %s, got %s: %s',code,sqlstate,sqlerrm); return; end;
 assert false,'Invalid preparation accepted';
end $$;
create function pg_temp.reject_action(action text,fee integer,consent boolean,code text,operation uuid default null)
returns void language plpgsql as $$
begin
 begin perform pg_temp.request_action(action,fee,consent,operation);
 exception when others then assert sqlstate=code,format('Expected %s, got %s: %s',code,sqlstate,sqlerrm); return; end;
 assert false,'Invalid action accepted';
end $$;

do $$ declare signature text; begin
 assert (select count(*) from bookworm_credentials.customer_ai_preparations)=0;
 assert (select count(*) from bookworm_credentials.customer_ai_policies)=0,'No production fee policy seeded';
 assert not has_schema_privilege('service_role','bookworm_credentials','usage');
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_preparations','select');
 assert not has_table_privilege('authenticated','bookworm_credentials.customer_ai_preparations','insert');
 assert (select relrowsecurity from pg_class where oid='bookworm_credentials.customer_ai_preparations'::regclass);
 foreach signature in array array['public.customer_ai_preparation_options(uuid,uuid,uuid,uuid,integer,text)',
  'public.prepare_customer_ai_request(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer)',
  'public.customer_ai_request_action(uuid,uuid,text,integer,boolean)'] loop
  assert has_function_privilege('service_role',signature,'execute');
  assert not has_function_privilege('authenticated',signature,'execute');
  assert not has_function_privilege('anon',signature,'execute');
 end loop;
end $$;
set local request.jwt.claims='{"role":"authenticated"}';
do $$ begin perform pg_temp.reject_prepare('{}','42501'); perform pg_temp.reject_action('status',null,false,'42501'); end $$;
set local request.jwt.claims='{"role":"service_role"}';
set local role service_role;
do $$ declare f customer_preparation_fixture; begin
 select * into strict f from customer_preparation_fixture;
 perform pg_temp.reject_prepare('{}','23514');
 perform public.mutate_ai_connection(f.u,'openai',f.connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
end $$;
reset role;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
 'per_request_credits',2,true,clock_timestamp()+interval '1 hour' from customer_preparation_fixture;
do $$ begin perform pg_temp.reject_prepare('{}','23514'); end $$; -- No paid plan yet.
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic preparation plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true from customer_preparation_fixture;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from customer_preparation_fixture;
insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
 select u,ws,'admin_adjustment',100,0 from customer_preparation_fixture;

set local role service_role;
do $$ declare f customer_preparation_fixture; r jsonb; options jsonb; changed jsonb; begin
 select * into strict f from customer_preparation_fixture;
 options:=public.customer_ai_preparation_options(f.u,f.ws,f.b,f.connection,1,'writer');
 assert jsonb_array_length(options)=1 and options#>>'{0,id}'=f.policy::text and options#>>'{0,platformFee,credits}'='2';
 assert pg_temp.request_action('status')->>'status'='not_found';
 perform pg_temp.reject_action('confirm',2,true,'P0002');
 perform pg_temp.reject_prepare(jsonb_build_object('owner',f.other_user),'42501');
 perform pg_temp.reject_prepare('{"revision":2}','42501');
 perform pg_temp.reject_prepare(jsonb_build_object('request',f.request||'{"apiKey":"synthetic-forbidden"}'),'22023');
 perform pg_temp.reject_prepare(jsonb_build_object('sources',jsonb_set(f.sources,'{0,version}','2')),'40001');
 perform pg_temp.reject_prepare('{"sources":[]}','22023');
 perform pg_temp.reject_prepare('{"omitted":122}','22023');
 r:=pg_temp.prepare_request(); assert r->>'status'='prepared' and r->'jobId'='null'::jsonb;
 assert r=pg_temp.prepare_request() and r=pg_temp.request_action('status'),'Lost prepare reply is recoverable without another write';
 assert r->>'providerCostStatus'='unknown' and r->>'chapterCount'='1' and r->>'contextOmitted'='0';
 assert r->'sourceVersions'=f.sources and r->'upstream'='null';
 assert not(r ?| array['request','requestSha256','apiKey','grantId','keySuffix']);
 assert public.customer_ai_request_action(f.other_user,f.op,'status')->>'status'='not_found';
 assert not exists(select 1 from public.ai_jobs where book_id=f.b),'Prepare created a job';
 assert not exists(select 1 from public.credit_ledger where reference_type='customer_ai_platform_fee' and user_id=f.u),'Prepare charged a fee';
 foreach changed in array array['{"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb,
  '{"omitted":1}',jsonb_build_object('policy',gen_random_uuid()),jsonb_build_object('request',f.request||'{"contextPolicy":{}}')] loop
  perform pg_temp.reject_prepare(changed,'40001');
 end loop;
 perform pg_temp.reject_action('confirm',2,false,'22023');
 perform pg_temp.reject_action('confirm',3,true,'22023');
 perform pg_temp.reject_action('status',2,false,'22023');
 perform pg_temp.reject_action('recover',null,false,'40001');
end $$;
reset role;

-- Every authority change must invalidate NEW confirmation, while saved status
-- remains readable after key/policy/plan changes. Subtransactions restore fixtures.
do $$ declare f customer_preparation_fixture; begin
 select * into strict f from customer_preparation_fixture;
 begin
  update bookworm_credentials.customer_ai_policies set enabled=false where id=f.policy;
  assert pg_temp.request_action('status')->>'status'='prepared';
  perform pg_temp.request_action('confirm',2,true); assert false,'Disabled policy accepted';
 exception when check_violation then null; end;
 begin
  update public.plans set is_active=false where id=f.plan;
  assert pg_temp.request_action('status')->>'status'='prepared';
  perform pg_temp.request_action('confirm',2,true); assert false,'Expired paid access accepted';
 exception when check_violation then null; end;
 begin
  update public.workspace_members set status='suspended' where workspace_id=f.ws and user_id=f.u;
  perform pg_temp.request_action('confirm',2,true); assert false,'Removed member accepted';
 exception when insufficient_privilege then null; end;
 begin
  update public.chapters set current_document_version_id=null where id=f.c;
  perform pg_temp.request_action('confirm',2,true); assert false,'Stale source accepted';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_ai_connection(f.u,'openai',f.connection,1,gen_random_uuid(),'revoke');
  assert pg_temp.request_action('status')->>'status'='prepared';
  perform pg_temp.request_action('confirm',2,true); assert false,'Revoked key accepted';
 exception when insufficient_privilege then null; end;
 assert not exists(select 1 from public.ai_jobs where book_id=f.b);
 begin update bookworm_credentials.customer_ai_preparations set context_omitted=1 where owner_id=f.u;
  assert false,'Preparation edited'; exception when check_violation then null; end;
 begin update bookworm_credentials.customer_ai_preparations set state='confirmed' where owner_id=f.u;
  assert false,'Fabricated confirmation'; exception when check_violation then null; end;
 begin delete from bookworm_credentials.customer_ai_preparations where owner_id=f.u;
  assert false,'Recovery authority deleted'; exception when check_violation then null; end;
end $$;

set local role service_role;
do $$ declare f customer_preparation_fixture; r jsonb; job uuid; new_op uuid:=gen_random_uuid(); begin
 select * into strict f from customer_preparation_fixture;
 r:=pg_temp.request_action('confirm',2,true); job:=(r->>'jobId')::uuid;
 assert r->>'status'='queued';
 assert r=pg_temp.request_action('confirm',2,true) and r=pg_temp.request_action('status');
 assert (select count(*) from public.ai_jobs where book_id=f.b)=1;
 assert (select count(*) from public.credit_ledger where reference_id=job and source='generation_reservation' and amount=-2)=1;
 assert pg_temp.request_action('cancel')->>'status'='cancelled';
 assert pg_temp.request_action('cancel')->>'status'='cancelled';
 assert pg_temp.request_action('confirm',2,true)->>'status'='cancelled','Confirm replay must not resurrect cancellation';
 assert (select count(*) from public.credit_ledger where reference_id=job and source='generation_release' and amount=2)=1;
 perform pg_temp.prepare_request(jsonb_build_object('operation',new_op));
 assert pg_temp.request_action('cancel',null,false,new_op)->>'status'='closed';
 assert pg_temp.prepare_request(jsonb_build_object('operation',new_op))->>'status'='closed';
 perform pg_temp.reject_action('confirm',2,true,'40001',new_op);
end $$;
reset role;

-- Expiry checked by the server; changing the user's clock cannot extend it.
do $$ declare f customer_preparation_fixture; expired uuid:=gen_random_uuid(); begin
 select * into strict f from customer_preparation_fixture;
 insert into bookworm_credentials.customer_ai_preparations(owner_id,operation_id,workspace_id,book_id,connection_id,credential_revision,
  policy_id,request_sha256,request_snapshot,source_versions,context_omitted,created_at,expires_at)
 values(f.u,expired,f.ws,f.b,f.connection,1,f.policy,repeat('a',64),f.request,f.sources,0,
  clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '10 minutes');
 assert pg_temp.request_action('status',null,false,expired)->>'status'='expired';
 perform pg_temp.reject_action('confirm',2,true,'40001',expired);
 assert pg_temp.request_action('cancel',null,false,expired)->>'status'='closed';
end $$;

-- Recovery consumes only the receipt and preserves canonical pending proposals.
do $$ declare f customer_preparation_fixture; op uuid:=gen_random_uuid(); r jsonb; j public.ai_jobs; saved jsonb; begin
 select * into strict f from customer_preparation_fixture;
 perform pg_temp.prepare_request(jsonb_build_object('operation',op));
 r:=pg_temp.request_action('confirm',2,true,op);
 select * into j from public.claim_customer_ai_job((r->>'jobId')::uuid,180);
 perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));
 perform pg_temp.reject_action('cancel',null,false,'40001',op);
 perform pg_temp.reject_action('recover',null,false,'40001',op);
 saved:=jsonb_build_object('jobId',j.id,'workspaceId',f.ws,'bookId',f.b,'agentType','writer','provider','openai',
  'model','synthetic-1','status','succeeded','responseId','synthetic-response','requestId','synthetic-request',
  'customerDispatchSha256',repeat('b',64),'diagnostics','[]'::jsonb,
  'suggestions',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'chapterId',f.c,'nodeId','n1','confidence',0.9,
   'rationale','Improve the opening.','operation',jsonb_build_object('type','replace_text','target',jsonb_build_object('chapterId',f.c,'nodeId','n1'),
   'payload',jsonb_build_object('nodeId','n1','from',0,'to',4,'text','Snow')))),
  'usage',jsonb_build_object('inputTokens',10,'outputTokens',4,'estimatedCostUsd',null,
   'providerTokenUsage',jsonb_build_object('input_tokens',10,'output_tokens',4,'total_tokens',14)));
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(j.id,repeat('b',64),saved);
 perform public.mutate_ai_connection(f.u,'openai',f.connection,1,gen_random_uuid(),'revoke');
 assert pg_temp.request_action('status',null,false,op)->>'status'='running';
 assert pg_temp.request_action('recover',null,false,op)->>'status'='succeeded';
 assert pg_temp.request_action('recover',null,false,op)->>'status'='succeeded';
 assert pg_temp.request_action('confirm',2,true,op)->>'status'='succeeded';
 assert (select count(*) from public.usage_events where ai_job_id=j.id and meter='customer_ai_request')=1;
 assert not exists(select 1 from public.credit_ledger where reference_id=j.id and source='generation_release');
 assert (select count(*) from public.document_versions where chapter_id=f.c)=1,'Recovery applied suggestions automatically';
 assert (select current_document_version_id=f.v from public.chapters where id=f.c);
end $$;

-- Rate gates use a replacement synthetic credential; nested blocks roll back
-- only their burst/hourly fixtures. The final rollback removes the whole suite.
do $$ declare f customer_preparation_fixture; n integer; r jsonb; begin
 select * into strict f from customer_preparation_fixture;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,2,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 begin
  n:=(select count(*) from bookworm_credentials.customer_ai_preparations where owner_id=f.u and created_at>clock_timestamp()-interval '1 minute');
  for i in n+1..10 loop perform pg_temp.prepare_request(jsonb_build_object('operation',gen_random_uuid(),'revision',3)); end loop;
  perform pg_temp.reject_prepare(jsonb_build_object('operation',gen_random_uuid(),'revision',3),'P0429');
  raise exception using errcode='P7777',message='rollback burst fixture';
 exception when sqlstate 'P7777' then null; end;
 begin
  for i in 1..50 loop
   insert into bookworm_credentials.customer_ai_preparations(owner_id,operation_id,workspace_id,book_id,connection_id,credential_revision,
    policy_id,request_sha256,request_snapshot,source_versions,context_omitted,state,created_at,expires_at)
   values(f.u,gen_random_uuid(),f.ws,f.b,f.connection,3,f.policy,repeat('a',64),f.request,f.sources,0,'closed',
    clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute');
  end loop;
  perform pg_temp.reject_prepare(jsonb_build_object('operation',gen_random_uuid(),'revision',3),'P0429');
  raise exception using errcode='P7777',message='rollback hourly fixture';
 exception when sqlstate 'P7777' then null; end;
end $$;
rollback;
