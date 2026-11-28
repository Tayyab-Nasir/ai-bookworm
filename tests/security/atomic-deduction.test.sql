begin;
do $$
declare u uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); failed uuid:=gen_random_uuid(); first jsonb; again jsonb;
begin
  assert not has_function_privilege('authenticated','public.deduct_job_credits(uuid,uuid,uuid,text,integer,uuid)','execute');
  assert not has_table_privilege('authenticated','public.credit_deduction_receipts','select');
  insert into auth.users(id,email) values(u,'atomic-deduct@local.test');
  insert into credit_ledger(user_id,source,amount,balance_after) values(u,'purchase',10,10);
  perform set_config('request.jwt.claim.role','service_role',true);
  first:=public.deduct_job_credits(u,null,null,'ai_credits',3,job);
  again:=public.deduct_job_credits(u,null,null,'ai_credits',3,job);
  assert first=again;
  assert (first->'entry'->>'balance_after')::int=7;
  begin
    perform public.deduct_job_credits(u,null,null,'ai_credits',4,job);
    raise exception 'changed replay accepted';
  exception when unique_violation then assert sqlerrm='credit deduction request conflict'; end;
  begin
    perform public.deduct_job_credits(u,null,null,'ai_credits',20,failed);
    raise exception 'overdraft accepted';
  exception when check_violation then assert sqlerrm='insufficient credits'; end;
  assert (select count(*) from usage_events where user_id=u)=1;
  assert (select count(*) from credit_ledger where user_id=u)=2;
  assert not exists(select 1 from credit_deduction_receipts where job_id=failed);
  begin
    perform public.deduct_job_credits(u,null,null,'ai_credits',0,failed);
    raise exception 'zero debit accepted';
  exception when invalid_parameter_value then null; end;
  -- Old debit without a receipt cannot safely be replayed or rewritten.
  insert into credit_ledger(user_id,source,amount,balance_after,reference_type,reference_id)
    values(u,'consumption',-1,0,'job',failed);
  begin
    perform public.deduct_job_credits(u,null,null,'ai_credits',1,failed);
    raise exception 'historical debit duplicated';
  exception when unique_violation then assert sqlerrm='historical deduction requires reconciliation'; end;
  assert (select count(*) from usage_events where user_id=u)=1;
end $$;
rollback;
