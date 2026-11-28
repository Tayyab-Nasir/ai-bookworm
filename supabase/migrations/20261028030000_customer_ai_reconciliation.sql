-- Service-only safety reconciliation; no worker, entitlement or model is enabled.
-- Successful receipts remain recoverable through existing receipt-only RPCs.
create function public.reconcile_customer_ai_job(p_job_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required'; end if;
 if p_job_id is null then raise exception using errcode='22023',message='customer job required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 -- Match claim, hold, cancellation, completion and connection revocation.
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 select * into strict a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into strict j from public.ai_jobs where id=p_job_id for update;
 if a.state='settled' and j.status='succeeded' then return 'settled'; end if;
 if a.state='released' and j.status='cancelled' then return 'released'; end if;
 if a.state='review' and j.status='failed' and j.error_code='customer_provider_outcome_unknown' then return 'requires_review'; end if;
 if a.state<>'held' or j.billing_mode<>'customer_key' or j.status not in ('queued','running') then
  raise exception using errcode='40001',message='customer job requires investigation'; end if;
 -- Null or active leases are not proof that a running worker has stopped.
 if j.status='running' and (j.lease_expires_at is null or j.lease_expires_at>clock_timestamp()) then return 'unchanged'; end if;
 if a.dispatched_at is null then
  if a.expires_at>clock_timestamp() and j.attempts<5 then return 'unchanged'; end if;
  perform public.cancel_customer_ai_job(a.job_id,a.owner_id);
  return 'released';
 end if;
 if j.status<>'running' or j.lease_token is distinct from a.dispatch_lease_token then
  raise exception using errcode='40001',message='customer dispatch lease changed'; end if;
 -- Hold is one-way and does not touch credits. A receipt may arrive after this
 -- transaction; the existing validated completion RPC can settle it from review.
 perform public.hold_customer_ai_job(a.job_id,a.dispatch_lease_token);
 return 'requires_review';
end $$;

revoke all on function public.reconcile_customer_ai_job(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_customer_ai_job(uuid) to service_role;
