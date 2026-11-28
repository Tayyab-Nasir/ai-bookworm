-- Disposable SQL only: revoked edit roles cannot commit new quoted billing or
-- results, while successful replays and dispatched review holds stay intact.
begin;

create function pg_temp.quote_permission_fixture(kind text) returns jsonb language plpgsql as $$
declare u uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); w uuid:=gen_random_uuid();
  b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); j uuid:=gen_random_uuid();
  q jsonb; request jsonb; catalog jsonb; snapshot public.image_quote_snapshots;
  source jsonb; quote_id uuid:=gen_random_uuid(); rates jsonb; maximum jsonb;
begin
  insert into auth.users(id,email) values(u,u::text||'@quote-permissions.local.test');
  insert into public.organizations(id,name,slug,owner_user_id) values(o,'Quote permission test',o::text,u);
  insert into public.workspaces(id,organization_id,name,slug,created_by) values(w,o,'Quote permission test',w::text,u);
  insert into public.workspace_members(workspace_id,user_id,role) values(w,u,'writer');
  insert into public.books(id,workspace_id,title,author_name,language,created_by) values(b,w,'Quote permission test','Fixture Author','en',u);
  insert into public.chapters(id,book_id,order_index,title) values(c,b,0,'Saved excerpt');
  insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values(v,c,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Saved excerpt."}]}', 'Saved excerpt.',2,u);
  update public.chapters set current_document_version_id=v where id=c;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values(u,w,'purchase',100,0);
  rates:=case when kind='bookbible' then
    '[{"dimension":"text_input","microUsdPerMillionTokens":"1000000"},{"dimension":"text_cached_input","microUsdPerMillionTokens":"1000000"},{"dimension":"text_output","microUsdPerMillionTokens":"1000000"}]'::jsonb
    else '[{"dimension":"text_input","microUsdPerMillionTokens":"1000000"},{"dimension":"image_input","microUsdPerMillionTokens":"1000000"},{"dimension":"text_output","microUsdPerMillionTokens":"1000000"},{"dimension":"image_output","microUsdPerMillionTokens":"1000000"}]'::jsonb end;
  maximum:=case when kind='bookbible' then
    '[{"dimension":"text_input","tokens":"1"},{"dimension":"text_cached_input","tokens":"1"},{"dimension":"text_output","tokens":"1"}]'::jsonb
    else '[{"dimension":"text_input","tokens":"1"},{"dimension":"image_input","tokens":"1"},{"dimension":"text_output","tokens":"0"},{"dimension":"image_output","tokens":"1"}]'::jsonb end;
  q:=jsonb_build_object('scope',jsonb_build_object('jobId',j,'workspaceId',w,'userId',u,'inputSha256',repeat('a',64)),
    'price',jsonb_build_object('version','permission-price','provider','openai','model','permission-model','rates',rates),
    'policy','{"approved":true,"version":"permission-policy","microUsdPerCredit":"1","markupBasisPoints":10000,"platformMicroUsd":"0","minimumCredits":"1"}'::jsonb,
    'maximumTokens',maximum,'maximumProviderMicroUsd','3','createdAt',clock_timestamp()-interval '1 second',
    'expiresAt',clock_timestamp()+interval '10 minutes','reservedCredits','3','fingerprint',repeat('b',64));
  if kind='bookbible' then
    source:=jsonb_build_object('versions',jsonb_build_array(jsonb_build_object('chapterId',c,'documentVersionId',v,'version',1)),
      'reading',jsonb_build_object('fingerprint',repeat('c',64),'pageIndex',0));
    request:=jsonb_build_object('jobId',j,'workspaceId',w,'bookId',b,'agentType','bookbible','model','permission-model','maxOutputTokens',1,
      'contextPolicy','{}'::jsonb,'input',jsonb_build_object('chapterIds',jsonb_build_array(c),'chapters',
        jsonb_build_object(c::text,jsonb_build_object('documentVersionId',v,'version',1,'nodes',jsonb_build_array(
          jsonb_build_object('id','n1','text','Saved excerpt.','textHash',encode(public.digest('Saved excerpt.','sha256'),'hex')))))));
    catalog:=jsonb_build_object('version','permission-catalog','approved',true,'expiresAt',clock_timestamp()+interval '1 hour',
      'entries',jsonb_build_array(jsonb_build_object('price',q->'price','policy',q->'policy')));
    insert into public.book_bible_token_quote_requests(id,user_id,workspace_id,book_id,generation_job_id,idempotency_key,
      generation_request_json,catalog_json,source_versions_json,source_sha256,generation_request_sha256,
      counted_input_tokens,usage_quote_json,status)
      values(quote_id,u,w,b,j,j::text,request,catalog,source,repeat('c',64),repeat('a',64),1,q,'ready');
  else
    request:=jsonb_build_object('jobId',j,'workspaceId',w,'userId',u,'bookId',b,'kind',kind,
      'model','permission-model','prompt','Fixture artwork','size','1024x1024','quality','low','references','[]'::jsonb);
    catalog:=jsonb_build_object('version','permission-catalog','approved',true,'effectiveAt',clock_timestamp()-interval '1 hour',
      'expiresAt',clock_timestamp()+interval '1 hour','entries',jsonb_build_array(jsonb_build_object('id','permission-option',
        'price',q->'price','policy',q->'policy','size','1024x1024','quality','low','maxPromptBytes',1000,'maxReferenceImages',0,
        'maximumTokens','{"text_input":1,"image_input":1,"text_output":0,"image_output":1}'::jsonb)));
    perform set_config('request.jwt.claim.role','service_role',true);
    select * into snapshot from public.save_image_quote_snapshot(u,w,b,j,j::text,repeat('a',64),request,'permission-catalog','permission-option',q);
    quote_id:=snapshot.id;
  end if;
  return jsonb_build_object('user',u,'workspace',w,'job',j,'quote',quote_id,'catalog',catalog,'kind',kind);
end $$;

create temp table quote_permission_fixtures(kind text primary key, fixture jsonb) on commit drop;
grant all on quote_permission_fixtures to service_role;
insert into quote_permission_fixtures values
  ('bookbible',pg_temp.quote_permission_fixture('bookbible')),
  ('illustration',pg_temp.quote_permission_fixture('illustration')),
  ('cover',pg_temp.quote_permission_fixture('cover')),
  ('queued_bible',pg_temp.quote_permission_fixture('bookbible')),
  ('live_bible',pg_temp.quote_permission_fixture('bookbible')),
  ('manual_bible',pg_temp.quote_permission_fixture('bookbible')),
  ('dispatched_bible',pg_temp.quote_permission_fixture('bookbible'));

set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare f jsonb; j public.ai_jobs; settled public.ai_jobs; token uuid; usage jsonb; settlement jsonb;
  receipt jsonb; asset uuid; completion_count bigint; ledger_count bigint; k text; u uuid; w uuid; v_job_id uuid;
begin
  for k,f in select kind,fixture from quote_permission_fixtures where kind in ('bookbible','illustration','cover') order by kind loop
    u:=(f->>'user')::uuid; w:=(f->>'workspace')::uuid; v_job_id:=(f->>'job')::uuid;
    if k='bookbible' then
      perform public.accept_book_bible_token_quote((f->>'quote')::uuid,u,3);
      select * into strict j from public.claim_quoted_book_bible_job(180);
      usage:='{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0.000002,"latencyMs":1,"measuredTokens":[{"dimension":"text_input","tokens":"1"},{"dimension":"text_cached_input","tokens":"0"},{"dimension":"text_output","tokens":"1"}]}'::jsonb;
    else
      perform public.accept_image_quote((f->>'quote')::uuid,u,3,f->'catalog');
      select * into strict j from public.claim_quoted_image_job(180);
      usage:='{"inputTokens":1,"outputTokens":1,"latencyMs":1,"reconciliationStatus":"supported","providerTokenUsage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"text_tokens":1,"image_tokens":0},"output_tokens_details":{"text_tokens":0,"image_tokens":1}}}'::jsonb;
    end if;
    assert j.id=v_job_id; token:=j.lease_token;
    assert public.claim_funded_dispatch(v_job_id,token,repeat('a',64),'permission-model');
    settlement:=jsonb_build_object('status','settle','requestId','permission-request','fingerprint',repeat('b',64),
      'priceVersion','permission-price','policyVersion','permission-policy','providerMicroUsd','2','debitCredits','2','releaseCredits','1',
      'tokens',case when k='bookbible' then usage->'measuredTokens' else
        '[{"dimension":"text_input","tokens":"1"},{"dimension":"image_input","tokens":"0"},{"dimension":"text_output","tokens":"0"},{"dimension":"image_output","tokens":"1"}]'::jsonb end);
    if k='bookbible' then
      insert into public.book_bible_service_receipts(job_id,request_sha256,result_json)
        values(v_job_id,repeat('e',64),jsonb_build_object('jobId',v_job_id,'workspaceId',w,'bookId',j.book_id,
          'agentType','bookbible','status','succeeded','provider','openai','model','permission-model',
          'requestId','permission-request','usage',usage,'diagnostics','[]'::jsonb,'suggestions','[]'::jsonb));
    else
      asset:=gen_random_uuid();
      receipt:=jsonb_build_object('assetId',asset,'name','Permission fixture','provider','openai','model','permission-model',
        'requestId','permission-request','mimeType','image/png','checksum',repeat('d',64),'sizeBytes',8,
        'storagePath',format('workspaces/%s/assets/%s/v1/generated.png',w,asset),'usage',usage);
      perform public.save_quoted_image_receipt(v_job_id,token,repeat('a',64),receipt);
    end if;
    update public.workspace_members set role='viewer' where workspace_id=w and user_id=u;
    begin
      if k='bookbible' then
        perform public.complete_quoted_book_bible_job(v_job_id,token,'openai','permission-model','permission-request',usage,'[]','[]',settlement);
      else perform public.complete_quoted_image_job(v_job_id,token,settlement); end if;
      assert false,'revoked writer committed quoted completion';
    exception when insufficient_privilege then null; end;
    -- A direct service settlement cannot bypass the same permission boundary.
    begin
      perform public.settle_funded_usage_quote(v_job_id,settlement);
      assert false,'generic settlement bypassed revoked quote permissions';
    exception when insufficient_privilege then null; end;
    assert (select status='held' and settlement_json is null from public.funded_usage_quotes q where q.job_id=v_job_id),
      'permission rejection settled held funds';
    assert not exists(select 1 from public.credit_ledger where reference_id=v_job_id and source='generation_release'),
      'permission rejection left a credit release';
    assert not exists(select 1 from public.ai_runs where ai_job_id=v_job_id)
      and not exists(select 1 from public.usage_events where ai_job_id=v_job_id), 'permission rejection left result accounting';
    assert (select status='running' and lease_token=token from public.ai_jobs where id=v_job_id), 'permission rejection changed lease/status';
    if k<>'bookbible' then assert not exists(select 1 from public.assets where id=asset), 'permission rejection published artwork'; end if;
    update public.workspace_members set role=case when k='bookbible' then 'writer'::public.member_role else 'illustrator'::public.member_role end
      where workspace_id=w and user_id=u;
    if k='bookbible' then
      select * into settled from public.complete_quoted_book_bible_job(v_job_id,token,'openai','permission-model','permission-request',usage,'[]','[]',settlement);
    else select * into settled from public.complete_quoted_image_job(v_job_id,token,settlement); end if;
    assert settled.id=v_job_id and settled.status='succeeded';
    select count(*) into completion_count from public.ai_runs where ai_job_id=v_job_id;
    select count(*) into ledger_count from public.credit_ledger where reference_id=v_job_id;
    update public.workspace_members set status='suspended' where workspace_id=w and user_id=u;
    if k='bookbible' then
      perform public.complete_quoted_book_bible_job(v_job_id,token,'openai','permission-model','permission-request',usage,'[]','[]',settlement);
    else perform public.complete_quoted_image_job(v_job_id,token,settlement); end if;
    assert (select count(*) from public.ai_runs where ai_job_id=v_job_id)=completion_count
      and (select count(*) from public.credit_ledger where reference_id=v_job_id)=ledger_count, 'completed replay changed accounting';
    begin
      if k='bookbible' then
        perform public.complete_quoted_book_bible_job(v_job_id,token,'openai','permission-model','changed-request',usage,'[]','[]',settlement);
      else perform public.complete_quoted_image_job(v_job_id,token,settlement||'{"requestId":"changed-request"}'::jsonb); end if;
      assert false,'revoked completed replay accepted changed settlement identity';
    exception when unique_violation then null; end;
  end loop;
  assert not has_function_privilege('service_role','public.guard_image_bible_quote_settlement_permission()','execute')
    and not has_function_privilege('authenticated','public.guard_image_bible_quote_settlement_permission()','execute')
    and not has_function_privilege('anon','public.guard_image_bible_quote_settlement_permission()','execute'),
    'trigger helper is directly callable';
end $$;
reset role;

-- Queue cleanup applies only before dispatch, and only without a live lease.
set local role service_role;
do $$ declare f jsonb; j public.ai_jobs; old_token uuid; k text; u uuid; w uuid; v_job_id uuid;
begin
  for k,f in select kind,fixture from quote_permission_fixtures where kind in ('queued_bible','live_bible','manual_bible','dispatched_bible') order by kind loop
    u:=(f->>'user')::uuid; w:=(f->>'workspace')::uuid; v_job_id:=(f->>'job')::uuid;
    perform public.accept_book_bible_token_quote((f->>'quote')::uuid,u,3);
    if k<>'queued_bible' then
      select * into strict j from public.claim_quoted_book_bible_job(180); assert j.id=v_job_id; old_token:=j.lease_token;
      if k='dispatched_bible' then assert public.claim_funded_dispatch(v_job_id,old_token,repeat('a',64),'permission-model'); end if;
    end if;
    update public.workspace_members set status='suspended' where workspace_id=w and user_id=u;
    if k='manual_bible' then
      begin
        perform public.release_quoted_book_bible_before_dispatch(v_job_id,old_token,null);
        assert false,'null pre-dispatch release reason accepted';
      exception when invalid_parameter_value then null; end;
      assert public.release_quoted_book_bible_before_dispatch(v_job_id,old_token,'access_changed');
      assert (select status='cancelled' and dispatched_at is null from public.funded_usage_quotes q where q.job_id=v_job_id);
      assert (select status='failed' and error_code='book_bible_access_changed_before_dispatch' from public.ai_jobs where id=v_job_id);
      assert (select count(*)=1 from public.credit_ledger where reference_id=v_job_id and source='generation_release' and amount=3);
      continue;
    end if;
    if k<>'queued_bible' then
      assert not exists(select 1 from public.claim_quoted_book_bible_job(180)), 'live lease was stolen during revoke cleanup';
      assert (select status='running' and lease_token=old_token from public.ai_jobs where id=v_job_id), 'cleanup mutated a live worker';
      update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=v_job_id;
    end if;
    if k='dispatched_bible' then
      select * into strict j from public.claim_quoted_book_bible_job(180);
      assert j.id=v_job_id and j.lease_token<>old_token;
      assert not public.claim_funded_dispatch(v_job_id,j.lease_token,repeat('a',64),'permission-model'), 'revoked recovery dispatched twice';
      assert public.hold_quoted_book_bible_for_review(v_job_id,j.lease_token,'provider_outcome_unknown','permission-dispatched');
      assert (select status='requires_review' from public.funded_usage_quotes q where q.job_id=v_job_id);
      assert not exists(select 1 from public.credit_ledger where reference_id=v_job_id and source='generation_release'), 'dispatched uncertainty refunded';
    else
      assert not exists(select 1 from public.claim_quoted_book_bible_job(180));
      perform public.claim_quoted_book_bible_job(180);
      assert (select status='failed' and error_code='book_bible_access_changed_before_dispatch' from public.ai_jobs where id=v_job_id);
      assert (select status='cancelled' and dispatched_at is null from public.funded_usage_quotes q where q.job_id=v_job_id);
      assert (select count(*)=1 from public.credit_ledger where reference_id=v_job_id and source='generation_release' and amount=3),
        'undispatched revoke cleanup did not release exactly once';
    end if;
  end loop;
end $$;
reset role;
rollback;
