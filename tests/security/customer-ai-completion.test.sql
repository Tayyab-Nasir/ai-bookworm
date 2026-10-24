-- Synthetic receipt-only acceptance. All fixtures roll back; no provider I/O.
begin;
create temp table customer_completion_fixture(u uuid,other_user uuid,org uuid,ws uuid,b uuid,c uuid,v uuid,plan uuid,subscription uuid,request jsonb,sources jsonb) on commit drop;
insert into customer_completion_fixture(u,other_user,org,ws,b,c,v,plan,subscription)
 values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid());
insert into auth.users(id,email) select u,'customer-completion@local.test' from customer_completion_fixture
 union all select other_user,'other-completion@local.test' from customer_completion_fixture;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Receipt tests',org::text,u from customer_completion_fixture;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Receipt tests',ws::text,u from customer_completion_fixture;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer' from customer_completion_fixture;
insert into public.books(id,workspace_id,title,author_name,created_by) select b,ws,'Synthetic book','Test author',u from customer_completion_fixture;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Original chapter' from customer_completion_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select v,c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain 🌧 fell."}]}','Rain 🌧 fell.',u from customer_completion_fixture;
update public.chapters set current_document_version_id=f.v from customer_completion_fixture f where id=f.c;
update customer_completion_fixture set request=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(c),
 'chapters',jsonb_build_object(c::text,jsonb_build_object('id',c,'version',1,'documentVersionId',v,
 'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain 🌧 fell.')))),
 'book',jsonb_build_object('title','Synthetic book'))),
 sources=jsonb_build_array(jsonb_build_object('chapterId',c,'documentVersionId',v,'version',1));
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic receipt plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true from customer_completion_fixture;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from customer_completion_fixture;
insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
 select u,ws,'admin_adjustment',1000,0 from customer_completion_fixture;
set local request.jwt.claims='{"role":"service_role"}';

create function pg_temp.customer_receipt_job(provider text default 'openai',agent text default 'writer',request_change jsonb default null)
returns public.ai_jobs language plpgsql as $$
declare f customer_completion_fixture; connection uuid; previous integer; policy uuid:=gen_random_uuid(); j public.ai_jobs; model_policy jsonb;
begin
 select * into strict f from customer_completion_fixture;
 select ac.id,ac.revision into connection,previous from public.ai_connections ac where ac.owner_id=f.u and ac.provider=$1;
 connection:=coalesce(connection,gen_random_uuid());
 if previous is null then
  perform public.mutate_ai_connection(f.u,provider,connection,null,gen_random_uuid(),'save','test','synthetic',
   encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
  previous:=1;
 end if;
 model_policy:='{"model":"synthetic-1","responseModels":["synthetic-snapshot"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}';
 if provider='openrouter' then model_policy:=model_policy||'{"upstream":"synthetic","responseUpstreams":["Synthetic"]}'; end if;
 insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
  values(policy,provider,agent,model_policy,'per_request_credits',2,true,clock_timestamp()+interval '1 hour');
 select * into j from public.create_customer_ai_job(gen_random_uuid(),gen_random_uuid(),f.u,f.ws,f.b,connection,previous,policy,
  repeat('a',64),coalesce(request_change,f.request),f.sources,2,true);
 select * into j from public.claim_customer_ai_job(j.id,180);
 perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));
 return j;
end $$;

