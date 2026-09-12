-- Preserve old codes/attributions, but keep one canonical active link per author.
with ranked as (
  select id, row_number() over (partition by user_id order by created_at, id) as ordinal
  from public.referral_codes where status = 'active'
)
update public.referral_codes set status = 'inactive'
where id in (select id from ranked where ordinal > 1);

create unique index referral_codes_active_user_key
  on public.referral_codes(user_id) where status = 'active';
create index credit_ledger_user_created_idx
  on public.credit_ledger(user_id, created_at desc, id desc);

-- Every writer uses the same lock, including older billing callers. Never trust
-- a balance calculated before the insert: two different rewards can arrive together.
create function public.credit_ledger_set_balance() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_balance bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('credits:' || new.user_id::text, 0));
  -- ponytail: sum the per-user ledger; add a locked balance projection if history
  -- volume makes this indexed scan material. This also tolerates old stale balances.
  select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where user_id = new.user_id;
  new.balance_after := v_balance + new.amount;
  if new.amount < 0 and new.balance_after < 0
    and new.source <> 'admin_adjustment'
    and not (new.source = 'reversal' and new.reference_type is not distinct from 'referral_reward') then
    raise exception 'insufficient credits' using errcode = '23514';
  end if;
  -- Timestamp after acquiring the lock keeps old latest-row readers consistent.
  new.created_at := clock_timestamp();
  return new;
end $$;
create trigger credit_ledger_balance_before_insert before insert on public.credit_ledger
  for each row execute function public.credit_ledger_set_balance();
revoke all on function public.credit_ledger_set_balance() from public, anon, authenticated;

create function public.get_or_create_referral_code(p_user_id uuid)
returns public.referral_codes
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_code public.referral_codes; v_attempt integer;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then raise exception 'user required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('referral-code:' || p_user_id::text, 0));
  select * into v_code from public.referral_codes where user_id = p_user_id and status = 'active';
  if found then return v_code; end if;
  for v_attempt in 1..5 loop
    insert into public.referral_codes(user_id, code)
    values (p_user_id, 'bw-' || encode(gen_random_bytes(4), 'hex'))
    on conflict do nothing returning * into v_code;
    if found then return v_code; end if;
    select * into v_code from public.referral_codes where user_id = p_user_id and status = 'active';
    if found then return v_code; end if;
  end loop;
  raise exception 'referral code could not be allocated' using errcode = '55000';
end $$;

