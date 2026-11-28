-- Disposable SQL assertions only. The runner provides synthetic Auth/schema
-- fixtures; this does not prove signed Stripe delivery or multi-connection races.
begin;

do $$
begin
  assert not has_function_privilege('anon','public.claim_stripe_subscription_event(text,text,text,boolean)','execute');
  assert not has_function_privilege('authenticated','public.claim_stripe_subscription_event(text,text,text,boolean)','execute');
  assert not has_function_privilege('anon','public.complete_stripe_subscription_event(text,uuid,jsonb)','execute');
  assert not has_function_privilege('authenticated','public.complete_stripe_subscription_event(text,uuid,jsonb)','execute');
  assert has_function_privilege('service_role','public.claim_stripe_subscription_event(text,text,text,boolean)','execute');
  assert has_function_privilege('service_role','public.complete_stripe_subscription_event(text,uuid,jsonb)','execute');
  assert (select relrowsecurity from pg_class where oid='bookworm_private.stripe_subscription_sync'::regclass);
  assert not has_table_privilege('anon','bookworm_private.stripe_subscription_sync','select');
  assert not has_table_privilege('authenticated','bookworm_private.stripe_subscription_sync','select');
  assert not has_table_privilege('authenticated','bookworm_private.stripe_subscription_sync','insert');
  assert not has_table_privilege('authenticated','bookworm_private.stripe_subscription_sync','update');
  assert has_table_privilege('service_role','bookworm_private.stripe_subscription_sync','select');
  assert has_table_privilege('service_role','bookworm_private.stripe_subscription_sync','insert');
  assert has_table_privilege('service_role','bookworm_private.stripe_subscription_sync','update');
end $$;

