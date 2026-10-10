-- Receipt rows from the old, non-atomic handler are not completion evidence.
alter table public.stripe_events
  add column processing_state text not null default 'legacy_unverified',
  add column provider_subscription_id text,
  add column livemode boolean,
  add column mutation_sha256 text,
  add column processed_at timestamptz,
  add constraint stripe_event_processing_state check(processing_state in ('legacy_unverified','pending','processed'));

create table bookworm_private.stripe_subscription_sync (
  provider_subscription_id text primary key check(provider_subscription_id ~ '^sub_[A-Za-z0-9_]{1,250}$'),
  event_id text,
  lease_token uuid,
  lease_expires_at timestamptz
);
alter table bookworm_private.stripe_subscription_sync enable row level security;
revoke all on table bookworm_private.stripe_subscription_sync from public,anon,authenticated;
grant select,insert,update on table bookworm_private.stripe_subscription_sync to service_role;
grant usage on schema bookworm_private to service_role;

create function public.claim_stripe_subscription_event(p_event_id text,p_event_type text,p_subscription_id text,p_livemode boolean)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare e public.stripe_events; s bookworm_private.stripe_subscription_sync; sub public.subscriptions; token uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$'
    or p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9_]{1,250}$' or p_livemode is null
    or p_event_type is null or p_event_type not in ('checkout.session.completed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted') then
    raise exception 'invalid Stripe event identity' using errcode='22023'; end if;
  -- One lock order for every claim/completion: subscription lease, then event.
  insert into bookworm_private.stripe_subscription_sync(provider_subscription_id) values(p_subscription_id) on conflict do nothing;
  select * into strict s from bookworm_private.stripe_subscription_sync where provider_subscription_id=p_subscription_id for update;
  insert into public.stripe_events(id,type,processing_state,provider_subscription_id,livemode)
    values(p_event_id,p_event_type,'pending',p_subscription_id,p_livemode) on conflict do nothing;
  select * into strict e from public.stripe_events where id=p_event_id for update;
  if e.type is distinct from p_event_type or (e.provider_subscription_id is not null and e.provider_subscription_id<>p_subscription_id)
    or (e.livemode is not null and e.livemode<>p_livemode) then raise exception 'Stripe event identity conflict' using errcode='23505'; end if;
  if e.processing_state='processed' then return jsonb_build_object('state','duplicate'); end if;
  if s.lease_token is not null and s.lease_expires_at>clock_timestamp() then return jsonb_build_object('state','busy'); end if;
  token:=gen_random_uuid();
  update bookworm_private.stripe_subscription_sync set event_id=p_event_id,lease_token=token,lease_expires_at=clock_timestamp()+interval '30 seconds'
    where provider_subscription_id=p_subscription_id;
  update public.stripe_events set processing_state='pending',provider_subscription_id=p_subscription_id,livemode=p_livemode where id=p_event_id;
  select * into sub from public.subscriptions where provider_subscription_id=p_subscription_id;
  return jsonb_build_object('state','claimed','leaseToken',token,'binding',case when sub.id is null then null else
    jsonb_build_object('organizationId',sub.organization_id,'planId',sub.plan_id,'customerId',sub.provider_customer_id) end);
end $$;

