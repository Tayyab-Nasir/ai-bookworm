-- Completion must meter a verified, review-only candidate without adding canon.
begin;
insert into auth.users(id,email) values
  ('b7100000-0000-4000-8000-000000000001','bible-ai-author@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('b7100000-0000-4000-8000-000000000002','Bible AI Org','bible-ai-org','b7100000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('b7100000-0000-4000-8000-000000000002','b7100000-0000-4000-8000-000000000001','owner');
insert into public.plans(id,name,billing_period,price_cents,entitlements_json) values
  ('b7100000-0000-4000-8000-000000000009','Bible AI test','month',1000,'{"ai_credits_monthly":2}');
insert into public.subscriptions(organization_id,plan_id,status) values
  ('b7100000-0000-4000-8000-000000000002','b7100000-0000-4000-8000-000000000009','active');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('b7100000-0000-4000-8000-000000000003','b7100000-0000-4000-8000-000000000002','Bible AI Workspace','bible-ai-workspace','b7100000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('b7100000-0000-4000-8000-000000000003','b7100000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('b7100000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000003','Cited Bible','Author','b7100000-0000-4000-8000-000000000001');
insert into public.chapters(id,book_id,order_index,title) values
  ('b7100000-0000-4000-8000-000000000005','b7100000-0000-4000-8000-000000000004',0,'Arrival');
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by) values
  ('b7100000-0000-4000-8000-000000000006','b7100000-0000-4000-8000-000000000005',1,
   '{"schemaVersion":"1.0","nodes":[{"id":"n1","type":"paragraph","text":"Mara had blue eyes."}]}',
   'Mara had blue eyes.',4,'b7100000-0000-4000-8000-000000000001');
update public.chapters set current_document_version_id='b7100000-0000-4000-8000-000000000006'
  where id='b7100000-0000-4000-8000-000000000005';

do $$
declare
  source_ref jsonb := jsonb_build_object(
    'chapterId','b7100000-0000-4000-8000-000000000005',
    'documentVersionId','b7100000-0000-4000-8000-000000000006',
    'nodeId','n1','textHash',encode(public.digest('Mara had blue eyes.','sha256'),'hex'));
begin
  insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by)
  values ('b7100000-0000-4000-8000-000000000007','b7100000-0000-4000-8000-000000000003',
          'b7100000-0000-4000-8000-000000000004','bookbible','running',
          jsonb_build_object('contextSources',jsonb_build_array(source_ref)),
          'book-bible-valid','b7100000-0000-4000-8000-000000000001');
end $$;

do $$
begin
  assert not has_function_privilege('authenticated',
    'public.complete_book_bible_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute'),
    'authenticated user can complete Book Bible AI jobs';
  assert has_function_privilege('service_role',
    'public.complete_book_bible_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute'),
    'service role cannot complete Book Bible AI jobs';
  begin
    insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by)
    values ('b7100000-0000-4000-8000-000000000008','b7100000-0000-4000-8000-000000000003',
            'b7100000-0000-4000-8000-000000000004','bookbible','running','{}',
            'book-bible-overlap','b7100000-0000-4000-8000-000000000001');
    assert false, 'overlapping paid Bible job was allowed';
  exception when unique_violation then null;
  end;
end $$;

set local role service_role;
do $$
declare
  source_ref jsonb := jsonb_build_object(
    'chapterId','b7100000-0000-4000-8000-000000000005',
    'documentVersionId','b7100000-0000-4000-8000-000000000006',
    'nodeId','n1','textHash',encode(public.digest('Mara had blue eyes.','sha256'),'hex'));
  candidate jsonb;
  result public.ai_jobs;
  run_count integer;
  usage_count integer;
begin
  candidate := jsonb_build_object('suggestionKind','book_bible_candidate','status','pending',
    'type','character','name','Mara','description','A character with blue eyes.',
    'attributes',jsonb_build_object('eyes','blue'),
    'sourceRefs',jsonb_build_array(source_ref),'confidence',0.8);
  begin
    perform public.complete_book_bible_ai_job('b7100000-0000-4000-8000-000000000007',
      'mock','mock-1','{"inputTokens":80,"outputTokens":20,"estimatedCostUsd":0}',
      '[]',jsonb_build_array(jsonb_set(candidate,'{sourceRefs,0,textHash}',to_jsonb(repeat('a',64)))),0);
    assert false, 'a fabricated citation was billed';
  exception when insufficient_privilege then null;
  end;
  assert (select status from public.ai_jobs where id='b7100000-0000-4000-8000-000000000007')='running',
    'invalid citation changed the job';
  assert not exists(select 1 from public.usage_events where ai_job_id='b7100000-0000-4000-8000-000000000007'),
    'invalid citation charged the author';
  select * into result from public.complete_book_bible_ai_job(
    'b7100000-0000-4000-8000-000000000007','mock','mock-1',
    '{"inputTokens":80,"outputTokens":20,"estimatedCostUsd":0}',
    '[]',jsonb_build_array(candidate),0);
  assert result.status='succeeded', 'Bible candidate job did not succeed';
  assert result.output_ref->'candidates'=jsonb_build_array(candidate), 'candidate was not saved';
  assert result.output_ref->>'savedBibleUpdated'='false', 'job falsely claims canon was saved';
  assert not exists(select 1 from public.book_bible_items where book_id=result.book_id),
    'AI completion changed canonical Book Bible';
  select count(*) into run_count from public.ai_runs where ai_job_id=result.id;
  select count(*) into usage_count from public.usage_events where ai_job_id=result.id;
  assert run_count=1 and usage_count=1, 'audit or usage missing';
  perform public.complete_book_bible_ai_job(result.id,'mock','mock-1',
    '{"inputTokens":80,"outputTokens":20,"estimatedCostUsd":0}','[]',jsonb_build_array(candidate),0);
  assert run_count=(select count(*) from public.ai_runs where ai_job_id=result.id), 'replay duplicated run';
  assert usage_count=(select count(*) from public.usage_events where ai_job_id=result.id), 'replay duplicated usage';
end $$;
reset role;
do $$ begin
  update public.ai_jobs set input_ref=input_ref || jsonb_build_object('reading',jsonb_build_object('fingerprint',repeat('a',64),'pageIndex',0))
    where id='b7100000-0000-4000-8000-000000000007';
  begin
    insert into public.ai_jobs(workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by)
    values('b7100000-0000-4000-8000-000000000003','b7100000-0000-4000-8000-000000000004','bookbible','succeeded',
      jsonb_build_object('reading',jsonb_build_object('fingerprint',repeat('a',64),'pageIndex',0)),
      'duplicate-reading-page','b7100000-0000-4000-8000-000000000001');
    assert false,'same reading page completed twice';
  exception when unique_violation then null; end;
  insert into public.ai_jobs(workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by)
  values('b7100000-0000-4000-8000-000000000003','b7100000-0000-4000-8000-000000000004','bookbible','succeeded',
    jsonb_build_object('reading',jsonb_build_object('fingerprint',repeat('a',64),'pageIndex',1)),
    'different-reading-page','b7100000-0000-4000-8000-000000000001');
end $$;
rollback;
