-- Service-only advisory scan; it neither claims, releases, nor dispatches.
-- Reconciliation and receipt completion remain separate, locked operations.
create index customer_ai_reconciliation_discovery
 on bookworm_credentials.customer_ai_jobs(created_at,job_id)
 where state in ('held','review');

create function public.discover_customer_ai_reconciliation_candidates(
 p_limit integer default 20,p_after_created_at timestamptz default null,p_after_job_id uuid default null
) returns table(job_id uuid,created_at timestamptz,action text)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required'; end if;
 if p_limit is null or p_limit not between 1 and 100
  or (p_after_created_at is null)<>(p_after_job_id is null)
  or (p_after_created_at is not null and not isfinite(p_after_created_at)) then
  raise exception using errcode='22023',message='invalid discovery cursor or limit'; end if;
 return query
 with candidates as materialized (
  select q.job_id,q.created_at from bookworm_credentials.customer_ai_jobs q
  where q.state in ('held','review')
   and (p_after_created_at is null or (q.created_at,q.job_id)>(p_after_created_at,p_after_job_id))
  order by q.created_at,q.job_id limit p_limit
 )
 select c.job_id,c.created_at,
  case
   when j.id is null or j.billing_mode<>'customer_key' then 'investigate'
   when a.state='review' then case
    when j.status<>'failed' or j.error_code is distinct from 'customer_provider_outcome_unknown'
      or a.dispatched_at is null then 'investigate'
    when exists(select 1 from public.ai_review_service_receipts r where r.job_id=a.job_id
      and r.request_sha256=a.receipt_fingerprint and r.result_json is not null) then 'receipt_available'
    else 'review' end
   when j.status not in ('queued','running') then 'investigate'
   when a.dispatched_at is not null and (j.status<>'running' or j.lease_token is distinct from a.dispatch_lease_token)
     then 'investigate'
   when j.status='running' and (j.lease_expires_at is null or j.lease_expires_at>clock_timestamp()) then 'none'
   when a.dispatched_at is not null then 'reconcile'
   when a.expires_at<=clock_timestamp() or j.attempts>=5 then 'reconcile'
   else 'none'
  end::text
 from candidates c join bookworm_credentials.customer_ai_jobs a on a.job_id=c.job_id
 left join public.ai_jobs j on j.id=a.job_id
 order by c.created_at,c.job_id;
end $$;

revoke all on function public.discover_customer_ai_reconciliation_candidates(integer,timestamptz,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.discover_customer_ai_reconciliation_candidates(integer,timestamptz,uuid) to service_role;
