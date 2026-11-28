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

-- Assign deterministic microsecond/tie boundaries only to synthetic fixtures.
reset role;
set constraints all immediate;
alter table bookworm_credentials.customer_ai_jobs disable trigger customer_ai_authority_immutable;
update bookworm_credentials.customer_ai_jobs a set created_at='2020-01-01 00:00:00+00'::timestamptz +
 case when x.i=3 then interval '1 microsecond' else interval '0 seconds' end
 from ready_books x where x.j=a.job_id;
alter table bookworm_credentials.customer_ai_jobs enable trigger customer_ai_authority_immutable;
do $$ begin
 assert has_function_privilege('service_role','public.discover_customer_ai_reconciliation_candidates(integer,timestamptz,uuid)','execute');
 assert not has_function_privilege('anon','public.discover_customer_ai_reconciliation_candidates(integer,timestamptz,uuid)','execute');
 assert not has_function_privilege('authenticated','public.discover_customer_ai_reconciliation_candidates(integer,timestamptz,uuid)','execute');
end $$;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
update public.ai_jobs set attempts=5 where id=(select j from ready_books where i=3);
do $$ declare a record; b record; c record; count_rows integer; begin
 select * into strict a from public.discover_customer_ai_reconciliation_candidates(1);
 select * into strict b from public.discover_customer_ai_reconciliation_candidates(1,a.created_at,a.job_id);
 select * into strict c from public.discover_customer_ai_reconciliation_candidates(1,b.created_at,b.job_id);
 assert a.action='none' and b.action='none' and c.action='reconcile','ineligible pages starved actionable job';
 assert a.created_at=b.created_at and a.job_id<b.job_id,'UUID tie order lost';
 assert c.created_at=a.created_at+interval '1 microsecond','timestamp precision lost';
 assert c.job_id=(select j from ready_books where i=3);
 select count(*) into count_rows from public.discover_customer_ai_reconciliation_candidates(1,c.created_at,c.job_id);
 assert count_rows=0,'cursor repeated final entry';
 select * into strict c from public.discover_customer_ai_reconciliation_candidates(1,a.created_at,'ffffffff-ffff-ffff-ffff-ffffffffffff');
 assert c.created_at=a.created_at+interval '1 microsecond','microsecond keyset boundary skipped';
 begin perform public.discover_customer_ai_reconciliation_candidates(0); assert false,'zero limit'; exception when invalid_parameter_value then null; end;
 begin perform public.discover_customer_ai_reconciliation_candidates(101); assert false,'oversized limit'; exception when invalid_parameter_value then null; end;
 begin perform public.discover_customer_ai_reconciliation_candidates(1,clock_timestamp(),null); assert false,'partial cursor'; exception when invalid_parameter_value then null; end;
 begin perform public.discover_customer_ai_reconciliation_candidates(1,'infinity'::timestamptz,gen_random_uuid()); assert false,'infinite cursor'; exception when invalid_parameter_value then null; end;
end $$;
set local request.jwt.claims='{"role":"authenticated"}';
do $$ begin
 begin perform public.discover_customer_ai_reconciliation_candidates(); assert false,'non-service JWT accepted'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare jid uuid; j public.ai_jobs; value text; begin
 jid:=(select x.j from ready_books x where i=3);
 assert public.reconcile_customer_ai_job(jid)='released';
 assert not exists(select 1 from public.discover_customer_ai_reconciliation_candidates(100) where job_id=jid),'released job exposed';
 jid:=(select x.j from ready_books x where i=2);
 j:=public.claim_customer_ai_job(jid,180);
 select action into strict value from public.discover_customer_ai_reconciliation_candidates(100) where job_id=jid;
 assert value='none','active lease marked actionable';
 perform public.resolve_customer_ai_dispatch(jid,j.lease_token,repeat('b',64));
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=jid;
 select action into strict value from public.discover_customer_ai_reconciliation_candidates(100) where job_id=jid;
 assert value='reconcile','expired dispatched lease omitted';
 assert public.reconcile_customer_ai_job(jid)='requires_review';
 select action into strict value from public.discover_customer_ai_reconciliation_candidates(100) where job_id=jid;
 assert value='review';
 insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(jid,repeat('b',64),'{}');
 select action into strict value from public.discover_customer_ai_reconciliation_candidates(100) where job_id=jid;
 assert value='receipt_available','receipt hint omitted';
 begin
  perform public.complete_customer_ai_job(jid,(select u from ready_account),repeat('b',64));
  assert false,'invalid hinted receipt accepted';
 exception when check_violation then null; end;
 assert not exists(select 1 from public.credit_ledger where reference_id=jid),'dispatched job refunded';
end $$;
reset role;
rollback;
