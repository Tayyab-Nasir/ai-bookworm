-- Book Bible quote consent, source pinning, funded acceptance, dispatch fencing,
-- and atomic measured settlement. Runs only in disposable PostgreSQL fixtures.
begin;

create temp table bible_quote_fixture (
  user_id uuid, viewer_id uuid, workspace_id uuid, book_id uuid, chapter_id uuid,
  version_id uuid, job_id uuid, request_id uuid
) on commit drop;
grant select,insert,update on bible_quote_fixture to authenticated,service_role;

insert into auth.users(id,email) values
 ('e4600000-0000-4000-8000-000000000001','book-bible-quote-owner@local.test'),
 ('e4600000-0000-4000-8000-000000000002','book-bible-quote-viewer@local.test');
set local role authenticated;
set local request.jwt.claims='{"sub":"e4600000-0000-4000-8000-000000000001"}';
do $$ declare w public.workspaces; b uuid;
begin
  select * into strict w from public.create_workspace_with_owner('Book Bible quote acceptance');
  insert into public.books(workspace_id,title,author_name,language,created_by)
    values(w.id,'The Quiet Atlas','Ada','en',auth.uid()) returning id into b;
  insert into bible_quote_fixture(user_id,viewer_id,workspace_id,book_id,chapter_id,version_id,job_id)
    values(auth.uid(),'e4600000-0000-4000-8000-000000000002',w.id,b,
      'e4600000-0000-4000-8000-000000000011','e4600000-0000-4000-8000-000000000012',
      'e4600000-0000-4000-8000-000000000021');
  assert not has_table_privilege('authenticated','public.book_bible_token_quote_requests','select'),
    'author can read private manuscript quote snapshots';
  assert not has_table_privilege('authenticated','public.book_bible_quote_service_receipts','select'),
    'author can read private provider receipts directly';
  assert not has_function_privilege('authenticated',
    'public.request_book_bible_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,boolean)','execute'),
    'author can call service-only quote request RPC';
  assert not has_function_privilege('authenticated',
    'public.accept_book_bible_token_quote(uuid,uuid,integer)','execute'),
    'author can call service-only quote acceptance RPC';
  assert not has_function_privilege('service_role','public.guard_text_service_receipt()','execute');
end $$;
reset role;

insert into public.workspace_members(workspace_id,user_id,role)
  select workspace_id,viewer_id,'viewer'::public.member_role from bible_quote_fixture;
insert into public.chapters(id,book_id,order_index,title)
  select chapter_id,book_id,0,'The arrival' from bible_quote_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
  select version_id,chapter_id,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Mara carried a silver compass."}]}'::jsonb,
    'Mara carried a silver compass.',5,user_id from bible_quote_fixture;
update public.chapters c set current_document_version_id=f.version_id from bible_quote_fixture f where c.id=f.chapter_id;

set local role service_role;
do $$
declare
  f bible_quote_fixture;
  body jsonb;
  sources jsonb;
  catalog jsonb;
  envelope jsonb;
  replay jsonb;
  ready public.book_bible_token_quote_requests;
  request_id uuid;
  lease uuid;
  q jsonb;
  accepted public.ai_jobs;
  repeated public.ai_jobs;
  claimed public.ai_jobs;
  completed public.ai_jobs;
  another public.ai_jobs;
  another_claim public.ai_jobs;
  source_ref jsonb;
  candidate jsonb;
  measured jsonb;
  settle jsonb;
  input_hash text:=repeat('a',64);
  text_hash text:=encode(public.digest('Mara carried a silver compass.','sha256'),'hex');
  now_at timestamptz:=clock_timestamp();
  another_job uuid;
  another_request uuid;
  another_lease uuid;
  another_hash text;
