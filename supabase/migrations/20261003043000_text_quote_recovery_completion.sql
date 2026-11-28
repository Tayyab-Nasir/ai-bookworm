-- Recover undelivered leased text work and commit metadata billing/results together.
-- These are source-only changes; they do not activate a paid catalog.
create function public.claim_quoted_text_job(p_kind text,p_lease_seconds integer)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; r jsonb; sources jsonb; source jsonb;
  role_name text; reason text; current_version uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('metadata','review') or p_lease_seconds is null
    or p_lease_seconds not between 30 and 600 then raise exception 'invalid text quote lease' using errcode='22023'; end if;
  for j in select a.* from public.ai_jobs a join public.funded_usage_quotes f on f.job_id=a.id
    where a.billing_mode='quoted'
      and ((p_kind='metadata' and a.agent_type='metadata')
        or (p_kind='review' and a.agent_type in ('writer','proofreader','copyeditor','consistency')))
      and (a.status='queued' or (a.status='running' and a.lease_expires_at<=clock_timestamp()))
      and (f.status='held' or (p_kind='metadata' and f.status='settled' and f.dispatched_at is not null))
    order by a.available_at,a.created_at,a.id for update of a skip locked limit 25
  loop
    select * into strict q from public.funded_usage_quotes where job_id=j.id for update;
    if p_kind='metadata' then
      select to_jsonb(t) into r from public.metadata_token_quote_requests t
        where t.id=(j.input_ref->>'metadataQuoteRequestId')::uuid for update;
      select coalesce(jsonb_agg(jsonb_build_object('chapterId',key,'documentVersionId',value->>'documentVersionId') order by key),'[]')
        into sources from jsonb_each(r#>'{generation_request_json,input,chapters}');
    else
      select to_jsonb(t) into r from public.ai_review_token_quote_requests t
        where t.id=(j.input_ref->>'aiReviewQuoteRequestId')::uuid for update;
      sources:=r->'source_versions_json';
    end if;
    if r is null or r->>'accepted_job_id' is distinct from j.id::text
      or r->>'user_id' is distinct from j.created_by::text or r->>'workspace_id' is distinct from j.workspace_id::text
      or r->>'book_id' is distinct from j.book_id::text or q.user_id is distinct from j.created_by
      or q.workspace_id is distinct from j.workspace_id
      or coalesce(r->>'generation_request_sha256',r->>'request_sha256') is distinct from j.input_ref->>'generationRequestSha256'
      or q.quote_json is distinct from r->'usage_quote_json' then
      raise exception 'text quote/job identity mismatch' using errcode='22023'; end if;
    if q.dispatched_at is null then
      reason:=null;
      if (q.quote_json->>'expiresAt')::timestamptz<=clock_timestamp() then reason:='quote_expired_before_dispatch'; end if;
      select role::text into role_name from public.workspace_members where workspace_id=j.workspace_id
        and user_id=j.created_by and status='active' for share;
      if not found or role_name not in ('owner','admin','editor','writer') then reason:='permission_revoked_before_dispatch'; end if;
      if not exists(select 1 from public.books where id=j.book_id and workspace_id=j.workspace_id for share) then reason:='source_changed_before_dispatch'; end if;
      for source in select value from jsonb_array_elements(sources) order by value->>'chapterId'
      loop
        select c.current_document_version_id into current_version from public.chapters c
          where c.id=(source->>'chapterId')::uuid and c.book_id=j.book_id for share;
        if not found or current_version is distinct from (source->>'documentVersionId')::uuid
          or not exists(select 1 from public.document_versions d where d.id=current_version
            and d.chapter_id=(source->>'chapterId')::uuid
            and (p_kind='metadata' or d.version_number=(source->>'version')::integer)) then
          reason:='source_changed_before_dispatch'; end if;
      end loop;
      if reason is not null then
        insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
          values(q.user_id,q.workspace_id,'generation_release',q.reserved_credits,0,'usage_quote',j.id);
        update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
          'status','cancelled','reason',reason,'releaseCredits',q.reserved_credits::text,'fingerprint',q.quote_json->>'fingerprint') where job_id=j.id;
        update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
          error_code=case when p_kind='metadata' then 'metadata_' else 'ai_review_' end||reason,
          error_message='Saved text quote could not be verified before provider dispatch.' where id=j.id;
        continue;
      end if;
    end if;
    update public.ai_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),started_at=coalesce(started_at,clock_timestamp()),
      completed_at=null where id=j.id returning * into j;
    return next j; return;
  end loop;
