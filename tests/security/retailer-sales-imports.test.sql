begin;

insert into auth.users(id,email) values('c9000000-0000-4000-8000-000000000001','sales-owner@local.test'),('c9000000-0000-4000-8000-000000000002','sales-viewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values('c9000000-0000-4000-8000-000000000003','Sales Org','sales-org','c9000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values('c9000000-0000-4000-8000-000000000003','c9000000-0000-4000-8000-000000000001','owner'),('c9000000-0000-4000-8000-000000000003','c9000000-0000-4000-8000-000000000002','member');
insert into public.workspaces(id,organization_id,name,slug,created_by) values('c9000000-0000-4000-8000-000000000004','c9000000-0000-4000-8000-000000000003','Sales','sales','c9000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values('c9000000-0000-4000-8000-000000000004','c9000000-0000-4000-8000-000000000001','editor'),('c9000000-0000-4000-8000-000000000004','c9000000-0000-4000-8000-000000000002','viewer');
insert into public.books(id,workspace_id,title,author_name,language,created_by) values('c9000000-0000-4000-8000-000000000005','c9000000-0000-4000-8000-000000000004','Sales book','Author','en','c9000000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values('c9000000-0000-4000-8000-000000000006','c9000000-0000-4000-8000-000000000003','Other','other','c9000000-0000-4000-8000-000000000001');
insert into public.books(id,workspace_id,title,author_name,language,created_by) values('c9000000-0000-4000-8000-000000000007','c9000000-0000-4000-8000-000000000006','Other book','Author','en','c9000000-0000-4000-8000-000000000001');

set local role authenticated;
set local request.jwt.claims='{"sub":"c9000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v_import uuid; v_again record; v_corrected record; v_summary jsonb;
begin
  assert to_regprocedure('public.import_retailer_sales(uuid,text,text,text,jsonb,uuid)') is null,
    'caller-controlled checksum parameter remains exposed';
  select import_id into v_import from public.import_retailer_sales(
    'c9000000-0000-4000-8000-000000000004','amazon_kdp','September.csv',
    '[{"bookId":"c9000000-0000-4000-8000-000000000005","soldOn":"2026-09-01","title":"Sales book","externalId":"B0TEST","marketplace":"US","format":"ebook","units":2,"reportedProceedsCents":998,"royaltyCents":697,"currency":"USD"}]'::jsonb
  );
  assert v_import is not null;
  select * into v_again from public.import_retailer_sales(
    'c9000000-0000-4000-8000-000000000004','amazon_kdp','same-rows-renamed.csv',
    '[{"soldOn":"2026-09-01","title":"Sales book","externalId":"B0TEST","marketplace":"US","format":"ebook","units":2,"reportedProceedsCents":998,"royaltyCents":697,"currency":"USD"}]'::jsonb
  );
  assert v_again.duplicate and v_again.import_id=v_import,
    'book mapping or caller provenance changed the source-report identity';
  v_summary := public.retailer_sales_summary('c9000000-0000-4000-8000-000000000004');
  assert v_summary->>'status'='imported' and (v_summary->>'units')::integer=2 and v_summary->>'currency'='USD';
  begin
    perform public.import_retailer_sales(
      'c9000000-0000-4000-8000-000000000004','amazon_kdp','September-overlap.csv',
      '[{"soldOn":"2026-09-01","title":"Sales book","units":1,"royaltyCents":1,"currency":"USD"}]'::jsonb
    );
    raise exception 'overlapping active retailer report was accepted';
  exception when invalid_parameter_value then assert sqlerrm='retailer report overlaps an active report; replace it explicitly'; end;
  perform public.import_retailer_sales(
    'c9000000-0000-4000-8000-000000000004','google_play','September-eur.csv',
    '[{"soldOn":"2026-09-02","title":"Sales book","units":-1,"reportedProceedsCents":-499,"royaltyCents":-349,"currency":"EUR"}]'::jsonb
  );
  v_summary := public.retailer_sales_summary('c9000000-0000-4000-8000-000000000004');
  assert v_summary->>'currency' is null and jsonb_array_length(v_summary->'currencies')=2,
    'mixed currency import produced a made-up top-line total';
  select * into v_corrected from public.import_retailer_sales(
    'c9000000-0000-4000-8000-000000000004','amazon_kdp','September-corrected.csv',
    '[{"soldOn":"2026-09-03","title":"Sales book","units":5,"reportedProceedsCents":1499,"royaltyCents":1049,"currency":"EUR"}]'::jsonb,
    v_import
  );
  assert not v_corrected.duplicate;
  select * into v_again from public.import_retailer_sales(
    'c9000000-0000-4000-8000-000000000004','amazon_kdp','September-corrected-retry.csv',
    '[{"soldOn":"2026-09-03","title":"Sales book","units":5,"reportedProceedsCents":1499,"royaltyCents":1049,"currency":"EUR"}]'::jsonb,
    v_import
  );
  assert v_again.duplicate and v_again.import_id=v_corrected.import_id,
    'retrying a saved replacement did not return its durable receipt';
  v_summary := public.retailer_sales_summary('c9000000-0000-4000-8000-000000000004');
  assert v_summary->>'currency'='EUR' and (v_summary->>'units')::integer=4,
    'corrected report did not remove superseded rows from totals';
  assert exists(select 1 from public.retailer_sales_imports where id=v_import and superseded_at is not null),
    'replaced report remained active';
  assert exists(select 1 from public.activity_events where event_type='retailer_sales_imported' and entity_id=v_corrected.import_id),
    'replacement import has no atomic activity entry';
  begin
    perform public.import_retailer_sales('c9000000-0000-4000-8000-000000000004','other','foreign-book.csv',
      '[{"bookId":"c9000000-0000-4000-8000-000000000007","soldOn":"2026-09-03","title":"Other","units":1,"royaltyCents":1,"currency":"USD"}]'::jsonb);
    raise exception 'foreign workspace book accepted';
  exception when insufficient_privilege then assert sqlerrm='sales row 1 references a book outside this workspace'; end;
  begin
    insert into public.retailer_sales_imports(workspace_id,source,file_name,content_sha256,row_count,period_start,period_end,created_by)
      values('c9000000-0000-4000-8000-000000000004','other','direct.csv',repeat('e',64),1,current_date,current_date,'c9000000-0000-4000-8000-000000000001');
    raise exception 'authenticated direct import write succeeded';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"c9000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
begin
  begin
    perform public.import_retailer_sales('c9000000-0000-4000-8000-000000000004','other','blocked.csv','[{"soldOn":"2026-09-01","title":"Blocked","units":1,"royaltyCents":1,"currency":"USD"}]'::jsonb);
    raise exception 'viewer imported sales';
  exception when insufficient_privilege then assert sqlerrm='retailer import requires editing access'; end;
end $$;

reset role;
set local role anon;
do $$
begin
  begin
    perform public.retailer_sales_summary('c9000000-0000-4000-8000-000000000004');
    raise exception 'anonymous retailer summary succeeded';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
