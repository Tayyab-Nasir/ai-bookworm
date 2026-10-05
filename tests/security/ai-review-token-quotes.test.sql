-- Exact AI review token counting persists a private, idempotent proposal only.
begin;

create temp table ai_review_quote_fixture (
  user_id uuid, viewer_id uuid, workspace_id uuid, book_id uuid,
  chapter_id uuid, version_id uuid, job_id uuid, request_id uuid
) on commit drop;
grant select,insert,update on ai_review_quote_fixture to authenticated,service_role;

insert into auth.users(id,email) values
 ('e3500000-0000-4000-8000-000000000001','ai-review-quote-owner@local.test'),
 ('e3500000-0000-4000-8000-000000000002','ai-review-quote-viewer@local.test');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e3500000-0000-4000-8000-000000000001"}';
do $$
declare ws public.workspaces; b uuid;
begin
  select * into strict ws from public.create_workspace_with_owner('AI review quote test');
  insert into public.books(workspace_id,title,author_name,language,created_by)
    values(ws.id,'Quote Test','Quote Owner','en',auth.uid()) returning id into b;
  insert into ai_review_quote_fixture(user_id,viewer_id,workspace_id,book_id,chapter_id,version_id,job_id)
    values(auth.uid(),'e3500000-0000-4000-8000-000000000002',ws.id,b,
      'e3500000-0000-4000-8000-000000000011','e3500000-0000-4000-8000-000000000012',
      'e3500000-0000-4000-8000-000000000021');
  assert not has_table_privilege('authenticated','public.ai_review_token_quote_requests','select'),
    'author can read private quote snapshot';
  assert not has_function_privilege('authenticated',
    'public.request_ai_review_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,boolean)','execute'),
    'author can call private quote RPC';
end $$;
reset role;

insert into public.workspace_members(workspace_id,user_id,role)
 select workspace_id,viewer_id,'viewer'::public.member_role from ai_review_quote_fixture;
insert into public.chapters(id,book_id,order_index,title)
 select chapter_id,book_id,0,'First chapter' from ai_review_quote_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
 select version_id,chapter_id,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"A silver road crosses the moonlit garden."}]}'::jsonb,
   'A silver road crosses the moonlit garden.',8,user_id from ai_review_quote_fixture;
update public.chapters c set current_document_version_id=f.version_id from ai_review_quote_fixture f where c.id=f.chapter_id;

set local role service_role;
do $$
declare
  f ai_review_quote_fixture;
  catalog jsonb;
  request_json jsonb;
  versions jsonb;
  envelope jsonb;
  replay jsonb;
  ready public.ai_review_token_quote_requests;
  v_job public.ai_jobs;
  v_replay public.ai_jobs;
  v_claim public.ai_jobs;
  v_reclaimed public.ai_jobs;
  v_dispatched boolean;
  quote_json jsonb;
  v_tokens jsonb;
  v_usage jsonb;
  h text:=repeat('a',64);
  t timestamptz:=clock_timestamp();
