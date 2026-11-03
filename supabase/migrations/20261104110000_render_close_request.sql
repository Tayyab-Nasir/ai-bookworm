-- Fence an unaccepted original render request without cancelling an accepted job.
create index render_close_actor_created_idx on public.publishing_jobs(created_by, created_at desc)
where channel = 'render' and status = 'cancelled' and request_json @> '{"action":"render","closedBeforeAcceptance":true}'::jsonb;

create function private.close_render_request_internal(p_book_id uuid, p_edition_id uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid := auth.uid();
  v_workspace uuid;
  v_role text;
  v_job public.publishing_jobs;
  v_closed boolean := false;
  v_count bigint;
begin
  if current_setting('role',true) is distinct from 'authenticated' or auth.role() is distinct from 'authenticated' or v_actor is null then
    raise exception 'authenticated actor required' using errcode='42501';
  end if;
  if p_book_id is null or p_edition_id is null or p_request_id is null
    or p_request_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    raise exception 'invalid render close request' using errcode='22023';
  end if;
  select workspace_id into v_workspace from public.books where id=p_book_id for share;
  if not found then raise exception 'book unavailable' using errcode='P0002'; end if;
  select role::text into v_role from public.workspace_members
   where workspace_id=v_workspace and user_id=v_actor and status='active' for share;
  -- Do not distinguish an inaccessible book from a nonexistent book.
  if not found then raise exception 'book unavailable' using errcode='P0002'; end if;
  if v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'render editing access required' using errcode='42501';
  end if;
  perform id from public.editions where id=p_edition_id and book_id=p_book_id for share;
  if not found then raise exception 'edition unavailable' using errcode='P0002'; end if;
  -- Serialize each actor's close attempts and bound unaccepted tombstone creation.
  perform pg_advisory_xact_lock(hashtextextended('render-close:'||v_actor::text,0));
  select * into v_job from public.publishing_jobs where idempotency_key=p_request_id for update;
  if not found then
    select count(*) into v_count from public.publishing_jobs
     where created_by=v_actor and channel='render' and status='cancelled'
       and request_json @> '{"action":"render","closedBeforeAcceptance":true}'::jsonb
       and created_at > clock_timestamp()-interval '1 hour';
    if v_count >= 60 then raise exception 'render close limit reached' using errcode='54000'; end if;
    insert into public.publishing_jobs(id,book_id,edition_id,channel,status,idempotency_key,created_by,request_json,response_json,completed_at)
     values(gen_random_uuid(),p_book_id,p_edition_id,'render','cancelled',p_request_id,v_actor,
       '{"action":"render","closedBeforeAcceptance":true}'::jsonb,
       '{"error":"request_closed_before_acceptance"}'::jsonb,clock_timestamp())
     on conflict(idempotency_key) do nothing returning * into v_job;
    v_closed := found;
    if not v_closed then select * into v_job from public.publishing_jobs where idempotency_key=p_request_id for update; end if;
  end if;
  if v_job.id is null or v_job.created_by is distinct from v_actor or v_job.book_id is distinct from p_book_id
     or v_job.edition_id is distinct from p_edition_id or v_job.channel is distinct from 'render'
     or v_job.request_json->>'action' is distinct from 'render' then
    raise exception 'render request identity conflict' using errcode='23505';
  end if;
  return jsonb_build_object('bookId',p_book_id,'editionId',p_edition_id,'requestId',p_request_id,
    'job',jsonb_build_object('id',v_job.id,'status',v_job.status),
    'closedBeforeAcceptance',v_job.status='cancelled' and v_job.request_json @> '{"action":"render","closedBeforeAcceptance":true}'::jsonb);
end $$;
revoke all on function private.close_render_request_internal(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.close_render_request_internal(uuid,uuid,text) to authenticated;

-- Expose only an invoker wrapper; the private function checks the JWT actor and membership.
create function public.close_render_request(p_book_id uuid, p_edition_id uuid, p_request_id text)
returns jsonb language sql security invoker set search_path='' as $$
  select private.close_render_request_internal(p_book_id, p_edition_id, p_request_id)
$$;
revoke all on function public.close_render_request(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.close_render_request(uuid,uuid,text) to authenticated;
