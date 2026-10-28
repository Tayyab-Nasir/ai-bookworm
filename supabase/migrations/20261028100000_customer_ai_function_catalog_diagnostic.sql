-- Unregistered, read-only catalog diagnostic. This is deliberately not a
-- readiness proof: it cannot establish function semantics, table/RLS safety,
-- migration history, project identity, or worker/provider availability. It
-- does not attest role SET chains, ADMIN escalation, ownership or unlisted
-- principals, including NOINHERIT memberships that permit SET ROLE.
create function public.inspect_customer_ai_function_contract() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
 signature text;
 proc_id oid;
 procedure_record record;
 signatures text[] := array[
  'public.inspect_customer_ai_function_contract()',
  'public.create_customer_ai_job(uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer,boolean)',
  'public.claim_customer_ai_job(uuid,integer)',
  'public.resolve_customer_ai_dispatch(uuid,uuid,text)',
  'public.customer_ai_dispatch_authorized(jsonb)',
  'public.cancel_customer_ai_job(uuid,uuid)',
  'public.hold_customer_ai_job(uuid,uuid)',
  'public.complete_customer_ai_job(uuid,uuid,text)',
  'public.prepare_customer_ai_dispatch(uuid,uuid)',
  'public.customer_ai_preparation_options(uuid,uuid,uuid,uuid,integer,text)',
  'public.prepare_customer_ai_request(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer)',
  'public.customer_ai_request_action(uuid,uuid,text,integer,boolean)',
  'public.close_customer_ai_preparation(uuid,uuid,uuid)',
  'public.discover_customer_ai_ready_jobs(integer,timestamp with time zone,uuid)',
  'public.reconcile_customer_ai_job(uuid)',
  'public.discover_customer_ai_reconciliation_candidates(integer,timestamp with time zone,uuid)',
  'public.recover_customer_ai_receipt(uuid)',
  'public.begin_customer_ai_maintenance(uuid,uuid,text)',
  'public.execute_customer_ai_maintenance(uuid)',
  'public.list_customer_ai_maintenance_attempts(integer,timestamp with time zone,uuid)',
  'public.read_customer_ai_maintenance(uuid)',
  'public.open_customer_ai_maintenance_slot(uuid,text)',
  'public.ack_customer_ai_maintenance_slot(uuid,text,uuid,integer)',
  'public.list_customer_ai_maintenance_slots(integer,uuid,text)',
  'public.list_customer_ai_maintenance_observations(integer,timestamp with time zone,uuid)'
 ];
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required';
 end if;
 foreach signature in array signatures loop
  proc_id:=to_regprocedure(signature);
  if proc_id is null then
   return jsonb_build_object('contract','customer-ai-function-catalog-v1','passed',false);
  end if;
  select prosecdef,proconfig into procedure_record from pg_catalog.pg_proc where oid=proc_id;
  if not coalesce(procedure_record.prosecdef,false)
   or not coalesce(procedure_record.proconfig @> array['search_path=pg_catalog, public'],false)
   or not has_function_privilege('service_role',proc_id,'EXECUTE')
   or has_function_privilege('anon',proc_id,'EXECUTE')
   or has_function_privilege('authenticated',proc_id,'EXECUTE') then
   return jsonb_build_object('contract','customer-ai-function-catalog-v1','passed',false);
  end if;
 end loop;
 return jsonb_build_object('contract','customer-ai-function-catalog-v1','passed',true);
end $$;
revoke all on function public.inspect_customer_ai_function_contract() from public,anon,authenticated,service_role;
grant execute on function public.inspect_customer_ai_function_contract() to service_role;