begin
  select * into strict f from ai_review_quote_fixture;
  catalog:=jsonb_build_object('approved',true,'version','synthetic-catalog','expiresAt',t+interval '30 minutes',
    'entries',jsonb_build_array(jsonb_build_object('id','writer-test','price',jsonb_build_object('provider','openai',
      'model','gpt-6-astra-2026-09-01','version','price-v1'))));
  request_json:=jsonb_build_object('jobId',f.job_id,'workspaceId',f.workspace_id,'bookId',f.book_id,
    'agentType','writer','model','gpt-6-astra-2026-09-01','maxOutputTokens',1200,
    'contextPolicy',jsonb_build_object('includeBookBible',true,'includeStyleGuide',true,'includeRelatedContext',false,
      'semanticTopK',5,'maxTokens',4096),
    'input',jsonb_build_object('chapterIds',jsonb_build_array(f.chapter_id),'userInstruction','Continue the scene.',
      'chapters',jsonb_build_object(f.chapter_id::text,jsonb_build_object('version',1))));
  versions:=jsonb_build_array(jsonb_build_object('chapterId',f.chapter_id,'documentVersionId',f.version_id,'version',1));
  begin
    perform public.request_ai_review_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,
      request_json,catalog,versions,'ai-review-no-consent',false);
    assert false,'AI review quote started without provider-count consent';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.request_ai_review_token_quote(f.viewer_id,f.book_id,f.workspace_id,f.job_id,
      request_json,catalog,versions,'ai-review-viewer-1',true);
    assert false,'viewer requested an AI review quote';
  exception when insufficient_privilege then null; end;

  envelope:=public.request_ai_review_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,
    request_json,catalog,versions,'ai-review-quote-1',true);
  assert (envelope->>'claimed')::boolean and envelope#>>'{request,status}'='counting',
    'new AI review quote was not leased for counting';
  update ai_review_quote_fixture set request_id=(envelope#>>'{request,id}')::uuid;
  replay:=public.request_ai_review_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,
    request_json,catalog,versions,'ai-review-quote-1',true);
  assert not (replay->>'claimed')::boolean and replay#>>'{request,id}'=envelope#>>'{request,id}',
    'AI review quote replay was not idempotent';
  begin
    perform public.request_ai_review_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,
      jsonb_set(request_json,'{input,userInstruction}','"different brief"'),catalog,versions,'ai-review-quote-1',true);
    assert false,'AI review quote key accepted changed generation instructions';
  exception when unique_violation then null; end;

  quote_json:=jsonb_build_object('scope',jsonb_build_object('jobId',f.job_id,'workspaceId',f.workspace_id,
      'userId',f.user_id,'inputSha256',h),
    'price',jsonb_build_object('provider','openai','model','gpt-6-astra-2026-09-01','version','price-v1','rates',jsonb_build_array(
      jsonb_build_object('dimension','text_input','microUsdPerMillionTokens','0'),
      jsonb_build_object('dimension','text_cached_input','microUsdPerMillionTokens','0'),
      jsonb_build_object('dimension','text_output','microUsdPerMillionTokens','750000'))),
    'policy',jsonb_build_object('approved',true,'version','policy-v1','microUsdPerCredit','100','markupBasisPoints',10000,
      'platformMicroUsd','0','minimumCredits','3'),
    'maximumTokens',jsonb_build_array(jsonb_build_object('dimension','text_cached_input','tokens','30'),
      jsonb_build_object('dimension','text_input','tokens','30'),jsonb_build_object('dimension','text_output','tokens','1200')),
    'reservedCredits','9','maximumProviderMicroUsd','900','fingerprint',repeat('b',64),'createdAt',t,'expiresAt',t+interval '10 minutes');
  select * into strict ready from public.complete_ai_review_token_quote_count((envelope#>>'{request,id}')::uuid,
    f.user_id,(envelope#>>'{request,lease_token}')::uuid,h,30,quote_json);
  assert ready.status='ready' and ready.counted_input_tokens=30 and ready.request_sha256=h,
    'exact count did not create a ready quote';
  assert (select count(*) from public.ai_jobs where id=f.job_id)=0,
    'quote preparation created a generation job before explicit acceptance';
  replay:=jsonb_build_object('same',public.complete_ai_review_token_quote_count(ready.id,f.user_id,
    (envelope#>>'{request,lease_token}')::uuid,h,30,quote_json));
  assert replay#>>'{same,status}'='ready','identical completed count could not recover safely';
  begin
    perform public.complete_ai_review_token_quote_count(ready.id,f.user_id,
      (envelope#>>'{request,lease_token}')::uuid,h,31,quote_json);
    assert false,'ready quote changed its measured input count';
  exception when unique_violation then null; end;

  assert not has_function_privilege('authenticated',
    'public.accept_ai_review_token_quote(uuid,uuid,integer)','execute'),
    'author can call private quote acceptance RPC';
  begin
    perform public.accept_ai_review_token_quote(ready.id,f.user_id,10);
    assert false,'AI review quote accepted with a changed credit total';
  exception when check_violation then null; end;
  begin
    perform public.accept_ai_review_token_quote(ready.id,f.viewer_id,9);
    assert false,'another user accepted the AI review quote';
  exception when no_data_found then null; end;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
    values(f.user_id,f.workspace_id,'purchase',20,0);
  select * into strict v_job from public.accept_ai_review_token_quote(ready.id,f.user_id,9);
  assert v_job.id=f.job_id and v_job.status='queued' and v_job.billing_mode='quoted'
    and v_job.agent_type='writer','accepted quote did not create the exact funded AI review job';
  assert v_job.input_ref->>'generationRequestSha256'=h
    and jsonb_array_length(v_job.input_ref->'chapterVersions')=1
    and not (v_job.input_ref ? 'chapters'),'accepted job did not retain only canonical manuscript pointers';
  assert (select status='held' and reserved_credits=9 from public.funded_usage_quotes where job_id=f.job_id),
    'accepted quote did not reserve its exact maximum';
  assert (select count(*)=1 from public.credit_ledger where reference_id=f.job_id and source='generation_reservation'),
    'accepted quote did not create exactly one reservation ledger event';
  select * into strict v_replay from public.accept_ai_review_token_quote(ready.id,f.user_id,9);
  assert v_replay.id=v_job.id and (select count(*)=1 from public.ai_jobs where id=f.job_id),
    'acceptance replay created a duplicate AI review job';
  select * into strict v_claim from public.claim_quoted_ai_review_job(180);
  assert v_claim.id=v_job.id and v_claim.lease_token is not null,
    'accepted funded AI review job was not claimed by the quoted worker';
  select * into v_replay from public.claim_ai_review_job(180);
  assert v_replay.id is null,'operational AI worker claimed a token-credit funded job';
  v_dispatched:=public.claim_funded_dispatch(v_claim.id,v_claim.lease_token,h,'gpt-6-astra-2026-09-01');
  assert v_dispatched,'funded AI review did not acquire its one-way dispatch marker';
  assert not public.claim_funded_dispatch(v_claim.id,v_claim.lease_token,h,'gpt-6-astra-2026-09-01'),
    'funded AI review dispatch marker was reusable';
  update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=v_job.id;
  select * into strict v_reclaimed from public.claim_quoted_ai_review_job(180);
  assert v_reclaimed.id=v_job.id and v_reclaimed.lease_token is distinct from v_claim.lease_token,
    'dispatched AI review receipt could not be recovered on a fresh lease';
  assert not public.claim_funded_dispatch(v_reclaimed.id,v_reclaimed.lease_token,h,'gpt-6-astra-2026-09-01'),
    'expired dispatched AI review was sent for generation twice';

  v_tokens:=jsonb_build_array(jsonb_build_object('dimension','text_input','tokens','2'),
    jsonb_build_object('dimension','text_cached_input','tokens','1'),
    jsonb_build_object('dimension','text_output','tokens','1'));
  v_usage:=jsonb_build_object('inputTokens',3,'outputTokens',1,'estimatedCostUsd',0.001,
    'latencyMs',10,'measuredTokens',v_tokens);
  insert into public.ai_review_service_receipts(job_id,request_sha256,result_json)
    values(v_job.id,repeat('c',64),jsonb_build_object('jobId',v_job.id,'workspaceId',f.workspace_id,'bookId',f.book_id,
      'agentType','writer','status','succeeded','provider','openai','model','gpt-6-astra-2026-09-01',
      'requestId','ai-review-receipt-good','usage',v_usage,'diagnostics','[]'::jsonb,'suggestions','[]'::jsonb));
  begin
    perform public.complete_quoted_ai_review_job(v_reclaimed.id,v_reclaimed.lease_token,
      'openai','gpt-6-astra-2026-09-01',
      jsonb_set(v_usage,'{measuredTokens}',jsonb_build_array(jsonb_build_object('dimension','text_input','tokens','3'),
        jsonb_build_object('dimension','text_output','tokens','1'))),
      '[]','[]',jsonb_build_object('status','settle','requestId','ai-review-receipt-mismatch',
        'fingerprint',repeat('b',64),'priceVersion','price-v1','policyVersion','policy-v1',
        'debitCredits','3','releaseCredits','6','tokens',v_tokens));
    assert false,'mismatched provider measurement and settlement tokens completed an AI review';
  exception when check_violation then null; end;
  begin
    perform public.complete_quoted_ai_review_job(v_reclaimed.id,v_reclaimed.lease_token,
      'openai','gpt-6-astra-2026-09-01',v_usage,'[]','[]',jsonb_build_object('status','settle','requestId','ai-review-receipt-good',
        'fingerprint',repeat('b',64),'priceVersion','price-v1','policyVersion','policy-v1',
        'debitCredits','2','releaseCredits','7','providerMicroUsd','1','tokens',v_tokens));
    assert false,'balanced but incorrect measured debit completed an AI review';
  exception when check_violation then null; end;

  -- Failed accounting must roll back the whole completion, leaving the
  -- dispatched reservation held for operator review rather than partially
  -- completing the job or returning credits.
  begin
    perform public.complete_quoted_ai_review_job(v_reclaimed.id,v_reclaimed.lease_token,
      'openai','gpt-6-astra-2026-09-01',
      v_usage,'[]','[]',jsonb_build_object('status','settle','requestId','ai-review-receipt-bad',
        'fingerprint',repeat('b',64),'priceVersion','price-v1','policyVersion','policy-v1',
        'debitCredits','8','releaseCredits','0','tokens',v_tokens));
    assert false,'unbalanced measured settlement completed an AI review';
  exception when check_violation then null; end;
  assert (select status='running' from public.ai_jobs where id=v_job.id)
    and (select status='held' and settlement_json is null from public.funded_usage_quotes where job_id=v_job.id),
    'rejected settlement partially changed the job or reservation';
  assert (select count(*)=0 from public.ai_runs where ai_job_id=v_job.id)
    and (select count(*)=0 from public.usage_events where ai_job_id=v_job.id),
    'rejected settlement wrote usage before accounting validation';

  select * into strict v_job from public.complete_quoted_ai_review_job(v_reclaimed.id,v_reclaimed.lease_token,
    'openai','gpt-6-astra-2026-09-01',
    v_usage,
    '[]','[]',jsonb_build_object('status','settle','requestId','ai-review-receipt-good',
      'fingerprint',repeat('b',64),'priceVersion','price-v1','policyVersion','policy-v1',
      'debitCredits','3','releaseCredits','6','providerMicroUsd','1',
      'tokens',v_tokens));
  assert v_job.status='succeeded' and v_job.lease_token is null and v_job.usage_json->>'inputTokens'='3',
    'valid measured settlement did not complete and release the AI review lease';
  assert (select status='settled' and settled_at is not null and settlement_json->>'debitCredits'='3'
      and settlement_json->>'releaseCredits'='6' from public.funded_usage_quotes where job_id=v_job.id),
    'valid measured settlement was not persisted with the exact quote balance';
  assert (select count(*)=1 from public.credit_ledger where reference_id=v_job.id and source='generation_reservation' and amount=-9)
    and (select count(*)=1 from public.credit_ledger where reference_id=v_job.id and source='generation_release' and amount=6)
    and (select count(*)=0 from public.credit_ledger where reference_id=v_job.id and source='consumption'),
    'settlement ledger does not contain exactly one reservation and remaining-credit release';
  assert (select count(*)=1 from public.ai_runs where ai_job_id=v_job.id and status='succeeded')
    and (select count(*)=1 from public.usage_events where ai_job_id=v_job.id and meter='ai_credits' and quantity=0),
    'successful AI completion usage receipts were not written exactly once';
end $$;
reset role;

rollback;
