begin;
do $$
declare target regprocedure := 'public.reserve_metadata_job_credit()'::regprocedure;
begin
  assert pg_get_function_result(target) = 'trigger', 'metadata reservation helper changed type';
  assert not has_function_privilege('anon', target, 'EXECUTE'), 'anonymous role can execute metadata trigger helper';
  assert not has_function_privilege('authenticated', target, 'EXECUTE'), 'authenticated role can execute metadata trigger helper';
  assert has_function_privilege('service_role', target, 'EXECUTE'), 'service access was unexpectedly revoked';
  assert exists(select 1 from pg_trigger where tgfoid='public.reserve_text_job_credit()'::regprocedure and not tgisinternal),
    'shared text credit reservation trigger must remain installed';
end $$;
rollback;
