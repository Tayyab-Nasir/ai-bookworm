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

-- Persist measured QC metadata, scoped to workspace members, and accept only
-- immutable listen-confirmation receipts from workspace approvers.
do $$
declare v_project uuid;
begin
  select id into strict v_project from public.audiobook_projects
    where edition_id='a6000000-0000-4000-8000-000000000007' and status='succeeded';
  insert into public.audiobook_qc_reports(
    id,project_id,document_version_id,audio_sha256,source_manifest_sha256,
    quality_report,created_by
  ) values (
    'a6000000-0000-4000-8000-000000000011',v_project,'a6000000-0000-4000-8000-000000000006',repeat('a',64),repeat('b',64),
    '{"schemaVersion":1,"rmsDbfs":-20,"reviewRequired":true}',
    'a6000000-0000-4000-8000-000000000001'
  );
  assert not has_table_privilege('authenticated','public.audiobook_qc_reports','insert');
  assert not has_table_privilege('authenticated','public.audiobook_qc_reports','update');
  assert not has_table_privilege('authenticated','public.audiobook_qc_signoffs','update');
end $$;

set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_report uuid;
begin
  select id into strict v_report from public.audiobook_qc_reports
    where audio_sha256=repeat('a',64);
  insert into public.audiobook_qc_signoffs(report_id,reviewer_id,listened_to_exact_audio)
    values(v_report,auth.uid(),true);
  assert (select count(*)=1 from public.audiobook_qc_signoffs where report_id=v_report);
  begin
    insert into public.audiobook_qc_signoffs(report_id,reviewer_id,listened_to_exact_audio)
      values(v_report,auth.uid(),true);
    raise exception 'duplicate author sign-off was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.audiobook_qc_signoffs(report_id,reviewer_id,listened_to_exact_audio)
      values(v_report,'a6000000-0000-4000-8000-000000000001',false);
    raise exception 'sign-off without explicit listening confirmation was accepted';
  exception when check_violation or insufficient_privilege then null;
  end;
  assert has_table_privilege('authenticated','public.audiobook_qc_reports','select');
  assert has_table_privilege('authenticated','public.audiobook_qc_signoffs','insert');
end $$;

reset role;
insert into auth.users(id,email) values('a6000000-0000-4000-8000-000000000012','audio-outsider@local.test');
set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000012","role":"authenticated"}';
do $$
begin
  assert (select count(*)=0 from public.audiobook_qc_reports where id='a6000000-0000-4000-8000-000000000011'),
    'non-member read a QC report';
  assert (select count(*)=0 from public.audiobook_qc_signoffs where report_id='a6000000-0000-4000-8000-000000000011'),
    'non-member read an author sign-off';
  begin
    insert into public.audiobook_qc_signoffs(report_id,reviewer_id,listened_to_exact_audio)
      values('a6000000-0000-4000-8000-000000000011',auth.uid(),true);
    raise exception 'non-member recorded an audio sign-off';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set local role service_role;
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
  values('a6000000-0000-4000-8000-000000000013','a6000000-0000-4000-8000-000000000003','cover','Test cover',
    'workspaces/a6000000-0000-4000-8000-000000000003/assets/test-cover/v1/cover.jpg','image/jpeg',1024,repeat('c',64),'draft',
    'a6000000-0000-4000-8000-000000000001');
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_job public.audiobook_google_play_export_jobs; v_extra public.audiobook_google_play_export_jobs;
begin
  assert has_function_privilege('authenticated','public.queue_audiobook_google_play_export(uuid,text,uuid,text)','execute');
  assert not has_function_privilege('anon','public.queue_audiobook_google_play_export(uuid,text,uuid,text)','execute');
  assert not has_function_privilege('authenticated','public.claim_audiobook_google_play_export(integer)','execute');
  select * into v_job from public.queue_audiobook_google_play_export(
    'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','google-export-paid-1');
  assert v_job.status='queued' and v_job.progress_total=1 and v_job.progress_chapters=0;
  assert v_job.snapshot_json->>'title'='Audio Book' and jsonb_array_length(v_job.snapshot_json->'chapters')=1;
  assert v_job.snapshot_json::text not like '%Narrate this saved chapter%', 'export queue leaked manuscript text';
  assert (select id from public.queue_audiobook_google_play_export(
    'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','google-export-paid-1'))=v_job.id,
    'export idempotency replay created a duplicate job';
  select * into v_extra from public.queue_audiobook_google_play_export(
    'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','google-export-cap-2');
  begin
    perform public.queue_audiobook_google_play_export(
      'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','google-export-cap-3');
    raise exception 'workspace export concurrency cap was not enforced';
  exception when program_limit_exceeded then null;
  end;
  select * into v_extra from public.cancel_audiobook_google_play_export(v_extra.id);
  assert v_extra.status='cancelled';
  begin
    perform public.queue_audiobook_google_play_export(
      'a6000000-0000-4000-8000-000000000007','9780306406158','a6000000-0000-4000-8000-000000000013','google-export-different');
    raise exception 'ISBN checksum validation failed';
  exception when invalid_parameter_value then null;
  end;
  assert has_table_privilege('authenticated','public.audiobook_google_play_export_jobs','select');
  assert not has_table_privilege('authenticated','public.audiobook_google_play_export_jobs','update');
