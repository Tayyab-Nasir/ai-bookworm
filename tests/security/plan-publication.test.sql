begin;
do $$
declare
  v_draft uuid;
  v_live uuid;
begin
  insert into public.plans(name,billing_period,price_cents,currency,entitlements_json)
    values('draft-safety-test','monthly',1900,'USD','{}'::jsonb)
    returning id into v_draft;
  assert not (select is_active from public.plans where id=v_draft),
    'new plans must be unpublished by default';

  insert into public.plans(name,is_active,billing_period,price_cents,currency,entitlements_json)
    values('live-safety-test',true,'monthly',1900,'USD','{}'::jsonb)
    returning id into v_live;
  assert (select is_active from public.plans where id=v_live),
    'plans may be published only through an explicit active flag';

  begin
    insert into public.plans(name,billing_period,price_cents,currency,entitlements_json)
      values('negative-price-test','monthly',-1,'USD','{}'::jsonb);
    raise exception 'negative plan price was accepted';
  exception when check_violation then
    null;
  end;
end $$;
rollback;
