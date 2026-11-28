-- Share the same operational credit hold across all text-generation agents.
-- Earlier metadata-only trigger is replaced, not run alongside this guard.
drop trigger metadata_job_credit_reservation on public.ai_jobs;
drop function public.reserve_metadata_job_credit();
-- Reserve the current operational ai_credits unit before text generation.
-- This is not an approved token-to-retail-credit conversion or plan activation.
create function public.reserve_text_job_credit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_role text;
  v_quota_text text;
  v_quota numeric := 0;
  v_used numeric;
  v_pending bigint;
begin
  if new.agent_type not in ('metadata','writer','proofreader','copyeditor','consistency','bookbible') or new.status not in ('queued','running') then return new; end if;
  if tg_op='UPDATE' then
    if old.agent_type in ('metadata','writer','proofreader','copyeditor','consistency','bookbible') and old.status in ('queued','running')
      and old.workspace_id=new.workspace_id and old.created_by=new.created_by then return new; end if;
  end if;
  select role into v_role from public.workspace_members
    where workspace_id=new.workspace_id and user_id=new.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'text reservation requires editing access' using errcode='42501';
  end if;
  select organization_id into v_org from public.workspaces where id=new.workspace_id;
  perform id from public.organizations where id=v_org for update;
  if not found then raise exception 'text organization missing' using errcode='22023'; end if;
  select coalesce(p.entitlements_json->>'ai_credits_monthly','0') into v_quota_text
    from public.subscriptions s join public.plans p on p.id=s.plan_id
    where s.organization_id=v_org and s.status in ('active','trialing')
    order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'invalid text credit entitlement' using errcode='22023';
    end if;
    v_quota := v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity),0) into v_used from public.usage_events
    where organization_id=v_org and meter='ai_credits'
      and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  select count(*) into v_pending from public.ai_jobs j join public.workspaces w on w.id=j.workspace_id
    where w.organization_id=v_org and j.agent_type in ('metadata','writer','proofreader','copyeditor','consistency','bookbible') and j.status in ('queued','running') and j.id<>new.id;
  if v_used+v_pending+1>v_quota then
    raise exception 'text credit capacity exhausted' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.reserve_text_job_credit() from public, anon, authenticated;
create trigger text_job_credit_reservation
before insert or update of status,agent_type,workspace_id,created_by on public.ai_jobs
for each row execute function public.reserve_text_job_credit();

-- Completion inserts usage and marks its job terminal in one transaction.
-- Hold the same organization lock until commit so reservations cannot observe
-- old consumption followed by a newly released pending job (an undercount).
create function public.lock_text_credit_accounting() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.meter='ai_credits' and new.organization_id is not null then
    perform id from public.organizations where id=new.organization_id for update;
    if not found then raise exception 'text credit organization missing' using errcode='22023'; end if;
  end if;
  return new;
end $$;
revoke all on function public.lock_text_credit_accounting() from public, anon, authenticated;
create trigger text_credit_accounting_lock before insert on public.usage_events
for each row execute function public.lock_text_credit_accounting();