end $$;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000012","role":"authenticated"}';
do $$
begin
  assert (select count(*)=0 from public.audiobook_google_play_export_jobs), 'non-member read an export job';
end $$;
reset role;
set local role service_role;
do $$
declare v_job public.audiobook_google_play_export_jobs; v_claim public.audiobook_google_play_export_jobs;
  v_path text; v_done public.audiobook_google_play_export_jobs; v_heartbeat jsonb;
begin
  select * into v_claim from public.claim_audiobook_google_play_export(300);
  assert v_claim.status='running' and v_claim.lease_token is not null;
  assert public.progress_audiobook_google_play_export(v_claim.id,v_claim.lease_token,1);
  v_path:=format('workspaces/%s/audiobook-exports/%s/%s.zip',v_claim.workspace_id,v_claim.id,v_claim.lease_token);
  select * into v_done from public.complete_audiobook_google_play_export(
    v_claim.id,v_claim.lease_token,v_path,1024,repeat('d',64),300);
  assert v_done.status='succeeded' and v_done.output_storage_path=v_path and v_done.total_duration_seconds=300;
  assert (select count(*)=1 from public.audiobook_google_play_export_jobs where id=v_claim.id);
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_queued public.audiobook_google_play_export_jobs; v_running public.audiobook_google_play_export_jobs;
begin
  select * into v_queued from public.queue_audiobook_google_play_export(
    'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','google-export-cancel-queued');
  select * into v_queued from public.cancel_audiobook_google_play_export(v_queued.id);
  assert v_queued.status='cancelled';
  select * into v_running from public.queue_audiobook_google_play_export(
    'a6000000-0000-4000-8000-000000000007','9780306406157','a6000000-0000-4000-8000-000000000013','google-export-cancel-running');
end $$;
reset role;
set local role service_role;
update public.audiobook_google_play_export_jobs set status='running',attempts=1,
  lease_token='a6000000-0000-4000-8000-000000000014',lease_expires_at=clock_timestamp()+interval '5 minutes'
  where idempotency_key='google-export-cancel-running';
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"a6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_job public.audiobook_google_play_export_jobs;
begin
  select * into v_job from public.cancel_audiobook_google_play_export(
    (select id from public.audiobook_google_play_export_jobs where idempotency_key='google-export-cancel-running'));
  assert v_job.status='running' and v_job.cancellation_requested_at is not null;
end $$;
reset role;
set local role service_role;
do $$
declare v_id uuid; v_state jsonb; v_claim public.audiobook_google_play_export_jobs;
begin
  select id into strict v_id from public.audiobook_google_play_export_jobs where idempotency_key='google-export-cancel-running';
  v_state:=public.heartbeat_audiobook_google_play_export(v_id,'a6000000-0000-4000-8000-000000000014',300);
  assert v_state->>'leased'='true' and v_state->>'cancelled'='true';
  update public.audiobook_google_play_export_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=v_id;
  select * into v_claim from public.claim_audiobook_google_play_export(300);
  assert v_claim.id is null;
  assert (select status from public.audiobook_google_play_export_jobs where id=v_id)='cancelled';
end $$;

rollback;