create function pg_temp.customer_receipt(j public.ai_jobs,provider text default 'openai') returns jsonb language plpgsql as $$
declare f customer_completion_fixture; evidence jsonb; suggestion jsonb; ref jsonb;
begin
 select * into strict f from customer_completion_fixture;
 evidence:=case provider
  when 'anthropic' then '{"input_tokens":7,"output_tokens":4,"cache_creation_input_tokens":2,"cache_read_input_tokens":1}'::jsonb
  when 'google' then '{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":1,"totalTokenCount":14}'::jsonb
  when 'openrouter' then '{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}'::jsonb
  else '{"input_tokens":10,"output_tokens":4,"total_tokens":14}'::jsonb end;
 ref:=jsonb_build_object('chapterId',f.c,'documentVersionId',f.v,'nodeId','n1','textHash',encode(sha256(convert_to('Rain 🌧 fell.','UTF8')),'hex'));
 if j.agent_type='metadata' then
  suggestion:=jsonb_build_object('suggestionKind','metadata_candidate','status','pending','confidence',0.9,
   'description','A synthetic story about a rainy day and a memorable journey.',
   'keywords',jsonb_build_array('rain'),'categories',jsonb_build_array('Fiction'),'audience','Adult readers',
   'rationale','Supported by the supplied chapter.','sourceRefs',jsonb_build_array(ref));
 elsif j.agent_type='bookbible' then
  suggestion:=jsonb_build_object('suggestionKind','book_bible_candidate','status','pending','confidence',0.9,
   'type','event','name','Rain','description','Rain falls.','attributes','{}'::jsonb,'sourceRefs',jsonb_build_array(ref));
 else
  suggestion:=jsonb_build_object('id',gen_random_uuid(),'chapterId',f.c,'nodeId','n1','confidence',0.9,'rationale','Improve the opening.',
   'operation',jsonb_build_object('operationId','untrusted-provider-id','type','replace_text','source','human','sourceRef','not-authority','expectedVersion',999,
    'target',jsonb_build_object('chapterId',f.c,'nodeId','n1'),'payload',jsonb_build_object('nodeId','n1','from',0,'to',4,'text','Snow')));
 end if;
 return jsonb_build_object('jobId',j.id,'workspaceId',j.workspace_id,'bookId',j.book_id,'agentType',j.agent_type,
  'provider',provider,'model','synthetic-snapshot','status','succeeded','responseId','synthetic-response','requestId','synthetic-request',
  'customerDispatchSha256',repeat('b',64),'diagnostics','[]'::jsonb,'suggestions',jsonb_build_array(suggestion),
  'usage',jsonb_build_object('inputTokens',10,'outputTokens',4,'estimatedCostUsd',null,'providerTokenUsage',evidence));
end $$;

create function pg_temp.reject_customer_completion(j public.ai_jobs,bad jsonb,fingerprint text default repeat('b',64)) returns void language plpgsql as $$
declare u uuid;
begin
 select f.u into u from customer_completion_fixture f;
 begin
  insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(j.id,fingerprint,bad);
  perform public.complete_customer_ai_job(j.id,u,repeat('b',64));
 exception when check_violation or invalid_parameter_value then
  assert not exists(select 1 from public.ai_runs where ai_job_id=j.id);
  assert not exists(select 1 from public.ai_suggestions where ai_job_id=j.id);
  assert not exists(select 1 from public.usage_events where ai_job_id=j.id);
  assert not exists(select 1 from public.ai_review_service_receipts where job_id=j.id),'failed probe must roll back its receipt';
  return;
 end;
 assert false,'Invalid receipt completed a customer job';
end $$;

do $$ declare signature text; begin
 assert has_function_privilege('service_role','public.complete_customer_ai_job(uuid,uuid,text)','execute');
 assert not has_function_privilege('authenticated','public.complete_customer_ai_job(uuid,uuid,text)','execute');
 assert not has_function_privilege('anon','public.complete_customer_ai_job(uuid,uuid,text)','execute');
 assert not has_table_privilege('service_role','public.ai_review_service_receipts','delete');
 assert not has_table_privilege('service_role','public.ai_review_service_receipts','truncate');
 assert has_table_privilege('service_role','public.ai_review_service_receipts','insert');
 assert has_table_privilege('service_role','public.ai_review_service_receipts','update');
 foreach signature in array array['bookworm_credentials.customer_receipt_assert(boolean)',
  'bookworm_credentials.customer_receipt_count(jsonb)','bookworm_credentials.customer_receipt_usage(text,jsonb)',
  'bookworm_credentials.customer_receipt_node(bookworm_credentials.customer_ai_jobs,text,text)',
  'bookworm_credentials.customer_receipt_refs(bookworm_credentials.customer_ai_jobs,jsonb)',
  'bookworm_credentials.customer_utf16_boundary(text,integer)',
  'bookworm_credentials.customer_receipt_candidate(bookworm_credentials.customer_ai_jobs,jsonb)'] loop
  assert not has_function_privilege('service_role',signature,'execute');
  assert not has_function_privilege('authenticated',signature,'execute');
  assert not has_function_privilege('anon',signature,'execute');
 end loop;
 assert not bookworm_credentials.customer_utf16_boundary('Rain 🌧 fell.',6),'must not split the surrogate pair';
 assert bookworm_credentials.customer_utf16_boundary('Rain 🌧 fell.',7);
