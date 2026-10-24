-- Synthetic, rolled-back proofs. No provider call, real key, policy or paid grant.
begin;
create temp table customer_job_fixture(u uuid,other_user uuid,org uuid,ws uuid,b uuid,c uuid,v uuid,
 connection uuid,policy uuid,plan uuid,subscription uuid,request jsonb,sources jsonb) on commit drop;
grant select,update on customer_job_fixture to service_role;
insert into customer_job_fixture(u,other_user,org,ws,b,c,v,connection,policy,plan,subscription)
 values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
 gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
insert into auth.users(id,email) select u,'customer-job-owner@local.test' from customer_job_fixture
 union all select other_user,'customer-job-other@local.test' from customer_job_fixture;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Customer job fixture',org::text,u from customer_job_fixture;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Customer jobs',ws::text,u from customer_job_fixture;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer'::public.member_role from customer_job_fixture
 union all select ws,other_user,'owner'::public.member_role from customer_job_fixture;
insert into public.books(id,workspace_id,title,author_name,created_by) select b,ws,'Synthetic book','Test author',u from customer_job_fixture;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Synthetic chapter' from customer_job_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select v,c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain fell."}]}','Rain fell.',u from customer_job_fixture;
update public.chapters set current_document_version_id=f.v from customer_job_fixture f where id=f.c;
update customer_job_fixture set request=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(c),
 'chapters',jsonb_build_object(c::text,jsonb_build_object('id',c,'version',1,'documentVersionId',v,
 'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain fell.')))),
 'book',jsonb_build_object('title','Synthetic book'))),
 sources=jsonb_build_array(jsonb_build_object('chapterId',c,'documentVersionId',v,'version',1));

create function pg_temp.new_customer_job(changes jsonb default '{}') returns public.ai_jobs language plpgsql as $$
declare f customer_job_fixture; args jsonb; j public.ai_jobs;
begin
 select * into strict f from customer_job_fixture;
 args:=jsonb_build_object('job',gen_random_uuid(),'operation',gen_random_uuid(),'owner',f.u,'workspace',f.ws,'book',f.b,
  'connection',f.connection,'revision',1,'policy',f.policy,'hash',repeat('a',64),'request',f.request,'sources',f.sources,'fee',2,'consent',true)||changes;
 select * into j from public.create_customer_ai_job((args->>'job')::uuid,(args->>'operation')::uuid,(args->>'owner')::uuid,
  (args->>'workspace')::uuid,(args->>'book')::uuid,(args->>'connection')::uuid,(args->>'revision')::integer,(args->>'policy')::uuid,
  args->>'hash',args->'request',args->'sources',(args->>'fee')::integer,(args->>'consent')::boolean);
 return j;
end $$;

create function pg_temp.reject_customer_job(changes jsonb,code text) returns void language plpgsql as $$
begin
 begin
  perform pg_temp.new_customer_job(changes);
 exception when others then
  assert sqlstate=code,format('Expected %s, got %s',code,sqlstate); return;
 end;
 assert false,'invalid customer job accepted';
end $$;

do $$ declare signature text; policy jsonb; invalid jsonb; provider text; begin
 assert (select count(*) from bookworm_credentials.customer_ai_policies)=0,'migration seeded a pricing decision';
 assert (select count(*) from bookworm_credentials.customer_ai_jobs)=0,'migration created customer jobs';
 assert not has_schema_privilege('service_role','bookworm_credentials','usage');
 foreach signature in array array[
  'public.create_customer_ai_job(uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer,boolean)',
  'public.claim_customer_ai_job(uuid,integer)','public.resolve_customer_ai_dispatch(uuid,uuid,text)',
  'public.customer_ai_dispatch_authorized(jsonb)','public.cancel_customer_ai_job(uuid,uuid)','public.hold_customer_ai_job(uuid,uuid)'] loop
  assert has_function_privilege('service_role',signature,'execute');
  assert not has_function_privilege('authenticated',signature,'execute');
  assert not has_function_privilege('anon',signature,'execute');
 end loop;
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_jobs','select');
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_policies','insert');
 assert not has_table_privilege('authenticated','bookworm_credentials.customer_ai_jobs','select');
 policy:='{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}';
 foreach provider in array array['openai','anthropic','google','xai'] loop
  assert bookworm_credentials.valid_customer_ai_policy(provider,policy);
 end loop;
 assert not bookworm_credentials.valid_customer_ai_policy('openrouter',policy);
 assert bookworm_credentials.valid_customer_ai_policy('openrouter',policy||'{"upstream":"synthetic","responseUpstreams":["Synthetic"]}');
 foreach invalid in array array['{}'::jsonb,policy-'model',policy||'{"url":"https://invalid.test"}',policy||'{"maxOutputTokens":0}',
  policy||'{"maxOutputTokens":1.5}',policy||'{"maxOutputTokens":128001}',policy||'{"maxOutputTokens":"1024"}',
  policy||'{"responseModels":[]}',policy||'{"responseModels":[null]}',policy||'{"model":"https://invalid.test/?key=secret"}',
  policy||'{"upstream":"unexpected"}',policy||'{"responseUpstreams":["unexpected"]}'] loop
  assert not bookworm_credentials.valid_customer_ai_policy('openai',invalid),'invalid model policy accepted';
 end loop;
