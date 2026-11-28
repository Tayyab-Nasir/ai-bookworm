begin;
do $$
declare
  u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); book uuid:=gen_random_uuid();
  chapter uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); job uuid:=gen_random_uuid();
  q jsonb; claimed public.ai_jobs; usage jsonb; settlement jsonb; result public.ai_jobs;
  p2 uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid(); j3 uuid:=gen_random_uuid(); cancelled jsonb;
begin
  assert not has_function_privilege('authenticated','public.claim_quoted_translation_job(integer)','execute');
  insert into auth.users(id,email) values(u,'quoted-queue@local.test');
  insert into organizations(id,name,slug,owner_user_id) values(org,'Quoted queue','quoted-queue',u);
  insert into workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Quoted','quoted-queue',u);
  insert into workspace_members(workspace_id,user_id,role) values(ws,u,'editor');
  insert into books(id,workspace_id,title,author_name,language,created_by) values(book,ws,'Quoted','Author','en',u);
  insert into chapters(id,book_id,order_index,title) values(chapter,book,0,'Opening');
  insert into document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
    values(doc,chapter,1,'{}','Source',1,u);
  insert into translation_projects(id,workspace_id,book_id,source_language,target_language,chapter_count,credit_units,idempotency_key,created_by)
    values(project,ws,book,'en','es',1,1,'quoted-project',u);
  -- No operational subscription allowance: this job explicitly requires a quote.
  insert into ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,input_ref,idempotency_key,created_by)
    values(job,ws,book,'translator','quoted',jsonb_build_object('translationProjectId',project,'creditUnits',1),'quoted-job',u);
  insert into translation_chapters(project_id,ai_job_id,chapter_id,document_version_id,chapter_order,source_sha256,credit_units)
    values(project,job,chapter,doc,0,repeat('c',64),1);
  perform set_config('request.jwt.claim.role','service_role',true);
  assert (select count(*) from claim_translation_job(600))=0;
  assert (select count(*) from claim_quoted_translation_job(600))=0;
  begin
    update ai_jobs set status='running' where id=job;
    raise exception 'unfunded job ran';
  exception when check_violation then assert sqlerrm='quoted job requires funded hold'; end;
  begin
    update ai_jobs set billing_mode='operational' where id=job;
    raise exception 'quoted job switched modes';
  exception when check_violation then assert sqlerrm='job billing mode is immutable'; end;
  insert into credit_ledger(user_id,source,amount,balance_after) values(u,'purchase',2,2);
  q:=jsonb_build_object('scope',jsonb_build_object('jobId',job,'workspaceId',ws,'userId',u,'inputSha256',repeat('c',64)),
    'reservedCredits','2','fingerprint',repeat('a',64),'policy',jsonb_build_object('approved',true,'version','test'),
    'price',jsonb_build_object('version','test','model','synthetic','provider','openai'),
    'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '10 minutes');
  perform reserve_funded_usage_quote(q);
  assert (select count(*) from claim_translation_job(600))=0;
  select * into claimed from claim_quoted_translation_job(600);
  assert claimed.id=job and claimed.status='running' and claimed.lease_token is not null;
  assert claim_funded_dispatch(job,claimed.lease_token,repeat('c',64),'synthetic');
  assert not claim_funded_dispatch(job,claimed.lease_token,repeat('c',64),'synthetic');
  usage:='{"inputTokens":10,"outputTokens":10,"estimatedCostUsd":0.001,"latencyMs":10,"measuredTokens":[]}';
  settlement:=jsonb_build_object('status','settle','fingerprint',repeat('a',64),'requestId','req-quoted',
    'debitCredits','1','releaseCredits','1','priceVersion','test','policyVersion','test');
  insert into translation_completion_receipts(ai_job_id,completion_json) values(job,jsonb_build_object(
    'p_job_id',job,'p_translated_text','Traducido','p_provider','openai','p_model','synthetic','p_request_id','req-quoted','p_usage',usage));
  begin
    perform complete_translation_chapter(job,claimed.lease_token,'Traducido','openai','synthetic','req-quoted',usage);
    raise exception 'quoted job completed without settlement';
  exception when check_violation then assert sqlerrm='quoted translation requires matching settlement'; end;
  begin
    perform complete_quoted_translation(job,gen_random_uuid(),'Traducido','openai','synthetic','req-quoted',usage,settlement);
    raise exception 'stale lease settled';
  exception when serialization_failure then assert sqlerrm='lease lost'; end;
  assert (select status from funded_usage_quotes where job_id=job)='held';
  select * into result from complete_quoted_translation(job,claimed.lease_token,'Traducido','openai','synthetic','req-quoted',usage,settlement);
  assert result.status='succeeded';
  assert (select status from funded_usage_quotes where job_id=job)='settled';
  assert (select sum(amount) from credit_ledger where user_id=u)=1;
  assert not exists(select 1 from usage_events where ai_job_id=job and meter='translation_credits');
  assert not has_function_privilege('authenticated','public.cancel_quoted_translation(uuid,uuid)','execute');
  insert into credit_ledger(user_id,source,amount,balance_after) values(u,'purchase',3,0);
  insert into translation_projects(id,workspace_id,book_id,source_language,target_language,chapter_count,credit_units,idempotency_key,created_by) values
    (p2,ws,book,'en','fr',1,1,'cancel-project',u),(p3,ws,book,'en','de',1,1,'dispatch-project',u);
  insert into ai_jobs(id,workspace_id,book_id,agent_type,billing_mode,input_ref,idempotency_key,created_by) values
    (j2,ws,book,'translator','quoted',jsonb_build_object('translationProjectId',p2,'creditUnits',1),'cancel-job',u),
    (j3,ws,book,'translator','quoted',jsonb_build_object('translationProjectId',p3,'creditUnits',1),'dispatch-job',u);
  insert into translation_chapters(project_id,ai_job_id,chapter_id,document_version_id,chapter_order,source_sha256,credit_units) values
    (p2,j2,chapter,doc,0,repeat('c',64),1),(p3,j3,chapter,doc,0,repeat('c',64),1);
  perform reserve_funded_usage_quote(jsonb_set(q,'{scope,jobId}',to_jsonb(j2)));
  begin
    perform cancel_quoted_translation(p2,gen_random_uuid());
    raise exception 'other user cancelled';
  exception when insufficient_privilege then assert sqlerrm='only the translation creator may cancel'; end;
  cancelled:=cancel_quoted_translation(p2,u);
  assert cancelled->>'releasedCredits'='2';
  assert cancel_quoted_translation(p2,u)=cancelled;
  assert (select status from ai_jobs where id=j2)='cancelled';
  assert (select status from funded_usage_quotes where job_id=j2)='cancelled';
  assert (select count(*) from credit_ledger where reference_id=j2 and source='generation_release')=1;
  assert (select sum(amount) from credit_ledger where user_id=u)=4;
  perform reserve_funded_usage_quote(jsonb_set(q,'{scope,jobId}',to_jsonb(j3)));
  select * into claimed from claim_quoted_translation_job(600);
  assert claimed.id=j3;
  assert claim_funded_dispatch(j3,claimed.lease_token,repeat('c',64),'synthetic');
  begin
    perform cancel_quoted_translation(p3,u);
    raise exception 'dispatched project refunded';
  exception when check_violation then assert sqlerrm='translation may already have provider usage'; end;
  assert (select status from funded_usage_quotes where job_id=j3)='held';
  assert (select sum(amount) from credit_ledger where user_id=u)=2;
end $$;
rollback;
