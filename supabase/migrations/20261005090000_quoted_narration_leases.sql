-- Funded narration fencing. No HTTP purchase or provider execution is enabled.
-- Lock order: job, funded quote, chapter project, source/member, wallet.
create function bookworm_private.validate_funded_narration_job(p_job_id uuid,p_require_current_source boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; s public.narration_quote_snapshots;
  p public.audiobook_projects; segment public.audiobook_segments; parent public.narration_chapter_quote_snapshots;
  document public.document_versions; member_role text; source_text text; r jsonb;
begin
  if auth.role() is distinct from 'service_role' or p_require_current_source is null then
    raise exception 'service narration validation required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.billing_mode<>'quoted' or j.agent_type<>'narrator' then
    raise exception 'quoted narration job missing' using errcode='22023'; end if;
  select * into f from public.funded_usage_quotes where job_id=j.id for update;
  if not found or f.status<>'held' or f.settlement_json is not null then
    raise exception 'narration requires a funded hold' using errcode='23514'; end if;
  select * into s from public.narration_quote_snapshots where generation_job_id=j.id;
  if not found then raise exception 'narration accepted snapshot missing' using errcode='22023'; end if;
  select * into segment from public.audiobook_segments where ai_job_id=j.id and billing_mode='quoted';
  if not found then raise exception 'narration accepted segment missing' using errcode='22023'; end if;
  select * into p from public.audiobook_projects where id=segment.project_id and billing_mode='quoted' for update;
  if not found then raise exception 'narration accepted project missing' using errcode='22023'; end if;
  select q.* into parent from public.narration_chapter_quote_snapshots q
    join public.narration_chapter_quote_acceptances a on a.quote_id=q.id and a.project_id=p.id
    join public.narration_chapter_quote_segments l on l.chapter_quote_id=q.id and l.quote_id=s.id
      and l.segment_index=segment.segment_index
    where q.id=p.narration_quote_id and a.expected_credits=q.reserved_credits and a.ai_disclosure_accepted;
  if not found then raise exception 'narration accepted chapter missing' using errcode='22023'; end if;
  r:=s.request_json;
  perform public.validate_narration_quote(r,s.quote_json);
  if j.created_by is distinct from s.user_id or j.workspace_id is distinct from s.workspace_id or j.book_id is distinct from s.book_id
    or j.model is distinct from r->>'model' or f.user_id is distinct from s.user_id or f.workspace_id is distinct from s.workspace_id
    or f.quote_json is distinct from s.quote_json or f.reserved_credits::text is distinct from s.quote_json->>'reservedCredits'
    or s.request_sha256 is distinct from bookworm_private.narration_request_hash(r)
    or j.input_ref is distinct from jsonb_build_object('audiobookProjectId',p.id,'narrationQuoteId',s.id,
      'requestSha256',s.request_sha256,'generationRequest',r)
    or p.created_by is distinct from s.user_id or p.workspace_id is distinct from s.workspace_id
    or p.book_id is distinct from s.book_id or p.edition_id is distinct from s.edition_id
    or p.chapter_id is distinct from s.chapter_id or p.document_version_id is distinct from s.document_version_id
    or p.voice is distinct from r->>'voice' or p.speed is distinct from (r->>'speed')::numeric
    or p.instructions is distinct from r->>'instructions' or p.segment_count is distinct from parent.segment_count
    or p.credit_units is distinct from parent.reserved_credits
    or segment.segment_index is distinct from (r->>'segmentIndex')::integer
    or segment.text_start is distinct from (r->>'textStart')::integer or segment.text_end is distinct from (r->>'textEnd')::integer
    or segment.text_sha256 is distinct from r->>'textSha256' or segment.credit_units is distinct from f.reserved_credits then
    raise exception 'narration funded identity mismatch' using errcode='22023'; end if;
  -- Pin and validate original text even on recovery. Only a new dispatch needs
  -- current author access and the chapter's current-version pointer.
  if p_require_current_source then
    if p.status not in ('queued','running') then raise exception 'narration chapter unavailable' using errcode='23514'; end if;
    select role into member_role from public.workspace_members where workspace_id=j.workspace_id
      and user_id=j.created_by and status='active' for share;
    if not found or member_role not in ('owner','admin','editor','writer') then
      raise exception 'narration writing access changed' using errcode='42501'; end if;
    perform id from public.books where id=p.book_id and workspace_id=p.workspace_id for share;
    if not found then raise exception 'narration source changed' using errcode='23514'; end if;
    perform id from public.editions where id=p.edition_id and book_id=p.book_id and type='audiobook' for share;
    if not found then raise exception 'narration source changed' using errcode='23514'; end if;
    perform id from public.chapters where id=p.chapter_id and book_id=p.book_id
      and current_document_version_id=p.document_version_id for share;
    if not found then raise exception 'narration source changed' using errcode='23514'; end if;
  end if;
  select * into document from public.document_versions where id=p.document_version_id and chapter_id=p.chapter_id for share;
  if not found or parent.source_sha256 is distinct from encode(public.digest(convert_to(document.plain_text,'UTF8'),'sha256'),'hex')
    or segment.text_end>length(document.plain_text) then
    raise exception 'narration source changed' using errcode='23514'; end if;
  source_text:=substring(document.plain_text from segment.text_start+1 for segment.text_end-segment.text_start);
  if not bookworm_private.narration_has_source_words(source_text)
    or octet_length(source_text)+coalesce(octet_length(p.instructions),0)>1800
    or segment.text_sha256 is distinct from encode(public.digest(convert_to(source_text,'UTF8'),'sha256'),'hex') then
    raise exception 'narration source changed' using errcode='23514'; end if;
end $$;
revoke all on function bookworm_private.validate_funded_narration_job(uuid,boolean) from public,anon,authenticated;
grant execute on function bookworm_private.validate_funded_narration_job(uuid,boolean) to service_role;

create function public.release_quoted_narration_before_dispatch(p_job_id uuid,p_lease_token uuid,p_reason text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; project_id uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_reason is null or p_reason not in ('quote_expired','source_changed','access_changed','request_mismatch','provider_not_configured','chapter_unavailable') then
    raise exception 'invalid narration release reason' using errcode='22023'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.billing_mode<>'quoted' or j.agent_type<>'narrator' then
    raise exception 'quoted narration job missing' using errcode='22023'; end if;
  select * into f from public.funded_usage_quotes where job_id=j.id for update;
  if not found or f.status<>'held' or f.dispatched_at is not null then
    raise exception 'narration hold is not releasable' using errcode='23514'; end if;
  if j.status not in ('queued','running') or (j.status='running' and
    (p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp())) then
    raise exception 'narration release lease lost' using errcode='40001'; end if;
  select p.id into project_id from public.audiobook_projects p join public.audiobook_segments s on s.project_id=p.id
    where s.ai_job_id=j.id and s.billing_mode='quoted' and p.billing_mode='quoted' for update of p;
  if not found or f.user_id is distinct from j.created_by or f.workspace_id is distinct from j.workspace_id then
    raise exception 'narration release identity mismatch' using errcode='22023'; end if;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(f.user_id,f.workspace_id,'generation_release',f.reserved_credits,0,'usage_quote',j.id);
  update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
    'status','cancelled','reason',p_reason,'releaseCredits',f.reserved_credits::text,'fingerprint',f.quote_json->>'fingerprint') where job_id=j.id;
  update public.ai_jobs set status='failed',completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,
    error_code=p_reason,error_message='Narration stopped before provider dispatch.' where id=j.id;
  update public.audiobook_projects set status='failed',completed_at=coalesce(completed_at,clock_timestamp()) where id=project_id;
  return true;
end $$;

create function public.claim_quoted_narration_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; p public.audiobook_projects; reason text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid narration lease' using errcode='22023'; end if;
  for j in select x.* from public.ai_jobs x join public.funded_usage_quotes q on q.job_id=x.id
    where x.billing_mode='quoted' and x.agent_type='narrator' and q.status='held' and x.available_at<=clock_timestamp()
      and (x.status='queued' or (x.status='running' and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())))
    order by x.created_at,x.id for update of x skip locked limit 100
  loop
    select * into f from public.funded_usage_quotes where job_id=j.id for update;
    select p0.* into p from public.audiobook_projects p0 join public.audiobook_segments s on s.project_id=p0.id
      where s.ai_job_id=j.id and s.billing_mode='quoted' and p0.billing_mode='quoted' for update of p0;
    if not found then raise exception 'narration accepted project missing' using errcode='22023'; end if;
    reason:=null;
    if f.dispatched_at is null then
      if (f.quote_json->>'expiresAt')::timestamptz<=clock_timestamp() then reason:='quote_expired';
      elsif p.status not in ('queued','running') then reason:='chapter_unavailable';
      else
        begin perform bookworm_private.validate_funded_narration_job(j.id,true);
        exception when insufficient_privilege then reason:='access_changed';
          when check_violation then reason:=case when sqlerrm='narration source changed' then 'source_changed' else 'request_mismatch' end;
          when invalid_parameter_value then reason:='request_mismatch';
        end;
      end if;
    else
      -- Recovery only: neither expired quotes nor changed access/source grants
      -- permission for a replacement provider call or a post-dispatch refund.
      perform bookworm_private.validate_funded_narration_job(j.id,false);
    end if;
    if reason is not null then
      if j.status='running' then update public.ai_jobs set status='queued',lease_token=null,lease_expires_at=null where id=j.id; end if;
      perform public.release_quoted_narration_before_dispatch(j.id,null,reason);
      continue;
    end if;
    update public.ai_jobs set status='running',lease_token=gen_random_uuid(),attempts=attempts+1,
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),started_at=coalesce(started_at,clock_timestamp())
      where id=j.id returning * into j;
    if p.status='queued' then
      update public.audiobook_projects set status='running',started_at=coalesce(started_at,clock_timestamp()) where id=p.id;
    end if;
    return next j; return;
  end loop;