end $$;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare f customer_job_fixture; begin
 select * into strict f from customer_job_fixture;
 perform pg_temp.reject_customer_job('{}','23514'); -- No operator-approved policy.
 perform public.mutate_ai_connection(f.u,'openai',f.connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
end $$;
reset role;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
 'per_request_credits',2,true,clock_timestamp()+interval '1 hour' from customer_job_fixture;
set local role service_role;
do $$ begin perform pg_temp.reject_customer_job('{}','23514'); end $$; -- No paid plan.
reset role;
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic customer plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":1}',true from customer_job_fixture;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from customer_job_fixture;

set local role service_role;
do $$ declare f customer_job_fixture; j public.ai_jobs; replay public.ai_jobs; identity jsonb; bad jsonb; n integer; begin
 select * into strict f from customer_job_fixture;
 perform pg_temp.reject_customer_job('{"consent":false}','22023');
 perform pg_temp.reject_customer_job('{"fee":3}','23514');
 perform pg_temp.reject_customer_job('{"revision":2}','42501');
 perform pg_temp.reject_customer_job(jsonb_build_object('owner',f.other_user),'42501'); -- Workspace owner cannot borrow writer key.
 perform pg_temp.reject_customer_job(jsonb_build_object('book',gen_random_uuid()),'42501');
 perform pg_temp.reject_customer_job(jsonb_build_object('request',f.request||'{"apiKey":"synthetic-not-a-key"}'),'22023');
 perform pg_temp.reject_customer_job(jsonb_build_object('sources',jsonb_build_array(f.sources->0,f.sources->0)),'22023');
 perform pg_temp.reject_customer_job(jsonb_build_object('sources',jsonb_set(f.sources,'{0,version}','2')),'40001');
 perform pg_temp.reject_customer_job('{}','23514'); -- Insufficient platform credits: all writes roll back.
 assert not exists(select 1 from public.ai_jobs where book_id=f.b);
 insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values(f.u,f.ws,'admin_adjustment',10,0);
 identity:=jsonb_build_object('job',gen_random_uuid(),'operation',gen_random_uuid());
 j:=pg_temp.new_customer_job(identity); replay:=pg_temp.new_customer_job(identity);
 assert j.id=replay.id and j.billing_mode='customer_key' and j.status='queued';
 assert j.input_ref ?& array['customerGrantId','requestSha256'] and (select count(*) from jsonb_object_keys(j.input_ref))=2;
 assert (select count(*) from public.credit_ledger where reference_id=j.id)=1;
 assert (select sum(amount) from public.credit_ledger where user_id=f.u)=8;
 assert not exists(select 1 from public.usage_events where user_id=f.u),'customer request consumed managed AI quota';
 perform pg_temp.reject_customer_job(identity||'{"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}','40001');
 perform pg_temp.reject_customer_job('{}','23514'); -- Monthly capacity remains reserved.
 begin
  perform public.deduct_job_credits(f.u,f.ws,f.org,'ai_credits',1,j.id); assert false,'legacy debit accepted';
 exception when check_violation then null; end;
 begin
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
   values(f.u,f.ws,'generation_reservation',-2,0,'customer_ai_platform_fee',j.id); assert false,'duplicate hold accepted';
 exception when check_violation then null; end;
 begin
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
   values(f.u,f.ws,'generation_release',2,0,'customer_ai_platform_fee',j.id); assert false,'unapproved refund accepted';
 exception when check_violation then null; end;
 begin
  update public.ai_jobs set billing_mode='operational' where id=j.id; assert false,'billing mode mutated';
 exception when check_violation then null; end;
 begin
  update public.ai_jobs set status='succeeded' where id=j.id; assert false,'receiptless success accepted';
 exception when check_violation then null; end;
 begin
  insert into public.ai_jobs(workspace_id,book_id,created_by,agent_type,model,billing_mode,idempotency_key)
   values(f.ws,f.b,f.u,'writer','synthetic-1','customer_key','fake-customer-authority'); assert false,'bare customer job accepted';
 exception when check_violation then null; end;
 -- The existing operational queue must never pick up a customer's credential job.
 replay:=public.claim_ai_review_job(); assert replay.id is distinct from j.id;
 begin perform public.cancel_customer_ai_job(j.id,f.other_user); assert false,'foreign cancellation accepted'; exception when no_data_found then null; end;
 replay:=public.cancel_customer_ai_job(j.id,f.u); assert replay.status='cancelled';
 replay:=public.cancel_customer_ai_job(j.id,f.u); assert replay.status='cancelled';
 assert (select count(*) from public.credit_ledger where reference_id=j.id)=2,'replay refunded twice';
 assert (select sum(amount) from public.credit_ledger where user_id=f.u)=10;
 j:=pg_temp.new_customer_job(); j:=public.claim_customer_ai_job(j.id,180);
 begin perform public.resolve_customer_ai_dispatch(j.id,gen_random_uuid(),repeat('b',64)); assert false,'wrong lease resolved key'; exception when serialization_failure then null; end;
 begin perform public.claim_customer_ai_job(j.id); assert false,'active lease reclaimed'; exception when serialization_failure then null; end;
 replay:=j;
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j.id;
 j:=public.claim_customer_ai_job(j.id);
 assert j.lease_token<>replay.lease_token and j.attempts=2;
 begin perform public.resolve_customer_ai_dispatch(j.id,replay.lease_token,repeat('b',64)); assert false,'stale lease resolved key'; exception when serialization_failure then null; end;
 perform public.cancel_customer_ai_job(j.id,f.u); -- Pre-dispatch claim may still cancel safely.
end $$;
reset role;

-- Plan, account and policy changes are rechecked, without inheriting a new key.
do $$ declare f customer_job_fixture; j public.ai_jobs; code text; value text; begin
 select * into strict f from customer_job_fixture;
 foreach value in array array['trialing','past_due','canceled'] loop
  update public.subscriptions set status=value where id=f.subscription;
  perform pg_temp.reject_customer_job('{}','23514');
 end loop;
 update public.subscriptions set status='active',current_period_end=clock_timestamp()-interval '1 second' where id=f.subscription;
 perform pg_temp.reject_customer_job('{}','23514');
 update public.subscriptions set current_period_end=clock_timestamp()+interval '1 day' where id=f.subscription;
 update public.plans set price_cents=0 where id=f.plan; perform pg_temp.reject_customer_job('{}','23514');
 update public.plans set price_cents=1000,is_active=false where id=f.plan; perform pg_temp.reject_customer_job('{}','23514');
 update public.plans set is_active=true where id=f.plan;
 -- A newer canceled subscription cannot fall back to an older active one.
 insert into public.subscriptions(organization_id,plan_id,status,created_at) values(f.org,f.plan,'canceled',clock_timestamp()+interval '1 second');
 perform pg_temp.reject_customer_job('{}','23514');
 delete from public.subscriptions where organization_id=f.org and id<>f.subscription;
 update bookworm_credentials.customer_ai_policies set enabled=false where id=f.policy;
 perform pg_temp.reject_customer_job('{}','23514');
 update bookworm_credentials.customer_ai_policies set enabled=true where id=f.policy;
 begin update bookworm_credentials.customer_ai_policies set fee_credits=3 where id=f.policy; assert false,'fee changed in place'; exception when check_violation then null; end;
 update public.workspace_members set role='viewer' where workspace_id=f.ws and user_id=f.u;
 perform pg_temp.reject_customer_job('{}','42501');
 update public.workspace_members set role='writer',status='suspended' where workspace_id=f.ws and user_id=f.u;
 perform pg_temp.reject_customer_job('{}','42501');
 update public.workspace_members set status='active' where workspace_id=f.ws and user_id=f.u;
 j:=pg_temp.new_customer_job();
 perform public.mutate_ai_connection(f.u,'openai',f.connection,1,gen_random_uuid(),'save','next','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('aa',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 begin perform public.claim_customer_ai_job(j.id); assert false,'rotated key silently inherited'; exception when insufficient_privilege then null; end;
 perform public.cancel_customer_ai_job(j.id,f.u);
 perform pg_temp.reject_customer_job('{}','42501');
 j:=pg_temp.new_customer_job('{"revision":2}'); j:=public.claim_customer_ai_job(j.id);
 update public.chapters set current_document_version_id=null where id=f.c;
 begin perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64)); assert false,'stale source dispatched'; exception when serialization_failure then null; end;
 update public.chapters set current_document_version_id=f.v where id=f.c;
 perform public.cancel_customer_ai_job(j.id,f.u);
