-- Disposable synthetic data only. All changes roll back.
begin;
create temp table ready_account(u uuid,org uuid,ws uuid,connection uuid,policy uuid,plan uuid,subscription uuid) on commit drop;
create temp table ready_books(i integer,b uuid,c uuid,v uuid,j uuid) on commit drop;
grant select on ready_account,ready_books to service_role;
insert into ready_account select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid();
insert into ready_books select i,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid() from generate_series(1,3) i;
insert into auth.users(id,email) select u,'ready-discovery@local.test' from ready_account;
insert into public.organizations(id,name,slug,owner_user_id) select org,'Discovery',org::text,u from ready_account;
insert into public.workspaces(id,organization_id,name,slug,created_by) select ws,org,'Discovery',ws::text,u from ready_account;
insert into public.workspace_members(workspace_id,user_id,role) select ws,u,'writer'::public.member_role from ready_account;
insert into public.books(id,workspace_id,title,author_name,created_by) select x.b,f.ws,'Synthetic','Author',f.u from ready_books x cross join ready_account f;
insert into public.chapters(id,book_id,order_index,title) select c,b,0,'Chapter' from ready_books;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by)
 select x.v,x.c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain."}]}','Rain.',f.u from ready_books x cross join ready_account f;
update public.chapters c set current_document_version_id=x.v from ready_books x where c.id=x.c;
insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active)
 select plan,'Synthetic paid plan','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":20}',true from ready_account;
insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end)
 select subscription,org,plan,'active',clock_timestamp()+interval '1 day' from ready_account;
insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at)
 select policy,'openai','writer','{"model":"synthetic-1","responseModels":["synthetic-1"],"maxOutputTokens":1024,"upstream":null,"responseUpstreams":[]}',
  'platform_plan',0,true,clock_timestamp()+interval '1 hour' from ready_account;
do $$ begin
 assert has_function_privilege('service_role','public.discover_customer_ai_ready_jobs(integer,timestamptz,uuid)','execute');
 assert not has_function_privilege('authenticated','public.discover_customer_ai_ready_jobs(integer,timestamptz,uuid)','execute');
 assert not has_function_privilege('anon','public.discover_customer_ai_ready_jobs(integer,timestamptz,uuid)','execute');
end $$;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare f ready_account; x ready_books; req jsonb; sources jsonb; begin
 select * into strict f from ready_account;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,null,gen_random_uuid(),'save','test','synthetic',
  encode(decode(repeat('ab',12),'hex'),'base64'),encode(decode(repeat('cd',32),'hex'),'base64'),encode(decode(repeat('ef',16),'hex'),'base64'));
 for x in select * from ready_books order by i loop
  req:=jsonb_build_object('input',jsonb_build_object('chapterIds',jsonb_build_array(x.c),
   'chapters',jsonb_build_object(x.c::text,jsonb_build_object('id',x.c,'version',1,'documentVersionId',x.v,
    'nodes',jsonb_build_array(jsonb_build_object('id','n1','type','paragraph','text','Rain.')))),
   'book',jsonb_build_object('title','Synthetic')));
  sources:=jsonb_build_array(jsonb_build_object('chapterId',x.c,'documentVersionId',x.v,'version',1));
  perform public.create_customer_ai_job(x.j,gen_random_uuid(),f.u,f.ws,x.b,f.connection,1,f.policy,repeat('a',64),req,sources,0,true);
 end loop;
end $$;
do $$ declare first_row record; second_row record; n integer; begin
 select count(*) into n from public.discover_customer_ai_ready_jobs(100); assert n=3;
 select * into strict first_row from public.discover_customer_ai_ready_jobs(1);
 select * into strict second_row from public.discover_customer_ai_ready_jobs(1,first_row.created_at,first_row.job_id);
 assert first_row.job_id<>second_row.job_id,'cursor repeated a job';
 select count(*) into n from public.discover_customer_ai_ready_jobs(100,second_row.created_at,second_row.job_id); assert n=1;
 begin perform public.discover_customer_ai_ready_jobs(0); assert false,'zero limit accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.discover_customer_ai_ready_jobs(101); assert false,'oversized limit accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.discover_customer_ai_ready_jobs(1,clock_timestamp(),null); assert false,'partial cursor accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.discover_customer_ai_ready_jobs(1,'infinity'::timestamptz,gen_random_uuid()); assert false,'infinite cursor accepted'; exception when invalid_parameter_value then null; end;
end $$;
set local request.jwt.claims='{"role":"authenticated"}';
do $$ begin
 begin perform public.discover_customer_ai_ready_jobs(); assert false,'non-service JWT accepted'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims='{"role":"service_role"}';
reset role;
-- Discovery filters stale and revoked access before pagination, and claim
-- rechecks the same permissions when the worker actually takes a lease.
update public.chapters set current_document_version_id=null where id in (select c from ready_books where i in (1,2));
set local role service_role;
do $$ declare a record; b record; c record; begin
 assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=1;
 select * into strict a from public.discover_customer_ai_ready_jobs(1);
 assert a.job_id=(select j from ready_books where i=1) and not a.ready,'first ineligible candidate was skipped';
 select * into strict b from public.discover_customer_ai_ready_jobs(1,a.created_at,a.job_id);
 assert b.job_id=(select j from ready_books where i=2) and not b.ready,'second ineligible candidate was skipped';
 select * into strict c from public.discover_customer_ai_ready_jobs(1,b.created_at,b.job_id);
 assert c.ready and c.job_id=(select j from ready_books where i=3),'ineligible pages starved next candidate';
end $$;
reset role;
update public.chapters c set current_document_version_id=x.v from ready_books x where x.i in (1,2) and c.id=x.c;
update public.subscriptions set status='canceled' where id=(select subscription from ready_account);
set local role service_role;
do $$ begin assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=0; end $$;
reset role;
update public.subscriptions set status='active' where id=(select subscription from ready_account);
update public.workspace_members set status='suspended' where workspace_id=(select ws from ready_account);
set local role service_role;
do $$ begin assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=0; end $$;
reset role;
update public.workspace_members set status='active' where workspace_id=(select ws from ready_account);
update bookworm_credentials.customer_ai_policies set enabled=false where id=(select policy from ready_account);
set local role service_role;
do $$ begin assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=0; end $$;
reset role;
update bookworm_credentials.customer_ai_policies set enabled=true where id=(select policy from ready_account);
set local role service_role;
do $$ declare x ready_books; j public.ai_jobs; begin
 select * into strict x from ready_books where i=1;
 j:=public.claim_customer_ai_job(x.j,180);
 assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=2,'active lease marked ready';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j.id;
 assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=3,'undispatched expired lease excluded';
 j:=public.claim_customer_ai_job(x.j,180);
 perform public.resolve_customer_ai_dispatch(j.id,j.lease_token,repeat('b',64));
end $$;
update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=(select j from ready_books where i=1);
do $$ begin assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=2,'dispatched lease returned'; end $$;
do $$ declare f ready_account; begin
 select * into strict f from ready_account;
 perform public.mutate_ai_connection(f.u,'openai',f.connection,1,gen_random_uuid(),'revoke');
 assert (select count(*) from public.discover_customer_ai_ready_jobs(100) where ready)=0,'revoked credential marked ready';
end $$;
reset role;
rollback;
