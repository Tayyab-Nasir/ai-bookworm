alter table public.funded_usage_quotes add column dispatched_at timestamptz;
alter table public.funded_usage_quotes add column dispatched_lease uuid;
alter table public.funded_usage_quotes add constraint funded_dispatch_pair
  check((dispatched_at is null)=(dispatched_lease is null));

-- One-way authorization for a provider call, NOT a renewable worker lease.
-- Unknown outcome after this commit retains the hold and cannot redispatch.
create function public.claim_funded_dispatch(p_job_id uuid,p_lease_token uuid,p_input_sha256 text,p_model text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes; v_role text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.status<>'running' or p_lease_token is null
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'funded dispatch lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.settlement_json is not null then
    raise exception 'funded dispatch requires held quote' using errcode='23514'; end if;
  if v_quote.dispatched_at is not null then return false; end if;
  if v_quote.user_id is distinct from v_job.created_by or v_quote.workspace_id is distinct from v_job.workspace_id
    or p_input_sha256 is null or p_model is null
    or v_quote.quote_json#>>'{scope,inputSha256}' is distinct from p_input_sha256
    or v_quote.quote_json#>>'{price,model}' is distinct from p_model
    or v_quote.quote_json#>>'{price,provider}' is distinct from 'openai' then
    raise exception 'funded dispatch request mismatch' using errcode='22023'; end if;
  if (v_quote.quote_json->>'expiresAt')::timestamptz<=clock_timestamp() then
    raise exception 'funded dispatch quote expired' using errcode='22023'; end if;
  select role into v_role from public.workspace_members where workspace_id=v_job.workspace_id
    and user_id=v_job.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'funded dispatch editing access revoked' using errcode='42501'; end if;
  update public.funded_usage_quotes set dispatched_at=clock_timestamp(),dispatched_lease=p_lease_token where job_id=p_job_id;
  return true;
end $$;
revoke all on function public.claim_funded_dispatch(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_funded_dispatch(uuid,uuid,text,text) to service_role;

create function public.guard_funded_quote_transition() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.quote_json is distinct from old.quote_json or new.job_id is distinct from old.job_id
    or new.user_id is distinct from old.user_id or new.workspace_id is distinct from old.workspace_id
    or new.reserved_credits is distinct from old.reserved_credits then
    raise exception 'funded quote is immutable' using errcode='23514'; end if;
  if old.dispatched_at is not null and (new.dispatched_at is distinct from old.dispatched_at
    or new.dispatched_lease is distinct from old.dispatched_lease) then
    raise exception 'funded dispatch cannot be reset' using errcode='23514'; end if;
  if new.status in ('settled','requires_review') and new.dispatched_at is null then
    raise exception 'undispatched quote cannot settle' using errcode='23514'; end if;
  if old.settlement_json is not null and (new.status is distinct from old.status
    or new.settlement_json is distinct from old.settlement_json) then
    raise exception 'funded settlement is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_funded_quote_transition() from public,anon,authenticated;
create trigger funded_quote_transition before update on public.funded_usage_quotes
for each row execute function public.guard_funded_quote_transition();
