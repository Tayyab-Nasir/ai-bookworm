begin;
insert into auth.users(id, email)
select ('a8700000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'referral-' || n || '@local.test'
from generate_series(1, 8) n;

set local role service_role;
do $$ declare v_code public.referral_codes; v_again public.referral_codes; v_result jsonb; begin
  v_code := public.get_or_create_referral_code('a8700000-0000-4000-8000-000000000001');
  v_again := public.get_or_create_referral_code('a8700000-0000-4000-8000-000000000001');
  assert v_code.id = v_again.id, 'repeat code creation changed the invitation';
  begin
    insert into public.referral_codes(user_id, code) values (v_code.user_id, 'bw-second-active');
    assert false, 'second active code accepted';
  exception when unique_violation then null; end;
  v_result := public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000008');
  assert v_result->>'reason' = 'no_attributed_referral', 'unattributed user earned a reward';
end $$;

insert into public.referrals(id, referrer_id, referred_user_id, code_id)
select ('a8710000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  c.user_id, ('a8700000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, c.id
from public.referral_codes c cross join generate_series(2, 6) n
where c.user_id = 'a8700000-0000-4000-8000-000000000001';

do $$ declare v_result jsonb; v_balance integer; begin
  v_result := public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000002');
  assert v_result->>'rewarded' = 'true' and v_result->'referral'->>'status' = 'rewarded', 'reward not completed';
  v_result := public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000002');
  assert v_result->>'duplicate' = 'true', 'qualification retry was not a no-op';
  assert (select count(*) from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000002') = 1, 'duplicate reward';

  insert into public.credit_ledger(user_id, source, amount, balance_after)
  values ('a8700000-0000-4000-8000-000000000001', 'consumption', -70, 99999) returning balance_after into v_balance;
  assert v_balance = 30, 'caller supplied stale balance was trusted';
  v_result := public.transition_referral('reverse', p_referral_id => 'a8710000-0000-4000-8000-000000000002');
  assert v_result->>'reversedAmount' = '-100', 'wrong compensating amount';
  assert public.referral_credit_summary('a8700000-0000-4000-8000-000000000001')->>'creditBalance' = '-70', 'spent reward could not be reversed into debt';
  v_result := public.transition_referral('reverse', p_referral_id => 'a8710000-0000-4000-8000-000000000002');
  assert v_result->>'alreadyReversed' = 'true', 'reversal retry was not a no-op';
  assert (select count(*) from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000002') = 2, 'duplicate reversal';
  perform public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000002');
  assert (select status from public.referrals where id = 'a8710000-0000-4000-8000-000000000002') = 'reversed', 'late qualify resurrected a reversed reward';
  begin
    insert into public.credit_ledger(user_id, source, amount, balance_after)
    values ('a8700000-0000-4000-8000-000000000001', 'consumption', -1, 1000);
    assert false, 'debt account could spend';
  exception when check_violation then null; end;
  begin
    insert into public.credit_ledger(user_id, source, amount, balance_after)
    values ('a8700000-0000-4000-8000-000000000001', 'reversal', -1, 1000);
    assert false, 'untyped reversal bypassed credit check';
  exception when check_violation then null; end;
end $$;

-- An inactive-code hold stays held after code reactivation and repeated delivery.
update public.referral_codes set status = 'inactive' where user_id = 'a8700000-0000-4000-8000-000000000001';
select public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000003');
select public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000004');
update public.referral_codes set status = 'active' where user_id = 'a8700000-0000-4000-8000-000000000001';
do $$ declare v_result jsonb; begin
  v_result := public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000003');
  assert v_result->>'held' = 'true', 'retry automatically cleared a fraud hold';
  assert not exists (select 1 from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000003'), 'held referral posted credit';
  v_result := public.transition_referral('approve', p_referral_id => 'a8710000-0000-4000-8000-000000000003');
  assert v_result->'referral'->>'status' = 'rewarded' and v_result->'referral'->>'flagged' = 'false', 'approval did not resolve hold';
  v_result := public.transition_referral('reject', p_referral_id => 'a8710000-0000-4000-8000-000000000003');
  assert v_result->>'alreadyResolved' = 'true', 'late reject overwrote approval';
  perform public.transition_referral('approve', p_referral_id => 'a8710000-0000-4000-8000-000000000003');
  assert (select count(*) from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000003') = 1, 'approval retry posted credit twice';
  perform public.transition_referral('reject', p_referral_id => 'a8710000-0000-4000-8000-000000000004');
  perform public.transition_referral('approve', p_referral_id => 'a8710000-0000-4000-8000-000000000004');
  perform public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000004');
  assert (select status from public.referrals where id = 'a8710000-0000-4000-8000-000000000004') = 'rejected', 'late action overwrote rejection';
  assert not exists (select 1 from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000004'), 'rejected referral rewarded';
end $$;

-- Force a failure after the ledger insert to prove the whole transition rolls back.
reset role;
create function public.test_referral_write_failure() returns trigger language plpgsql as $$ begin
  if new.id = 'a8710000-0000-4000-8000-000000000005' then raise exception 'injected write failure'; end if;
  return new;
end $$;
create trigger test_referral_write_failure before update on public.referrals
  for each row execute function public.test_referral_write_failure();
set local role service_role;
do $$ begin
  begin
    perform public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000005');
    assert false, 'injected write failure was ignored';
  exception when raise_exception then
    assert sqlerrm = 'injected write failure', 'unexpected failure';
  end;
  assert not exists (select 1 from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000005'), 'failed referral update left a ledger reward';
  assert (select status from public.referrals where id = 'a8710000-0000-4000-8000-000000000005') = 'attributed', 'failed transition persisted status';
end $$;
reset role;
drop trigger test_referral_write_failure on public.referrals;
drop function public.test_referral_write_failure();
set local role service_role;

-- Recover the older implementation's partially committed reward without a repost.
insert into public.credit_ledger(user_id, source, amount, balance_after, reference_type, reference_id)
values ('a8700000-0000-4000-8000-000000000001', 'referral_reward', 100, 0, 'referral', 'a8710000-0000-4000-8000-000000000006');
do $$ declare v_result jsonb; begin
  v_result := public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000006');
  assert v_result->>'rewarded' = 'false' and v_result->'referral'->>'status' = 'rewarded', 'partial reward not recovered';
  assert (select count(*) from public.credit_ledger where reference_id = 'a8710000-0000-4000-8000-000000000006') = 1, 'legacy reward reposted';
end $$;

-- Counts are in SQL, beyond the typical PostgREST 1000-row cap and 100-row history.
insert into public.credit_ledger(user_id, source, amount, balance_after, reference_type, reference_id)
select 'a8700000-0000-4000-8000-000000000007', 'referral_reward', 1, 0, 'referral', gen_random_uuid()
from generate_series(1, 1105);
do $$ declare v_summary jsonb; begin
  v_summary := public.referral_credit_summary('a8700000-0000-4000-8000-000000000007');
  assert v_summary->>'creditBalance' = '1105' and v_summary->>'referralCredits' = '1105', 'summary truncated full history';
  v_summary := public.referral_credit_summary('a8700000-0000-4000-8000-000000000001');
  assert v_summary->>'creditBalance' = '130' and v_summary->>'referralCredits' = '200' and v_summary->>'rewardedReferrals' = '2', 'summary mixed spending with referral earnings';
  begin
    update public.credit_ledger set amount = 9 where user_id = 'a8700000-0000-4000-8000-000000000007';
    assert false, 'ledger became mutable';
  exception when raise_exception then null; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8700000-0000-4000-8000-000000000007', true);
do $$ begin
  assert public.referral_credit_summary('a8700000-0000-4000-8000-000000000007')->>'creditBalance' = '1105', 'own summary not readable';
  begin
    perform public.referral_credit_summary('a8700000-0000-4000-8000-000000000001');
    assert false, 'other author summary readable';
  exception when insufficient_privilege then null; end;
  begin
    perform public.transition_referral('qualify', 'a8700000-0000-4000-8000-000000000005');
    assert false, 'authenticated user self-qualified';
  exception when insufficient_privilege then null; end;
  begin
    perform public.get_or_create_referral_code('a8700000-0000-4000-8000-000000000001');
    assert false, 'authenticated user created another author code';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
