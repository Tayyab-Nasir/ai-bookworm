-- Read-only discovery. The existing specific-ID claim remains the only lease
-- authority, and the dispatch resolver rechecks authorization before key use.
-- This does not enable customer AI or seed a policy or paid entitlement.
create index customer_ai_undispatched_discovery
 on bookworm_credentials.customer_ai_jobs(created_at,job_id)
 where state='held' and dispatched_at is null;

create function public.discover_customer_ai_ready_jobs(
 p_limit integer default 20, p_after_created_at timestamptz default null, p_after_job_id uuid default null
) returns table(job_id uuid,created_at timestamptz,ready boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required'; end if;
 if p_limit is null or p_limit not between 1 and 100
   or (p_after_created_at is null)<>(p_after_job_id is null)
   or (p_after_created_at is not null and not isfinite(p_after_created_at)) then
  raise exception using errcode='22023',message='invalid discovery cursor or limit'; end if;
 -- Bound the candidate scan *before* checking changing eligibility. Return
 -- every scanned cursor, including ineligible rows, so callers can advance
 -- through an arbitrarily long run of revoked or expired jobs without starvation.
 return query
 with candidates as materialized (
  select q.job_id,q.created_at from bookworm_credentials.customer_ai_jobs q
  where q.state='held' and q.dispatched_at is null
   and (p_after_created_at is null or (q.created_at,q.job_id)>(p_after_created_at,p_after_job_id))
  order by q.created_at,q.job_id limit p_limit
 )
 select candidate.job_id,candidate.created_at,exists(
 select 1 from bookworm_credentials.customer_ai_jobs a
 join public.ai_jobs j on j.id=a.job_id
 join public.workspaces w on w.id=a.workspace_id and w.organization_id=a.organization_id
 join public.books b on b.id=a.book_id and b.workspace_id=a.workspace_id
 join public.workspace_members m on m.workspace_id=a.workspace_id and m.user_id=a.owner_id
  and m.status='active' and m.role in ('owner','admin','editor','writer')
 join public.ai_connections c on c.id=a.connection_id and c.owner_id=a.owner_id
  and c.revision=a.credential_revision and c.provider=a.provider and c.status='saved'
 join bookworm_credentials.customer_ai_policies p on p.id=a.policy_id and p.enabled and p.expires_at>clock_timestamp()
 join lateral (select s.plan_id,s.status,s.current_period_end from public.subscriptions s
   where s.organization_id=a.organization_id order by s.created_at desc,s.id desc limit 1) s on true
 join public.plans plan on plan.id=s.plan_id
 where a.job_id=candidate.job_id and a.state='held' and a.dispatched_at is null and a.expires_at>clock_timestamp()
  and j.billing_mode='customer_key' and j.attempts<5
  and ((j.status='queued' and j.available_at<=clock_timestamp())
    or (j.status='running' and j.lease_expires_at<=clock_timestamp()))
  and s.status='active' and s.current_period_end>clock_timestamp() and plan.is_active and plan.price_cents>0
  and plan.entitlements_json->'customer_ai_enabled'='true'::jsonb
  and coalesce(plan.entitlements_json->>'customer_ai_requests_monthly','') ~ '^[1-9][0-9]{0,6}$'
  and exists(select 1 from bookworm_credentials.ai_connection_secrets secret
    where secret.connection_id=a.connection_id and secret.revision=a.credential_revision)
  and not exists(select 1 from jsonb_array_elements(a.source_versions) v
    where not exists(select 1 from public.chapters chapter
      join public.document_versions d on d.id=chapter.current_document_version_id and d.chapter_id=chapter.id
      where chapter.book_id=a.book_id and chapter.id=(v->>'chapterId')::uuid
       and d.id=(v->>'documentVersionId')::uuid and d.version_number=(v->>'version')::integer))
 ) from candidates candidate order by candidate.created_at,candidate.job_id;
end $$;

revoke all on function public.discover_customer_ai_ready_jobs(integer,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.discover_customer_ai_ready_jobs(integer,timestamptz,uuid) to service_role;
