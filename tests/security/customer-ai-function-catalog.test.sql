-- Catalog diagnostic only: it does not prove complete database readiness.
begin;
set local request.jwt.claims='{"role":"service_role"}';
do $$ begin
 assert public.inspect_customer_ai_function_contract() =
  '{"contract":"customer-ai-function-catalog-v1","passed":true}'::jsonb;
 assert has_function_privilege('service_role','public.inspect_customer_ai_function_contract()','execute');
 assert not has_function_privilege('anon','public.inspect_customer_ai_function_contract()','execute');
 assert not has_function_privilege('authenticated','public.inspect_customer_ai_function_contract()','execute');
end $$;

create function pg_temp.check_drift(statement text) returns void language plpgsql as $$
begin
 begin
  execute statement;
  assert public.inspect_customer_ai_function_contract() =
   '{"contract":"customer-ai-function-catalog-v1","passed":false}'::jsonb, statement;
  -- Roll back only the mutation, leaving later cases independent.
  raise exception using errcode='P7777';
 exception when sqlstate 'P7777' then null; end;
 assert public.inspect_customer_ai_function_contract() =
  '{"contract":"customer-ai-function-catalog-v1","passed":true}'::jsonb, 'rollback failed';
end $$;
select pg_temp.check_drift('grant execute on function public.claim_customer_ai_job(uuid,integer) to public');
select pg_temp.check_drift('grant execute on function public.inspect_customer_ai_function_contract() to public');
select pg_temp.check_drift('grant execute on function public.claim_customer_ai_job(uuid,integer) to anon');
select pg_temp.check_drift('grant execute on function public.claim_customer_ai_job(uuid,integer) to authenticated');
select pg_temp.check_drift('grant service_role to authenticated');
-- On PG16+, demonstrate a deliberate limitation: a SET-only chain is not
-- an effective inherited EXECUTE grant, and this diagnostic does not see it.
do $$ begin
 if current_setting('server_version_num')::integer >= 160000 then
  begin
   execute 'grant service_role to authenticated with inherit false, set true';
   assert not has_function_privilege('authenticated','public.claim_customer_ai_job(uuid,integer)','execute');
   assert pg_has_role('authenticated','service_role','SET');
   assert public.inspect_customer_ai_function_contract()->>'passed' = 'true', 'diagnostic unexpectedly claims to cover SET chains';
   raise exception using errcode='P7777';
  exception when sqlstate 'P7777' then null; end;
  assert public.inspect_customer_ai_function_contract()->>'passed' = 'true';
 end if;
end $$;
select pg_temp.check_drift('revoke execute on function public.claim_customer_ai_job(uuid,integer) from service_role');
select pg_temp.check_drift('alter function public.claim_customer_ai_job(uuid,integer) security invoker');
select pg_temp.check_drift('alter function public.claim_customer_ai_job(uuid,integer) set search_path=public,pg_catalog');
select pg_temp.check_drift('alter function public.claim_customer_ai_job(uuid,integer) reset search_path');
select pg_temp.check_drift('alter function public.claim_customer_ai_job(uuid,integer) rename to diagnostic_temp_claim');

set local role anon;
do $$ begin
 begin perform public.inspect_customer_ai_function_contract(); assert false,'anon could call diagnostic';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
 begin perform public.inspect_customer_ai_function_contract(); assert false,'authenticated could call diagnostic';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ begin
 assert public.inspect_customer_ai_function_contract()->>'passed' = 'true';
end $$;
reset role;
-- The JWT claim is required even when the caller has SQL EXECUTE.
set local request.jwt.claims='{"role":"authenticated"}';
do $$ begin
 begin perform public.inspect_customer_ai_function_contract(); assert false,'claim check missing';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
