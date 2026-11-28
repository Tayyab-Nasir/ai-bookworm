-- Paid-only generation: an organization without an explicit active entitlement
-- has zero image capacity. This forward migration also corrects environments
-- that already applied the earlier guard versions with a non-zero fallback.
create or replace function public.guard_image_completion_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job public.ai_jobs;
  v_role text;
  v_org uuid;
  v_quota_text text;
  v_quota numeric := 0;
  v_used numeric;
begin
  if new.meter <> 'image_credits' or new.ai_job_id is null then return new; end if;
  select * into v_job from public.ai_jobs where id = new.ai_job_id;
  if not found or v_job.agent_type not in ('illustrator','cover_designer')
    or v_job.status <> 'running' or new.quantity <> 1
    or new.workspace_id is distinct from v_job.workspace_id
    or new.user_id is distinct from v_job.created_by then
    raise exception 'invalid image completion credit' using errcode='22023';
  end if;
  select role into v_role from public.workspace_members
    where workspace_id=v_job.workspace_id and user_id=v_job.created_by and status='active'
    for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'image creator can no longer edit this workspace' using errcode='42501';
  end if;
  select organization_id into v_org from public.workspaces where id=v_job.workspace_id;
  if v_org is distinct from new.organization_id then
    raise exception 'image credit organization mismatch' using errcode='22023';
  end if;
  perform id from public.organizations where id=v_org for update;
  select case when p.entitlements_json ? 'image_credits_monthly'
    then coalesce(p.entitlements_json->>'image_credits_monthly', '0') else null end into v_quota_text
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
      and created_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC');
  if v_used + new.quantity > v_quota then
    raise exception 'image credit quota exceeded at completion' using errcode='23514';
  end if;
  new.created_at := now();
  return new;
end $$;

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

revoke all on function public.guard_image_completion_credit() from public, anon, authenticated;
revoke all on function public.reserve_image_job_credit() from public, anon, authenticated;
