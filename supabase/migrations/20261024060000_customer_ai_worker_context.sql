-- Private, non-secret preparation for the single-use customer key resolver.
-- Repeating this read is safe; the resolver still reauthorizes at dispatch.
create function public.prepare_customer_ai_dispatch(p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 -- Same lock order as claim/resolution/revocation: owner, organization, grant, job.
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 if bookworm_credentials.customer_ai_access(a.owner_id,a.workspace_id,a.book_id,a.connection_id,a.credential_revision,a.provider) is distinct from a.organization_id then
  raise exception using errcode='42501',message='customer AI organization changed'; end if;
 perform bookworm_credentials.customer_ai_allowance(a.organization_id);
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if not found then raise exception using errcode='40001',message='customer preparation unavailable'; end if;
 if a.state<>'held' or a.dispatched_at is not null or a.expires_at<=clock_timestamp() or j.status<>'running'
   or j.billing_mode<>'customer_key' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp()
   or not exists(select 1 from bookworm_credentials.customer_ai_policies where id=a.policy_id and enabled and expires_at>clock_timestamp()) then
  raise exception using errcode='40001',message='customer preparation unavailable'; end if;
 perform bookworm_credentials.check_customer_ai_sources(a.book_id,a.source_versions,a.request_snapshot);
 return jsonb_build_object('scope',jsonb_build_object('grantId',a.grant_id,'jobId',a.job_id,'workspaceId',a.workspace_id,
  'bookId',a.book_id,'ownerId',a.owner_id,'connectionId',a.connection_id,'credentialRevision',a.credential_revision,
  'leaseToken',p_lease_token,'provider',a.provider,'agentType',a.agent_type,'expectedRequestSha256',a.request_sha256,'policy',a.model_policy),
  'request',a.request_snapshot);
end $$;

revoke all on function public.prepare_customer_ai_dispatch(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_customer_ai_dispatch(uuid,uuid) to service_role;