begin
  assert not has_function_privilege('authenticated',
    'bookworm_private.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)','execute');
  select * into strict f from bible_quote_fixture;
  body:=jsonb_build_object('jobId',f.job_id,'workspaceId',f.workspace_id,'bookId',f.book_id,
    'agentType','bookbible','model','gpt-6-astra','maxOutputTokens',6000,
    'contextPolicy',jsonb_build_object('maxTokens',12000,'includeBookBible',false,'includeStyleGuide',false,
      'includeRelatedContext',false,'semanticTopK',5),
    'input',jsonb_build_object('chapterIds',jsonb_build_array(f.chapter_id),'chapters',jsonb_build_object(f.chapter_id::text,
      jsonb_build_object('id',f.chapter_id,'documentVersionId',f.version_id,'version',1,'title','The arrival','order',0,
        'nodes',jsonb_build_array(jsonb_build_object('id','n1','text','Mara carried a silver compass.','textHash',text_hash,
          'truncated',false,'excerptStart',0,'excerptEnd',30,'fullTextLength',30)))),
      'userInstruction','Extract reviewable entities only.'));
  sources:=jsonb_build_object('versions',jsonb_build_array(jsonb_build_object('chapterId',f.chapter_id,
      'documentVersionId',f.version_id,'version',1)),
    'reading',jsonb_build_object('fingerprint',repeat('f',64),'pageIndex',0));
  catalog:=jsonb_build_object('approved',true,'version','synthetic-test-catalog','expiresAt',now_at+interval '30 minutes',
    'entries',jsonb_build_array(jsonb_build_object('id','gpt-6-astra','maxOutputTokens',6000,
      'price',jsonb_build_object('provider','openai','model','gpt-6-astra','version','price-v1',
        'rates',jsonb_build_array(jsonb_build_object('dimension','text_input','microUsdPerMillionTokens','1000000'),
          jsonb_build_object('dimension','text_cached_input','microUsdPerMillionTokens','1000000'),
          jsonb_build_object('dimension','text_output','microUsdPerMillionTokens','1000000'))),
      'policy',jsonb_build_object('approved',true,'version','policy-v1','microUsdPerCredit','1',
        'markupBasisPoints',10000,'platformMicroUsd','0','minimumCredits','1'))));
  begin
    perform public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,body,catalog,sources,'bible-no-consent',false);
    assert false,'quote accepted without provider token-count consent';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.request_book_bible_token_quote(f.viewer_id,f.book_id,f.workspace_id,f.job_id,body,catalog,sources,'bible-viewer-1',true);
    assert false,'viewer requested a Book Bible quote';
  exception when insufficient_privilege then null; end;
  begin
    perform public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,body,
      jsonb_set(catalog,'{approved}','false'),sources,'bible-unapproved-1',true);
    assert false,'unapproved catalog created a Book Bible quote';
  exception when invalid_parameter_value then null; end;

  envelope:=public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,body,catalog,sources,'bible-quote-1',true);
  assert (envelope->>'claimed')::boolean and envelope#>>'{request,status}'='counting',
    'new quote did not persist explicit consent and a count lease';
  request_id:=(envelope#>>'{request,id}')::uuid; lease:=(envelope#>>'{request,lease_token}')::uuid;
  replay:=public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,body,catalog,sources,'bible-quote-1',true);
  assert not (replay->>'claimed')::boolean and replay#>>'{request,id}'=request_id::text,
    'idempotent quote replay claimed a second count or changed identity';
  begin
    perform public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,f.job_id,
      jsonb_set(body,array['input','userInstruction'],'"changed instruction"'),catalog,sources,'bible-quote-1',true);
    assert false,'quote idempotency accepted different manuscript text';
  exception when unique_violation then null; end;
  assert not exists(select 1 from public.ai_jobs where id=f.job_id)
    and not exists(select 1 from public.funded_usage_quotes where job_id=f.job_id),
    'quote counting created a generation job or reserved credits before author acceptance';

  q:=jsonb_build_object('scope',jsonb_build_object('jobId',f.job_id,'workspaceId',f.workspace_id,'userId',f.user_id,'inputSha256',input_hash),
    'price',jsonb_build_object('provider','openai','model','gpt-6-astra','version','price-v1',
      'rates',jsonb_build_array(jsonb_build_object('dimension','text_input','microUsdPerMillionTokens','1000000'),
        jsonb_build_object('dimension','text_cached_input','microUsdPerMillionTokens','1000000'),
        jsonb_build_object('dimension','text_output','microUsdPerMillionTokens','1000000'))),
    'policy',jsonb_build_object('approved',true,'version','policy-v1','microUsdPerCredit','1','markupBasisPoints',10000,
      'platformMicroUsd','0','minimumCredits','1'),
    'maximumTokens',jsonb_build_array(jsonb_build_object('dimension','text_input','tokens','100'),
      jsonb_build_object('dimension','text_cached_input','tokens','100'),jsonb_build_object('dimension','text_output','tokens','6000')),
    'reservedCredits','6200','maximumProviderMicroUsd','6200','fingerprint',repeat('b',64),
    'createdAt',now_at,'expiresAt',now_at+interval '10 minutes');
  select * into strict ready from public.complete_book_bible_token_quote_count(request_id,f.user_id,lease,input_hash,100,q);
  assert ready.status='ready' and ready.counted_input_tokens=100 and ready.generation_request_sha256=input_hash,
    'counting did not save exact request hash and token count';
  select * into strict ready from public.complete_book_bible_token_quote_count(request_id,f.user_id,lease,input_hash,100,q);
  begin
    perform public.complete_book_bible_token_quote_count(request_id,f.user_id,lease,repeat('c',64),100,q);
    assert false,'ready quote accepted a mismatched count replay';
  exception when unique_violation then null; end;
  insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values('e4600000-0000-4000-8000-000000000013',f.chapter_id,2,
      '{"nodes":[{"id":"n1","type":"paragraph","text":"Mara carried a golden compass."}]}'::jsonb,
      'Mara carried a golden compass.',5,f.user_id);
  update public.chapters set current_document_version_id='e4600000-0000-4000-8000-000000000013' where id=f.chapter_id;
  begin
    perform public.accept_book_bible_token_quote(request_id,f.user_id,6200);
    assert false,'acceptance allowed a stale saved manuscript version';
  exception when serialization_failure then null; end;
  assert not exists(select 1 from public.ai_jobs where id=f.job_id)
    and not exists(select 1 from public.funded_usage_quotes where job_id=f.job_id),
    'stale source acceptance partially created a generation job or reservation';
  update public.chapters set current_document_version_id=f.version_id where id=f.chapter_id;
  begin
    perform public.accept_book_bible_token_quote(request_id,f.user_id,6000);
    assert false,'quote accepted a changed displayed credit amount';
  exception when check_violation then null; end;
  begin
    perform public.accept_book_bible_token_quote(request_id,f.viewer_id,6200);
    assert false,'another author accepted this quote';
  exception when no_data_found then null; end;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
    values(f.user_id,f.workspace_id,'purchase',10000,0);
  select * into strict accepted from public.accept_book_bible_token_quote(request_id,f.user_id,6200);
  assert accepted.id=f.job_id and accepted.agent_type='bookbible' and accepted.billing_mode='quoted' and accepted.status='queued',
    'acceptance did not create its pinned quoted Book Bible job';
  assert accepted.input_ref->>'generationRequestSha256'=input_hash
    and accepted.input_ref#>>'{reading,fingerprint}'=repeat('f',64)
    and jsonb_array_length(accepted.input_ref->'contextSources')=1,
    'accepted job omitted its exact request hash, reading page or trusted source refs';
  assert (select status='held' and reserved_credits=6200 from public.funded_usage_quotes where job_id=f.job_id)
    and (select count(*)=1 from public.credit_ledger where reference_id=f.job_id and source='generation_reservation' and amount=-6200)
    and not exists(select 1 from public.usage_events where ai_job_id=f.job_id),
    'acceptance failed to atomically reserve exact credits without operational charge';
  select * into strict repeated from public.accept_book_bible_token_quote(request_id,f.user_id,6200);
  assert repeated.id=accepted.id and (select count(*)=1 from public.ai_jobs where id=f.job_id)
    and (select count(*)=1 from public.credit_ledger where reference_id=f.job_id and source='generation_reservation'),
    'acceptance replay duplicated the job or reservation';
  select * into strict claimed from public.claim_quoted_book_bible_job(180);
  assert claimed.id=f.job_id and claimed.status='running' and claimed.lease_token is not null,
    'quoted Book Bible job could not be claimed';
  assert not exists(select 1 from public.claim_quoted_book_bible_job(180)),
    'a live pre-dispatch lease was stolen';
  update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=f.job_id;
  select * into strict repeated from public.claim_quoted_book_bible_job(180);
  assert repeated.id=f.job_id and repeated.lease_token<>claimed.lease_token and repeated.attempts=claimed.attempts+1,
    'a worker stopped before dispatch left an unrecoverable funded job';
  begin
    perform public.claim_funded_dispatch(f.job_id,claimed.lease_token,input_hash,'gpt-6-astra');
    assert false,'expired previous worker could dispatch after its lease was replaced';
  exception when serialization_failure then null; end;
  claimed:=repeated;
  assert public.claim_funded_dispatch(f.job_id,claimed.lease_token,input_hash,'gpt-6-astra'),
    'quoted Book Bible job could not claim one-way dispatch';
  assert not public.claim_funded_dispatch(f.job_id,claimed.lease_token,input_hash,'gpt-6-astra'),
    'quoted Book Bible dispatch marker was reusable';
  update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=f.job_id;
  select * into strict repeated from public.claim_quoted_book_bible_job(180);
  assert repeated.id=f.job_id and repeated.lease_token<>claimed.lease_token,
    'dispatched job cannot reclaim an expired lease to read its receipt';
  claimed:=repeated;
  assert not public.claim_funded_dispatch(f.job_id,claimed.lease_token,input_hash,'gpt-6-astra'),
    'lease replacement allowed a second provider dispatch';
  assert public.renew_quoted_book_bible_lease(f.job_id,claimed.lease_token,180),
    'quoted Book Bible lease could not renew';

  source_ref:=jsonb_build_object('chapterId',f.chapter_id,'documentVersionId',f.version_id,'nodeId','n1','textHash',text_hash);
  candidate:=jsonb_build_object('suggestionKind','book_bible_candidate','status','pending','type','character','name','Mara',
    'description','A traveler carrying a compass.','attributes',jsonb_build_object('object','silver compass'),
    'sourceRefs',jsonb_build_array(source_ref),'confidence',0.9);
  measured:=jsonb_build_object('inputTokens',20,'outputTokens',5,'estimatedCostUsd',0.000025,'latencyMs',15,
    'measuredTokens',jsonb_build_array(jsonb_build_object('dimension','text_input','tokens','18'),
      jsonb_build_object('dimension','text_cached_input','tokens','2'),jsonb_build_object('dimension','text_output','tokens','5')));
  settle:=jsonb_build_object('status','settle','requestId','provider-request-bible-1','fingerprint',repeat('b',64),
    'priceVersion','price-v1','policyVersion','policy-v1','providerMicroUsd','25','debitCredits','25','releaseCredits','6175',
    'tokens',measured->'measuredTokens');
  begin
    perform public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra','provider-request-bible-1',
      measured,'[]',jsonb_build_array(candidate),settle);
    assert false,'Book Bible completed without a durable raw provider result';
  exception when check_violation then null; end;
  -- This fingerprint hashes the full HTTP request, not the counted prompt.
  insert into public.book_bible_service_receipts(job_id,request_sha256,result_json)
    values(f.job_id,repeat('e',64),null);
  begin
    perform public.complete_quoted_book_bible_job(f.job_id,null,'openai','gpt-6-astra','provider-request-bible-1',
      measured,'[]',jsonb_build_array(candidate),settle);
    assert false,'null Book Bible completion lease accepted';
  exception when serialization_failure then null; end;
  update public.book_bible_service_receipts set result_json=jsonb_build_object('jobId',f.job_id,'workspaceId',f.workspace_id,
    'bookId',f.book_id,'agentType','bookbible','status','succeeded','provider','openai','model','gpt-6-astra',
    'requestId','provider-request-bible-1','usage',measured,'diagnostics','[]'::jsonb,'suggestions',jsonb_build_array(candidate))
    where job_id=f.job_id and result_json is null;
  begin
    update public.book_bible_service_receipts set result_json=null where job_id=f.job_id;
    assert false,'saved Book Bible receipt was cleared';
  exception when check_violation then null; end;
  begin
    update public.book_bible_service_receipts set request_sha256=repeat('f',64) where job_id=f.job_id;
    assert false,'saved Book Bible receipt request identity changed';
  exception when check_violation then null; end;
  begin
    perform public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra','provider-request-bible-1',
      measured,'[]',jsonb_build_array(jsonb_set(candidate,'{name}','"Forged candidate"')),settle);
    assert false,'Book Bible output differed from its durable provider receipt';
  exception when check_violation then null; end;
  begin
    perform public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra','provider-request-bible-1',
      jsonb_set(measured,'{measuredTokens,0,tokens}','"19"'), '[]',jsonb_build_array(candidate),settle);
    assert false,'mismatched settlement and measured receipt completed';
  exception when check_violation then null; end;
  begin
    perform public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra','provider-request-bible-bad',
      measured,'[]',jsonb_build_array(candidate),jsonb_set(settle,'{debitCredits}','"24"'));
    assert false,'incorrect measured-token credit settlement completed';
  exception when check_violation then null; end;
  assert (select status='running' from public.ai_jobs where id=f.job_id)
    and (select status='held' and settlement_json is null from public.funded_usage_quotes where job_id=f.job_id)
    and not exists(select 1 from public.ai_runs where ai_job_id=f.job_id)
    and not exists(select 1 from public.book_bible_quote_service_receipts where job_id=f.job_id),
    'failed completion partially settled, wrote receipts, or changed the job';

  select * into strict completed from public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra',
    'provider-request-bible-1',measured,'[]',jsonb_build_array(candidate),settle);
  assert completed.status='succeeded' and completed.lease_token is null
    and completed.output_ref->'candidates'=jsonb_build_array(candidate)
    and completed.output_ref->>'savedBibleUpdated'='false',
    'measured Book Bible completion did not save a review-only candidate atomically';
  assert (select status='settled' and settlement_json->>'debitCredits'='25' and settlement_json->>'releaseCredits'='6175'
      from public.funded_usage_quotes where job_id=f.job_id)
    and (select count(*)=1 from public.credit_ledger where reference_id=f.job_id and source='generation_reservation' and amount=-6200)
    and (select count(*)=1 from public.credit_ledger where reference_id=f.job_id and source='generation_release' and amount=6175)
    and not exists(select 1 from public.credit_ledger where reference_id=f.job_id and source='consumption'),
    'measured settlement did not debit actual use and release the exact remainder without legacy debit';
  assert (select count(*)=1 from public.ai_runs where ai_job_id=f.job_id and provider='openai' and model='gpt-6-astra')
    and (select count(*)=1 from public.usage_events where ai_job_id=f.job_id and meter='ai_credits' and quantity=0)
    and (select receipt.request_id='provider-request-bible-1' and receipt.result_json->'usage'=measured
      from public.book_bible_quote_service_receipts receipt where receipt.job_id=f.job_id),
    'atomic Book Bible AI run, zero operational usage marker, or provider receipt missing';
  select * into strict repeated from public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra',
    'provider-request-bible-1',measured,'[]',jsonb_build_array(candidate),settle);
  assert repeated.id=f.job_id and (select count(*)=1 from public.ai_runs where ai_job_id=f.job_id)
    and (select count(*)=1 from public.usage_events where ai_job_id=f.job_id)
    and (select count(*)=1 from public.book_bible_quote_service_receipts where job_id=f.job_id),
    'identical successful completion replay duplicated accounting or receipt';
  begin
    perform public.complete_quoted_book_bible_job(f.job_id,claimed.lease_token,'openai','gpt-6-astra','other-request',
      measured,'[]',jsonb_build_array(candidate),settle);
    assert false,'successful job accepted a different completion replay';
  exception when unique_violation then null; end;

  -- A second page with no provider dispatch can be safely released; it must
  -- never receive an automatic refund after the one-way marker is written.
  another_job:='e4600000-0000-4000-8000-000000000031';
  another_hash:=repeat('c',64);
  body:=jsonb_set(body,'{jobId}',to_jsonb(another_job));
  sources:=jsonb_set(sources,'{reading,fingerprint}',to_jsonb(repeat('e',64)));
  sources:=jsonb_set(sources,'{reading,pageIndex}','1');
  envelope:=public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,another_job,body,catalog,sources,'bible-quote-release',true);
  another_request:=(envelope#>>'{request,id}')::uuid; another_lease:=(envelope#>>'{request,lease_token}')::uuid;
  q:=jsonb_set(q,'{scope,jobId}',to_jsonb(another_job));
  q:=jsonb_set(q,'{scope,inputSha256}',to_jsonb(another_hash));
  q:=jsonb_set(q,'{fingerprint}',to_jsonb(repeat('d',64)));
  q:=jsonb_set(q,'{createdAt}',to_jsonb(clock_timestamp()));
  q:=jsonb_set(q,'{expiresAt}',to_jsonb(clock_timestamp()+interval '10 minutes'));
  perform public.complete_book_bible_token_quote_count(another_request,f.user_id,another_lease,another_hash,100,q);
  select * into strict another from public.accept_book_bible_token_quote(another_request,f.user_id,6200);
  select * into strict another_claim from public.claim_quoted_book_bible_job(180);
  assert another_claim.id=another_job and public.release_quoted_book_bible_before_dispatch(another_job,another_claim.lease_token,'request_mismatch'),
    'undispatched Book Bible request could not be safely released';
  assert (select status='cancelled' and dispatched_at is null from public.funded_usage_quotes where job_id=another_job)
    and (select count(*)=1 from public.credit_ledger where reference_id=another_job and source='generation_release' and amount=6200)
    and (select status='failed' from public.ai_jobs where id=another_job),
    'pre-dispatch Book Bible failure did not atomically return the exact held credits';

  another_job:='e4600000-0000-4000-8000-000000000032';
  another_hash:=repeat('d',64);
  body:=jsonb_set(body,'{jobId}',to_jsonb(another_job));
  sources:=jsonb_set(sources,'{reading,fingerprint}',to_jsonb(repeat('a',64)));
  sources:=jsonb_set(sources,'{reading,pageIndex}','2');
  envelope:=public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,another_job,body,catalog,sources,'bible-quote-hold',true);
  another_request:=(envelope#>>'{request,id}')::uuid; another_lease:=(envelope#>>'{request,lease_token}')::uuid;
  q:=jsonb_set(q,'{scope,jobId}',to_jsonb(another_job));
  q:=jsonb_set(q,'{scope,inputSha256}',to_jsonb(another_hash));
  q:=jsonb_set(q,'{fingerprint}',to_jsonb(repeat('e',64)));
  q:=jsonb_set(q,'{createdAt}',to_jsonb(clock_timestamp()));
  q:=jsonb_set(q,'{expiresAt}',to_jsonb(clock_timestamp()+interval '10 minutes'));
  perform public.complete_book_bible_token_quote_count(another_request,f.user_id,another_lease,another_hash,100,q);
  perform public.accept_book_bible_token_quote(another_request,f.user_id,6200);
  select * into strict another_claim from public.claim_quoted_book_bible_job(180);
  assert another_claim.id=another_job and public.claim_funded_dispatch(another_job,another_claim.lease_token,another_hash,'gpt-6-astra'),
    'second Book Bible job did not acquire dispatch fence';
  assert public.hold_quoted_book_bible_for_review(another_job,another_claim.lease_token,'provider_outcome_unknown','bible-timeout-2'),
    'unknown Book Bible provider outcome could not be held for review';
  assert (select status='requires_review' and dispatched_at is not null
      and settlement_json->>'heldCredits'='6200' from public.funded_usage_quotes where job_id=another_job)
    and not exists(select 1 from public.credit_ledger where reference_id=another_job and source='generation_release')
    and (select status='failed' from public.ai_jobs where id=another_job),
    'dispatched uncertain Book Bible job was refunded or not retained for review';

  -- A process can stop after claiming but before dispatch. If its saved source
  -- changes while its lease is alive, leave it alone; on lease expiry cancel
  -- and return its hold exactly once, without touching the earlier review hold.
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
    values(f.user_id,f.workspace_id,'purchase',10000,0);
  another_job:='e4600000-0000-4000-8000-000000000033';
  body:=jsonb_set(body,'{jobId}',to_jsonb(another_job));
  sources:=jsonb_set(sources,'{reading,pageIndex}','3');
  envelope:=public.request_book_bible_token_quote(f.user_id,f.book_id,f.workspace_id,another_job,body,catalog,sources,'bible-stopped-before-dispatch',true);
  another_request:=(envelope#>>'{request,id}')::uuid; another_lease:=(envelope#>>'{request,lease_token}')::uuid;
  q:=jsonb_set(q,'{scope,jobId}',to_jsonb(another_job));
  perform public.complete_book_bible_token_quote_count(another_request,f.user_id,another_lease,another_hash,100,q);
  perform public.accept_book_bible_token_quote(another_request,f.user_id,6200);
  select * into strict another_claim from public.claim_quoted_book_bible_job(180);
  update public.chapters set current_document_version_id='e4600000-0000-4000-8000-000000000013' where id=f.chapter_id;
  perform public.claim_quoted_book_bible_job(180);
  assert (select status='running' and lease_token=another_claim.lease_token from public.ai_jobs where id=another_job),
    'cleanup changed a worker with a live lease';
  update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=another_job;
  assert not exists(select 1 from public.claim_quoted_book_bible_job(180)), 'stale source was dispatched after worker restart';
  perform public.claim_quoted_book_bible_job(180);
  assert (select status='cancelled' and dispatched_at is null from public.funded_usage_quotes where job_id=another_job)
    and (select count(*)=1 from public.credit_ledger where reference_id=another_job and source='generation_release' and amount=6200)
    and (select status='failed' and lease_token is null and lease_expires_at is null
      and error_code='book_bible_source_changed_before_dispatch' from public.ai_jobs where id=another_job),
    'abandoned stale pre-dispatch job did not release its hold exactly once';
  assert (select status='requires_review' from public.funded_usage_quotes where job_id='e4600000-0000-4000-8000-000000000032'),
    'cleanup released an unrelated dispatched review hold';
end $$;
reset role;
rollback;
