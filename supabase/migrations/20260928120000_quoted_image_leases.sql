-- Worker fencing and safe cancellation; no provider execution is enabled here.
create function public.release_quoted_image_before_dispatch(p_job_id uuid,p_lease_token uuid,p_reason text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes;
begin
 if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
 if p_reason is null or p_reason not in ('quote_expired','source_changed','access_changed','request_mismatch','provider_not_configured') then
  raise exception 'invalid image release reason' using errcode='22023'; end if;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if not found or j.billing_mode<>'quoted' or j.agent_type not in ('illustrator','cover_designer') then
  raise exception 'quoted image job missing' using errcode='22023'; end if;
 select * into q from public.funded_usage_quotes where job_id=j.id for update;
 if not found or q.status<>'held' or q.dispatched_at is not null then
  raise exception 'image hold is not releasable' using errcode='23514'; end if;
 if j.status not in ('queued','running') or (j.status='running' and
   (j.lease_token is distinct from p_lease_token or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp())) then
  raise exception 'image release lease lost' using errcode='40001'; end if;
 insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
  values(j.created_by,j.workspace_id,'generation_release',q.reserved_credits,0,'usage_quote',j.id);
 update public.funded_usage_quotes set status='cancelled',settled_at=clock_timestamp(),settlement_json=jsonb_build_object(
  'status','cancelled','reason',p_reason,'releaseCredits',q.reserved_credits::text,'fingerprint',q.quote_json->>'fingerprint') where job_id=j.id;
 update public.ai_jobs set status='failed',completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,
  error_code=p_reason,error_message='Image generation stopped before provider dispatch.' where id=j.id;
 return true;
end $$;

create function public.claim_quoted_image_job(p_lease_seconds integer default 180)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; s public.image_quote_snapshots; reason text;
begin
 if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
 if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then raise exception 'invalid image lease' using errcode='22023'; end if;
 for j in select x.* from public.ai_jobs x join public.funded_usage_quotes f on f.job_id=x.id
  where x.billing_mode='quoted' and x.agent_type in ('illustrator','cover_designer') and f.status='held'
   and (x.status='queued' or (x.status='running' and x.lease_expires_at<=clock_timestamp()))
  order by x.created_at,x.id for update of x skip locked limit 100
 loop
  select * into q from public.funded_usage_quotes where job_id=j.id for update;
  select s0.* into s from public.image_quote_snapshots s0 join public.image_quote_acceptances a on a.quote_id=s0.id
   where a.job_id=j.id and s0.id=(j.input_ref->>'imageQuoteId')::uuid;
  if not found or s.user_id is distinct from j.created_by or s.workspace_id is distinct from j.workspace_id
   or s.generation_job_id is distinct from j.id or s.request_sha256 is distinct from j.input_ref->>'requestSha256'
   or s.request_json is distinct from j.input_ref->'generationRequest' or s.quote_json is distinct from q.quote_json then
   raise exception 'image quote/job identity mismatch' using errcode='22023'; end if;
  reason:=null;
  if q.dispatched_at is null then
   if s.expires_at<=clock_timestamp() then reason:='quote_expired';
   elsif not exists(select 1 from public.workspace_members where workspace_id=j.workspace_id and user_id=j.created_by
     and status='active' and role in ('owner','admin','editor','writer','illustrator','designer')) then reason:='access_changed';
   elsif exists(select 1 from jsonb_array_elements(s.request_json->'references') r where not exists(
    select 1 from public.assets a join public.asset_versions v on v.asset_id=a.id and v.storage_path=a.storage_path
    where a.id=(r->>'assetId')::uuid and a.workspace_id=j.workspace_id and a.deleted_at is null and a.mime_type='image/png'
     and v.version_number=(r->>'version')::integer and a.checksum=r->>'sha256' and v.checksum=a.checksum
     and v.scan_status in ('clean','trusted_generated'))) then reason:='source_changed'; end if;
  end if;
  if reason is not null then
   -- Expired leases are no longer owned. Return them to queued solely for
   -- atomic undispatched cancellation; never touch a live lease or dispatch.
   if j.status='running' then update public.ai_jobs set status='queued',lease_token=null,lease_expires_at=null where id=j.id; end if;
   perform public.release_quoted_image_before_dispatch(j.id,null,reason);
   continue;
  end if;
  update public.ai_jobs set status='running',lease_token=gen_random_uuid(),attempts=attempts+1,
   lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),started_at=coalesce(started_at,clock_timestamp())
   where id=j.id returning * into j;
  return next j; return;
 end loop;
end $$;

create function public.renew_quoted_image_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 180)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
 if p_lease_seconds is null or p_lease_seconds not between 30 and 600 then raise exception 'invalid image lease' using errcode='22023'; end if;
 update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
  where id=p_job_id and agent_type in ('illustrator','cover_designer') and billing_mode='quoted' and status='running'
  and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
 return found;
end $$;

create function public.hold_quoted_image_for_review(p_job_id uuid,p_lease_token uuid,p_reason text,p_request_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes;
begin
 if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
 if p_reason is null or p_reason not in ('provider_outcome_unknown','invalid_result','usage_unreconciled','storage_unconfirmed')
  or coalesce(length(trim(p_request_id)),0) not between 1 and 256 then raise exception 'invalid image review reason' using errcode='22023'; end if;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if not found or j.billing_mode<>'quoted' or j.agent_type not in ('illustrator','cover_designer') or j.status<>'running'
  or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then
  raise exception 'image review lease lost' using errcode='40001'; end if;
 select * into q from public.funded_usage_quotes where job_id=j.id for update;
 if not found or q.status<>'held' or q.dispatched_at is null then raise exception 'image review requires dispatched hold' using errcode='23514'; end if;
 perform public.settle_funded_usage_quote(j.id,jsonb_build_object('status','requires_review','requestId',p_request_id,
  'reason',p_reason,'heldCredits',q.reserved_credits::text,'fingerprint',q.quote_json->>'fingerprint'));
 update public.ai_jobs set status='failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),
  error_code='image_generation_requires_review',error_message='Image generation requires billing review.' where id=j.id;
 return true;
end $$;

revoke all on function public.release_quoted_image_before_dispatch(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_quoted_image_job(integer) from public,anon,authenticated;
revoke all on function public.renew_quoted_image_lease(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.hold_quoted_image_for_review(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.release_quoted_image_before_dispatch(uuid,uuid,text) to service_role;
grant execute on function public.claim_quoted_image_job(integer) to service_role;
grant execute on function public.renew_quoted_image_lease(uuid,uuid,integer) to service_role;
grant execute on function public.hold_quoted_image_for_review(uuid,uuid,text,text) to service_role;
