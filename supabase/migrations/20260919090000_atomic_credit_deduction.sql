-- Service-only receipt for the legacy credits/deduct endpoint. Not a pricing
-- policy or a substitute for pre-provider generation reservations.
create table public.credit_deduction_receipts (
  job_id uuid primary key,
  request_json jsonb not null,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.credit_deduction_receipts enable row level security;
revoke all on public.credit_deduction_receipts from public,anon,authenticated;
grant select,insert on public.credit_deduction_receipts to service_role;

create function public.deduct_job_credits(
  p_user_id uuid,p_workspace_id uuid,p_organization_id uuid,
  p_meter text,p_amount integer,p_job_id uuid
) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_request jsonb; v_receipt public.credit_deduction_receipts;
  v_usage public.usage_events; v_entry public.credit_ledger; v_result jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_user_id is null or p_job_id is null or p_amount is null or p_amount<=0
    or p_meter is null or length(trim(p_meter))=0 or length(p_meter)>128 then
    raise exception 'invalid credit deduction' using errcode='22023'; end if;
  v_request:=jsonb_build_object('userId',p_user_id,'workspaceId',p_workspace_id,
    'organizationId',p_organization_id,'meter',p_meter,'amount',p_amount);
  perform pg_advisory_xact_lock(hashtextextended('credit-deduction:'||p_job_id::text,0));
  select * into v_receipt from public.credit_deduction_receipts where job_id=p_job_id;
  if found then
    if v_receipt.request_json is distinct from v_request then
      raise exception 'credit deduction request conflict' using errcode='23505'; end if;
    return v_receipt.result_json;
  end if;
  -- Do not duplicate a historical debit that predates receipt storage.
  if exists(select 1 from public.credit_ledger where source='consumption' and reference_id=p_job_id) then
    raise exception 'historical deduction requires reconciliation' using errcode='23505'; end if;
  insert into public.usage_events(organization_id,user_id,workspace_id,meter,quantity,metadata_json)
    values(p_organization_id,p_user_id,p_workspace_id,p_meter,p_amount,jsonb_build_object('jobId',p_job_id)) returning * into v_usage;
  -- Existing ledger trigger locks this user's balance and rejects overdrafts.
  -- Any exception rolls back the usage insert as well.
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(p_user_id,p_workspace_id,'consumption',-p_amount,0,'job',p_job_id) returning * into v_entry;
  v_result:=jsonb_build_object('usage',to_jsonb(v_usage),'entry',to_jsonb(v_entry));
  insert into public.credit_deduction_receipts(job_id,request_json,result_json) values(p_job_id,v_request,v_result);
  return v_result;
end $$;
revoke all on function public.deduct_job_credits(uuid,uuid,uuid,text,integer,uuid) from public,anon,authenticated;
grant execute on function public.deduct_job_credits(uuid,uuid,uuid,text,integer,uuid) to service_role;
