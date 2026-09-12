-- Durable AI accounting and human-review transitions against real PostgreSQL.
begin;

insert into auth.users(id,email) values
  ('a5000000-0000-0000-0000-000000000001','ai-editor@local.test'),
  ('b5000000-0000-0000-0000-000000000001','ai-viewer@local.test'),
  ('c5000000-0000-0000-0000-000000000001','ai-outsider@local.test');

insert into public.organizations(id,name,slug,owner_user_id) values
  ('10000000-0000-4000-8000-000000000001','AI Org A','ai-org-a','a5000000-0000-0000-0000-000000000001'),
  ('10000000-0000-4000-8000-000000000002','AI Org B','ai-org-b','c5000000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('10000000-0000-4000-8000-000000000001','a5000000-0000-0000-0000-000000000001','owner'),
  ('10000000-0000-4000-8000-000000000002','c5000000-0000-0000-0000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','AI Workspace A','ai-ws-a','a5000000-0000-0000-0000-000000000001'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','AI Workspace B','ai-ws-b','c5000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('20000000-0000-4000-8000-000000000001','a5000000-0000-0000-0000-000000000001','editor'),
  ('20000000-0000-4000-8000-000000000001','b5000000-0000-0000-0000-000000000001','viewer'),
  ('20000000-0000-4000-8000-000000000002','c5000000-0000-0000-0000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','AI Book A','A','a5000000-0000-0000-0000-000000000001'),
  ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','AI Book B','B','c5000000-0000-0000-0000-000000000001');
insert into public.chapters(id,book_id,order_index,title) values
  ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',0,'Chapter A'),
  ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',0,'Chapter B');
insert into public.document_versions(
  id,chapter_id,version_number,content_json,plain_text,word_count,created_by
) values
  ('70000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,
   '{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"Original text"}]}',
   'Original text',2,'a5000000-0000-0000-0000-000000000001'),
  ('70000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002',1,
   '{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"Other text"}]}',
   'Other text',2,'c5000000-0000-0000-0000-000000000001');
update public.chapters set current_document_version_id = case id
  when '40000000-0000-4000-8000-000000000001' then '70000000-0000-4000-8000-000000000001'::uuid
  else '70000000-0000-4000-8000-000000000002'::uuid end;

insert into public.ai_jobs(
  id,workspace_id,book_id,agent_type,status,idempotency_key,created_by
) values
  ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','proofreader','running','ai-success','a5000000-0000-0000-0000-000000000001'),
  ('50000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','proofreader','running','ai-invalid','a5000000-0000-0000-0000-000000000001'),
  ('50000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','proofreader','running','ai-cross-scope','a5000000-0000-0000-0000-000000000001');

do $$
begin
  assert not has_function_privilege('anon', 'public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)', 'execute'),
    'anon can complete AI jobs';
  assert not has_function_privilege('authenticated', 'public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)', 'execute'),
    'authenticated can complete AI jobs';
  assert has_function_privilege('service_role', 'public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)', 'execute'),
    'service role cannot complete AI jobs';
  assert not has_function_privilege('anon', 'public.accept_ai_suggestion(uuid,jsonb,text,integer)', 'execute'),
    'anon can accept AI suggestions';
  assert has_function_privilege('authenticated', 'public.accept_ai_suggestion(uuid,jsonb,text,integer)', 'execute'),
    'authenticated cannot call accept RPC';
  assert not has_function_privilege('service_role', 'public.accept_ai_suggestion(uuid,jsonb,text,integer)', 'execute'),
    'service role can impersonate human acceptance';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.complete_ai_job(
      '50000000-0000-4000-8000-000000000001','mock','mock-1',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}',
      '[]','[]',1
    );
    assert false, 'authenticated role completed AI job';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare
  operation jsonb := jsonb_build_object(
    'operationId','op-valid',
    'type','replace_text',
    'target',jsonb_build_object('chapterId','40000000-0000-4000-8000-000000000001','nodeId','n1'),
    'payload',jsonb_build_object('nodeId','n1','from',0,'to',8,'text','Revised'),
    'expectedVersion',1
  );
  suggestions jsonb;
  result public.ai_jobs;
  suggestion_count integer;
  run_count integer;
  usage_count integer;
begin
  suggestions := jsonb_build_array(
    jsonb_build_object('id','60000000-0000-4000-8000-000000000001','entityType','chapter','entityId','40000000-0000-4000-8000-000000000001','operation',operation,'rationale','Accept this fix','confidence',0.95),
    jsonb_build_object('id','60000000-0000-4000-8000-000000000002','entityType','chapter','entityId','40000000-0000-4000-8000-000000000001','operation',jsonb_set(operation,'{operationId}','"op-reject"'),'rationale','Reject this fix','confidence',0.7),
    jsonb_build_object('id','60000000-0000-4000-8000-000000000003','entityType','chapter','entityId','40000000-0000-4000-8000-000000000001','operation',jsonb_set(operation,'{operationId}','"op-viewer"'),'rationale','Viewer must not review','confidence',0.6),
    jsonb_build_object('id','60000000-0000-4000-8000-000000000004','entityType','chapter','entityId','40000000-0000-4000-8000-000000000001','operation',jsonb_set(operation,'{operationId}','"op-outsider"'),'rationale','Outsider must not review','confidence',null)
  );

  select * into result from public.complete_ai_job(
    '50000000-0000-4000-8000-000000000001','mock','mock-1',
    '{"inputTokens":100,"outputTokens":25,"estimatedCostUsd":0.001,"latencyMs":42}',
    '[{"severity":"info","code":"STYLE","message":"Checked","location":{"chapterId":"40000000-0000-4000-8000-000000000001"}}]',
    suggestions,3.5
  );
  assert result.status = 'succeeded' and result.model = 'mock-1', 'job completion did not persist';
  assert result.output_ref->>'suggestionCount' = '4', 'job output summary missing';
  assert (select count(*) from public.ai_suggestions where ai_job_id=result.id) = 4, 'suggestions not persisted';
  assert exists(
    select 1 from public.ai_runs
    where ai_job_id=result.id and workspace_id=result.workspace_id
      and provider='mock' and model='mock-1' and tokens_in=100 and tokens_out=25
      and estimated_cost=0.001 and latency_ms=42 and status='succeeded'
  ), 'AI run not persisted';
  assert exists(
    select 1 from public.usage_events
    where ai_job_id=result.id
      and organization_id='10000000-0000-4000-8000-000000000001'
      and workspace_id='20000000-0000-4000-8000-000000000001'
      and user_id='a5000000-0000-0000-0000-000000000001'
      and meter='ai_credits' and quantity=3.5
  ), 'credit usage did not derive tenant and user from job';

  select count(*) into suggestion_count from public.ai_suggestions where ai_job_id=result.id;
  select count(*) into run_count from public.ai_runs where ai_job_id=result.id;
  select count(*) into usage_count from public.usage_events where ai_job_id=result.id and meter='ai_credits';
  perform public.complete_ai_job(
    result.id,'mock','mock-1',
    '{"inputTokens":100,"outputTokens":25,"estimatedCostUsd":0.001,"latencyMs":42}',
    '[{"severity":"info","code":"STYLE","message":"Checked","location":{}}]',
    suggestions,3.5
  );
  assert suggestion_count=(select count(*) from public.ai_suggestions where ai_job_id=result.id), 'retry duplicated suggestions';
  assert run_count=(select count(*) from public.ai_runs where ai_job_id=result.id), 'retry duplicated run';
  assert usage_count=(select count(*) from public.usage_events where ai_job_id=result.id and meter='ai_credits'), 'retry duplicated credits';

  begin
    perform public.complete_ai_job(
      '50000000-0000-4000-8000-000000000002','mock','mock-1',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}',
      '[]',
      jsonb_build_array(
        jsonb_build_object('id','60000000-0000-4000-8000-000000000005','entityType','chapter','entityId','40000000-0000-4000-8000-000000000001','operation',operation,'rationale','Valid first item','confidence',0.5),
        jsonb_build_object('id','bad')
      ),1
    );
    assert false, 'malformed completion partially persisted';
  exception when invalid_parameter_value then null;
  end;
  assert (select status from public.ai_jobs where id='50000000-0000-4000-8000-000000000002')='running', 'failed completion changed job state';
  assert not exists(select 1 from public.ai_suggestions where ai_job_id='50000000-0000-4000-8000-000000000002'), 'failed completion left suggestions';
  assert not exists(select 1 from public.ai_runs where ai_job_id='50000000-0000-4000-8000-000000000002'), 'failed completion left run';
  assert not exists(select 1 from public.usage_events where ai_job_id='50000000-0000-4000-8000-000000000002'), 'failed completion charged credits';

  begin
    perform public.complete_ai_job(
      '50000000-0000-4000-8000-000000000003','mock','mock-1',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}',
      '[]',
      jsonb_build_array(jsonb_build_object(
        'id','60000000-0000-4000-8000-000000000006','entityType','chapter',
        'entityId','40000000-0000-4000-8000-000000000002',
        'operation',jsonb_set(operation,'{target,chapterId}','"40000000-0000-4000-8000-000000000002"'),
        'rationale','Cross tenant target','confidence',0.5
      )),1
    );
    assert false, 'service completion accepted cross-tenant suggestion';
  exception when insufficient_privilege then null;
  end;
  assert not exists(select 1 from public.ai_runs where ai_job_id='50000000-0000-4000-8000-000000000003'), 'cross-tenant completion left run';
