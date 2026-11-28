-- Bind quoted Book Bible accounting to the immutable, privately saved provider
-- result. The full HTTP request fingerprint is not the provider-input hash.
create trigger book_bible_service_receipt_immutable
before update on public.book_bible_service_receipts
for each row execute function public.guard_text_service_receipt();

-- Keep the existing candidate/citation/accounting implementation private. Its
-- public entry point additionally verifies the durable receipt and lease.
alter function public.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)
  set schema bookworm_private;
revoke all on function bookworm_private.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function bookworm_private.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)
  to service_role;

create function public.complete_quoted_book_bible_job(
  p_job_id uuid,p_lease_token uuid,p_provider text,p_model text,p_request_id text,
  p_usage jsonb,p_diagnostics jsonb,p_candidates jsonb,p_settlement jsonb
) returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; r public.book_bible_service_receipts;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.agent_type<>'bookbible' or j.billing_mode<>'quoted' then
    raise exception 'quoted Book Bible job missing' using errcode='P0002'; end if;
  if j.status='succeeded' and not exists(select 1 from public.book_bible_quote_service_receipts saved
    where saved.job_id=j.id and saved.result_json=jsonb_build_object('requestId',trim(p_request_id),
      'provider',trim(p_provider),'model',trim(p_model),'usage',p_usage,'diagnostics',p_diagnostics,
      'candidates',p_candidates,'settlement',p_settlement)) then
    raise exception 'Book Bible completion replay mismatch' using errcode='23505'; end if;
  if j.status<>'succeeded' and (j.status<>'running' or p_lease_token is null
    or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null
    or j.lease_expires_at<=clock_timestamp()) then
    raise exception 'Book Bible quote lease lost' using errcode='40001'; end if;
  select * into q from public.funded_usage_quotes where job_id=j.id for update;
  select * into r from public.book_bible_service_receipts where job_id=j.id for share;
  if r.result_json is null or r.result_json->>'jobId' is distinct from j.id::text
    or r.result_json->>'workspaceId' is distinct from j.workspace_id::text
    or r.result_json->>'bookId' is distinct from j.book_id::text
    or r.result_json->>'agentType' is distinct from 'bookbible'
    or r.result_json->>'status' is distinct from 'succeeded'
    or r.result_json->>'provider' is distinct from p_provider
    or r.result_json->>'model' is distinct from p_model
    or r.result_json->>'requestId' is distinct from trim(p_request_id)
    or r.result_json->'usage' is distinct from p_usage
    or r.result_json->'diagnostics' is distinct from p_diagnostics
    or r.result_json->'suggestions' is distinct from p_candidates
    or q.job_id is null or q.user_id is distinct from j.created_by
    or q.workspace_id is distinct from j.workspace_id or q.dispatched_at is null then
    raise exception 'Book Bible funded receipt mismatch' using errcode='23514'; end if;
  perform bookworm_private.assert_text_quote_settlement(q.quote_json,p_usage,p_settlement);
  return bookworm_private.complete_quoted_book_bible_job(p_job_id,p_lease_token,p_provider,p_model,p_request_id,
    p_usage,p_diagnostics,p_candidates,p_settlement);
end $$;
revoke all on function public.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.complete_quoted_book_bible_job(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)
  to service_role;
