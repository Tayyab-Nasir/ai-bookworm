begin;
do $$
declare
  u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid();
  job uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); plan uuid:=gen_random_uuid();
  q jsonb; q2 jsonb; s jsonb; a public.funded_usage_quotes; b public.funded_usage_quotes;
begin
  assert not has_table_privilege('authenticated','public.funded_usage_quotes','select');
  assert not has_function_privilege('authenticated','public.reserve_funded_usage_quote(jsonb)','execute');
  assert not has_function_privilege('authenticated','public.settle_funded_usage_quote(uuid,jsonb)','execute');
  insert into auth.users(id,email) values(u,'funded@local.test');
  insert into organizations(id,name,slug,owner_user_id) values(org,'Funded','funded-quotes',u);
  insert into workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Funded','funded-quotes',u);
  insert into workspace_members(workspace_id,user_id,role) values(ws,u,'editor');
  insert into plans(id,name,billing_period,price_cents,entitlements_json) values(plan,'Funded','month',1000,'{"ai_credits_monthly":10}');
  insert into subscriptions(organization_id,plan_id,status) values(org,plan,'active');
  insert into ai_jobs(id,workspace_id,agent_type,input_ref,idempotency_key,created_by) values
    (job,ws,'writer','{}','funded-job',u),(other,ws,'writer','{}','funded-other',u);
  insert into credit_ledger(user_id,source,amount,balance_after) values(u,'purchase',5,5);
  perform set_config('request.jwt.claim.role','service_role',true);
  -- Synthetic trusted service output; calculator correctness has separate tests.
  q:=jsonb_build_object('scope',jsonb_build_object('jobId',job,'workspaceId',ws,'userId',u),
    'reservedCredits','4','fingerprint',repeat('a',64),'policy',jsonb_build_object('approved',true,'version','test-v1'),
    'price',jsonb_build_object('version','synthetic-v1'),
    'createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '10 minutes');
  a:=public.reserve_funded_usage_quote(q); b:=public.reserve_funded_usage_quote(q);
  assert a=b; assert a.status='held';
  assert (select sum(amount) from credit_ledger where user_id=u)=1;
  begin
    perform public.reserve_funded_usage_quote(jsonb_set(q,'{reservedCredits}','"3"'));
    raise exception 'changed quote replay accepted';
  exception when unique_violation then assert sqlerrm='funded quote request conflict'; end;
  q2:=jsonb_set(q,'{scope,jobId}',to_jsonb(other));
  begin
    perform public.reserve_funded_usage_quote(q2);
    raise exception 'unfunded quote accepted';
  exception when check_violation then assert sqlerrm='insufficient credits'; end;
  assert not exists(select 1 from funded_usage_quotes where job_id=other);
  begin
    perform public.deduct_job_credits(u,ws,org,'ai_credits',1,job);
    raise exception 'legacy double debit accepted';
  exception when unique_violation then assert sqlerrm='job already uses another credit mode'; end;
  assert not exists(select 1 from usage_events where metadata_json->>'jobId'=job::text);
  s:=jsonb_build_object('status','settle','fingerprint',repeat('a',64),'requestId','req-test',
    'debitCredits','2','releaseCredits','2','priceVersion','synthetic-v1','policyVersion','test-v1');
  begin
    perform public.settle_funded_usage_quote(job,jsonb_set(s,'{releaseCredits}','"3"'));
    raise exception 'unbalanced settlement accepted';
  exception when check_violation then assert sqlerrm='settlement does not balance reservation'; end;
  a:=public.settle_funded_usage_quote(job,s); b:=public.settle_funded_usage_quote(job,s);
  assert a=b; assert a.status='settled';
  assert (select sum(amount) from credit_ledger where user_id=u)=3;
  assert (select count(*) from credit_ledger where reference_id=job and source='generation_release')=1;
  begin
    perform public.settle_funded_usage_quote(job,jsonb_set(s,'{requestId}','"changed"'));
    raise exception 'changed settlement accepted';
  exception when unique_violation then assert sqlerrm='quote settlement conflict'; end;
  -- Review holds remain funded; they are not automatically refunded.
  q2:=jsonb_set(q2,'{reservedCredits}','"3"');
  perform public.reserve_funded_usage_quote(q2);
  a:=public.settle_funded_usage_quote(other,jsonb_build_object('status','requires_review',
    'fingerprint',repeat('a',64),'requestId','req-review','heldCredits','3'));
  assert a.status='requires_review';
  assert (select sum(amount) from credit_ledger where user_id=u)=0;
end $$;
rollback;