create function public.complete_stripe_subscription_event(p_event_id text,p_lease_token uuid,p_mutation jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare e public.stripe_events; s bookworm_private.stripe_subscription_sync; sub public.subscriptions; org uuid; plan uuid;
  customer text; subscription text; status text; period bigint; digest text; granting boolean;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$' or p_lease_token is null
    or p_mutation is null or jsonb_typeof(p_mutation)<>'object' or length(p_mutation::text)>4096
    or not p_mutation ?& array['organizationId','planId','customerId','subscriptionId','status','periodEnd','priceId','expectedPriceId']
    or (select count(*) from jsonb_object_keys(p_mutation))<>8
    or jsonb_typeof(p_mutation->'subscriptionId')<>'string' or (p_mutation->>'subscriptionId') !~ '^sub_[A-Za-z0-9_]{1,250}$'
    or jsonb_typeof(p_mutation->'customerId')<>'string' or (p_mutation->>'customerId') !~ '^cus_[A-Za-z0-9_]{1,250}$'
    or jsonb_typeof(p_mutation->'status')<>'string' or (p_mutation->>'status') not in ('active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')
    or jsonb_typeof(p_mutation->'organizationId') not in ('string','null') or jsonb_typeof(p_mutation->'planId') not in ('string','null')
    or jsonb_typeof(p_mutation->'priceId') not in ('string','null') or jsonb_typeof(p_mutation->'expectedPriceId') not in ('string','null')
    or jsonb_typeof(p_mutation->'periodEnd') not in ('number','null') then
    raise exception 'invalid Stripe subscription mutation' using errcode='22023'; end if;
  if p_mutation->>'organizationId' is not null and (p_mutation->>'organizationId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or p_mutation->>'planId' is not null and (p_mutation->>'planId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or p_mutation->>'periodEnd' is not null and (p_mutation->>'periodEnd') !~ '^[0-9]{1,10}$' then
    raise exception 'invalid Stripe subscription mutation' using errcode='22023'; end if;
  org:=(p_mutation->>'organizationId')::uuid; plan:=(p_mutation->>'planId')::uuid;
  customer:=p_mutation->>'customerId'; subscription:=p_mutation->>'subscriptionId'; status:=p_mutation->>'status';
  period:=(p_mutation->>'periodEnd')::bigint; granting:=status in ('active','trialing');
  if period is not null and period>4102444800 then raise exception 'invalid Stripe subscription period' using errcode='22023'; end if;
  digest:=encode(public.digest(convert_to(p_mutation::text,'UTF8'),'sha256'),'hex');
  select * into s from bookworm_private.stripe_subscription_sync where provider_subscription_id=subscription for update;
  select * into e from public.stripe_events where id=p_event_id for update;
  if e.id is null or e.provider_subscription_id is distinct from subscription then raise exception 'Stripe event missing or mismatched' using errcode='22023'; end if;
  if e.processing_state='processed' then
    if e.mutation_sha256 is distinct from digest then raise exception 'Stripe completion replay conflict' using errcode='23505'; end if;
    return jsonb_build_object('state','processed');
  end if;
  if s.provider_subscription_id is null or s.event_id is distinct from p_event_id or s.lease_token is distinct from p_lease_token
    or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'Stripe reconciliation lease lost' using errcode='40001'; end if;
  select * into sub from public.subscriptions where provider_subscription_id=subscription for update;
  if sub.id is not null and (sub.organization_id is distinct from org or (sub.provider_customer_id is not null and sub.provider_customer_id<>customer)) then
    raise exception 'Stripe subscription owner conflict' using errcode='23505'; end if;
  if sub.id is null and (org is null or plan is null or not exists(select 1 from public.plans where id=plan and is_active and price_cents>0)) then
    raise exception 'Stripe subscription plan unavailable' using errcode='23514'; end if;
  if granting and (org is null or plan is null or p_mutation->>'priceId' is null or p_mutation->>'priceId' !~ '^price_[A-Za-z0-9_]{1,250}$'
    or p_mutation->>'expectedPriceId' is distinct from p_mutation->>'priceId'
    or not exists(select 1 from public.plans where id=plan and price_cents>0 and (is_active or (sub.id is not null and sub.plan_id=plan)))) then
    raise exception 'Stripe subscription price or plan mismatch' using errcode='23514'; end if;
  if sub.id is not null and not granting and sub.plan_id is distinct from plan then raise exception 'Stripe inactive plan changed' using errcode='23505'; end if;
  insert into public.subscriptions(organization_id,provider_customer_id,provider_subscription_id,plan_id,status,current_period_end)
    values(org,customer,subscription,plan,status,case when period is null then null else to_timestamp(period) end)
    on conflict(provider_subscription_id) do update set status=excluded.status,plan_id=excluded.plan_id,provider_customer_id=excluded.provider_customer_id,
      current_period_end=excluded.current_period_end,updated_at=clock_timestamp();
  update public.stripe_events set processing_state='processed',mutation_sha256=digest,processed_at=clock_timestamp() where id=p_event_id;
  update bookworm_private.stripe_subscription_sync set event_id=null,lease_token=null,lease_expires_at=null where provider_subscription_id=subscription;
  return jsonb_build_object('state','processed');
end $$;
revoke all on function public.claim_stripe_subscription_event(text,text,text,boolean),public.complete_stripe_subscription_event(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_stripe_subscription_event(text,text,text,boolean),public.complete_stripe_subscription_event(text,uuid,jsonb) to service_role;