end $$;

-- Platform-plan mode has no per-generation debit, but still needs a paid plan
-- and finite monthly capacity. This is a test policy only, not the product choice.
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select gen_random_uuid(),provider,agent_type,model_policy,'platform_plan',0,true,expires_at from bookworm_credentials.customer_ai_policies;
update customer_job_fixture set policy=(select id from bookworm_credentials.customer_ai_policies where fee_mode='platform_plan');
set local role service_role;
do $$ declare f customer_job_fixture; j public.ai_jobs; envelope jsonb; scope jsonb; n integer; begin
 select * into strict f from customer_job_fixture;
 j:=pg_temp.new_customer_job('{"revision":2,"fee":0}');
 assert not exists(select 1 from public.credit_ledger where reference_id=j.id),'platform mode charged generation credits';
 begin perform public.deduct_job_credits(f.u,f.ws,f.org,'ai_credits',1,j.id); assert false,'zero-fee mode charged legacy credits'; exception when check_violation then null; end;
 j:=public.claim_customer_ai_job(j.id);
 envelope:=public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64)); scope:=envelope->'scope';
 assert scope->>'ownerId'=f.u::text and scope->>'connectionId'=f.connection::text and (scope->>'credentialRevision')::integer=2;
 assert (envelope->'credential') ?& array['keyId','nonce','ciphertext','tag'];
 assert not (envelope->'credential') ? 'apiKey' and not (envelope->'credential') ? 'secret';
 assert public.customer_ai_dispatch_authorized(scope);
 assert not public.customer_ai_dispatch_authorized(scope||jsonb_build_object('ownerId',f.other_user));
 assert not public.customer_ai_dispatch_authorized(scope||'{"credentialRevision":1}');
 assert not public.customer_ai_dispatch_authorized(scope||'{"unexpected":true}');
 assert not public.customer_ai_dispatch_authorized('{"jobId":"bad"}');
 begin perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64)); assert false,'secret was resolved twice'; exception when serialization_failure then null; end;
 begin perform public.cancel_customer_ai_job(j.id,f.u); assert false,'dispatched job refunded'; exception when serialization_failure then null; end;
 begin perform public.fail_ai_review_job(j.id,j.lease_token,'test','Synthetic',true); assert false,'legacy retry requeued customer dispatch'; exception when check_violation then null; end;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,2,gen_random_uuid(),'revoke');
 assert not public.customer_ai_dispatch_authorized(scope),'revoked credential still authorized';
 begin perform public.hold_customer_ai_job(j.id,gen_random_uuid()); assert false,'foreign lease marked review'; exception when serialization_failure then null; end;
 j:=public.hold_customer_ai_job(j.id,j.lease_token); assert j.status='failed' and j.error_code='customer_provider_outcome_unknown';
 j:=public.hold_customer_ai_job(j.id,(scope->>'leaseToken')::uuid); assert j.status='failed';
 assert not public.customer_ai_dispatch_authorized(scope),'held outcome allowed redispatch';
 assert not exists(select 1 from public.credit_ledger where reference_id=j.id);
 assert not exists(select 1 from public.ai_runs where ai_job_id=j.id),'unknown provider cost recorded as zero';
