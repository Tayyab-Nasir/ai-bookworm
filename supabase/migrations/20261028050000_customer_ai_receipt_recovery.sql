-- Trusted background recovery of one exact durable receipt. This function
-- neither dispatches a provider nor changes credit holds on uncertain work.
create function public.recover_customer_ai_receipt(p_job_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required'; end if;
 if p_job_id is null then raise exception using errcode='22023',message='customer job required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 if a.dispatched_at is null or a.receipt_fingerprint is null or not exists(
  select 1 from public.ai_review_service_receipts
   where job_id=a.job_id and request_sha256=a.receipt_fingerprint and result_json is not null
 ) then raise exception using errcode='40001',message='completed customer receipt unavailable'; end if;
 -- Completion obtains the established owner/organization/job locks and checks
 -- receipt identity, content, state and immutable dispatch fingerprint again.
 select * into j from public.complete_customer_ai_job(a.job_id,a.owner_id,a.receipt_fingerprint);
 if j.status is distinct from 'succeeded' then
  raise exception using errcode='23514',message='customer receipt completion unavailable'; end if;
 return 'settled';
end $$;

revoke all on function public.recover_customer_ai_receipt(uuid) from public,anon,authenticated,service_role;
grant execute on function public.recover_customer_ai_receipt(uuid) to service_role;
