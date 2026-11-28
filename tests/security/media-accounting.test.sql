begin;
do $$
begin
  assert not has_function_privilege('anon','public.lock_media_credit_accounting()','execute');
  assert not has_function_privilege('authenticated','public.lock_media_credit_accounting()','execute');
  assert exists(select 1 from pg_trigger where tgrelid='public.usage_events'::regclass
    and tgname='media_credit_accounting_lock' and tgenabled='O' and not tgisinternal);
end $$;
rollback;