end $$;
create or replace function public.claim_quoted_metadata_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language sql security invoker set search_path=public,pg_temp as $$
  select * from public.claim_quoted_text_job('metadata',p_lease_seconds);
$$;
create or replace function public.claim_quoted_ai_review_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language sql security invoker set search_path=public,pg_temp as $$
  select * from public.claim_quoted_text_job('review',p_lease_seconds);
$$;
revoke all on function public.claim_quoted_text_job(text,integer) from public,anon,authenticated;
grant execute on function public.claim_quoted_text_job(text,integer) to service_role;

-- The irreversible marker must serialize with source edits, not only worker claims.
create function public.guard_text_quote_dispatch() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; sources jsonb; source jsonb; current_version uuid; role_name text;
begin
  if old.dispatched_at is not null or new.dispatched_at is null then return new; end if;
  select * into strict j from public.ai_jobs where id=new.job_id for update;
  if j.billing_mode<>'quoted' or j.agent_type not in ('metadata','writer','proofreader','copyeditor','consistency') then return new; end if;
  select role::text into role_name from public.workspace_members where workspace_id=j.workspace_id
    and user_id=j.created_by and status='active' for share;
  if not found or role_name not in ('owner','admin','editor','writer') then
    raise exception 'text dispatch writing access revoked' using errcode='42501'; end if;
  if not exists(select 1 from public.books where id=j.book_id and workspace_id=j.workspace_id for share) then
    raise exception 'text dispatch book scope changed' using errcode='40001'; end if;
  if j.agent_type='metadata' then
    select coalesce(jsonb_agg(jsonb_build_object('chapterId',key,'documentVersionId',value->>'documentVersionId') order by key),'[]')
      into sources from public.metadata_token_quote_requests r,
        lateral jsonb_each(r.generation_request_json#>'{input,chapters}')
      where r.id=(j.input_ref->>'metadataQuoteRequestId')::uuid and r.accepted_job_id=j.id;
  else
    select source_versions_json into sources from public.ai_review_token_quote_requests
      where id=(j.input_ref->>'aiReviewQuoteRequestId')::uuid and accepted_job_id=j.id;
  end if;
  if sources is null or jsonb_typeof(sources) is distinct from 'array' or jsonb_array_length(sources)=0 then
    raise exception 'text dispatch source snapshot missing' using errcode='23514'; end if;
  for source in select value from jsonb_array_elements(sources) order by value->>'chapterId'
  loop
    select current_document_version_id into current_version from public.chapters
      where id=(source->>'chapterId')::uuid and book_id=j.book_id for share;
    if not found or current_version is distinct from (source->>'documentVersionId')::uuid then
      raise exception 'text dispatch source changed' using errcode='40001'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.guard_text_quote_dispatch() from public,anon,authenticated,service_role;
create trigger funded_text_dispatch_source before update of dispatched_at on public.funded_usage_quotes
for each row execute function public.guard_text_quote_dispatch();

-- Preserve the existing transition implementations and ACLs while closing SQL
-- NULL fall-through in their reason and lease predicates. Fail migration if the
-- pinned compatibility definitions do not have the expected guards.
do $$ declare signature text; definition text; repaired text; begin
  foreach signature in array array[
    'public.fail_quoted_metadata_before_dispatch(uuid,uuid,text)',
    'public.mark_quoted_metadata_requires_review(uuid,uuid,text,text)',
    'public.release_quoted_ai_review_before_dispatch(uuid,uuid,text)',
    'public.hold_quoted_ai_review_for_review(uuid,uuid,text,text)'
  ] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    repaired:=replace(definition,'p_reason not in (','p_reason is null or p_reason not in (');
    if repaired=definition then raise exception 'text reason guard missing: %',signature; end if;
    definition:=repaired;
    repaired:=replace(definition,'v_job.lease_token is distinct from p_lease_token',
      'p_lease_token is null or v_job.lease_expires_at is null or v_job.lease_token is distinct from p_lease_token');
    if repaired=definition then raise exception 'text lease guard missing: %',signature; end if;
    execute repaired;
  end loop;
end $$;
create or replace function public.renew_quoted_metadata_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid metadata lease' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and agent_type='metadata' and billing_mode='quoted' and status='running'
      and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

-- Keep compatibility implementation outside the public RPC schema. Only trusted
-- service callers may invoke it; public operational completion rejects quoted work.
create schema if not exists bookworm_private;
revoke all on schema bookworm_private from public,anon,authenticated;
grant usage on schema bookworm_private to service_role;
alter function public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) set schema bookworm_private;
create function public.complete_metadata_ai_job(p_job_id uuid,p_provider text,p_model text,p_usage jsonb,
  p_diagnostics jsonb,p_candidate jsonb,p_credit_quantity numeric) returns public.ai_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if found and j.billing_mode='quoted' then raise exception 'quoted metadata requires fenced completion' using errcode='23514'; end if;
  return bookworm_private.complete_metadata_ai_job(p_job_id,p_provider,p_model,p_usage,p_diagnostics,p_candidate,p_credit_quantity);
