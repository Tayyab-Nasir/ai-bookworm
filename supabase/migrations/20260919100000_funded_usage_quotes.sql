-- Server-owned calculator output. No public mutation or client-supplied prices.
create table public.funded_usage_quotes (
  job_id uuid primary key references public.ai_jobs(id),
  user_id uuid not null references auth.users(id),
  workspace_id uuid not null references public.workspaces(id),
  quote_json jsonb not null check(jsonb_typeof(quote_json)='object' and octet_length(quote_json::text)<=65536),
  reserved_credits integer not null check(reserved_credits>0),
  status text not null default 'held' check(status in ('held','settled','requires_review')),
  settlement_json jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
alter table public.funded_usage_quotes enable row level security;
revoke all on public.funded_usage_quotes from public,anon,authenticated;
grant select,insert,update on public.funded_usage_quotes to service_role;

create function public.reserve_funded_usage_quote(p_quote jsonb) returns public.funded_usage_quotes
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_existing public.funded_usage_quotes; v_units integer; v_role text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if jsonb_typeof(p_quote) is distinct from 'object'
    or coalesce(p_quote->>'reservedCredits','') !~ '^[1-9][0-9]{0,9}$'
    or coalesce(p_quote->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    or p_quote#>'{policy,approved}' is distinct from 'true'::jsonb then
    raise exception 'invalid funded quote' using errcode='22023'; end if;
  v_units:=(p_quote->>'reservedCredits')::integer;
  select * into v_job from public.ai_jobs where id=(p_quote#>>'{scope,jobId}')::uuid for update;
  if not found or v_job.workspace_id is distinct from (p_quote#>>'{scope,workspaceId}')::uuid
    or v_job.created_by is distinct from (p_quote#>>'{scope,userId}')::uuid then
    raise exception 'quote job scope mismatch' using errcode='22023'; end if;
  select * into v_existing from public.funded_usage_quotes where job_id=v_job.id;
  if found then
    if v_existing.quote_json is distinct from p_quote then
      raise exception 'funded quote request conflict' using errcode='23505'; end if;
    return v_existing;
  end if;
  if v_job.status<>'queued' then raise exception 'quote requires undispatched job' using errcode='23514'; end if;
  if (p_quote->>'createdAt') is null or (p_quote->>'expiresAt') is null
    or (p_quote->>'createdAt')::timestamptz>clock_timestamp()
    or (p_quote->>'expiresAt')::timestamptz<=clock_timestamp()
    or (p_quote->>'expiresAt')::timestamptz>(p_quote->>'createdAt')::timestamptz+interval '1 hour' then
    raise exception 'quote expired or invalid' using errcode='22023'; end if;
  select role into v_role from public.workspace_members
    where workspace_id=v_job.workspace_id and user_id=v_job.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'quote requires editing access' using errcode='42501'; end if;
  if exists(select 1 from public.credit_ledger where reference_id=v_job.id and source='consumption') then
    raise exception 'job already debited' using errcode='23505'; end if;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(v_job.created_by,v_job.workspace_id,'generation_reservation',-v_units,0,'usage_quote',v_job.id);
  insert into public.funded_usage_quotes(job_id,user_id,workspace_id,quote_json,reserved_credits)
    values(v_job.id,v_job.created_by,v_job.workspace_id,p_quote,v_units) returning * into v_existing;
  return v_existing;
end $$;

create function public.settle_funded_usage_quote(p_job_id uuid,p_settlement jsonb) returns public.funded_usage_quotes
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_quote public.funded_usage_quotes; v_debit integer; v_release integer;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found then raise exception 'funded quote missing' using errcode='22023'; end if;
  if v_quote.settlement_json is not null then
    if v_quote.settlement_json is distinct from p_settlement then
      raise exception 'quote settlement conflict' using errcode='23505'; end if;
    return v_quote;
  end if;
  if jsonb_typeof(p_settlement) is distinct from 'object' or octet_length(p_settlement::text)>65536
    or p_settlement->>'fingerprint' is distinct from v_quote.quote_json->>'fingerprint'
    or length(coalesce(trim(p_settlement->>'requestId'),'')) not between 1 and 256 then
    raise exception 'invalid quote settlement' using errcode='22023'; end if;
  if p_settlement->>'status'='requires_review' then
    if p_settlement->>'heldCredits' is distinct from v_quote.reserved_credits::text then
      raise exception 'invalid review hold' using errcode='22023'; end if;
    update public.funded_usage_quotes set status='requires_review',settlement_json=p_settlement
      where job_id=p_job_id returning * into v_quote;
    return v_quote;
  end if;
  if p_settlement->>'status' is distinct from 'settle'
    or coalesce(p_settlement->>'debitCredits','') !~ '^[1-9][0-9]{0,9}$'
    or coalesce(p_settlement->>'releaseCredits','') !~ '^(0|[1-9][0-9]{0,9})$'
    or p_settlement->>'priceVersion' is distinct from v_quote.quote_json#>>'{price,version}'
    or p_settlement->>'policyVersion' is distinct from v_quote.quote_json#>>'{policy,version}' then
    raise exception 'invalid quote settlement' using errcode='22023'; end if;
  v_debit:=(p_settlement->>'debitCredits')::integer; v_release:=(p_settlement->>'releaseCredits')::integer;
  if v_debit::bigint+v_release<>v_quote.reserved_credits then
    raise exception 'settlement does not balance reservation' using errcode='23514'; end if;
  if v_release>0 then
    insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
      values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_release,0,'usage_quote',p_job_id);
  end if;
  update public.funded_usage_quotes set status='settled',settlement_json=p_settlement,settled_at=clock_timestamp()
    where job_id=p_job_id returning * into v_quote;
  return v_quote;
end $$;
revoke all on function public.reserve_funded_usage_quote(jsonb) from public,anon,authenticated;
revoke all on function public.settle_funded_usage_quote(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_funded_usage_quote(jsonb) to service_role;
grant execute on function public.settle_funded_usage_quote(uuid,jsonb) to service_role;

-- Legacy deduction and quoted reservation must never both debit one job.
-- This guard shares the legacy receipt lock and runs before balance calculation.
create function public.guard_job_credit_mode() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.reference_id is not null and new.source in ('consumption','generation_reservation') then
    perform pg_advisory_xact_lock(hashtextextended('credit-deduction:'||new.reference_id::text,0));
    if exists(select 1 from public.credit_ledger where reference_id=new.reference_id
      and source=case when new.source='consumption' then 'generation_reservation' else 'consumption' end) then
      raise exception 'job already uses another credit mode' using errcode='23505'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_job_credit_mode() from public,anon,authenticated;
create trigger aa_job_credit_mode before insert on public.credit_ledger
for each row execute function public.guard_job_credit_mode();
