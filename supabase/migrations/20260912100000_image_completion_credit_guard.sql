-- Finalization and its credit entry are one transaction, including recovery.
create function public.guard_image_completion_credit() returns trigger
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
  -- Serialize completions in all workspaces of this organization.
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
revoke all on function public.guard_image_completion_credit() from public, anon, authenticated;
create trigger image_completion_credit_guard before insert on public.usage_events
for each row execute function public.guard_image_completion_credit();
