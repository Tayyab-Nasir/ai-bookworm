begin;
create temp table text_quote_fixture(owner_id uuid,workspace_id uuid,book_id uuid,chapter_id uuid,version_id uuid) on commit drop;
grant all on text_quote_fixture to authenticated,service_role;
insert into auth.users(id,email) values('e4300000-0000-4000-8000-000000000001','text-quote-recovery@local.test');
set local role authenticated;
set local request.jwt.claims='{"sub":"e4300000-0000-4000-8000-000000000001"}';
do $$ declare w public.workspaces; b uuid; begin
  select * into strict w from public.create_workspace_with_owner('Text quote recovery');
  insert into public.books(workspace_id,title,author_name,language,created_by)
    values(w.id,'Recovery Book','Quote Author','en',auth.uid()) returning id into b;
  insert into text_quote_fixture values(auth.uid(),w.id,b,'e4300000-0000-4000-8000-000000000011','e4300000-0000-4000-8000-000000000012');
end $$;
reset role;
insert into public.chapters(id,book_id,title,order_index) select chapter_id,book_id,'Opening',0 from text_quote_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
  select version_id,chapter_id,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"A quiet map recalls the road."}]}','A quiet map recalls the road.',6,owner_id from text_quote_fixture;
update public.chapters c set current_document_version_id=f.version_id from text_quote_fixture f where c.id=f.chapter_id;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
  select 'e4300000-0000-4000-8000-000000000013',chapter_id,2,'{"nodes":[{"id":"n1","type":"paragraph","text":"A revised quiet map."}]}','A revised quiet map.',4,owner_id from text_quote_fixture;
insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) select owner_id,workspace_id,'purchase',100,0 from text_quote_fixture;