end $$;

do $$ declare f customer_completion_fixture; j public.ai_jobs; done public.ai_jobs; raw jsonb; bad jsonb;
 provider text; agent text; op jsonb; before_version jsonb; before_metadata jsonb;
begin
 select * into strict f from customer_completion_fixture;
 select content_json into before_version from public.document_versions where id=f.v;
 select to_jsonb(b) into before_metadata from public.books b where id=f.b;
 -- Every supported provider and every supported text agent reaches the real
 -- SQL completion shape without paid I/O, fee duplication or manuscript writes.
 foreach provider in array array['openai','anthropic','google','openrouter','xai'] loop
  foreach agent in array array['writer','proofreader','copyeditor','consistency','metadata','bookbible'] loop
   j:=pg_temp.customer_receipt_job(provider,agent); raw:=pg_temp.customer_receipt(j,provider);
   if provider='openai' and agent='writer' then
    begin
     perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
     perform public.complete_customer_ai_job(j.id,f.u,repeat('b',64)); assert false;
    exception when insufficient_privilege then null; end;
    assert current_setting('request.jwt.claims')='{"role":"service_role"}';
    foreach bad in array array[null::jsonb,'{}'::jsonb,raw-'usage',raw-'responseId',raw||'{"status":"failed"}',
     raw||'{"provider":"anthropic"}',raw||'{"model":"not-approved"}',raw||'{"apiKey":"forbidden-extra-field"}',
     raw||jsonb_build_object('jobId',gen_random_uuid()),raw||jsonb_build_object('bookId',gen_random_uuid()),
     raw||jsonb_build_object('workspaceId',gen_random_uuid()),raw||'{"agentType":"metadata"}',
     raw||jsonb_build_object('customerDispatchSha256',repeat('d',64)),jsonb_set(raw,'{usage,estimatedCostUsd}','0'),
     jsonb_set(raw,'{usage,inputTokens}','null'),jsonb_set(raw,'{usage,providerTokenUsage,total_tokens}','15'),
     jsonb_set(raw,'{usage,providerTokenUsage,unexpected_cost}','1'),jsonb_set(raw,'{usage,outputTokens}','2147483648'),
     jsonb_set(raw,'{usage,inputTokens}','1.5'),jsonb_set(raw,'{usage,inputTokens}','"10"'),
     jsonb_set(raw,'{suggestions,0,chapterId}',to_jsonb(gen_random_uuid())),
     jsonb_set(raw,'{suggestions,0,operation,target,nodeId}','"other"'),
     jsonb_set(raw,'{suggestions,0,operation,payload,to}','100'),jsonb_set(raw,'{suggestions,0,operation,payload,to}','6'),
     jsonb_set(raw,'{suggestions,0,operation,payload,from}','-1'),jsonb_set(raw,'{suggestions,0,operation,type}','"delete_node"'),
     jsonb_set(raw,'{suggestions,0,confidence}','1.1'),raw||'{"diagnostics":[null]}'] loop
     perform pg_temp.reject_customer_completion(j,bad);
    end loop;
    perform pg_temp.reject_customer_completion(j,raw,repeat('e',64));
   end if;
   if agent in ('metadata','bookbible') then
    perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,sourceRefs,0,textHash}',to_jsonb(repeat('e',64))));
    perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,sourceRefs,0,documentVersionId}',to_jsonb(gen_random_uuid())));
    perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,sourceRefs}','[]'));
    perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,status}','"accepted"'));
    if agent='metadata' then
     perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,keywords}','["same","SAME"]'));
     perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,description}','"too short"'));
    else
     perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,attributes}','{"imageAssetIds":[]}'));
     perform pg_temp.reject_customer_completion(j,jsonb_set(raw,'{suggestions,0,type}','"unknown"'));
    end if;
   end if;
   insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(j.id,repeat('b',64),raw);
   -- Recovery of an already-produced result does not require a fresh lease.
   if agent='writer' then perform public.hold_customer_ai_job(j.id,j.lease_token); end if;
   done:=public.complete_customer_ai_job(j.id,f.u,repeat('b',64));
   assert done.status='succeeded' and done.model='synthetic-1','canonical request model must remain immutable';
   assert done.usage_json=raw->'usage' and done.output_ref->>'costPayer'='customer';
   assert done.output_ref->>'providerCostStatus'='unknown' and done.output_ref->>'reviewRequired'='true';
   assert (select count(*) from public.ai_runs ar where ar.ai_job_id=j.id and ar.cost_payer='customer' and ar.estimated_cost is null
    and ar.provider=raw->>'provider' and ar.model='synthetic-snapshot' and ar.tokens_in=10 and ar.tokens_out=4)=1;
   assert (select count(*) from public.usage_events where ai_job_id=j.id and meter='customer_ai_request' and quantity=1)=1;
   assert (select count(*) from public.credit_ledger where reference_id=j.id)=1;
   assert (select sum(amount) from public.credit_ledger where reference_id=j.id)=-2;
   if agent in ('metadata','bookbible') then
    assert not exists(select 1 from public.ai_suggestions where ai_job_id=j.id);
    if agent='metadata' then assert done.output_ref->'candidate'=raw#>'{suggestions,0}';
    else assert done.output_ref->'candidates'=raw->'suggestions'; end if;
   else
    assert (select count(*) from public.ai_suggestions where ai_job_id=j.id and status='pending')=1;
    select operation_json into op from public.ai_suggestions where ai_job_id=j.id;
    assert op->>'source'='ai' and op->>'expectedVersion'='1' and op->>'operationId' like 'ai:%';
    assert op->>'sourceRef'<>'not-authority' and op#>>'{payload,text}'='Snow';
   end if;
   assert to_jsonb(public.complete_customer_ai_job(j.id,f.u,repeat('b',64)))=to_jsonb(done),'exact replay returns same result';
   assert (select count(*) from public.ai_runs where ai_job_id=j.id)=1;
   assert (select count(*) from public.usage_events where ai_job_id=j.id)=1;
   assert (select count(*) from public.credit_ledger where reference_id=j.id)=1;
   begin perform public.complete_customer_ai_job(j.id,f.other_user,repeat('b',64)); assert false;
    exception when no_data_found then null; end;
   begin perform public.complete_customer_ai_job(j.id,f.u,repeat('e',64)); assert false;
    exception when check_violation then null; end;
   begin update public.ai_jobs set output_ref='{}' where id=j.id; assert false;
    exception when check_violation then null; end;
   begin update public.ai_runs set estimated_cost=0 where ai_job_id=j.id; assert false;
    exception when check_violation then null; end;
   begin delete from public.ai_review_service_receipts where job_id=j.id; assert false;
    exception when check_violation then null; end;
  end loop;
 end loop;
 assert (select content_json from public.document_versions where id=f.v)=before_version;
 assert (select to_jsonb(b) from public.books b where id=f.b) is not distinct from before_metadata;
 assert not exists(select 1 from public.book_bible_items where book_id=f.b);
 assert (select current_document_version_id from public.chapters where id=f.c)=f.v;