-- One row lock serializes qualification, manual review, and reversal. Ledger
-- changes and state changes commit together; held referrals require human review.
create function public.transition_referral(
  p_action text, p_referred_user_id uuid default null, p_referral_id uuid default null
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_ref public.referrals;
  v_original public.credit_ledger;
  v_reversal public.credit_ledger;
  v_flags text[] := '{}';
  v_recent bigint;
  v_posted boolean := false;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('qualify', 'approve', 'reject', 'reverse')
    or (p_action = 'qualify' and (p_referred_user_id is null or p_referral_id is not null))
    or (p_action <> 'qualify' and (p_referral_id is null or p_referred_user_id is not null)) then
    raise exception 'invalid referral transition' using errcode = '22023';
  end if;
  select * into v_ref from public.referrals
    where (p_action = 'qualify' and referred_user_id = p_referred_user_id)
       or (p_action <> 'qualify' and id = p_referral_id)
    for update;
  if not found then
    if p_action = 'qualify' then return jsonb_build_object('qualified', false, 'reason', 'no_attributed_referral'); end if;
    raise exception 'referral not found' using errcode = 'P0002';
  end if;

  if p_action = 'qualify' then
    if v_ref.status <> 'attributed' then
      return jsonb_build_object('qualified', false, 'duplicate', true, 'status', v_ref.status, 'held', v_ref.status = 'held', 'referral', to_jsonb(v_ref));
    end if;
    if v_ref.referrer_id = v_ref.referred_user_id then v_flags := array_append(v_flags, 'self_referral'); end if;
    if not exists (select 1 from public.referral_codes where id = v_ref.code_id and status = 'active') then
      v_flags := array_append(v_flags, 'inactive_code');
    end if;
    select count(*) into v_recent from public.referrals
      where referrer_id = v_ref.referrer_id and created_at >= now() - interval '24 hours';
    if v_recent > 20 then v_flags := array_append(v_flags, 'velocity_' || v_recent || '_per_day'); end if;
    if cardinality(v_flags) > 0 then
      update public.referrals set status = 'held', flagged = true,
        flag_reason = array_to_string(v_flags, ','), qualified_at = now()
        where id = v_ref.id returning * into v_ref;
      return jsonb_build_object('qualified', true, 'held', true, 'flags', to_jsonb(v_flags), 'referral', to_jsonb(v_ref));
    end if;
  elsif p_action in ('approve', 'reject') then
    if v_ref.status <> 'held' then return jsonb_build_object('referral', to_jsonb(v_ref), 'alreadyResolved', true); end if;
    if p_action = 'reject' then
      update public.referrals set status = 'rejected', flagged = false, reviewed_at = now()
        where id = v_ref.id returning * into v_ref;
      return jsonb_build_object('referral', to_jsonb(v_ref));
    end if;
  else
    if v_ref.status = 'reversed' then return jsonb_build_object('referral', to_jsonb(v_ref), 'alreadyReversed', true); end if;
    if v_ref.status <> 'rewarded' then raise exception 'only rewarded referrals can be reversed' using errcode = '22023'; end if;
    select * into v_original from public.credit_ledger where source = 'referral_reward' and reference_id = v_ref.id;
    if not found or v_original.user_id <> v_ref.referrer_id or v_original.amount <= 0 then
      raise exception 'reward entry not found or inconsistent' using errcode = '55000';
    end if;
    select * into v_reversal from public.credit_ledger where source = 'reversal' and reference_id = v_ref.id;
    if found then
      if v_reversal.user_id <> v_ref.referrer_id or v_reversal.amount <> -v_original.amount
        or v_reversal.reference_type is distinct from 'referral_reward' then
        raise exception 'reversal entry is inconsistent' using errcode = '55000';
      end if;
    else
      insert into public.credit_ledger(user_id, source, amount, balance_after, reference_type, reference_id)
      values (v_ref.referrer_id, 'reversal', -v_original.amount, 0, 'referral_reward', v_ref.id);
    end if;
    update public.referrals set status = 'reversed', flagged = false, reviewed_at = now()
      where id = v_ref.id returning * into v_ref;
    return jsonb_build_object('referral', to_jsonb(v_ref), 'reversedAmount', -v_original.amount, 'originalEntryId', v_original.id);
  end if;

  -- Recover a legacy partially written reward without posting it again.
  select * into v_original from public.credit_ledger where source = 'referral_reward' and reference_id = v_ref.id;
  if found then
    if v_original.user_id <> v_ref.referrer_id or v_original.amount <= 0
      or v_original.reference_type is distinct from 'referral' then
      raise exception 'reward entry is inconsistent' using errcode = '55000';
    end if;
  else
    insert into public.credit_ledger(user_id, source, amount, balance_after, reference_type, reference_id)
    values (v_ref.referrer_id, 'referral_reward', 100, 0, 'referral', v_ref.id);
    v_posted := true;
  end if;
  update public.referrals set status = 'rewarded', flagged = false,
    qualified_at = coalesce(qualified_at, now()),
    reviewed_at = case when p_action = 'approve' then now() else reviewed_at end
    where id = v_ref.id returning * into v_ref;
  return jsonb_build_object('qualified', true, 'held', false, 'rewarded', v_posted, 'referral', to_jsonb(v_ref));
end $$;

-- Aggregate before PostgREST row limits; history may be paginated independently.
create function public.referral_credit_summary(p_user_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if p_user_id is null or (current_user <> 'service_role' and auth.role() is distinct from 'service_role'
    and auth.uid() is distinct from p_user_id) then
    raise exception 'own credit summary required' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'creditBalance', coalesce(sum(amount), 0),
      'referralCredits', coalesce(sum(amount) filter (where source = 'referral_reward'
        or (source = 'reversal' and reference_type = 'referral_reward')), 0),
      'rewardedReferrals', (select count(*) from public.referrals where referrer_id = p_user_id and status = 'rewarded')
    ) from public.credit_ledger where user_id = p_user_id
  );
end $$;

revoke all on function public.get_or_create_referral_code(uuid) from public, anon, authenticated;
revoke all on function public.transition_referral(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.referral_credit_summary(uuid) from public, anon;
grant execute on function public.get_or_create_referral_code(uuid), public.transition_referral(text, uuid, uuid) to service_role;
grant execute on function public.referral_credit_summary(uuid) to authenticated, service_role;