create function pg_temp.text_quote_job(kind text,separate_book boolean default false) returns uuid language plpgsql as $$
declare f text_quote_fixture; j uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); request_json jsonb; q jsonb; current_id uuid; version_number integer;
begin
  select * into strict f from text_quote_fixture;
  if separate_book then
    f.book_id:=gen_random_uuid(); f.chapter_id:=gen_random_uuid(); f.version_id:=gen_random_uuid();
    insert into public.books(id,workspace_id,title,author_name,language,created_by)
      values(f.book_id,f.workspace_id,'Another queued book','Quote Author','en',f.owner_id);
    insert into public.chapters(id,book_id,title,order_index) values(f.chapter_id,f.book_id,'Another opening',0);
    insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
      values(f.version_id,f.chapter_id,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Another book remembers its road."}]}',
        'Another book remembers its road.',5,f.owner_id);
    update public.chapters set current_document_version_id=f.version_id where id=f.chapter_id;
  end if;
  select c.current_document_version_id,d.version_number into current_id,version_number from public.chapters c
    join public.document_versions d on d.id=c.current_document_version_id where c.id=f.chapter_id;
  request_json:=jsonb_build_object('jobId',j,'workspaceId',f.workspace_id,'bookId',f.book_id,'agentType',kind,
    'model','text-test','maxOutputTokens',1000,'contextPolicy','{}'::jsonb,
    'input',jsonb_build_object('chapterIds',jsonb_build_array(f.chapter_id),'userInstruction','Review source.',
      'chapters',jsonb_build_object(f.chapter_id::text,jsonb_build_object('documentVersionId',current_id,'id',f.chapter_id,
        'version',version_number,'title','Opening','nodes',jsonb_build_array(jsonb_build_object('id','n1','textHash',repeat('d',64)))))));
  q:=jsonb_build_object('scope',jsonb_build_object('jobId',j,'workspaceId',f.workspace_id,'userId',f.owner_id,'inputSha256',repeat('a',64)),
    'price',jsonb_build_object('provider','openai','model','text-test','version','price-v1','rates',jsonb_build_array(
      jsonb_build_object('dimension','text_input','microUsdPerMillionTokens','1000000'),
      jsonb_build_object('dimension','text_cached_input','microUsdPerMillionTokens','100000'),
      jsonb_build_object('dimension','text_output','microUsdPerMillionTokens','2000000'))),
    'policy',jsonb_build_object('approved',true,'version','policy-v1','microUsdPerCredit','1000','markupBasisPoints',15000,
      'platformMicroUsd','100','minimumCredits','1'),
    'maximumTokens',jsonb_build_array(jsonb_build_object('dimension','text_input','tokens','1000'),
      jsonb_build_object('dimension','text_cached_input','tokens','1000'),jsonb_build_object('dimension','text_output','tokens','1000')),
    'reservedCredits','5','maximumProviderMicroUsd','3100','fingerprint',repeat('c',64),
    'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '30 minutes');
  if kind='metadata' then
    insert into public.metadata_token_quote_requests(id,user_id,workspace_id,book_id,generation_job_id,idempotency_key,generation_request_json,
      catalog_json,source_sha256,generation_request_sha256,usage_quote_json,quote_expires_at,status)
      values(r,f.owner_id,f.workspace_id,f.book_id,j,r::text,request_json,'{"approved":true}',repeat('b',64),repeat('a',64),q,
        (q->>'expiresAt')::timestamptz,'ready');
    insert into public.ai_jobs(id,workspace_id,book_id,created_by,agent_type,billing_mode,status,idempotency_key,input_ref)
      values(j,f.workspace_id,f.book_id,f.owner_id,kind,'quoted','queued',j::text,jsonb_build_object('metadataQuoteRequestId',r,
        'sourceSha256',repeat('b',64),'generationRequestSha256',repeat('a',64),'contextSources',jsonb_build_array(
          jsonb_build_object('chapterId',f.chapter_id,'documentVersionId',current_id,'nodeId','n1','textHash',repeat('d',64)))));
    perform public.reserve_funded_usage_quote(q);
    update public.metadata_token_quote_requests set accepted_job_id=j,accepted_at=clock_timestamp() where id=r;
  else
    insert into public.ai_review_token_quote_requests(id,user_id,workspace_id,book_id,generation_job_id,idempotency_key,generation_request_json,
      catalog_json,source_versions_json,status,request_sha256,counted_input_tokens,usage_quote_json)
      values(r,f.owner_id,f.workspace_id,f.book_id,j,r::text,request_json,'{"approved":true}',jsonb_build_array(
        jsonb_build_object('chapterId',f.chapter_id,'documentVersionId',current_id,'version',version_number)),
        'ready',repeat('a',64),1000,q);
    insert into public.ai_jobs(id,workspace_id,book_id,created_by,agent_type,billing_mode,status,idempotency_key,input_ref,model)
      values(j,f.workspace_id,f.book_id,f.owner_id,kind,'quoted','queued',j::text,jsonb_build_object('aiReviewQuoteRequestId',r,
        'generationRequestSha256',repeat('a',64),'chapterVersions',jsonb_build_array(jsonb_build_object('chapterId',f.chapter_id,
          'documentVersionId',current_id,'version',version_number))), 'text-test');
    perform public.reserve_funded_usage_quote(q);
    update public.ai_review_token_quote_requests set accepted_job_id=j,accepted_at=clock_timestamp() where id=r;
  end if;
  return j;
end $$;
grant execute on function pg_temp.text_quote_job(text,boolean) to service_role;
set local role service_role;
do $$
declare f text_quote_fixture; j uuid; newer uuid; claimed public.ai_jobs; reclaimed public.ai_jobs; kind text;
  candidate jsonb; usage jsonb; settlement jsonb; receipt jsonb; completed public.ai_jobs;
  quote_json jsonb; malformed jsonb; raw_suggestions jsonb; suggestions jsonb; suggestion_id uuid:=gen_random_uuid();
begin
  select * into strict f from text_quote_fixture;
  assert not has_function_privilege('authenticated','public.complete_quoted_metadata_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)','execute');
  assert not has_schema_privilege('authenticated','bookworm_private','usage');
  assert not has_function_privilege('authenticated','bookworm_private.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute');
  assert not has_function_privilege('authenticated','bookworm_private.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)','execute');
  assert not has_function_privilege('authenticated','bookworm_private.assert_text_quote_settlement(jsonb,jsonb,jsonb)','execute');
  foreach kind in array array['metadata','proofreader'] loop
    j:=pg_temp.text_quote_job(kind);
    if kind='metadata' then select * into strict claimed from public.claim_quoted_metadata_job(180);
    else select * into strict claimed from public.claim_quoted_ai_review_job(180); end if;
    assert claimed.id=j;
    assert not exists(select 1 from public.claim_quoted_text_job(case when kind='metadata' then 'metadata' else 'review' end,180)), 'live lease was reclaimed';
    update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second',available_at=clock_timestamp()-interval '1 minute' where id=j;
    select * into strict reclaimed from public.claim_quoted_text_job(case when kind='metadata' then 'metadata' else 'review' end,180);
    assert reclaimed.id=j and reclaimed.lease_token is distinct from claimed.lease_token,'undispatched expired lease was stranded';
    begin
      if kind='metadata' then perform public.fail_quoted_metadata_before_dispatch(j,reclaimed.lease_token,null);
      else perform public.release_quoted_ai_review_before_dispatch(j,reclaimed.lease_token,null); end if;
      assert false,'null cancellation reason accepted'; exception when invalid_parameter_value then null; end;
    update public.ai_jobs set lease_token=null,lease_expires_at=null where id=j;
    begin
      if kind='metadata' then perform public.fail_quoted_metadata_before_dispatch(j,null,'request_mismatch');
      else perform public.release_quoted_ai_review_before_dispatch(j,null,'request_mismatch'); end if;
      assert false,'null cancellation lease released credits'; exception when serialization_failure then null; end;
    update public.ai_jobs set lease_token=reclaimed.lease_token,lease_expires_at=clock_timestamp()+interval '3 minutes' where id=j;
    assert (select status from public.funded_usage_quotes where job_id=j)='held';
    if kind='metadata' then
      begin perform public.renew_quoted_metadata_lease(j,reclaimed.lease_token,null);
        assert false,'null renewal duration accepted'; exception when invalid_parameter_value then null; end;
    end if;
    begin perform public.claim_funded_dispatch(j,claimed.lease_token,repeat('a',64),'text-test');
      assert false,'old text lease dispatched'; exception when serialization_failure then null; end;
    update public.workspace_members set role='designer' where workspace_id=f.workspace_id and user_id=f.owner_id;
    begin perform public.claim_funded_dispatch(j,reclaimed.lease_token,repeat('a',64),'text-test');
      assert false,'downgraded nonwriting role dispatched text'; exception when insufficient_privilege then null; end;
    assert (select dispatched_at is null from public.funded_usage_quotes where job_id=j);
    update public.workspace_members set role='owner' where workspace_id=f.workspace_id and user_id=f.owner_id;
    -- A source edit after claim must still prevent the irreversible dispatch marker.
    update public.chapters set current_document_version_id='e4300000-0000-4000-8000-000000000013' where id=f.chapter_id;
    begin perform public.claim_funded_dispatch(j,reclaimed.lease_token,repeat('a',64),'text-test');
      assert false,'stale source dispatched'; exception when serialization_failure then null; end;
    update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second',available_at=clock_timestamp()-interval '1 minute' where id=j;
    newer:=pg_temp.text_quote_job(kind,true);
    select * into strict claimed from public.claim_quoted_text_job(case when kind='metadata' then 'metadata' else 'review' end,180);
    assert claimed.id=newer and (select status from public.funded_usage_quotes where job_id=j)='cancelled','stale job blocked later valid work';
    perform public.claim_quoted_text_job(case when kind='metadata' then 'metadata' else 'review' end,180);
    assert (select count(*) from public.credit_ledger where reference_id=j and source='generation_release')=1,'stale hold released twice';
    assert public.claim_funded_dispatch(newer,claimed.lease_token,repeat('a',64),'text-test');
    update public.ai_jobs set lease_token=null,lease_expires_at=null where id=newer;
    begin
      if kind='metadata' then perform public.mark_quoted_metadata_requires_review(newer,null,'provider_outcome_unknown','invalid-null-lease');
      else perform public.hold_quoted_ai_review_for_review(newer,null,'provider_outcome_unknown','invalid-null-lease'); end if;
      assert false,'null lease wrote a text review hold'; exception when serialization_failure then null; end;
    update public.ai_jobs set lease_token=claimed.lease_token,lease_expires_at=clock_timestamp()+interval '3 minutes' where id=newer;
    if kind='metadata' then assert public.mark_quoted_metadata_requires_review(newer,claimed.lease_token,'provider_outcome_unknown','test-held-metadata');
    else assert public.hold_quoted_ai_review_for_review(newer,claimed.lease_token,'provider_outcome_unknown','test-held-review'); end if;
    assert (select status from public.funded_usage_quotes where job_id=newer)='requires_review'
      and not exists(select 1 from public.credit_ledger where reference_id=newer and source='generation_release');
    update public.chapters set current_document_version_id=f.version_id where id=f.chapter_id;
  end loop;

  j:=pg_temp.text_quote_job('metadata');
  select * into strict claimed from public.claim_quoted_metadata_job(180);
  assert public.claim_funded_dispatch(j,claimed.lease_token,repeat('a',64),'text-test');
  candidate:=jsonb_build_object('suggestionKind','metadata_candidate','status','pending',
    'description','A quiet map and its keeper lead readers through the secret roads of a winter town.',
    'keywords',jsonb_build_array('winter map'),'categories',jsonb_build_array('Fiction / Mystery'),'audience','Adults',
    'rationale','Opening source establishes the map.','confidence',0.9,'sourceRefs',jsonb_build_array(
      jsonb_build_object('chapterId',f.chapter_id,'documentVersionId',f.version_id,'nodeId','n1','textHash',repeat('d',64))));
  usage:=jsonb_build_object('inputTokens',90,'outputTokens',60,'estimatedCostUsd',0.0002,'measuredTokens',jsonb_build_array(
    jsonb_build_object('dimension','text_input','tokens','80'),jsonb_build_object('dimension','text_cached_input','tokens','10'),
    jsonb_build_object('dimension','text_output','tokens','60')));
  settlement:=jsonb_build_object('status','settle','requestId','metadata-native-receipt','fingerprint',repeat('c',64),
    'priceVersion','price-v1','policyVersion','policy-v1','providerMicroUsd','201','debitCredits','1','releaseCredits','4',
    'tokens',jsonb_build_array(jsonb_build_object('dimension','text_cached_input','tokens','10'),
      jsonb_build_object('dimension','text_input','tokens','80'),jsonb_build_object('dimension','text_output','tokens','60')));
  receipt:=jsonb_build_object('jobId',j,'workspaceId',f.workspace_id,'bookId',f.book_id,'agentType','metadata','status','succeeded',
    'provider','openai','model','text-test','requestId','metadata-native-receipt','usage',usage,'diagnostics','[]'::jsonb,'suggestions',jsonb_build_array(candidate));
  insert into public.metadata_service_receipts(job_id,request_sha256,result_json) values(j,repeat('e',64),receipt);
  begin update public.metadata_service_receipts set request_sha256=repeat('f',64) where job_id=j;
    assert false,'receipt request identity changed'; exception when check_violation then null; end;
  begin update public.metadata_service_receipts set result_json=null where job_id=j;
    assert false,'receipt result was erased'; exception when check_violation then null; end;
  begin perform public.complete_metadata_ai_job(j,'openai','text-test',usage,'[]',candidate,0);
    assert false,'legacy completion bypassed quoted lease'; exception when check_violation then null; end;
  begin perform public.complete_quoted_metadata_job(j,gen_random_uuid(),'openai','text-test',usage,'[]',candidate,settlement);
    assert false,'stale lease settled metadata'; exception when serialization_failure then null; end;
  begin perform public.complete_quoted_metadata_job(j,claimed.lease_token,'openai','text-test',usage,'[]',candidate,
      jsonb_set(jsonb_set(settlement,'{debitCredits}','"2"'),'{releaseCredits}','"3"'));
    assert false,'wrong measured arithmetic settled metadata'; exception when check_violation then null; end;
  begin perform public.complete_quoted_metadata_job(j,claimed.lease_token,'openai','text-test',jsonb_set(usage,'{inputTokens}','91'),'[]',candidate,settlement);
    assert false,'completion differed from durable receipt'; exception when check_violation then null; end;
  assert (select status from public.funded_usage_quotes where job_id=j)='held'
    and not exists(select 1 from public.ai_runs where ai_job_id=j),'rejected settlement partially wrote';
  update public.workspace_members set role='viewer' where workspace_id=f.workspace_id and user_id=f.owner_id;
  begin perform public.complete_quoted_metadata_job(j,claimed.lease_token,'openai','text-test',usage,'[]',candidate,settlement);
    assert false,'revoked editor completed metadata'; exception when insufficient_privilege then null; end;
  assert (select status from public.funded_usage_quotes where job_id=j)='held'
    and not exists(select 1 from public.credit_ledger where reference_id=j and source='generation_release');
  update public.workspace_members set role='owner' where workspace_id=f.workspace_id and user_id=f.owner_id;
  select * into strict completed from public.complete_quoted_metadata_job(j,claimed.lease_token,'openai','text-test',usage,'[]',candidate,settlement);
  assert completed.status='succeeded' and completed.lease_token is null;
  update public.workspace_members set role='viewer' where workspace_id=f.workspace_id and user_id=f.owner_id;
  select * into strict completed from public.complete_quoted_metadata_job(j,claimed.lease_token,'openai','text-test',usage,'[]',candidate,settlement);
  assert completed.status='succeeded' and (select count(*) from public.ai_runs where ai_job_id=j)=1
    and (select count(*) from public.credit_ledger where reference_id=j and source='generation_release')=1;

  update public.workspace_members set role='owner' where workspace_id=f.workspace_id and user_id=f.owner_id;
  j:=pg_temp.text_quote_job('proofreader');
  select * into strict claimed from public.claim_quoted_ai_review_job(180);
  assert public.claim_funded_dispatch(j,claimed.lease_token,repeat('a',64),'text-test');
  settlement:=jsonb_set(settlement,'{requestId}','"review-native-receipt"');
  raw_suggestions:=jsonb_build_array(jsonb_build_object('chapterId',f.chapter_id,'nodeId','n1',
    'rationale',E'  Clearer opening.\n','operation',jsonb_build_object('operationId','provider-generated',
      'type','replace_text','expectedVersion',99,'target',jsonb_build_object('chapterId',f.chapter_id,'nodeId','n1','ignoredBySchema',true),
      'payload',jsonb_build_object('nodeId','n1','from',0,'to',1,'text','The'))));
  suggestions:=jsonb_build_array(jsonb_build_object('id',suggestion_id,'entityType','chapter','entityId',f.chapter_id,
    'rationale','Clearer opening.','confidence',null,'operation',jsonb_build_object('operationId','ai:'||suggestion_id,
      'type','replace_text','expectedVersion',1,'source','ai','sourceRef',suggestion_id,
      'target',jsonb_build_object('chapterId',f.chapter_id,'nodeId','n1'),
      'payload',jsonb_build_object('nodeId','n1','from',0,'to',1,'text','The'))));
  receipt:=jsonb_build_object('jobId',j,'workspaceId',f.workspace_id,'bookId',f.book_id,'agentType','proofreader','status','succeeded',
    'provider','openai','model','text-test','requestId','review-native-receipt','usage',usage,'diagnostics','[]'::jsonb,'suggestions',raw_suggestions);
  insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(j,repeat('e',64),receipt);
  begin perform public.complete_ai_job(j,'openai','text-test',usage,'[]',suggestions,0);
    assert false,'legacy completion bypassed quoted AI review lease'; exception when check_violation then null; end;
  begin perform public.complete_quoted_ai_review_job(j,claimed.lease_token,'openai','text-test',usage,'[]',
      jsonb_set(suggestions,'{0,operation,payload,text}','"Invented output"'),settlement);
    assert false,'review output differed from saved provider receipt'; exception when check_violation then null; end;
  begin perform public.complete_quoted_ai_review_job(j,claimed.lease_token,'openai','text-test',usage,'[]',suggestions,
      jsonb_set(jsonb_set(settlement,'{debitCredits}','"2"'),'{releaseCredits}','"3"'));
    assert false,'balanced wrong measured AI review debit accepted'; exception when check_violation then null; end;
  select q.quote_json into quote_json from public.funded_usage_quotes q where q.job_id=j;
  foreach malformed in array array[
    jsonb_set(usage,'{inputTokens}','null'),
    jsonb_set(usage,'{inputTokens}','"90"'),
    jsonb_set(usage,'{measuredTokens,0,tokens}','"-1"'),
    jsonb_set(usage,'{measuredTokens,0,tokens}','"1.5"'),
    jsonb_set(usage,'{measuredTokens,0,tokens}','80'),
    jsonb_set(usage,'{measuredTokens,0,dimension}','"image_input"'),
    jsonb_set(usage,'{measuredTokens,0,dimension}','"text_output"'),
    jsonb_set(usage,'{measuredTokens,0,unpriced}','true')
  ] loop
    begin perform bookworm_private.assert_text_quote_settlement(quote_json,malformed,
        jsonb_set(settlement,'{tokens}',malformed->'measuredTokens'));
      assert false,'malformed text dimensions or aggregate accepted'; exception when check_violation then null; end;
  end loop;
  -- A running row with null lease fields is not authority to commit a result.
  update public.ai_jobs set lease_token=null,lease_expires_at=null where id=j;
  begin perform public.complete_quoted_ai_review_job(j,null,'openai','text-test',usage,'[]',suggestions,settlement);
    assert false,'null AI review lease settled'; exception when serialization_failure then null; end;
  update public.ai_jobs set lease_token=claimed.lease_token,lease_expires_at=clock_timestamp()+interval '3 minutes' where id=j;
  update public.workspace_members set role='viewer' where workspace_id=f.workspace_id and user_id=f.owner_id;
  begin perform public.complete_quoted_ai_review_job(j,claimed.lease_token,'openai','text-test',usage,'[]',suggestions,settlement);
    assert false,'revoked editor completed AI review'; exception when insufficient_privilege then null; end;
  assert (select status from public.funded_usage_quotes where job_id=j)='held'
    and not exists(select 1 from public.ai_suggestions where ai_job_id=j)
    and not exists(select 1 from public.credit_ledger where reference_id=j and source='generation_release');
  update public.workspace_members set role='owner' where workspace_id=f.workspace_id and user_id=f.owner_id;
  select * into strict completed from public.complete_quoted_ai_review_job(j,claimed.lease_token,'openai','text-test',usage,'[]',suggestions,settlement);
  assert completed.status='succeeded' and completed.lease_token is null;
  update public.workspace_members set role='viewer' where workspace_id=f.workspace_id and user_id=f.owner_id;
  select * into strict completed from public.complete_quoted_ai_review_job(j,null,'openai','text-test',usage,'[]',suggestions,settlement);
  assert completed.status='succeeded' and (select count(*) from public.ai_runs where ai_job_id=j)=1
    and (select count(*) from public.ai_suggestions where ai_job_id=j)=1
    and (select count(*) from public.credit_ledger where reference_id=j and source='generation_release')=1;
end $$;
reset role;
rollback;
