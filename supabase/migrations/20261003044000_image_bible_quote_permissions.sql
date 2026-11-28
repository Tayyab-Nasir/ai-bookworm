-- New image/Book Bible settlements require current edit permission. The shared
-- row lock fences revocation through the same transaction's result writes.
-- Completed RPC replays do not update funding and remain side-effect-free.
create function public.guard_image_bible_quote_settlement_permission() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_role text; v_status text;
begin
  if old.status<>'held' or new.status<>'settled' then return new; end if;
  select * into v_job from public.ai_jobs where id=new.job_id and billing_mode='quoted'
    and agent_type in ('bookbible','illustrator','cover_designer');
  if not found then return new; end if;
  select role::text,status::text into v_role,v_status from public.workspace_members
    where workspace_id=new.workspace_id and user_id=new.user_id for share;
  if not found or v_status<>'active'
    or (v_job.agent_type='bookbible' and v_role not in ('owner','admin','editor','writer'))
    or (v_job.agent_type in ('illustrator','cover_designer')
      and v_role not in ('owner','admin','editor','writer','illustrator','designer')) then
    raise exception 'quoted generation completion access changed' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_image_bible_quote_settlement_permission()
  from public,anon,authenticated,service_role;
create trigger image_bible_quote_settlement_permission before update of status on public.funded_usage_quotes
  for each row execute function public.guard_image_bible_quote_settlement_permission();

create or replace function public.release_quoted_book_bible_before_dispatch(p_job_id uuid,p_lease_token uuid,p_reason text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_quote public.funded_usage_quotes;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_reason is null or p_reason not in ('source_changed','request_mismatch','access_changed') then
    raise exception 'invalid Book Bible pre-dispatch reason' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.agent_type<>'bookbible' or v_job.billing_mode<>'quoted' or v_job.status<>'running'
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at is null
    or v_job.lease_expires_at<=clock_timestamp() then raise exception 'Book Bible lease lost' using errcode='40001'; end if;
  select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;
  if not found or v_quote.status<>'held' or v_quote.dispatched_at is not null then
    raise exception 'dispatched Book Bible request cannot be released' using errcode='23514'; end if;
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
    values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',p_job_id);
  update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
    'status','cancelled','reason',p_reason,'releaseCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint')
    where job_id=p_job_id;
  update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
    error_code=case p_reason when 'source_changed' then 'book_bible_source_changed_before_dispatch'
      when 'access_changed' then 'book_bible_access_changed_before_dispatch'
      else 'book_bible_request_mismatch_before_dispatch' end,
    error_message='Book Bible request could not be verified before provider dispatch.' where id=p_job_id;
  return true;
end $$;

create or replace function public.claim_quoted_book_bible_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_request public.book_bible_token_quote_requests; v_quote public.funded_usage_quotes;
  v_reason text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then raise exception 'invalid Book Bible lease' using errcode='22023'; end if;
  for v_job in select j.* from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    join public.book_bible_token_quote_requests r on r.id=(j.input_ref->>'bookBibleQuoteRequestId')::uuid
    where j.agent_type='bookbible' and j.billing_mode='quoted'
      and (j.status='queued' or (j.status='running' and j.lease_expires_at<=clock_timestamp()))
      and q.status='held' and q.dispatched_at is null
      and ((q.quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
        or not exists(select 1 from public.workspace_members m where m.workspace_id=j.workspace_id
          and m.user_id=j.created_by and m.status='active' and m.role in ('owner','admin','editor','writer'))
        or exists(select 1 from jsonb_array_elements(r.source_versions_json->'versions') s(item)
          where not exists(select 1 from public.chapters c join public.document_versions d
            on d.id=c.current_document_version_id and d.chapter_id=c.id where c.id=(s.item->>'chapterId')::uuid
              and c.book_id=j.book_id and d.id=(s.item->>'documentVersionId')::uuid
              and d.version_number=(s.item->>'version')::integer)))
    order by j.created_at,j.id for update of j,q skip locked limit 25
  loop
    select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
    v_reason:=case when (v_quote.quote_json->>'expiresAt')::timestamptz<=clock_timestamp()
      then 'quote_expired_before_dispatch'
      when not exists(select 1 from public.workspace_members m where m.workspace_id=v_job.workspace_id
        and m.user_id=v_job.created_by and m.status='active' and m.role in ('owner','admin','editor','writer'))
      then 'access_changed_before_dispatch' else 'source_changed_before_dispatch' end;
    insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
      values(v_quote.user_id,v_quote.workspace_id,'generation_release',v_quote.reserved_credits,0,'usage_quote',v_job.id);
    update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
      'status','cancelled','reason',v_reason,'releaseCredits',v_quote.reserved_credits::text,'fingerprint',v_quote.quote_json->>'fingerprint')
      where job_id=v_job.id;
    update public.ai_jobs set status='failed',completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,
      error_code='book_bible_'||v_reason,
      error_message='Book Bible quote could not be dispatched with the accepted source, access and pricing.' where id=v_job.id;
  end loop;
  select j.* into v_job from public.ai_jobs j join public.funded_usage_quotes q on q.job_id=j.id
    where j.agent_type='bookbible' and j.billing_mode='quoted'
      and ((j.status='queued' and q.status='held' and q.dispatched_at is null)
        or (j.status='running' and j.lease_expires_at<=clock_timestamp() and q.status='held'))
    order by j.created_at,j.id for update of j skip locked limit 1;
  if not found then return; end if;
  select * into v_request from public.book_bible_token_quote_requests where id=(v_job.input_ref->>'bookBibleQuoteRequestId')::uuid for update;
  select * into v_quote from public.funded_usage_quotes where job_id=v_job.id for update;
  if not found or v_request.accepted_job_id is distinct from v_job.id or v_request.user_id is distinct from v_job.created_by
    or v_request.workspace_id is distinct from v_job.workspace_id or v_request.book_id is distinct from v_job.book_id
    or v_request.generation_request_sha256 is distinct from v_job.input_ref->>'generationRequestSha256'
    or v_quote.user_id is distinct from v_job.created_by or v_quote.workspace_id is distinct from v_job.workspace_id
    or v_quote.status<>'held' or v_quote.quote_json is distinct from v_request.usage_quote_json then
    raise exception 'quoted Book Bible job identity or funding mismatch' using errcode='22023'; end if;
  if v_quote.dispatched_at is null and (v_quote.quote_json->>'expiresAt')::timestamptz<=clock_timestamp() then return; end if;
  update public.ai_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),started_at=coalesce(started_at,clock_timestamp()),completed_at=null
    where id=v_job.id returning * into v_job;
  return next v_job;
end $$;

revoke all on function public.release_quoted_book_bible_before_dispatch(uuid,uuid,text),
  public.claim_quoted_book_bible_job(integer) from public,anon,authenticated;
grant execute on function public.release_quoted_book_bible_before_dispatch(uuid,uuid,text),
  public.claim_quoted_book_bible_job(integer) to service_role;
