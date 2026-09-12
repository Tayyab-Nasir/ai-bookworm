begin;

insert into auth.users(id,email) values('a6000000-0000-4000-8000-000000000001','audio-editor@local.test');
insert into public.organizations(id,name,slug,owner_user_id)
  values('a6000000-0000-4000-8000-000000000002','Audio Org','audio-org','a6000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role)
  values('a6000000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by)
  values('a6000000-0000-4000-8000-000000000003','a6000000-0000-4000-8000-000000000002','Audio','audio-ws','a6000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role)
  values('a6000000-0000-4000-8000-000000000003','a6000000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by)
  values('a6000000-0000-4000-8000-000000000004','a6000000-0000-4000-8000-000000000003','Audio Book','Author','a6000000-0000-4000-8000-000000000001');
insert into public.chapters(id,book_id,order_index,title)
  values('a6000000-0000-4000-8000-000000000005','a6000000-0000-4000-8000-000000000004',0,'Opening');
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
  values('a6000000-0000-4000-8000-000000000006','a6000000-0000-4000-8000-000000000005',1,'{}','Narrate this saved chapter.',4,'a6000000-0000-4000-8000-000000000001');
update public.chapters set current_document_version_id='a6000000-0000-4000-8000-000000000006' where id='a6000000-0000-4000-8000-000000000005';
insert into public.editions(id,book_id,type,language,edition_metadata_json)
  values('a6000000-0000-4000-8000-000000000007','a6000000-0000-4000-8000-000000000004','audiobook','en','{"kind":"audiobook","voice":"marin","speed":1}');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json)
  values('a6000000-0000-4000-8000-000000000008','Audio test','month',1000,'{"audio_credits_monthly":1}');
insert into public.subscriptions(id,organization_id,plan_id,status)
  values('a6000000-0000-4000-8000-000000000009','a6000000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-000000000008','canceled');

do $$
begin
  assert has_function_privilege('authenticated','public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb)','execute');
  assert not has_function_privilege('anon','public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb)','execute');
  assert not has_function_privilege('authenticated','public.claim_audiobook_job(integer)','execute');
  assert has_function_privilege('service_role','public.complete_audiobook_segment(uuid,uuid,uuid,text,text,bigint,text,text,text,text,jsonb)','execute');
end $$;

set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_segments jsonb:=jsonb_build_array(jsonb_build_object(
  'index',0,'start',0,'end',27,'creditUnits',1,
  'sha256',encode(digest(convert_to('Narrate this saved chapter.','UTF8'),'sha256'),'hex')));
begin
  begin
    perform public.queue_audiobook_project('a6000000-0000-4000-8000-000000000007','a6000000-0000-4000-8000-000000000005','marin',null,1,'audio-unpaid',v_segments);
    raise exception 'unpaid account queued narration';
  exception when check_violation then assert sqlerrm='audio credit capacity exhausted'; end;
end $$;

reset role;
update public.subscriptions set status='active' where id='a6000000-0000-4000-8000-000000000009';
set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_segments jsonb:=jsonb_build_array(jsonb_build_object(
  'index',0,'start',0,'end',27,'creditUnits',1,
  'sha256',encode(digest(convert_to('Narrate this saved chapter.','UTF8'),'sha256'),'hex')));
  v_project public.audiobook_projects;
begin
  select * into v_project from public.queue_audiobook_project(
    'a6000000-0000-4000-8000-000000000007','a6000000-0000-4000-8000-000000000005','marin',null,1,'audio-paid',v_segments);
  assert v_project.status='queued' and v_project.credit_units=1 and v_project.segment_count=1;
  assert not exists(select 1 from public.ai_jobs where id=(select ai_job_id from public.audiobook_segments where project_id=v_project.id)
    and input_ref::text like '%Narrate this%'), 'queued job leaked manuscript text';
  assert (select count(*) from public.queue_audiobook_project(
    'a6000000-0000-4000-8000-000000000007','a6000000-0000-4000-8000-000000000005','marin',null,1,'audio-paid',v_segments))=1,
    'idempotent audiobook replay did not return the saved project';
  begin
    perform public.queue_audiobook_project(
      'a6000000-0000-4000-8000-000000000007','a6000000-0000-4000-8000-000000000005','cedar',null,1,'audio-paid',v_segments);
    raise exception 'changed narration settings reused an idempotency key';
  exception when unique_violation then
    assert sqlerrm='audiobook request key conflict';
  end;
end $$;

reset role;
set local role service_role;
do $$
declare v_job public.ai_jobs; v_done public.ai_jobs; v_project uuid; v_path text;
begin
  select * into v_job from public.claim_audiobook_job(600);
  assert v_job.status='running' and v_job.lease_token is not null;
  v_project:=(v_job.input_ref->>'audiobookProjectId')::uuid;
  v_path:=format('workspaces/%s/audiobooks/%s/0.mp3',v_job.workspace_id,v_project);
  select * into v_done from public.complete_audiobook_segment(v_job.id,v_job.lease_token,
    'a6000000-0000-4000-8000-000000000010',v_path,'audio/mpeg',128,'0000000000000000000000000000000000000000000000000000000000000000',
    'openai','gpt-4o-mini-tts','req-test','{"inputTokens":7,"outputTokens":80,"estimatedCostUsd":0.000964,"latencyMs":50}');
  assert v_done.status='succeeded';
  assert (select status from public.audiobook_projects where id=v_project)='succeeded';
  assert (select quantity from public.usage_events where ai_job_id=v_job.id and meter='audio_credits')=1;
  assert (select scan_status from public.asset_versions where asset_id='a6000000-0000-4000-8000-000000000010')='trusted_generated';
end $$;

rollback;