insert into auth.users(id,email) values('a9100000-0000-4000-8000-000000000001','stripe-sql@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('a9110000-0000-4000-8000-000000000001','Stripe SQL first','stripe-sql-first','a9100000-0000-4000-8000-000000000001'),
  ('a9110000-0000-4000-8000-000000000002','Stripe SQL other','stripe-sql-other','a9100000-0000-4000-8000-000000000001');
insert into public.plans(id,name,is_active,billing_period,price_cents,currency,entitlements_json) values
  ('a9120000-0000-4000-8000-000000000001','stripe-sql-published',true,'monthly',2900,'USD','{}'),
  ('a9120000-0000-4000-8000-000000000002','stripe-sql-unpublished',false,'monthly',2900,'USD','{}'),
  ('a9120000-0000-4000-8000-000000000003','stripe-sql-free',true,'monthly',0,'USD','{}'),
  ('a9120000-0000-4000-8000-000000000004','stripe-sql-other-published',true,'monthly',3900,'USD','{}');

-- A receipt from the old receipt-before-effect handler remains uncertain.
insert into public.stripe_events(id,type,created_at)
  values('evt_sql_legacy','customer.subscription.updated','2020-01-02T03:04:05Z');
do $$ begin
  assert (select processing_state='legacy_unverified' and provider_subscription_id is null
    and livemode is null and mutation_sha256 is null and processed_at is null
    and created_at='2020-01-02T03:04:05Z'::timestamptz from public.stripe_events where id='evt_sql_legacy');
end $$;

-- Inject a failure after the normalized subscription write, at the processed
-- receipt update. Its switch exists only within this rollback-only SQL fixture.
create function public.test_stripe_receipt_failure() returns trigger language plpgsql as $$
begin
  if new.id='evt_sql_atomic' and new.processing_state='processed'
    and current_setting('bookworm.test_stripe_receipt_failure',true)='on' then
    raise exception 'injected Stripe processed receipt failure';
  end if;
  return new;
end $$;
create trigger test_stripe_receipt_failure before update on public.stripe_events
  for each row execute function public.test_stripe_receipt_failure();

set local role anon;
do $$ begin
  begin
    perform public.claim_stripe_subscription_event('evt_sql_denied','customer.subscription.updated','sub_sql_denied',false);
    assert false,'anonymous caller claimed a billing event';
  exception when insufficient_privilege then null; end;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_denied',gen_random_uuid(),'{}');
    assert false,'anonymous caller completed a billing event';
  exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
-- A caller-controlled role claim cannot bypass the revoked EXECUTE privilege.
select set_config('request.jwt.claim.role','service_role',true);
do $$ begin
  begin
    perform public.claim_stripe_subscription_event('evt_sql_denied','customer.subscription.updated','sub_sql_denied',false);
    assert false,'authenticated caller claimed a billing event';
  exception when insufficient_privilege then null; end;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_denied',gen_random_uuid(),'{}');
    assert false,'authenticated caller completed a billing event';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;

do $$
declare
  v_claim jsonb; v_lease uuid; v_new_lease uuid; v_mutation jsonb; v_bad_plan uuid; v_binding jsonb;
begin
  assert not exists(select 1 from public.stripe_events where id='evt_sql_denied');
  begin
    perform public.claim_stripe_subscription_event('invalid','customer.subscription.updated','sub_sql_first',false);
    assert false,'invalid event identity accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.claim_stripe_subscription_event('evt_sql_invalid','unhandled.event','sub_sql_first',false);
    assert false,'unsupported event type accepted';
  exception when invalid_parameter_value then null; end;

  v_claim:=public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.created','sub_sql_first',false);
  assert v_claim->>'state'='claimed' and v_claim->'binding'='null'::jsonb;
  v_lease:=(v_claim->>'leaseToken')::uuid;
  assert (select processing_state='pending' and mutation_sha256 is null and processed_at is null
    from public.stripe_events where id='evt_sql_first'),'claim was reported as completed';
  assert public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.created','sub_sql_first',false)->>'state'='busy';
  assert public.claim_stripe_subscription_event('evt_sql_other_live','customer.subscription.updated','sub_sql_first',false)->>'state'='busy';
  assert (select lease_token=v_lease and event_id='evt_sql_first' from bookworm_private.stripe_subscription_sync
    where provider_subscription_id='sub_sql_first'),'live claimant lost its token';
  begin
    perform public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.updated','sub_sql_first',false);
    assert false,'event type identity changed';
  exception when unique_violation then null; end;
  begin
    perform public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.created','sub_sql_other',false);
    assert false,'event subscription identity changed';
  exception when unique_violation then null; end;
  begin
    perform public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.created','sub_sql_first',true);
    assert false,'event livemode identity changed';
  exception when unique_violation then null; end;

  v_mutation:=jsonb_build_object('organizationId','a9110000-0000-4000-8000-000000000001',
    'planId','a9120000-0000-4000-8000-000000000001','customerId','cus_sql_first','subscriptionId','sub_sql_first',
    'status','active','periodEnd',2000000000,'priceId','price_sql_paid','expectedPriceId','price_sql_paid');
  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',v_lease,v_mutation||'{"extra":true}');
    assert false,'unknown normalized mutation field accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',v_lease,v_mutation||'{"periodEnd":1.5}');
    assert false,'fractional subscription period accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',v_lease,v_mutation||'{"expectedPriceId":"price_sql_wrong"}');
    assert false,'mismatched approved price accepted';
  exception when check_violation then null; end;
  foreach v_bad_plan in array array[
    'a9120000-0000-4000-8000-000000000002'::uuid,
    'a9120000-0000-4000-8000-000000000003'::uuid,
    'a9120000-0000-4000-8000-000000000099'::uuid
  ] loop
    begin
      perform public.complete_stripe_subscription_event('evt_sql_first',v_lease,
        jsonb_set(v_mutation,'{planId}',to_jsonb(v_bad_plan)));
      assert false,'first subscription accepted an unpublished, free or unknown plan';
    exception when check_violation then null; end;
  end loop;
  assert not exists(select 1 from public.subscriptions where provider_subscription_id='sub_sql_first');
  assert (select processing_state='pending' from public.stripe_events where id='evt_sql_first');

  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',gen_random_uuid(),v_mutation);
    assert false,'wrong pending lease completed';
  exception when serialization_failure then null; end;
  update bookworm_private.stripe_subscription_sync set lease_expires_at=clock_timestamp()-interval '1 second'
    where provider_subscription_id='sub_sql_first';
  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',v_lease,v_mutation);
    assert false,'expired pending lease completed';
  exception when serialization_failure then null; end;
  v_claim:=public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.created','sub_sql_first',false);
  v_new_lease:=(v_claim->>'leaseToken')::uuid;
  assert v_claim->>'state'='claimed' and v_new_lease<>v_lease;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',v_lease,v_mutation);
    assert false,'replaced lease completed';
  exception when serialization_failure then null; end;
  assert public.complete_stripe_subscription_event('evt_sql_first',v_new_lease,v_mutation)->>'state'='processed';
  assert (select organization_id='a9110000-0000-4000-8000-000000000001'::uuid
    and plan_id='a9120000-0000-4000-8000-000000000001'::uuid and provider_customer_id='cus_sql_first'
    and status='active' and current_period_end=to_timestamp(2000000000)
    from public.subscriptions where provider_subscription_id='sub_sql_first'),'normalized subscription not saved';
  assert (select processing_state='processed' and processed_at is not null
    and mutation_sha256=encode(public.digest(convert_to(v_mutation::text,'UTF8'),'sha256'),'hex')
    from public.stripe_events where id='evt_sql_first'),'processed receipt omitted exact mutation identity';
  assert (select event_id is null and lease_token is null and lease_expires_at is null
    from bookworm_private.stripe_subscription_sync where provider_subscription_id='sub_sql_first');
  assert public.claim_stripe_subscription_event('evt_sql_first','customer.subscription.created','sub_sql_first',false)->>'state'='duplicate';
  assert public.complete_stripe_subscription_event('evt_sql_first',v_new_lease,v_mutation)->>'state'='processed';
  assert (select count(*) from public.subscriptions where provider_subscription_id='sub_sql_first')=1;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_first',v_new_lease,v_mutation||'{"status":"canceled"}');
    assert false,'different completion replay changed the effect';
  exception when unique_violation then null; end;
  assert (select status from public.subscriptions where provider_subscription_id='sub_sql_first')='active';

  -- Failure at the processed receipt write must also roll back subscription
  -- insertion. Retry the exact owned lease, not a second subscription effect.
  v_claim:=public.claim_stripe_subscription_event('evt_sql_atomic','customer.subscription.created','sub_sql_atomic',false);
  v_lease:=(v_claim->>'leaseToken')::uuid;
  v_mutation:=v_mutation||'{"subscriptionId":"sub_sql_atomic","customerId":"cus_sql_atomic"}';
  perform set_config('bookworm.test_stripe_receipt_failure','on',true);
  begin
    perform public.complete_stripe_subscription_event('evt_sql_atomic',v_lease,v_mutation);
    assert false,'injected processed-receipt failure was ignored';
  exception when raise_exception then assert sqlerrm='injected Stripe processed receipt failure'; end;
  assert not exists(select 1 from public.subscriptions where provider_subscription_id='sub_sql_atomic'),'failed receipt left a subscription effect';
  assert (select processing_state='pending' and mutation_sha256 is null and processed_at is null
    from public.stripe_events where id='evt_sql_atomic'),'failed effect left a processed receipt';
  assert (select event_id='evt_sql_atomic' and lease_token=v_lease
    from bookworm_private.stripe_subscription_sync where provider_subscription_id='sub_sql_atomic');
  assert public.claim_stripe_subscription_event('evt_sql_atomic','customer.subscription.created','sub_sql_atomic',false)->>'state'='busy';
  perform set_config('bookworm.test_stripe_receipt_failure','off',true);
  assert public.complete_stripe_subscription_event('evt_sql_atomic',v_lease,v_mutation)->>'state'='processed';
  assert (select count(*) from public.subscriptions where provider_subscription_id='sub_sql_atomic')=1;
  assert (select processing_state='processed' from public.stripe_events where id='evt_sql_atomic');

  v_claim:=public.claim_stripe_subscription_event('evt_sql_legacy','customer.subscription.updated','sub_sql_legacy',false);
  assert v_claim->>'state'='claimed','legacy uncertainty was silently treated as completed';
  v_lease:=(v_claim->>'leaseToken')::uuid;
  assert not exists(select 1 from public.subscriptions where provider_subscription_id='sub_sql_legacy');
  assert (select processing_state='pending' and created_at='2020-01-02T03:04:05Z'::timestamptz
    and type='customer.subscription.updated' and mutation_sha256 is null and processed_at is null
    from public.stripe_events where id='evt_sql_legacy'),'claim replaced historical receipt provenance';
  v_mutation:=v_mutation||'{"subscriptionId":"sub_sql_legacy","customerId":"cus_sql_legacy"}';
  assert public.complete_stripe_subscription_event('evt_sql_legacy',v_lease,v_mutation)->>'state'='processed';
  assert (select count(*) from public.subscriptions where provider_subscription_id='sub_sql_legacy')=1;

  -- A published plan can become historical without stranding a cancellation.
  update public.plans set is_active=false where id='a9120000-0000-4000-8000-000000000001';
  v_claim:=public.claim_stripe_subscription_event('evt_sql_renew','customer.subscription.updated','sub_sql_first',false);
  v_binding:=v_claim->'binding'; v_lease:=(v_claim->>'leaseToken')::uuid;
  assert v_binding=jsonb_build_object('organizationId','a9110000-0000-4000-8000-000000000001',
    'planId','a9120000-0000-4000-8000-000000000001','customerId','cus_sql_first');
  v_mutation:=v_mutation||'{"subscriptionId":"sub_sql_first","customerId":"cus_sql_first","status":"trialing"}';
  assert public.complete_stripe_subscription_event('evt_sql_renew',v_lease,v_mutation)->>'state'='processed',
    'same historical paid plan could not reconcile an existing subscription';
  assert (select status from public.subscriptions where provider_subscription_id='sub_sql_first')='trialing';

  v_claim:=public.claim_stripe_subscription_event('evt_sql_cancel','customer.subscription.deleted','sub_sql_first',false);
  v_lease:=(v_claim->>'leaseToken')::uuid;
  v_mutation:=v_mutation||'{"status":"canceled","periodEnd":null,"priceId":null,"expectedPriceId":null}';
  begin
    perform public.complete_stripe_subscription_event('evt_sql_cancel',v_lease,
      v_mutation||'{"organizationId":"a9110000-0000-4000-8000-000000000002"}');
    assert false,'existing subscription moved to another tenant';
  exception when unique_violation then null; end;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_cancel',v_lease,v_mutation||'{"customerId":"cus_sql_other"}');
    assert false,'existing subscription switched Stripe customer';
  exception when unique_violation then null; end;
  begin
    perform public.complete_stripe_subscription_event('evt_sql_cancel',v_lease,
      v_mutation||'{"planId":"a9120000-0000-4000-8000-000000000004"}');
    assert false,'inactive mutation switched its historical plan';
  exception when unique_violation then null; end;
  assert (select status='trialing' and provider_customer_id='cus_sql_first'
    and organization_id='a9110000-0000-4000-8000-000000000001'::uuid
    and plan_id='a9120000-0000-4000-8000-000000000001'::uuid
    from public.subscriptions where provider_subscription_id='sub_sql_first');
  assert public.complete_stripe_subscription_event('evt_sql_cancel',v_lease,v_mutation)->>'state'='processed',
    'cancellation required an obsolete price mapping';
  assert (select status='canceled' and current_period_end is null and provider_customer_id='cus_sql_first'
    and organization_id='a9110000-0000-4000-8000-000000000001'::uuid
    and plan_id='a9120000-0000-4000-8000-000000000001'::uuid
    from public.subscriptions where provider_subscription_id='sub_sql_first');
  assert not exists(select 1 from public.subscriptions where provider_subscription_id='sub_sql_first'
    and status in ('active','trialing')),'canceled subscription retained an eligible billing status';
  assert public.claim_stripe_subscription_event('evt_sql_cancel','customer.subscription.deleted','sub_sql_first',false)->>'state'='duplicate';
  assert not exists(select 1 from public.credit_ledger where user_id='a9100000-0000-4000-8000-000000000001'),
    'subscription reconciliation invented a credit grant or payment';
end $$;
reset role;
rollback;
