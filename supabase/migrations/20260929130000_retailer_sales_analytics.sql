create function public.retailer_sales_analytics(p_workspace_id uuid, p_months integer default 12)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_window_start date;
  v_window_end date;
  v_result jsonb;
begin
  if v_uid is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'retailer sales analytics requires workspace access' using errcode = '42501';
  end if;
  if p_months is null or p_months < 1 or p_months > 36 then
    raise exception 'retailer analytics window must be between 1 and 36 months' using errcode = '22023';
  end if;

  v_window_end := (date_trunc('month', timezone('utc', now())) + interval '1 month')::date;
  v_window_start := (date_trunc('month', timezone('utc', now())) - make_interval(months => p_months - 1))::date;

  with active_rows as (
    select r.book_id, coalesce(b.title, r.title) as title, r.sold_on,
      date_trunc('month', r.sold_on)::date as month, r.currency, i.source,
      r.units, r.reported_proceeds_cents, r.royalty_cents
    from public.retailer_sales_rows r
    join public.retailer_sales_imports i
      on i.id = r.import_id and i.workspace_id = p_workspace_id and i.superseded_at is null
    left join public.books b on b.id = r.book_id and b.workspace_id = p_workspace_id
    where r.workspace_id = p_workspace_id and r.sold_on >= v_window_start and r.sold_on < v_window_end
  ), monthly as (
    select month, currency, sum(units)::bigint as units,
      case when count(reported_proceeds_cents)=count(*) then sum(reported_proceeds_cents)::bigint else null end as reported_proceeds_cents,
      sum(royalty_cents)::bigint as royalty_cents
    from active_rows group by month, currency
  ), books as (
    select book_id, title, currency, sum(units)::bigint as units,
      case when count(reported_proceeds_cents)=count(*) then sum(reported_proceeds_cents)::bigint else null end as reported_proceeds_cents,
      sum(royalty_cents)::bigint as royalty_cents,
      min(sold_on) as first_sold_on, max(sold_on) as last_sold_on
    from active_rows group by book_id, title, currency
  ), sources as (
    select source, currency, sum(units)::bigint as units,
      case when count(reported_proceeds_cents)=count(*) then sum(reported_proceeds_cents)::bigint else null end as reported_proceeds_cents,
      sum(royalty_cents)::bigint as royalty_cents
    from active_rows group by source, currency
  )
  select jsonb_build_object(
    'windowStart', v_window_start,
    'windowEnd', v_window_end,
    'monthCount', p_months,
    'monthly', coalesce((select jsonb_agg(jsonb_build_object(
      'month', month, 'currency', currency, 'units', units,
      'reportedProceedsCents', reported_proceeds_cents, 'royaltyCents', royalty_cents
    ) order by month, currency) from monthly), '[]'::jsonb),
    'books', coalesce((select jsonb_agg(jsonb_build_object(
      'bookId', book_id, 'title', title, 'currency', currency, 'units', units,
      'reportedProceedsCents', reported_proceeds_cents, 'royaltyCents', royalty_cents,
      'firstSoldOn', first_sold_on, 'lastSoldOn', last_sold_on
    ) order by royalty_cents desc nulls last, units desc, title, currency)
      from (select * from books order by royalty_cents desc nulls last, units desc, title, currency limit 100) ranked_books), '[]'::jsonb),
    'bookCount', (select count(*)::integer from books),
    'booksTruncated', (select count(*) > 100 from books),
    'sources', coalesce((select jsonb_agg(jsonb_build_object(
      'source', source, 'currency', currency, 'units', units,
      'reportedProceedsCents', reported_proceeds_cents, 'royaltyCents', royalty_cents
    ) order by source, currency) from sources), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

revoke all on function public.retailer_sales_analytics(uuid, integer) from public, anon;
grant execute on function public.retailer_sales_analytics(uuid, integer) to authenticated, service_role;

-- The all-time dashboard summary follows the same unknown-proceeds rule.
-- A known subtotal is not a complete reported proceeds total.
create or replace function public.retailer_sales_summary(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_summary jsonb;
begin
  if v_uid is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'retailer sales summary requires workspace access' using errcode = '42501';
  end if;
  with import_stats as (
    select count(*)::integer as imports, max(created_at) as latest_imported_at
    from public.retailer_sales_imports where workspace_id=p_workspace_id and superseded_at is null
  ), grouped as (
    select currency, sum(units)::bigint as units,
      case when count(reported_proceeds_cents)=count(*) then sum(reported_proceeds_cents)::bigint else null end as reported_proceeds_cents,
      sum(royalty_cents)::bigint as royalty_cents
    from public.retailer_sales_rows r join public.retailer_sales_imports i on i.id=r.import_id
    where r.workspace_id=p_workspace_id and i.workspace_id=p_workspace_id and i.superseded_at is null group by currency
  ), totals as (
    select coalesce(sum(units),0)::bigint as units, count(*)::integer as currencies from grouped
  )
  select jsonb_build_object(
    'status',case when import_stats.imports>0 then 'imported' else 'not_connected' end,
    'imports',import_stats.imports,'latestImportedAt',import_stats.latest_imported_at,
    'units',case when import_stats.imports>0 then totals.units else null end,
    'reportedProceedsCents',case when totals.currencies=1 then (select reported_proceeds_cents from grouped limit 1) else null end,
    'royaltyCents',case when totals.currencies=1 then (select royalty_cents from grouped limit 1) else null end,
    'currency',case when totals.currencies=1 then (select currency from grouped limit 1) else null end,
    'currencies',coalesce((select jsonb_agg(jsonb_build_object(
      'currency',currency,'units',units,'reportedProceedsCents',reported_proceeds_cents,'royaltyCents',royalty_cents
    ) order by currency) from grouped),'[]'::jsonb)
  ) into v_summary from import_stats cross join totals;
  return v_summary;
end $$;