end $$;
reset role;

set local role service_role;
do $$
declare
  job public.ai_jobs;
  claimed public.ai_jobs;
  finished public.ai_jobs;
  operation jsonb := jsonb_build_object(
    'operationId','queued-op','type','replace_text',
    'target',jsonb_build_object('chapterId','40000000-0000-4000-8000-000000000001','nodeId','n1'),
    'payload',jsonb_build_object('nodeId','n1','from',0,'to',8,'text','Queued'),
    'expectedVersion',1
  );
begin
  assert not has_function_privilege('authenticated','public.claim_ai_review_job(integer)','execute'), 'client can claim AI review';
  assert has_function_privilege('service_role','public.claim_ai_review_job(integer)','execute'), 'service cannot claim AI review';
  insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by)
    values('50000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
      'proofreader','queued','{"chapterVersions":[{"chapterId":"40000000-0000-4000-8000-000000000001","version":1}],"userInstruction":null,"contextPolicy":{"includeBookBible":true,"includeStyleGuide":true,"includeRelatedContext":false,"semanticTopK":5,"maxTokens":4096}}',
      'ai-queued-success','a5000000-0000-0000-0000-000000000001');
  select * into claimed from public.claim_ai_review_job(30);
  assert claimed.id='50000000-0000-4000-8000-000000000007' and claimed.status='running' and claimed.attempts=1 and claimed.lease_token is not null, 'AI job was not claimed with a fence';
  assert public.renew_ai_review_lease(claimed.id,claimed.lease_token,30), 'AI lease did not renew';
  begin
    perform public.complete_leased_ai_review_job(claimed.id,'f5000000-0000-4000-8000-000000000007','mock','mock-queue',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}','[]','[]',0);
    assert false, 'wrong AI lease completed job';
  exception when serialization_failure then null; end;
  select * into finished from public.complete_leased_ai_review_job(claimed.id,claimed.lease_token,'mock','mock-queue',
    '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}','[]',
    jsonb_build_array(jsonb_build_object('id','60000000-0000-4000-8000-000000000007','entityType','chapter','entityId','40000000-0000-4000-8000-000000000001','operation',operation,'rationale','Queued completion','confidence',0.9)),0);
  assert finished.status='succeeded' and finished.lease_token is null and finished.lease_expires_at is null, 'fenced AI completion did not clear lease';
  assert exists(select 1 from public.ai_runs where ai_job_id=finished.id), 'fenced AI completion did not retain accounting';
  insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,idempotency_key,created_by)
    values('50000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','writer','queued','ai-queued-fail','a5000000-0000-0000-0000-000000000001');
  select * into claimed from public.claim_ai_review_job(30);
  select * into job from public.fail_ai_review_job(claimed.id,claimed.lease_token,'ai_service_unavailable','AI service unavailable',true);
  assert job.status='queued' and job.attempts=1 and job.error_code='ai_service_unavailable' and job.lease_token is null, 'retryable AI failure was not safely requeued';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare
  accepted public.document_versions;
  retry public.document_versions;
  rejected public.ai_suggestions;
  content jsonb := '{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"Revised text"}]}';
