-- Metadata token quotes require explicit consent, immutable service-side
-- snapshots, current saved sources and one atomic author-funded acceptance.
begin;

create temp table metadata_quote_fixture (
  owner_id uuid, outsider_id uuid, workspace_id uuid, book_id uuid,
  chapter_id uuid, version_id uuid, stale_request_id uuid, stale_job_id uuid,
  request_id uuid, job_id uuid
) on commit drop;
grant select,insert,update on metadata_quote_fixture to authenticated,service_role;

insert into auth.users(id,email) values
 ('e2500000-0000-4000-8000-000000000001','metadata-quote-owner@local.test'),
 ('e2500000-0000-4000-8000-000000000002','metadata-quote-outsider@local.test');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2500000-0000-4000-8000-000000000001"}';
do $$
declare ws public.workspaces; b uuid;
begin
  select * into strict ws from public.create_workspace_with_owner('Metadata quote acceptance');
  insert into public.books(workspace_id,title,author_name,language,created_by)
    values(ws.id,'The Quiet Map','Quote Owner','en',auth.uid()) returning id into b;
  insert into metadata_quote_fixture(owner_id,outsider_id,workspace_id,book_id,chapter_id,version_id,stale_job_id,job_id)
    values(auth.uid(),'e2500000-0000-4000-8000-000000000002',ws.id,b,
      'e2500000-0000-4000-8000-000000000011','e2500000-0000-4000-8000-000000000012',
      'e2500000-0000-4000-8000-000000000021','e2500000-0000-4000-8000-000000000022');
  assert not has_table_privilege('authenticated','public.metadata_token_quote_requests','select'),
    'author can read private quote snapshots directly';
  assert not has_function_privilege('authenticated',
    'public.request_metadata_token_quote(uuid,uuid,uuid,uuid,jsonb,jsonb,text,boolean)','execute'),
    'author can call private metadata quote RPC';
end $$;
reset role;

insert into public.workspace_members(workspace_id,user_id,role)
 select workspace_id,outsider_id,'viewer'::public.member_role from metadata_quote_fixture;
insert into public.chapters(id,book_id,order_index,title)
 select chapter_id,book_id,0,'First chapter' from metadata_quote_fixture;
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
 select version_id,chapter_id,1,'{"nodes":[{"id":"n1","type":"paragraph","text":"A quiet map remembers every road."}]}'::jsonb,
   'A quiet map remembers every road.',7,owner_id from metadata_quote_fixture;
update public.chapters c set current_document_version_id=f.version_id from metadata_quote_fixture f where c.id=f.chapter_id;
set local role service_role;
do $$
declare
  f metadata_quote_fixture;
  catalog jsonb;
  request_json jsonb;
  q jsonb;
  r public.metadata_token_quote_requests;
  replay public.metadata_token_quote_requests;
  stored public.metadata_token_quote_requests;
  job public.ai_jobs;
  replay_job public.ai_jobs;
  claimed_job public.ai_jobs;
  stale_request public.metadata_token_quote_requests;
  stale_quote jsonb;
  stale_json jsonb;
  source_hash text := repeat('a',64);
  wire_hash text := repeat('b',64);