end $$;

-- A snapshot with plausible version pointers but forged manuscript text cannot
-- turn a saved service response into an editor proposal.
do $$ declare f customer_completion_fixture; j public.ai_jobs; bad_request jsonb; begin
 select * into strict f from customer_completion_fixture;
 bad_request:=jsonb_set(f.request,array['input','chapters',f.c::text,'nodes','0','text'],'"Invented source text"');
 j:=pg_temp.customer_receipt_job('openai','writer',bad_request);
 perform pg_temp.reject_customer_completion(j,pg_temp.customer_receipt(j));
 perform public.hold_customer_ai_job(j.id,j.lease_token);
 assert (select count(*) from public.credit_ledger where reference_id=j.id)=1,'unverified output must not refund a possible provider charge';
end $$;

-- Completion must be atomic even when persistence fails after proposals, run
-- evidence and the private settled transition have been attempted.
create function pg_temp.reject_customer_usage() returns trigger language plpgsql as $$
begin
 if new.meter='customer_ai_request' then raise exception 'synthetic persistence failure'; end if;
 return new;
end $$;
create trigger synthetic_customer_usage_failure before insert on public.usage_events for each row execute function pg_temp.reject_customer_usage();
do $$ declare f customer_completion_fixture; j public.ai_jobs; begin
 select * into strict f from customer_completion_fixture;
 j:=pg_temp.customer_receipt_job();
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(j.id,repeat('b',64),pg_temp.customer_receipt(j));
 begin perform public.complete_customer_ai_job(j.id,f.u,repeat('b',64)); assert false;
 exception when raise_exception then
  assert sqlerrm='synthetic persistence failure';
 end;
 assert (select state from bookworm_credentials.customer_ai_jobs where job_id=j.id)='held';
 assert (select status from public.ai_jobs where id=j.id)='running';
 assert not exists(select 1 from public.ai_suggestions where ai_job_id=j.id);
 assert not exists(select 1 from public.ai_runs where ai_job_id=j.id);
 assert (select count(*) from public.credit_ledger where reference_id=j.id)=1;
 perform public.hold_customer_ai_job(j.id,j.lease_token);