begin
  select * into accepted from public.accept_ai_suggestion(
    '60000000-0000-4000-8000-000000000001',content,'Revised text',2
  );
  assert accepted.version_number=2 and accepted.created_by=auth.uid(), 'accept did not append canonical version';
  assert (select current_document_version_id from public.chapters where id=accepted.chapter_id)=accepted.id, 'accept did not advance chapter pointer';
  assert exists(
    select 1 from public.ai_suggestions
    where id='60000000-0000-4000-8000-000000000001'
      and status='accepted' and reviewed_by=auth.uid() and reviewed_at is not null
  ), 'accept did not record reviewer';
  select * into retry from public.accept_ai_suggestion(
    '60000000-0000-4000-8000-000000000001',content,'Revised text',2
  );
  assert retry.id=accepted.id, 'accept retry created another document version';
  assert (select count(*) from public.document_versions where chapter_id=accepted.chapter_id)=2, 'accept retry duplicated version';

  select * into rejected from public.reject_ai_suggestion('60000000-0000-4000-8000-000000000002');
  assert rejected.status='rejected' and rejected.reviewed_by=auth.uid(), 'reject did not persist reviewer state';
  assert (public.reject_ai_suggestion('60000000-0000-4000-8000-000000000002')).status='rejected', 'reject retry is not idempotent';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"b5000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.reject_ai_suggestion('60000000-0000-4000-8000-000000000003');
    assert false, 'viewer rejected AI suggestion';
  exception when insufficient_privilege then null;
  end;
  assert (select status from public.ai_suggestions where id='60000000-0000-4000-8000-000000000003')='pending', 'viewer changed suggestion state';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.accept_ai_suggestion(
      '60000000-0000-4000-8000-000000000004',
      '{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"Stolen"}]}',
      'Stolen',1
    );
    assert false, 'cross-tenant editor accepted AI suggestion';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
