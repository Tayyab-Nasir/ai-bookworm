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
  assert has_function_privilege('authenticated','public.queue_translation_project(uuid,text,text)','execute');
  assert has_function_privilege('authenticated','public.adopt_translation_project(uuid,text)','execute');
  assert not has_function_privilege('anon','public.queue_translation_project(uuid,text,text)','execute');
  assert not has_function_privilege('authenticated','public.claim_translation_job(integer)','execute');
  assert has_function_privilege('service_role','public.complete_translation_chapter(uuid,uuid,text,text,text,text,jsonb)','execute');
end $$;

set local role authenticated;
set local request.jwt.claims='{"sub":"b7000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.queue_translation_project('b7000000-0000-4000-8000-000000000004','es','translation-unpaid');
    raise exception 'unpaid account queued translation';
  exception when check_violation then assert sqlerrm='translation credit capacity exhausted'; end;
end $$;

reset role;
update public.subscriptions set status='active' where id='b7000000-0000-4000-8000-000000000008';
set local role authenticated;
set local request.jwt.claims='{"sub":"b7000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_project public.translation_projects;
begin
  select * into v_project from public.queue_translation_project('b7000000-0000-4000-8000-000000000004','es','translation-paid');
  assert v_project.status='queued' and v_project.credit_units=1 and v_project.chapter_count=1;
  assert not exists(select 1 from public.ai_jobs where agent_type='translator' and input_ref::text like '%saved chapter%'),
    'queued translation job leaked manuscript text';
  assert (select count(*) from public.queue_translation_project('b7000000-0000-4000-8000-000000000004','es','translation-paid'))=1,
    'idempotent translation replay did not return saved project';
  begin
    perform public.queue_translation_project('b7000000-0000-4000-8000-000000000004','fr','translation-paid');
    raise exception 'changed target reused translation key';
  exception when unique_violation then assert sqlerrm='translation request key conflict'; end;
end $$;

reset role;
set local role service_role;
do $$
declare v_job public.ai_jobs; v_done public.ai_jobs; v_project uuid;
begin
  select * into v_job from public.claim_translation_job(600);
  assert v_job.status='running' and v_job.lease_token is not null;
  v_project := (v_job.input_ref->>'translationProjectId')::uuid;
  select * into v_done from public.complete_translation_chapter(v_job.id,v_job.lease_token,
    'Un capítulo guardado para traducir.','openai','gpt-6-astra','req-test',
    '{"inputTokens":12,"outputTokens":14,"estimatedCostUsd":0.00082,"latencyMs":50}');
  assert v_done.status='succeeded';
  assert (select status from public.translation_projects where id=v_project)='succeeded';
  assert (select quantity from public.usage_events where ai_job_id=v_job.id and meter='translation_credits')=1;
end $$;

reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"b7000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_book public.books;
begin
  select * into v_book from public.adopt_translation_project(
    (select id from public.translation_projects where idempotency_key='translation-paid'),'Libro traducido');
  assert v_book.language='es' and v_book.title='Libro traducido';
  assert (select plain_text from public.document_versions dv join public.chapters c on c.current_document_version_id=dv.id
    where c.book_id=v_book.id)='Un capítulo guardado para traducir.';
  assert (select adopted_book_id from public.translation_projects where idempotency_key='translation-paid')=v_book.id;
end $$;

rollback;