end $$;
reset role;
-- Recheck authorization after dispatch, and retain a charged fee on ambiguity.
do $$ declare f customer_job_fixture; j public.ai_jobs; scope jsonb; key_revision integer; p uuid; connection uuid; provider text; policy jsonb; begin
 select * into strict f from customer_job_fixture;
 update public.plans set entitlements_json='{"customer_ai_enabled":true,"customer_ai_requests_monthly":20}' where id=f.plan;
 select id into p from bookworm_credentials.customer_ai_policies where fee_mode='per_request_credits';
 perform public.mutate_ai_connection(f.u,'openai',f.connection,3,gen_random_uuid(),'save','last','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('aa',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 j:=pg_temp.new_customer_job(jsonb_build_object('revision',4,'policy',p,'fee',2)); j:=public.claim_customer_ai_job(j.id);
 scope:=public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('c',64))->'scope';
 assert public.customer_ai_dispatch_authorized(scope);
 update bookworm_credentials.customer_ai_policies set enabled=false where id=p;
 assert not public.customer_ai_dispatch_authorized(scope),'disabled policy authorized dispatch';
 update bookworm_credentials.customer_ai_policies set enabled=true where id=p;
 update public.subscriptions set status='past_due' where id=f.subscription;
 assert not public.customer_ai_dispatch_authorized(scope),'unpaid plan authorized dispatch';
 update public.subscriptions set status='active' where id=f.subscription;
 update public.workspace_members set status='suspended' where workspace_id=f.ws and user_id=f.u;
 assert not public.customer_ai_dispatch_authorized(scope),'suspended member authorized dispatch';
 update public.workspace_members set status='active' where workspace_id=f.ws and user_id=f.u;
 assert not public.customer_ai_dispatch_authorized(jsonb_set(scope,'{policy,maxOutputTokens}','2048')),'larger output limit accepted';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j.id;
 assert not public.customer_ai_dispatch_authorized(scope),'expired dispatch lease accepted';
 begin perform public.claim_customer_ai_job(j.id); assert false,'expired dispatched job reclaimed'; exception when serialization_failure then null; end;
 perform public.hold_customer_ai_job(j.id,j.lease_token);
 assert (select sum(amount) from public.credit_ledger where user_id=f.u)=8,'ambiguous charged fee was returned';
 begin perform public.cancel_customer_ai_job(j.id,f.u); assert false,'review hold was refunded'; exception when serialization_failure then null; end;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,4,gen_random_uuid(),'revoke');
 -- Provider identity is explicit, not a model prefix or another connection.
 foreach provider in array array['anthropic','google','openrouter','xai'] loop
  p:=gen_random_uuid(); connection:=gen_random_uuid();
  policy:='{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}';
  if provider='openrouter' then policy:=policy||'{"upstream":"synthetic","responseUpstreams":["Synthetic"]}'; end if;
  insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
   values(p,provider,'copyeditor',policy,'platform_plan',0,true,clock_timestamp()+interval '1 hour');
  perform public.mutate_ai_connection(f.u,provider,connection,null,gen_random_uuid(),'save','test','synthetic',
   encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('aa',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
  perform pg_temp.reject_customer_job(jsonb_build_object('revision',5,'policy',p,'fee',0),'42501');
  j:=pg_temp.new_customer_job(jsonb_build_object('connection',connection,'revision',1,'policy',p,'fee',0));
  assert j.agent_type='copyeditor';
  perform public.cancel_customer_ai_job(j.id,f.u);
 end loop;
end $$;
do $$ declare f customer_job_fixture; begin
 select * into strict f from customer_job_fixture;
 assert not exists(select 1 from bookworm_credentials.ai_connection_secrets where connection_id=f.connection),'revocation retained encrypted key';
 assert exists(select 1 from bookworm_credentials.customer_ai_jobs where owner_id=f.u and state='review' and dispatched_at is not null);
 assert (select content_json#>>'{nodes,0,text}' from public.document_versions where id=f.v)='Rain fell.','request mutated manuscript';
end $$;
set local role authenticated;
do $$ begin
 begin perform pg_temp.new_customer_job(); assert false,'browser called private job RPC'; exception when insufficient_privilege then null; end;
 begin perform * from bookworm_credentials.customer_ai_jobs; assert false,'browser read snapshots'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