end $$;

create function public.renew_quoted_narration_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then
    raise exception 'invalid narration lease' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and agent_type='narrator' and billing_mode='quoted' and status='running'
      and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.hold_quoted_narration_for_review(p_job_id uuid,p_lease_token uuid,p_reason text,p_request_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; project_id uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_reason is null or p_reason not in ('provider_outcome_unknown','invalid_result','usage_unreconciled','transcript_mismatch','storage_unconfirmed','encoding_failed')
    or coalesce(length(trim(p_request_id)),0) not between 1 and 256 then
    raise exception 'invalid narration review reason' using errcode='22023'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.billing_mode<>'quoted' or j.agent_type<>'narrator' or j.status<>'running'
    or p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then
    raise exception 'narration review lease lost' using errcode='40001'; end if;
  select * into f from public.funded_usage_quotes where job_id=j.id for update;
  if not found or f.status<>'held' or f.dispatched_at is null then
    raise exception 'narration review requires dispatched hold' using errcode='23514'; end if;
  select p.id into project_id from public.audiobook_projects p join public.audiobook_segments s on s.project_id=p.id
    where s.ai_job_id=j.id and s.billing_mode='quoted' and p.billing_mode='quoted' for update of p;
  if not found then raise exception 'narration review project missing' using errcode='22023'; end if;
  perform public.settle_funded_usage_quote(j.id,jsonb_build_object('status','requires_review','requestId',p_request_id,
    'reason',p_reason,'heldCredits',f.reserved_credits::text,'fingerprint',f.quote_json->>'fingerprint'));
  update public.ai_jobs set status='failed',completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,
    error_code='narration_requires_review',error_message='Narration requires operator review.' where id=j.id;
  update public.audiobook_projects set status='failed',completed_at=coalesce(completed_at,clock_timestamp()) where id=project_id;
  return true;
end $$;

revoke all on function public.release_quoted_narration_before_dispatch(uuid,uuid,text),public.claim_quoted_narration_job(integer),
  public.renew_quoted_narration_lease(uuid,uuid,integer),public.hold_quoted_narration_for_review(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.release_quoted_narration_before_dispatch(uuid,uuid,text),public.claim_quoted_narration_job(integer),
  public.renew_quoted_narration_lease(uuid,uuid,integer),public.hold_quoted_narration_for_review(uuid,uuid,text,text) to service_role;

-- Enforce source/member locks inside the shared dispatch boundary itself, not
-- only a new wrapper that a stale worker could bypass. Other media stay intact.
do $$ declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('public.claim_funded_dispatch(uuid,uuid,text,text)'::regprocedure);
  anchor:='if v_quote.dispatched_at is not null then return false; end if;';
  if position(anchor in definition)=0 then raise exception 'funded dispatch definition changed'; end if;
  execute replace(definition,anchor,anchor||E'\n  if v_job.billing_mode=''quoted'' and v_job.agent_type=''narrator'' then\n'
    ||'    perform bookworm_private.validate_funded_narration_job(v_job.id,true);'||E'\n  end if;');
end $$;
