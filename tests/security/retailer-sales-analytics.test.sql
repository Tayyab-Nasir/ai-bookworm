begin;

insert into auth.users(id,email) values
  ('c9100000-0000-4000-8000-000000000001','analytics-owner@local.test'),
  ('c9100000-0000-4000-8000-000000000002','analytics-viewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id)
  values('c9100000-0000-4000-8000-000000000003','Analytics Org','analytics-org','c9100000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('c9100000-0000-4000-8000-000000000003','c9100000-0000-4000-8000-000000000001','owner'),
  ('c9100000-0000-4000-8000-000000000003','c9100000-0000-4000-8000-000000000002','member');
insert into public.workspaces(id,organization_id,name,slug,created_by)
  values('c9100000-0000-4000-8000-000000000004','c9100000-0000-4000-8000-000000000003','Analytics','analytics','c9100000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('c9100000-0000-4000-8000-000000000004','c9100000-0000-4000-8000-000000000001','editor'),
  ('c9100000-0000-4000-8000-000000000004','c9100000-0000-4000-8000-000000000002','viewer');
insert into public.books(id,workspace_id,title,author_name,language,created_by)
  values('c9100000-0000-4000-8000-000000000005','c9100000-0000-4000-8000-000000000004','Canonical River','Author','en','c9100000-0000-4000-8000-000000000001');

set local role authenticated;
set local request.jwt.claims='{"sub":"c9100000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare
  v_old uuid;
  v_replacement uuid;
  v_result jsonb;
  v_usd jsonb;
  v_eur jsonb;
begin
  select import_id into v_old from public.import_retailer_sales(
    'c9100000-0000-4000-8000-000000000004','amazon_kdp','old.csv',
    jsonb_build_array(jsonb_build_object('bookId','c9100000-0000-4000-8000-000000000005','soldOn',current_date::text,
      'title','Old report title','units',2,'reportedProceedsCents',200,'royaltyCents',140,'currency','USD'))
  );
  select import_id into v_replacement from public.import_retailer_sales(
    'c9100000-0000-4000-8000-000000000004','amazon_kdp','replacement.csv',
    jsonb_build_array(jsonb_build_object('bookId','c9100000-0000-4000-8000-000000000005','soldOn',current_date::text,
      'title','Replacement report title','units',5,'reportedProceedsCents',500,'royaltyCents',350,'currency','USD'),
      jsonb_build_object('bookId','c9100000-0000-4000-8000-000000000005','soldOn',current_date::text,
      'title','Correction with no reported proceeds','units',-1,'royaltyCents',-70,'currency','USD')),
    v_old
  );
  perform public.import_retailer_sales(
    'c9100000-0000-4000-8000-000000000004','google_play','eur.csv',
    jsonb_build_array(jsonb_build_object('bookId','c9100000-0000-4000-8000-000000000005','soldOn',current_date::text,
      'title','River in Europe','units',3,'reportedProceedsCents',300,'royaltyCents',210,'currency','EUR'))
  );

  v_result := public.retailer_sales_analytics('c9100000-0000-4000-8000-000000000004', 12);
  assert (v_result->>'monthCount')::integer = 12;
  assert (v_result->>'windowStart')::date <= current_date and (v_result->>'windowEnd')::date > current_date;
  assert jsonb_array_length(v_result->'monthly') = 2, 'monthly totals must stay split by currency';
  select value into v_usd from jsonb_array_elements(v_result->'monthly') where value->>'currency'='USD';
  select value into v_eur from jsonb_array_elements(v_result->'monthly') where value->>'currency'='EUR';
  assert (v_usd->>'units')::integer = 4 and (v_usd->>'royaltyCents')::integer = 280,
    'monthly analytics included a superseded retailer report';
  assert (v_eur->>'units')::integer = 3 and (v_eur->>'royaltyCents')::integer = 210;
  assert v_usd->>'reportedProceedsCents' is null, 'partial monthly proceeds must remain unknown';
  assert exists(select 1 from jsonb_array_elements(v_result->'books') b
    where b->>'bookId'='c9100000-0000-4000-8000-000000000005' and b->>'title'='Canonical River'
      and b->>'currency'='USD' and (b->>'units')::integer=4 and b->>'reportedProceedsCents' is null),
    'book analytics did not use canonical workspace title or active row totals';
  assert exists(select 1 from jsonb_array_elements(v_result->'sources') s
    where s->>'source'='amazon_kdp' and s->>'currency'='USD' and (s->>'units')::integer=4 and s->>'reportedProceedsCents' is null);
  assert exists(select 1 from jsonb_array_elements(public.retailer_sales_summary('c9100000-0000-4000-8000-000000000004')->'currencies') s
    where s->>'currency'='USD' and s->>'reportedProceedsCents' is null),
    'the all-time dashboard cannot report a partial proceeds subtotal as a complete total';
  begin
    perform public.retailer_sales_analytics('c9100000-0000-4000-8000-000000000004', 0);
    raise exception 'invalid analytics window was accepted';
  exception when invalid_parameter_value then assert sqlerrm='retailer analytics window must be between 1 and 36 months'; end;
end $$;

reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"c9100000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
begin
  assert jsonb_array_length(public.retailer_sales_analytics('c9100000-0000-4000-8000-000000000004',12)->'monthly')=2,
    'an active read-only member can inspect the workspace analytics';
  begin
    perform public.retailer_sales_analytics('c9100000-0000-4000-8000-000000000006', 12);
    raise exception 'non-member read of retailer analytics succeeded';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
update public.workspace_members set status='suspended'
  where workspace_id='c9100000-0000-4000-8000-000000000004' and user_id='c9100000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims='{"sub":"c9100000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
begin
  begin
    perform public.retailer_sales_analytics('c9100000-0000-4000-8000-000000000004',12);
    assert false, 'suspended workspace membership cannot read analytics';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.retailer_sales_analytics('c9100000-0000-4000-8000-000000000004', 12);
    raise exception 'anonymous retailer analytics succeeded';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
