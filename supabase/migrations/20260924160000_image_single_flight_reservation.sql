-- The API's pending-image read is advisory: two connections can both see no
-- pending row. The organization row lock already serializes credit capacity;
-- enforce the author/workspace single-flight invariant while holding it.
create or replace function public.reserve_image_job_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role text;
  v_org uuid;
  v_quota_text text;
  v_quota numeric := 0;
  v_used numeric;
  v_pending bigint;
begin
  if new.agent_type not in ('illustrator','cover_designer')
    or new.status not in ('queued','running') then return new; end if;
  if tg_op='UPDATE' then
    if old.agent_type in ('illustrator','cover_designer')
      and old.status in ('queued','running')
      and old.workspace_id=new.workspace_id and old.created_by=new.created_by then
      return new;
    end if;
  end if;
  select role into v_role from public.workspace_members
    where workspace_id=new.workspace_id and user_id=new.created_by and status='active'
    for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'image reservation requires editing access' using errcode='42501';
  end if;
  select organization_id into v_org from public.workspaces where id=new.workspace_id;
  perform id from public.organizations where id=v_org for update;
  if not found then raise exception 'image organization missing' using errcode='22023'; end if;

  if exists (
    select 1 from public.ai_jobs j
      where j.workspace_id=new.workspace_id and j.created_by=new.created_by
        and j.agent_type in ('illustrator','cover_designer')
        and j.status in ('queued','running') and j.id<>new.id
  ) then
    raise exception 'image request already pending' using errcode='23514';
  end if;

  select case when p.entitlements_json ? 'image_credits_monthly'
    then coalesce(p.entitlements_json->>'image_credits_monthly','0') else null end into v_quota_text
    from public.subscriptions s left join public.plans p on p.id=s.plan_id
    where s.organization_id=v_org and s.status in ('active','trialing')
    order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'invalid image credit entitlement' using errcode='22023';
    end if;
    v_quota := v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity),0) into v_used from public.usage_events
    where organization_id=v_org and meter='image_credits'
      and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  select count(*) into v_pending from public.ai_jobs j
    join public.workspaces w on w.id=j.workspace_id
    where w.organization_id=v_org and j.agent_type in ('illustrator','cover_designer')
      and j.status in ('queued','running') and j.id<>new.id;
  if v_used+v_pending+1>v_quota then
    raise exception 'image credit capacity exhausted' using errcode='23514';
  end if;
  return new;
end $$;
