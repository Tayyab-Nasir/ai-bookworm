begin;

insert into auth.users(id,email) values('b7000000-0000-4000-8000-000000000001','translator@local.test');
insert into public.organizations(id,name,slug,owner_user_id)
  values('b7000000-0000-4000-8000-000000000002','Translation Org','translation-org','b7000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role)
  values('b7000000-0000-4000-8000-000000000002','b7000000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by)
  values('b7000000-0000-4000-8000-000000000003','b7000000-0000-4000-8000-000000000002','Translation','translation-ws','b7000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role)
  values('b7000000-0000-4000-8000-000000000003','b7000000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,language,created_by)
  values('b7000000-0000-4000-8000-000000000004','b7000000-0000-4000-8000-000000000003','Source book','Author','en','b7000000-0000-4000-8000-000000000001');
insert into public.chapters(id,book_id,order_index,title)
  values('b7000000-0000-4000-8000-000000000005','b7000000-0000-4000-8000-000000000004',0,'Opening');
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
  values('b7000000-0000-4000-8000-000000000006','b7000000-0000-4000-8000-000000000005',1,'{}','A saved chapter for translation.',5,'b7000000-0000-4000-8000-000000000001');
update public.chapters set current_document_version_id='b7000000-0000-4000-8000-000000000006' where id='b7000000-0000-4000-8000-000000000005';
insert into public.plans(id,name,billing_period,price_cents,entitlements_json)
  values('b7000000-0000-4000-8000-000000000007','Translation test','month',1000,'{"translation_credits_monthly":1}');
insert into public.subscriptions(id,organization_id,plan_id,status)
  values('b7000000-0000-4000-8000-000000000008','b7000000-0000-4000-8000-000000000002','b7000000-0000-4000-8000-000000000007','canceled');

do $$
begin
  assert not has_function_privilege('authenticated','public.queue_translation_project(uuid,text,text)','execute');
  assert has_function_privilege('authenticated','public.adopt_translation_project(uuid,text)','execute');
  assert not has_function_privilege('anon','public.queue_translation_project(uuid,text,text)','execute');
  assert not has_function_privilege('service_role','public.queue_translation_project(uuid,text,text)','execute');
  assert not has_function_privilege('authenticated','public.claim_translation_job(integer)','execute');
  assert not has_function_privilege('service_role','public.claim_translation_job(integer)','execute');
  assert has_function_privilege('service_role','public.complete_translation_chapter(uuid,uuid,text,text,text,text,jsonb)','execute');
end $$;

set local role authenticated;
set local request.jwt.claims='{"sub":"b7000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.queue_translation_project('b7000000-0000-4000-8000-000000000004','es','translation-retired');
    raise exception 'authenticated caller reached retired translation queue';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role service_role;
set local request.jwt.claims='{"sub":"b7000000-0000-4000-8000-000000000001","role":"service_role"}';
do $$
begin
  begin
    perform public.claim_translation_job(600);
    raise exception 'service role reached retired translation claim';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