begin
  select * into strict f from metadata_quote_fixture;
  catalog:=jsonb_build_object('approved',true,'version','test-catalog',
    'expiresAt',clock_timestamp()+interval '30 minutes','entries',jsonb_build_array(
      jsonb_build_object('id','metadata-test','price',jsonb_build_object('provider','openai','model','gpt-6-astra','version','price-v1'),
        'policy',jsonb_build_object('approved',true,'version','policy-v1'))));
  request_json:=jsonb_build_object('jobId',f.stale_job_id,'workspaceId',f.workspace_id,'bookId',f.book_id,
    'agentType','metadata','model','gpt-6-astra','maxOutputTokens',2048,
    'input',jsonb_build_object('chapters',jsonb_build_object(f.chapter_id::text,
      jsonb_build_object('documentVersionId',f.version_id,'nodes',jsonb_build_array(
        jsonb_build_object('id','n1','textHash',repeat('d',64)))))));

  begin
    perform public.request_metadata_token_quote(f.owner_id,f.book_id,f.workspace_id,f.stale_job_id,
      request_json,catalog,'metadata-quote-no-consent',false);
    assert false,'metadata quote accepted without token-count consent';
  exception when invalid_parameter_value then assert sqlerrm='invalid metadata quote request'; end;
  begin
    perform public.request_metadata_token_quote(f.outsider_id,f.book_id,f.workspace_id,f.stale_job_id,
      request_json,catalog,'metadata-outsider-request',true);
    assert false,'viewer/outsider requested quote';
  exception when insufficient_privilege then null; end;

  select * into strict r from public.request_metadata_token_quote(f.owner_id,f.book_id,f.workspace_id,
    f.stale_job_id,request_json,catalog,'metadata-quote-stale-1',true);
  select * into strict replay from public.request_metadata_token_quote(f.owner_id,f.book_id,f.workspace_id,
    f.stale_job_id,request_json,catalog,'metadata-quote-stale-1',true);
  assert replay.id=r.id and r.status='counting' and r.consented_at is not null,
    'metadata quote request did not persist consent or replay idempotently';
  source_hash:=r.source_sha256;
  assert source_hash ~ '^[a-f0-9]{64}$','metadata source snapshot hash was not saved';
  begin
    perform public.request_metadata_token_quote(f.owner_id,f.book_id,f.workspace_id,f.stale_job_id,
      request_json,catalog,'metadata-quote-stale-1',false);
    assert false,'request key replay skipped consent validation';
  exception when invalid_parameter_value then null; end;

  q:=jsonb_build_object('scope',jsonb_build_object('jobId',f.stale_job_id,'workspaceId',f.workspace_id,
      'userId',f.owner_id,'inputSha256',wire_hash),
    'reservedCredits','5','fingerprint',repeat('c',64),
    'policy',jsonb_build_object('approved',true,'version','policy-v1'),
    'price',jsonb_build_object('version','price-v1','model','gpt-6-astra','provider','openai'),
    'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '10 minutes');
  begin
    perform public.complete_metadata_token_quote_count(r.id,f.owner_id,r.lease_token,wire_hash,
      jsonb_set(q,'{scope,userId}',to_jsonb(f.outsider_id)));
    assert false,'metadata count accepted foreign user scope';
  exception when invalid_parameter_value then assert sqlerrm='metadata quote provider binding mismatch'; end;
  select * into strict stored from public.complete_metadata_token_quote_count(r.id,f.owner_id,r.lease_token,wire_hash,q);
  select * into strict r from public.metadata_token_quote_requests where id=stored.id;
  assert r.status='ready','metadata count did not mark the proposal ready';
  begin
    perform public.complete_metadata_token_quote_count(r.id,f.owner_id,r.lease_token,wire_hash,
      jsonb_set(q,'{reservedCredits}','"6"'));
    assert false,'ready metadata quote changed on replay';
  exception when unique_violation then null; end;
  begin
    perform public.accept_metadata_token_quote(r.id,f.owner_id,4);
    assert false,'author accepted a different credit amount';
  exception when check_violation then null; end;

  -- A stale saved source must not create either the job or the hold.
  insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values('e2500000-0000-4000-8000-000000000013',f.chapter_id,2,'{"nodes":[]}','A revised chapter.',3,f.owner_id);
  update public.chapters set current_document_version_id='e2500000-0000-4000-8000-000000000013' where id=f.chapter_id;
  begin
    perform public.accept_metadata_token_quote(r.id,f.owner_id,5);
    assert false,'quote accepted after its saved source version changed';
  exception when serialization_failure then assert sqlerrm='metadata source version changed; request a new quote'; end;
  assert not exists(select 1 from public.ai_jobs where id=f.stale_job_id)
    and not exists(select 1 from public.funded_usage_quotes where job_id=f.stale_job_id),
    'stale quote wrote an AI job or reserved funds';

  -- Re-quote against the new saved version and accept one atomic funded job.
  update metadata_quote_fixture set version_id='e2500000-0000-4000-8000-000000000013' where owner_id=f.owner_id;
  select * into strict f from metadata_quote_fixture;
  request_json:=jsonb_set(request_json,'{jobId}',to_jsonb(f.job_id));
  request_json:=jsonb_set(request_json,'{input,chapters}',jsonb_build_object(f.chapter_id::text,
    jsonb_build_object('documentVersionId',f.version_id,'nodes',jsonb_build_array(
      jsonb_build_object('id','n1','textHash',repeat('d',64))))));
  select * into strict r from public.request_metadata_token_quote(f.owner_id,f.book_id,f.workspace_id,
    f.job_id,request_json,catalog,'metadata-quote-accepted-1',true);
  q:=jsonb_build_object('scope',jsonb_build_object('jobId',f.job_id,'workspaceId',f.workspace_id,
      'userId',f.owner_id,'inputSha256',wire_hash),
    'reservedCredits','5','fingerprint',repeat('d',64),
    'policy',jsonb_build_object('approved',true,'version','policy-v1'),
    'price',jsonb_build_object('version','price-v1','model','gpt-6-astra','provider','openai'),
    'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '10 minutes');
  select * into strict r from public.complete_metadata_token_quote_count(r.id,f.owner_id,r.lease_token,wire_hash,q);
  begin
    insert into public.ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,status,input_ref,idempotency_key,created_by)
      values(f.job_id,f.workspace_id,f.book_id,'metadata','quoted','running','{}','metadata-unfunded',f.owner_id);
    assert false,'quoted metadata job ran without funded acceptance';
  exception when check_violation then null; end;
  begin
    perform public.accept_metadata_token_quote(r.id,f.owner_id,5);
    assert false,'quoted metadata acceptance ignored missing subscription';
  exception when check_violation then null; end;
  assert not exists(select 1 from public.ai_jobs where id=f.job_id)
    and not exists(select 1 from public.funded_usage_quotes where job_id=f.job_id),
    'failed acceptance partially created job or hold';
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after)
    values(f.owner_id,f.workspace_id,'purchase',20,0);
  begin
    select * into strict job from public.accept_metadata_token_quote(r.id,f.owner_id,5);
  exception when others then raise exception 'metadata accepted-job stage failed: %',sqlerrm; end;
  assert job.id=f.job_id and job.agent_type='metadata' and job.billing_mode='quoted' and job.status='queued',
    'acceptance did not create the queued quoted metadata job';
  assert (select status from public.funded_usage_quotes where job_id=f.job_id)='held'
    and (select count(*) from public.credit_ledger where reference_id=f.job_id and source='generation_reservation')=1
    and not exists(select 1 from public.usage_events where metadata_json->>'jobId'=f.job_id::text),
    'acceptance failed to reserve once in funded ledger or charged legacy usage';
  select * into strict replay_job from public.accept_metadata_token_quote(r.id,f.owner_id,5);
  assert replay_job.id=job.id and (select count(*) from public.ai_jobs where id=f.job_id)=1
    and (select count(*) from public.credit_ledger where reference_id=f.job_id and source='generation_reservation')=1,
    'metadata acceptance replay duplicated job or hold';
  select * into strict claimed_job from public.claim_quoted_metadata_job(180);
  assert claimed_job.id=f.job_id and claimed_job.status='running' and claimed_job.lease_token is not null
    and jsonb_array_length(claimed_job.input_ref->'contextSources')=1
    and claimed_job.input_ref#>>'{contextSources,0,documentVersionId}'=f.version_id::text,
    'quoted metadata claim omitted its fenced lease or trusted source refs';
  assert public.claim_funded_dispatch(f.job_id,claimed_job.lease_token,wire_hash,'gpt-6-astra'),
    'quoted metadata job could not acquire its one dispatch marker';
  assert not public.claim_funded_dispatch(f.job_id,claimed_job.lease_token,wire_hash,'gpt-6-astra'),
    'quoted metadata dispatch marker was not one-way';
  assert public.renew_quoted_metadata_lease(f.job_id,claimed_job.lease_token,180),
    'quoted metadata running lease could not be renewed';
  assert public.mark_quoted_metadata_requires_review(f.job_id,claimed_job.lease_token,
    'provider_outcome_unknown','metadata-dispatch-unknown:test'),
    'unknown quoted metadata outcome could not retain a review hold';
  assert (select status from public.funded_usage_quotes where job_id=f.job_id)='requires_review'
    and (select settlement_json->>'heldCredits' from public.funded_usage_quotes where job_id=f.job_id)='5'
    and (select status from public.ai_jobs where id=f.job_id)='failed'
    and not exists(select 1 from public.credit_ledger where reference_id=f.job_id and source='generation_release'),
    'uncertain quoted metadata outcome was charged or automatically refunded';
  update public.workspace_members set role='viewer' where workspace_id=f.workspace_id and user_id=f.owner_id;
  begin
    perform public.accept_metadata_token_quote(r.id,f.owner_id,5);
    assert false,'revoked author accepted a quoted metadata job';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
