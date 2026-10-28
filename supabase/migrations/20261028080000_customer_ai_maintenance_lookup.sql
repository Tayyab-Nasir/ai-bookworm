-- Exact service-only replay lookup, including immutable completed attempts.
create function public.read_customer_ai_maintenance(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare entry bookworm_credentials.customer_ai_maintenance_attempts;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_attempt_id is null then raise exception using errcode='22023',message='maintenance identity required'; end if;
 select * into entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=p_attempt_id;
 if not found then raise exception using errcode='P0002',message='maintenance attempt not found'; end if;
 return jsonb_build_object('attemptId',entry.attempt_id,'jobId',entry.job_id,'action',entry.action,'state',entry.state,'result',entry.result);
end $$;
revoke all on function public.read_customer_ai_maintenance(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_customer_ai_maintenance(uuid) to service_role;

-- The restart scan can skip retained completed attempts instead of walking
-- the historical prefix. The original index is retained for other consumers.
create index customer_ai_maintenance_outstanding_list
 on bookworm_credentials.customer_ai_maintenance_attempts(created_at,attempt_id)
 where state in ('pending','needs_review');
