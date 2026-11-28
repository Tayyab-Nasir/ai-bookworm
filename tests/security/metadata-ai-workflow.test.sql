-- Metadata generation remains service-completed, tenant-bound, idempotent and
-- incapable of changing canonical author metadata.
begin;

insert into auth.users(id,email) values
  ('a7100000-0000-4000-8000-000000000001','metadata-author@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('a7100000-0000-4000-8000-000000000002','Metadata Org','metadata-org','a7100000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('a7100000-0000-4000-8000-000000000002','a7100000-0000-4000-8000-000000000001','owner');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
  ('a7100000-0000-4000-8000-000000000009','Metadata test','month',1000,'{"ai_credits_monthly":2}');
insert into public.subscriptions(organization_id,plan_id,status) values
  ('a7100000-0000-4000-8000-000000000002','a7100000-0000-4000-8000-000000000009','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('a7100000-0000-4000-8000-000000000003','a7100000-0000-4000-8000-000000000002','Metadata Workspace','metadata-workspace','a7100000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('a7100000-0000-4000-8000-000000000003','a7100000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('a7100000-0000-4000-8000-000000000004','a7100000-0000-4000-8000-000000000003','Cited Journey','Author','a7100000-0000-4000-8000-000000000001');
insert into public.chapters(id,book_id,order_index,title) values
  ('a7100000-0000-4000-8000-000000000005','a7100000-0000-4000-8000-000000000004',0,'Arrival');
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by) values
  ('a7100000-0000-4000-8000-000000000006','a7100000-0000-4000-8000-000000000005',1,
   '{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"A cartographer follows a silver compass home."}]}',
   'A cartographer follows a silver compass home.',7,'a7100000-0000-4000-8000-000000000001');
update public.chapters set current_document_version_id='a7100000-0000-4000-8000-000000000006'
  where id='a7100000-0000-4000-8000-000000000005';
insert into public.book_metadata(book_id,description,keywords,categories) values
  ('a7100000-0000-4000-8000-000000000004','Author saved copy','["saved"]','["Fiction"]');

insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by) values
  ('a7100000-0000-4000-8000-000000000007','a7100000-0000-4000-8000-000000000003','a7100000-0000-4000-8000-000000000004','metadata','running',
   '{"contextSources":[{"chapterId":"a7100000-0000-4000-8000-000000000005","documentVersionId":"a7100000-0000-4000-8000-000000000006","nodeId":"n1","textHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}',
   'metadata-valid','a7100000-0000-4000-8000-000000000001'),
  ('a7100000-0000-4000-8000-000000000008','a7100000-0000-4000-8000-000000000003','a7100000-0000-4000-8000-000000000004','metadata','failed',
   '{"contextSources":[{"chapterId":"a7100000-0000-4000-8000-000000000005","documentVersionId":"a7100000-0000-4000-8000-000000000006","nodeId":"n1","textHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}',
   'metadata-invalid','a7100000-0000-4000-8000-000000000001');

do $$
begin
  begin
    update public.ai_jobs set status='running'
      where id='a7100000-0000-4000-8000-000000000008';
    assert false, 'second active metadata job for the same author/book was allowed';
  exception when unique_violation then null;
  end;
  assert not has_function_privilege('anon','public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute'),
    'anon can complete metadata AI jobs';
  assert not has_function_privilege('authenticated','public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute'),
    'authenticated can complete metadata AI jobs';
  assert has_function_privilege('service_role','public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute'),
    'service role cannot complete metadata AI jobs';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7100000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.complete_metadata_ai_job(
      'a7100000-0000-4000-8000-000000000007','mock','mock-1',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}','[]','{}',0
    );
    assert false, 'authenticated user completed metadata job';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare
  source_ref jsonb := '{"chapterId":"a7100000-0000-4000-8000-000000000005","documentVersionId":"a7100000-0000-4000-8000-000000000006","nodeId":"n1","textHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
  candidate jsonb;
  result public.ai_jobs;
  run_count integer;
  usage_count integer;
begin
  candidate := jsonb_build_object(
    'suggestionKind','metadata_candidate',
    'description','A cartographer follows an impossible compass on a journey home.',
    'keywords',jsonb_build_array('fantasy adventure','cartographer'),
    'categories',jsonb_build_array('Fiction / Fantasy'),
    'audience','Adult fantasy readers',
    'rationale','Grounded in the saved opening chapter.',
    'confidence',0.92,
    'sourceRefs',jsonb_build_array(source_ref),
    'status','pending'
  );
  select * into result from public.complete_metadata_ai_job(
    'a7100000-0000-4000-8000-000000000007','mock','mock-1',
    '{"inputTokens":80,"outputTokens":30,"estimatedCostUsd":0,"latencyMs":12}',
    '[]',candidate,0
  );
  assert result.status='succeeded', 'metadata job did not succeed';
  assert result.output_ref->'candidate'=candidate, 'candidate was not durably stored';
  assert result.output_ref->>'reviewRequired'='true', 'review requirement missing';
  assert result.output_ref->>'savedMetadataUpdated'='false', 'output falsely claims metadata was saved';
  assert (select description from public.book_metadata where book_id=result.book_id)='Author saved copy',
    'AI completion overwrote author metadata';
  assert (select keywords from public.book_metadata where book_id=result.book_id)='["saved"]'::jsonb,
    'AI completion changed author keywords';
  assert exists(select 1 from public.ai_runs where ai_job_id=result.id and status='succeeded'),
    'metadata run audit missing';
  assert exists(select 1 from public.usage_events where ai_job_id=result.id and meter='ai_credits' and quantity=0),
    'metadata credit event missing';

  select count(*) into run_count from public.ai_runs where ai_job_id=result.id;
  select count(*) into usage_count from public.usage_events where ai_job_id=result.id;
  perform public.complete_metadata_ai_job(result.id,'mock','mock-1',
    '{"inputTokens":80,"outputTokens":30,"estimatedCostUsd":0,"latencyMs":12}','[]',candidate,0);
  assert run_count=(select count(*) from public.ai_runs where ai_job_id=result.id), 'retry duplicated AI run';
  assert usage_count=(select count(*) from public.usage_events where ai_job_id=result.id), 'retry duplicated credit event';

  update public.ai_jobs set status='running'
    where id='a7100000-0000-4000-8000-000000000008';
  assert found, 'completion did not release the metadata generation slot';

  begin
    perform public.complete_metadata_ai_job(
      'a7100000-0000-4000-8000-000000000008','mock','mock-1',
      '{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0}','[]',
      jsonb_set(candidate,'{sourceRefs,0,textHash}','"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'),1
    );
    assert false, 'completion accepted a citation outside trusted evidence';
  exception when insufficient_privilege then null;
  end;
  assert (select status from public.ai_jobs where id='a7100000-0000-4000-8000-000000000008')='running',
    'failed citation changed job status';
  assert not exists(select 1 from public.ai_runs where ai_job_id='a7100000-0000-4000-8000-000000000008'),
    'failed citation left an AI run';
  assert not exists(select 1 from public.usage_events where ai_job_id='a7100000-0000-4000-8000-000000000008'),
    'failed citation charged credits';
end $$;
reset role;

rollback;