end $$;
drop trigger synthetic_customer_usage_failure on public.usage_events;

-- Execute the public security-definer RPC as the real restricted service role,
-- without granting it access to the private authority schema or helpers.
grant select on customer_completion_fixture to service_role;
set local role service_role;
do $$ declare f customer_completion_fixture; j public.ai_jobs; begin
 select * into strict f from customer_completion_fixture;
 select * into strict j from public.ai_jobs where book_id=f.b and status='failed'
  and exists(select 1 from public.ai_review_service_receipts where job_id=ai_jobs.id);
 j:=public.complete_customer_ai_job(j.id,f.u,repeat('b',64));
 assert j.status='succeeded';
end $$;
reset role;

-- A rotated/revoked key, expired plan, disabled policy and newer manuscript do
-- not require another provider call to recover paid evidence from version 1.
do $$ declare f customer_completion_fixture; j public.ai_jobs; raw jsonb; a bookworm_credentials.customer_ai_jobs; version2 uuid:=gen_random_uuid(); begin
 select * into strict f from customer_completion_fixture;
 j:=pg_temp.customer_receipt_job(); raw:=pg_temp.customer_receipt(j);
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=j.id;
 perform public.hold_customer_ai_job(j.id,j.lease_token);
 perform public.mutate_ai_connection(f.u,'openai',a.connection_id,a.credential_revision,gen_random_uuid(),'revoke',null,null,null,null,null);
 update public.subscriptions set current_period_end=clock_timestamp()-interval '1 second' where id=f.subscription;
 update bookworm_credentials.customer_ai_policies set enabled=false where id=a.policy_id;
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
  values(version2,f.c,2,'{"nodes":[{"id":"n1","type":"paragraph","text":"Changed manuscript"}]}','Changed manuscript',f.u);
 update public.chapters set current_document_version_id=version2 where id=f.c;
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(j.id,repeat('b',64),raw);
 j:=public.complete_customer_ai_job(j.id,f.u,repeat('b',64));
 assert j.status='succeeded';
 assert (select operation_json->>'expectedVersion' from public.ai_suggestions where ai_job_id=j.id)='1';
 assert (select current_document_version_id from public.chapters where id=f.c)=version2;
 assert (select count(*) from public.credit_ledger where reference_id=j.id)=1;
end $$;
rollback;