end $$;
revoke all on function public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.complete_metadata_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) to service_role;

alter function public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) set schema bookworm_private;
create function public.complete_ai_job(p_job_id uuid,p_provider text,p_model text,p_usage jsonb,
  p_diagnostics jsonb,p_suggestions jsonb,p_credit_quantity numeric) returns public.ai_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if found and j.billing_mode='quoted' then raise exception 'quoted AI work requires fenced completion' using errcode='23514'; end if;
  return bookworm_private.complete_ai_job(p_job_id,p_provider,p_model,p_usage,p_diagnostics,p_suggestions,p_credit_quantity);
end $$;
revoke all on function public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.complete_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric) to service_role;

-- Shared validation recomputes reservation and settlement from immutable prices.
create function bookworm_private.assert_text_quote_settlement(q jsonb,u jsonb,s jsonb) returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
declare item jsonb; dimension text; tokens numeric; rate numeric; maximum numeric; numerator numeric:=0;
  maximum_numerator numeric:=0; input_count numeric:=0; cached_count numeric:=0; output_count numeric:=0;
  denominator numeric; multiplier numeric; platform numeric; minimum_credits numeric; debit numeric; reserved numeric;
begin
  if jsonb_typeof(q) is distinct from 'object' or jsonb_typeof(u) is distinct from 'object' or jsonb_typeof(s) is distinct from 'object'
    or jsonb_typeof(u->'inputTokens') is distinct from 'number' or jsonb_typeof(u->'outputTokens') is distinct from 'number'
    or coalesce(u->>'inputTokens','') !~ '^(0|[1-9][0-9]{0,20})$' or coalesce(u->>'outputTokens','') !~ '^(0|[1-9][0-9]{0,20})$'
    or jsonb_typeof(u->'measuredTokens') is distinct from 'array' or jsonb_typeof(s->'tokens') is distinct from 'array'
    or jsonb_typeof(q#>'{price,rates}') is distinct from 'array' or jsonb_typeof(q->'maximumTokens') is distinct from 'array'
    or jsonb_array_length(u->'measuredTokens')<>3 or jsonb_array_length(q#>'{price,rates}')<>3 or jsonb_array_length(q->'maximumTokens')<>3
    or (select count(distinct value->>'dimension') from jsonb_array_elements(u->'measuredTokens'))<>3
    or (select count(distinct value->>'dimension') from jsonb_array_elements(q#>'{price,rates}'))<>3
    or (select count(distinct value->>'dimension') from jsonb_array_elements(q->'maximumTokens'))<>3
    or (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(u->'measuredTokens'))
      is distinct from (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(s->'tokens'))
    or s->>'status' is distinct from 'settle' or s->>'fingerprint' is distinct from q->>'fingerprint'
    or s->>'priceVersion' is distinct from q#>>'{price,version}' or s->>'policyVersion' is distinct from q#>>'{policy,version}'
    or q#>'{policy,approved}' is distinct from 'true'::jsonb
    or coalesce(q#>>'{policy,microUsdPerCredit}','') !~ '^[1-9][0-9]{0,20}$'
    or coalesce(q#>>'{policy,minimumCredits}','') !~ '^[1-9][0-9]{0,20}$'
    or coalesce(q#>>'{policy,platformMicroUsd}','') !~ '^(0|[1-9][0-9]{0,20})$'
    or coalesce(q#>>'{policy,markupBasisPoints}','') !~ '^[0-9]{1,7}$' then
    raise exception 'invalid measured text settlement' using errcode='23514'; end if;
  denominator:=(q#>>'{policy,microUsdPerCredit}')::numeric*1000000*10000;
  multiplier:=(q#>>'{policy,markupBasisPoints}')::numeric;
  platform:=(q#>>'{policy,platformMicroUsd}')::numeric*1000000;
  minimum_credits:=(q#>>'{policy,minimumCredits}')::numeric;
  if multiplier not between 10000 and 1000000 then raise exception 'invalid text credit policy' using errcode='23514'; end if;
  for item in select value from jsonb_array_elements(u->'measuredTokens') loop
    dimension:=item->>'dimension';
    if dimension is null or dimension not in ('text_input','text_cached_input','text_output')
      or jsonb_typeof(item) is distinct from 'object' or item-array['dimension','tokens']<>'{}'::jsonb
      or jsonb_typeof(item->'tokens') is distinct from 'string'
      or coalesce(item->>'tokens','') !~ '^(0|[1-9][0-9]{0,20})$' then
      raise exception 'invalid measured text dimension' using errcode='23514'; end if;
    tokens:=(item->>'tokens')::numeric;
    select value into item from jsonb_array_elements(q#>'{price,rates}') where value->>'dimension'=dimension;
    if item is null or coalesce(item->>'microUsdPerMillionTokens','') !~ '^(0|[1-9][0-9]{0,20})$' then
      raise exception 'invalid text price dimension' using errcode='23514'; end if;
    rate:=(item->>'microUsdPerMillionTokens')::numeric;
    select value into item from jsonb_array_elements(q->'maximumTokens') where value->>'dimension'=dimension;
    if item is null or coalesce(item->>'tokens','') !~ '^(0|[1-9][0-9]{0,20})$' then
      raise exception 'invalid text maximum dimension' using errcode='23514'; end if;
    maximum:=(item->>'tokens')::numeric;
    if tokens>maximum then raise exception 'text measured usage exceeds quote' using errcode='23514'; end if;
    numerator:=numerator+rate*tokens; maximum_numerator:=maximum_numerator+rate*maximum;
    case dimension when 'text_input' then input_count:=tokens;
      when 'text_cached_input' then cached_count:=tokens; when 'text_output' then output_count:=tokens; end case;
  end loop;
  debit:=greatest(minimum_credits,ceil((numerator+platform)*multiplier/denominator));
  reserved:=greatest(minimum_credits,ceil((maximum_numerator+platform)*multiplier/denominator));
  if (u->>'inputTokens')::numeric is distinct from input_count+cached_count or (u->>'outputTokens')::numeric is distinct from output_count
    or q->>'reservedCredits' is distinct from reserved::text or q->>'maximumProviderMicroUsd' is distinct from ceil(maximum_numerator/1000000)::text
    or s->>'debitCredits' is distinct from debit::text or s->>'releaseCredits' is distinct from (reserved-debit)::text
    or s->>'providerMicroUsd' is distinct from ceil(numerator/1000000)::text then
    raise exception 'text measured billing mismatch' using errcode='23514'; end if;
end $$;
revoke all on function bookworm_private.assert_text_quote_settlement(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function bookworm_private.assert_text_quote_settlement(jsonb,jsonb,jsonb) to service_role;

create function public.guard_text_service_receipt() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.job_id is distinct from old.job_id or new.request_sha256 is distinct from old.request_sha256
    or new.created_at is distinct from old.created_at
    or (old.result_json is not null and new.result_json is distinct from old.result_json) then
    raise exception 'text service receipt is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_text_service_receipt() from public,anon,authenticated,service_role;
create trigger metadata_service_receipt_immutable before update on public.metadata_service_receipts
for each row execute function public.guard_text_service_receipt();
create trigger ai_review_service_receipt_immutable before update on public.ai_review_service_receipts
for each row execute function public.guard_text_service_receipt();

create function public.complete_quoted_metadata_job(p_job_id uuid,p_lease_token uuid,p_provider text,p_model text,
  p_usage jsonb,p_diagnostics jsonb,p_candidate jsonb,p_settlement jsonb) returns public.ai_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; receipt public.metadata_service_receipts;
  r public.metadata_token_quote_requests; role_name text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.agent_type<>'metadata' or j.billing_mode<>'quoted' then raise exception 'quoted metadata job missing' using errcode='22023'; end if;
  select * into strict q from public.funded_usage_quotes where job_id=j.id for update;
  select * into receipt from public.metadata_service_receipts where job_id=j.id for share;
  select * into r from public.metadata_token_quote_requests where id=(j.input_ref->>'metadataQuoteRequestId')::uuid for share;
  if receipt.result_json is null or receipt.result_json->>'jobId' is distinct from j.id::text
    or receipt.result_json->>'workspaceId' is distinct from j.workspace_id::text or receipt.result_json->>'bookId' is distinct from j.book_id::text
    or receipt.result_json->>'agentType' is distinct from 'metadata' or receipt.result_json->>'status' is distinct from 'succeeded'
    or receipt.result_json->>'provider' is distinct from p_provider or receipt.result_json->>'model' is distinct from p_model
    or receipt.result_json->>'requestId' is distinct from p_settlement->>'requestId'
    or receipt.result_json->'usage' is distinct from p_usage or receipt.result_json->'diagnostics' is distinct from p_diagnostics
    or receipt.result_json->'suggestions' is distinct from jsonb_build_array(p_candidate)
    or r.accepted_job_id is distinct from j.id or r.user_id is distinct from j.created_by
    or r.workspace_id is distinct from j.workspace_id or r.book_id is distinct from j.book_id
    or r.usage_quote_json is distinct from q.quote_json or r.generation_request_sha256 is distinct from j.input_ref->>'generationRequestSha256'
    or q.quote_json#>>'{scope,inputSha256}' is distinct from r.generation_request_sha256
    or q.user_id is distinct from j.created_by or q.workspace_id is distinct from j.workspace_id or q.dispatched_at is null
    or q.quote_json#>>'{price,provider}' is distinct from p_provider or p_provider is distinct from 'openai'
    or q.quote_json#>>'{price,model}' is distinct from p_model then
    raise exception 'metadata funded receipt mismatch' using errcode='23514'; end if;
  if j.status='succeeded' then
    if q.status='settled' and q.settlement_json=p_settlement and j.output_ref->'candidate'=p_candidate
      and j.usage_json=p_usage then return j; end if;
    raise exception 'metadata completion replay conflict' using errcode='23505';
  end if;
  if j.status<>'running' or p_lease_token is null or j.lease_token is distinct from p_lease_token
    or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then
    raise exception 'metadata quote lease lost' using errcode='40001'; end if;
  select role::text into role_name from public.workspace_members where workspace_id=j.workspace_id
    and user_id=j.created_by and status='active' for share;
  if not found or role_name not in ('owner','admin','editor','writer') then
    raise exception 'metadata editing access revoked' using errcode='42501'; end if;
  if not exists(select 1 from public.books where id=j.book_id and workspace_id=j.workspace_id for share) then
    raise exception 'metadata book scope changed' using errcode='42501'; end if;
  perform bookworm_private.assert_text_quote_settlement(q.quote_json,p_usage,p_settlement);
  if q.status not in ('held','settled') or q.reserved_credits::text is distinct from q.quote_json->>'reservedCredits' then
    raise exception 'metadata funded balance mismatch' using errcode='23514'; end if;
  perform public.settle_funded_usage_quote(j.id,p_settlement);
  select * into j from bookworm_private.complete_metadata_ai_job(j.id,p_provider,p_model,p_usage,p_diagnostics,p_candidate,0);
  update public.ai_jobs set lease_token=null,lease_expires_at=null where id=j.id returning * into j;
  return j;
end $$;
revoke all on function public.complete_quoted_metadata_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_quoted_metadata_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;

-- Match quantities by dimension; provider order and canonical quote order differ.
alter function public.complete_quoted_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb) set schema bookworm_private;
do $$ declare definition text; begin
  select pg_get_functiondef('bookworm_private.complete_quoted_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure) into definition;
  execute replace(definition,'public.complete_ai_job(','bookworm_private.complete_ai_job(');
end $$;
create function public.complete_quoted_ai_review_job(p_job_id uuid,p_lease_token uuid,p_provider text,p_model text,
  p_usage jsonb,p_diagnostics jsonb,p_suggestions jsonb,p_settlement jsonb) returns public.ai_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; r public.ai_review_token_quote_requests; receipt public.ai_review_service_receipts;
  role_name text; measured jsonb; settled_tokens jsonb; raw jsonb; normalized jsonb; source_version integer; ordinal integer:=0;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.billing_mode<>'quoted' or j.agent_type not in ('writer','proofreader','copyeditor','consistency') then
    raise exception 'quoted AI review job missing' using errcode='22023'; end if;
  select * into strict q from public.funded_usage_quotes where job_id=j.id for update;
  select * into r from public.ai_review_token_quote_requests where id=(j.input_ref->>'aiReviewQuoteRequestId')::uuid for share;
  select * into receipt from public.ai_review_service_receipts where job_id=j.id for share;
  if r.accepted_job_id is distinct from j.id or r.user_id is distinct from j.created_by or r.workspace_id is distinct from j.workspace_id
    or r.book_id is distinct from j.book_id or r.usage_quote_json is distinct from q.quote_json
    or r.request_sha256 is distinct from j.input_ref->>'generationRequestSha256'
    or q.quote_json#>>'{scope,inputSha256}' is distinct from r.request_sha256
    or q.user_id is distinct from j.created_by or q.workspace_id is distinct from j.workspace_id or q.dispatched_at is null
    or receipt.result_json is null or receipt.result_json->>'jobId' is distinct from j.id::text
    or receipt.result_json->>'workspaceId' is distinct from j.workspace_id::text or receipt.result_json->>'bookId' is distinct from j.book_id::text
    or receipt.result_json->>'agentType' is distinct from j.agent_type or receipt.result_json->>'status' is distinct from 'succeeded'
    or receipt.result_json->>'provider' is distinct from p_provider or receipt.result_json->>'model' is distinct from p_model
    or receipt.result_json->>'requestId' is distinct from p_settlement->>'requestId'
    or receipt.result_json->'usage' is distinct from p_usage or receipt.result_json->'diagnostics' is distinct from p_diagnostics
    or jsonb_typeof(receipt.result_json->'suggestions') is distinct from 'array' or jsonb_typeof(p_suggestions) is distinct from 'array'
    or jsonb_array_length(receipt.result_json->'suggestions')<>jsonb_array_length(p_suggestions) then
    raise exception 'AI review funded receipt mismatch' using errcode='23514'; end if;
  for raw in select value from jsonb_array_elements(receipt.result_json->'suggestions') loop
    normalized:=p_suggestions->ordinal; ordinal:=ordinal+1;
    select (value->>'version')::integer into source_version from jsonb_array_elements(r.source_versions_json)
      where value->>'chapterId'=raw->>'chapterId';
    if source_version is null or normalized->>'entityType' is distinct from 'chapter'
      or normalized->>'entityId' is distinct from raw->>'chapterId'
      or normalized->>'rationale' is distinct from regexp_replace(raw->>'rationale','^[[:space:]]+|[[:space:]]+$','','g')
      or coalesce(normalized->'confidence','null') is distinct from coalesce(raw->'confidence','null')
      or normalized#>>'{operation,source}' is distinct from 'ai'
      or normalized#>>'{operation,sourceRef}' is distinct from normalized->>'id'
      or normalized#>>'{operation,operationId}' is distinct from 'ai:'||(normalized->>'id')
      or normalized#>>'{operation,expectedVersion}' is distinct from source_version::text
      or normalized#>>'{operation,target,chapterId}' is distinct from raw->>'chapterId'
      or normalized#>>'{operation,target,nodeId}' is distinct from raw->>'nodeId'
      or normalized#>>'{operation,payload,nodeId}' is distinct from raw->>'nodeId'
      or (normalized->'operation')-array['operationId','source','sourceRef','expectedVersion']
        is distinct from jsonb_build_object('type',raw#>'{operation,type}',
          'target',jsonb_build_object('chapterId',raw#>'{operation,target,chapterId}','nodeId',raw#>'{operation,target,nodeId}'),
          'payload',jsonb_build_object('nodeId',raw#>'{operation,payload,nodeId}','from',raw#>'{operation,payload,from}',
            'to',raw#>'{operation,payload,to}','text',raw#>'{operation,payload,text}')) then
      raise exception 'AI review suggestions differ from durable receipt' using errcode='23514'; end if;
  end loop;
  perform bookworm_private.assert_text_quote_settlement(q.quote_json,p_usage,p_settlement);
  if jsonb_typeof(p_usage->'measuredTokens') is distinct from 'array' or jsonb_typeof(p_settlement->'tokens') is distinct from 'array' then
    raise exception 'AI review measured usage missing' using errcode='23514'; end if;
  select jsonb_agg(value order by value->>'dimension') into measured from jsonb_array_elements(p_usage->'measuredTokens');
  select jsonb_agg(value order by value->>'dimension') into settled_tokens from jsonb_array_elements(p_settlement->'tokens');
  if measured is distinct from settled_tokens then raise exception 'AI review measured settlement mismatch' using errcode='23514'; end if;
  p_usage:=jsonb_set(p_usage,'{measuredTokens}',measured);
  p_settlement:=jsonb_set(p_settlement,'{tokens}',settled_tokens);
  if j.status='succeeded' then
    if q.status='settled' and q.settlement_json=p_settlement and j.model=p_model and j.usage_json=p_usage
      and p_provider is not distinct from q.quote_json#>>'{price,provider}' then return j; end if;
    raise exception 'AI review completion replay conflict' using errcode='23505';
  end if;
  if j.status<>'running' or p_lease_token is null or j.lease_token is distinct from p_lease_token
    or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then
    raise exception 'AI review quote lease lost' using errcode='40001'; end if;
  select role::text into role_name from public.workspace_members where workspace_id=j.workspace_id
    and user_id=j.created_by and status='active' for share;
  if not found or role_name not in ('owner','admin','editor','writer') then
    raise exception 'AI review editing access revoked' using errcode='42501'; end if;
  if not exists(select 1 from public.books where id=j.book_id and workspace_id=j.workspace_id for share) then
    raise exception 'AI review book scope changed' using errcode='42501'; end if;
  return bookworm_private.complete_quoted_ai_review_job(p_job_id,p_lease_token,p_provider,p_model,p_usage,p_diagnostics,p_suggestions,
    jsonb_set(p_settlement,'{tokens}',settled_tokens));
end $$;
revoke all on function public.complete_quoted_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_quoted_ai_review_job(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb) to service_role;
