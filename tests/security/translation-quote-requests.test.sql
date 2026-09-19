begin;
do $$
declare u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
  c uuid:=gen_random_uuid(); d uuid:=gen_random_uuid(); catalog jsonb; result public.translation_quote_requests; replay public.translation_quote_requests;
  claimed public.translation_quote_requests; counted jsonb; proposed jsonb; q jsonb; jid uuid;
begin
  assert not has_table_privilege('authenticated','public.translation_quote_requests','select');
  assert not has_function_privilege('authenticated','public.request_translation_quote(uuid,uuid,text,text,jsonb,text)','execute');
  insert into auth.users(id,email) values(u,'quote-request@local.test');
  insert into organizations(id,name,slug,owner_user_id) values(org,'Quote request','quote-request',u);
  insert into workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Quotes','quote-request',u);
  insert into workspace_members(workspace_id,user_id,role) values(ws,u,'editor');
  insert into books(id,workspace_id,title,author_name,language,created_by) values(b,ws,'Quotes','Author','en',u);
  insert into chapters(id,book_id,order_index,title) values(c,b,0,'Chapter');
  insert into document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by) values(d,c,1,'{}','Private source',2,u);
  update chapters set current_document_version_id=d where id=c;
  catalog:=jsonb_build_object('version','test','approved',true,'effectiveAt',clock_timestamp()-interval '1 minute','expiresAt',clock_timestamp()+interval '1 day',
    'entries',jsonb_build_array(jsonb_build_object('id','test-model','price',jsonb_build_object('model','synthetic'))));
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into result from request_translation_quote(b,u,'es','test-model',catalog,'request-1');
  assert result.status='queued' and result.proposal_id is null and result.counts_json='{}';
  assert result.chapters_json#>>'{0,documentVersionId}'=d::text;
  assert result.chapters_json::text not like '%Private source%';
  assert not exists(select 1 from ai_jobs where book_id=b);
  assert not exists(select 1 from credit_ledger where user_id=u);
  select * into replay from request_translation_quote(b,u,'es','test-model',catalog,'request-1');
  assert replay.id=result.id;
  begin
    perform request_translation_quote(b,u,'fr','test-model',catalog,'request-1');
    raise exception 'changed replay accepted';
  exception when unique_violation then assert sqlerrm='translation quote key conflict'; end;
  begin
    perform request_translation_quote(b,u,'es','test-model',catalog,'request-2');
    raise exception 'active duplicate accepted';
  exception when unique_violation then assert sqlerrm='translation quote already preparing'; end;
  begin
    update translation_quote_requests set target_language='fr' where id=result.id;
    raise exception 'request mutated';
  exception when check_violation then assert sqlerrm='translation quote request is immutable'; end;
  select * into claimed from claim_translation_quote_request();
  assert claimed.id=result.id and claimed.status='running';
  assert (select count(*) from claim_translation_quote_request())=0;
  jid:=(claimed.chapters_json#>>'{0,jobId}')::uuid;
  counted:=jsonb_build_object('inputTokens',12,'inputSha256',repeat('a',64),'model','synthetic');
  begin
    perform record_translation_quote_count(claimed.id,gen_random_uuid(),jid,counted);
    raise exception 'stale count accepted';
  exception when serialization_failure then assert sqlerrm='quote lease lost'; end;
  assert record_translation_quote_count(claimed.id,claimed.lease_token,jid,counted);
  select * into claimed from claim_translation_quote_request();
  assert claimed.counts_json->jid::text=counted;
  q:=jsonb_build_object('scope',jsonb_build_object('jobId',jid,'userId',u,'workspaceId',ws,'inputSha256',repeat('a',64)),
    'reservedCredits','2','expiresAt',clock_timestamp()+interval '10 minutes');
  proposed:=jsonb_build_array((claimed.chapters_json->0)||jsonb_build_object('quote',q));
  assert complete_translation_quote_request(claimed.id,claimed.lease_token,proposed)=claimed.id;
  assert complete_translation_quote_request(claimed.id,claimed.lease_token,proposed)=claimed.id;
  assert (select status from translation_quote_requests where id=claimed.id)='ready';
  assert (select reserved_credits from translation_quote_proposals where id=claimed.id)=2;
  assert not exists(select 1 from ai_jobs where book_id=b);
  assert not exists(select 1 from credit_ledger where user_id=u);
  select * into result from request_translation_quote(b,u,'es','test-model',catalog,'request-2');
  select * into claimed from claim_translation_quote_request();
  update translation_quote_requests set lease_expires_at=clock_timestamp()-interval '1 second' where id=claimed.id;
  assert (select count(*) from claim_translation_quote_request())=0;
  assert (select error_code from translation_quote_requests where id=claimed.id)='counting_outcome_unknown';
  select * into result from request_translation_quote(b,u,'es','test-model',catalog,'request-3');
  update translation_quote_requests set status='failed',error_code='test_failure' where id=result.id;
  begin
    perform request_translation_quote(b,u,'es','test-model',catalog,'request-4');
    raise exception 'request limit bypassed';
  exception when program_limit_exceeded then assert sqlerrm='translation quote request limit reached'; end;
end $$;
rollback;
