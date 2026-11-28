begin;
do $$
declare u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
  p uuid:=gen_random_uuid(); c uuid; d uuid; j uuid; q jsonb; items jsonb:='[]';
  expires timestamptz:=clock_timestamp()+interval '10 minutes'; result public.translation_projects; n integer;
  expired uuid:=gen_random_uuid(); changed uuid:=gen_random_uuid();
begin
  assert not has_table_privilege('authenticated','public.translation_quote_proposals','select');
  assert not has_table_privilege('authenticated','public.translation_quote_proposals','insert');
  assert not has_function_privilege('authenticated','public.accept_translation_quote(uuid,uuid,integer)','execute');
  insert into auth.users(id,email) values(u,'proposal@local.test');
  insert into organizations(id,name,slug,owner_user_id) values(org,'Proposal','proposal',u);
  insert into workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Proposal','proposal',u);
  insert into workspace_members(workspace_id,user_id,role) values(ws,u,'editor');
  insert into books(id,workspace_id,title,author_name,language,created_by) values(b,ws,'Proposal','Author','en',u);
  for n in 0..1 loop
    c:=gen_random_uuid(); d:=gen_random_uuid(); j:=gen_random_uuid();
    insert into chapters(id,book_id,order_index,title) values(c,b,n,'Chapter');
    insert into document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
      values(d,c,1,'{}','Source',1,u);
    q:=jsonb_build_object('scope',jsonb_build_object('jobId',j,'userId',u,'workspaceId',ws,'inputSha256',repeat('a',64)),
      'reservedCredits','2','fingerprint',repeat('b',64),'policy',jsonb_build_object('approved',true,'version','test'),
      'price',jsonb_build_object('version','test','model','synthetic','provider','openai'),
      'createdAt',clock_timestamp()-interval '1 second','expiresAt',expires);
    items:=items||jsonb_build_array(jsonb_build_object('jobId',j,'chapterId',c,'documentVersionId',d,'chapterOrder',n,
      'sourceSha256',encode(digest(convert_to('Source','UTF8'),'sha256'),'hex'),'quote',q));
  end loop;
  insert into translation_quote_proposals(id,user_id,workspace_id,book_id,source_language,target_language,catalog_version,chapters_json,reserved_credits,expires_at)
    values(p,u,ws,b,'en','es','test',items,4,expires);
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into translation_quote_proposals(id,user_id,workspace_id,book_id,source_language,target_language,catalog_version,chapters_json,reserved_credits,created_at,expires_at)
    values(expired,u,ws,b,'en','es','test',items,4,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute');
  begin
    perform accept_translation_quote(expired,u,4);
    raise exception 'expired offer accepted';
  exception when invalid_parameter_value then assert sqlerrm='translation proposal expired'; end;
  insert into translation_quote_proposals(id,user_id,workspace_id,book_id,source_language,target_language,catalog_version,chapters_json,reserved_credits,expires_at)
    values(changed,u,ws,b,'en','es','test',jsonb_set(items,'{0,sourceSha256}',to_jsonb(repeat('0',64))),4,expires);
  begin
    perform accept_translation_quote(changed,u,4);
    raise exception 'changed source accepted';
  exception when check_violation then assert sqlerrm='proposal source unavailable or changed'; end;
  begin
    perform accept_translation_quote(p,gen_random_uuid(),4);
    raise exception 'wrong payer accepted';
  exception when insufficient_privilege then assert sqlerrm='proposal payer mismatch'; end;
  begin
    perform accept_translation_quote(p,u,3);
    raise exception 'wrong confirmation accepted';
  exception when check_violation then assert sqlerrm='proposal credit confirmation mismatch'; end;
  insert into credit_ledger(user_id,source,amount,balance_after) values(u,'purchase',3,3);
  begin
    perform accept_translation_quote(p,u,4);
    raise exception 'partial funding accepted';
  exception when check_violation then assert sqlerrm='insufficient credits'; end;
  assert not exists(select 1 from translation_projects where id=p);
  assert not exists(select 1 from ai_jobs where book_id=b);
  assert not exists(select 1 from funded_usage_quotes where user_id=u);
  assert (select sum(amount) from credit_ledger where user_id=u)=3;
  assert (select accepted_project_id from translation_quote_proposals where id=p) is null;
  insert into credit_ledger(user_id,source,amount,balance_after) values(u,'purchase',1,4);
  select * into result from accept_translation_quote(p,u,4);
  assert result.id=p and result.chapter_count=2;
  assert (select count(*) from ai_jobs where book_id=b and billing_mode='quoted')=2;
  assert (select count(*) from funded_usage_quotes where user_id=u and status='held')=2;
  assert (select sum(amount) from credit_ledger where user_id=u)=0;
  select * into result from accept_translation_quote(p,u,4);
  assert result.id=p;
  assert (select count(*) from credit_ledger where user_id=u and source='generation_reservation')=2;
  begin
    update translation_quote_proposals set reserved_credits=1 where id=p;
    raise exception 'proposal modified';
  exception when check_violation then assert sqlerrm='translation proposal is immutable'; end;
  update workspace_members set role='viewer' where workspace_id=ws and user_id=u;
  begin
    perform accept_translation_quote(p,u,4);
    raise exception 'revoked editor replayed';
  exception when insufficient_privilege then assert sqlerrm='translation editing access required'; end;
end $$;
rollback;
