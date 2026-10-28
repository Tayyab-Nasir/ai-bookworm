begin;
do $$
#variable_conflict use_variable
declare u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 chapter uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); connection uuid:=gen_random_uuid();
 policy uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid(); attempt uuid:=gen_random_uuid(); review_attempt uuid:=gen_random_uuid();
 req jsonb; sources jsonb; before_result jsonb; after_result jsonb; plan_line text; uses_index boolean:=false;
begin
 assert has_function_privilege('service_role','public.read_customer_ai_maintenance(uuid)','execute');
 assert not has_function_privilege('anon','public.read_customer_ai_maintenance(uuid)','execute');
 assert not has_function_privilege('authenticated','public.read_customer_ai_maintenance(uuid)','execute');
 assert not has_table_privilege('service_role','bookworm_credentials.customer_ai_maintenance_attempts','select');
 assert (select indexdef like '%WHERE (state = ANY%' from pg_indexes
  where schemaname='bookworm_credentials' and indexname='customer_ai_maintenance_outstanding_list');
 insert into auth.users(id,email) values(u,u::text||'@local.test');
 insert into public.organizations(id,name,slug,owner_user_id) values(org,'Lookup test',org::text,u);
 insert into public.workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Lookup test',ws::text,u);
 insert into public.workspace_members(workspace_id,user_id,role) values(ws,u,'writer');
 insert into public.books(id,workspace_id,title,author_name,created_by) values(b,ws,'Synthetic','Author',u);
 insert into public.chapters(id,book_id,order_index,title) values(chapter,b,0,'Chapter');
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
  values(version_id,chapter,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain."}]}','Rain.',u);
 update public.chapters set current_document_version_id=version_id where id=chapter;
 insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
  values(plan,'Lookup plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":100}',true);
 insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
  values(gen_random_uuid(),org,plan,'active',clock_timestamp()+interval '1 day');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform public.mutate_ai_connection(u,'openai',connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
  values(policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
   'platform_plan',0,true,clock_timestamp()+interval '1 hour');
 req:=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(chapter),
  'chapters',jsonb_build_object(chapter::text,jsonb_build_object('id',chapter,'version',1,'documentVersionId',version_id,
   'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain.')))),
  'book',jsonb_build_object('title','Synthetic')));
 sources:=jsonb_build_array(jsonb_build_object('chapterId',chapter,'documentVersionId',version_id,'version',1));
 perform public.create_customer_ai_job(job_id,gen_random_uuid(),u,ws,b,connection,1,policy,repeat('a',64),req,sources,0,true);
 before_result:=public.begin_customer_ai_maintenance(attempt,job_id,'reconcile');
 assert public.read_customer_ai_maintenance(attempt)=before_result;
 assert (select count(*) from public.list_customer_ai_maintenance_attempts() where attempt_id=attempt)=1;
 after_result:=public.execute_customer_ai_maintenance(attempt);
 assert after_result->>'state'='completed' and after_result->>'result'='unchanged';
 assert public.read_customer_ai_maintenance(attempt)=after_result;
 assert public.begin_customer_ai_maintenance(attempt,job_id,'reconcile')=after_result;
 assert (select count(*) from public.list_customer_ai_maintenance_attempts() where attempt_id=attempt)=0;
 perform public.begin_customer_ai_maintenance(review_attempt,job_id,'recover_receipt');
 after_result:=public.execute_customer_ai_maintenance(review_attempt);
 assert after_result->>'state'='needs_review' and after_result->>'result' is null;
 assert public.read_customer_ai_maintenance(review_attempt)=after_result;
 assert (select count(*) from public.list_customer_ai_maintenance_attempts() where attempt_id=review_attempt)=1;
 assert not (after_result ?| array['ownerId','receipt','fingerprint','request','error']);
 begin perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  perform public.read_customer_ai_maintenance(attempt); assert false,'untrusted JWT accepted';
  exception when insufficient_privilege then null; end;
 begin perform public.read_customer_ai_maintenance(null); assert false,'null accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.read_customer_ai_maintenance(gen_random_uuid()); assert false,'unknown attempt accepted'; exception when no_data_found then null; end;
 perform set_config('enable_seqscan','off',true);
 for plan_line in execute 'explain select attempt_id,job_id,action,state,result,created_at from bookworm_credentials.customer_ai_maintenance_attempts where state in (''pending'',''needs_review'') order by created_at,attempt_id limit 20' loop
  if position('customer_ai_maintenance_outstanding_list' in plan_line)>0 then uses_index:=true; end if;
 end loop;
 assert uses_index,'outstanding cursor did not use partial index';
end $$;
rollback;
