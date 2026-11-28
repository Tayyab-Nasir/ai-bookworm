-- Author-uploaded retailer reports. These rows are source-backed analytics,
-- not publishing-job guesses or retailer API claims.
create table public.retailer_sales_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null check (source in ('amazon_kdp','barnes_noble','apple_books','google_play','lulu','other')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  row_count integer not null check (row_count between 1 and 2000),
  period_start date not null,
  period_end date not null,
  supersedes_import_id uuid references public.retailer_sales_imports(id) on delete restrict,
  superseded_at timestamptz,
  superseded_by uuid unique references public.retailer_sales_imports(id) on delete restrict,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  check (supersedes_import_id is null or supersedes_import_id <> id),
  unique(workspace_id, source, content_sha256)
);

create table public.retailer_sales_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.retailer_sales_imports(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid references public.books(id) on delete set null,
  sold_on date not null,
  title text not null check (length(title) between 1 and 500),
  external_id text check (external_id is null or length(external_id) <= 200),
  marketplace text check (marketplace is null or length(marketplace) <= 100),
  format text check (format is null or length(format) <= 100),
  units integer not null check (units between -1000000 and 1000000),
  reported_proceeds_cents bigint check (reported_proceeds_cents between -1000000000000 and 1000000000000),
  royalty_cents bigint not null check (royalty_cents between -1000000000000 and 1000000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  source_row_number integer not null check (source_row_number between 1 and 2000),
  created_at timestamptz not null default now(),
  unique(import_id, source_row_number)
);

alter table public.retailer_sales_imports enable row level security;
alter table public.retailer_sales_rows enable row level security;

create policy retailer_sales_imports_select on public.retailer_sales_imports
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy retailer_sales_rows_select on public.retailer_sales_rows
  for select to authenticated using (private.is_workspace_member(workspace_id));

revoke all on public.retailer_sales_imports, public.retailer_sales_rows
  from public, anon, authenticated, service_role;
grant select on public.retailer_sales_imports, public.retailer_sales_rows to authenticated;
grant select, insert, update, delete on public.retailer_sales_imports, public.retailer_sales_rows to service_role;

create index retailer_sales_imports_workspace_created on public.retailer_sales_imports(workspace_id, created_at desc);
create unique index retailer_sales_imports_replacement_once on public.retailer_sales_imports(supersedes_import_id) where supersedes_import_id is not null;
create index retailer_sales_rows_workspace_sold_on on public.retailer_sales_rows(workspace_id, sold_on desc);
create index retailer_sales_rows_book_sold_on on public.retailer_sales_rows(book_id, sold_on desc) where book_id is not null;

create function public.import_retailer_sales(
  p_workspace_id uuid,
  p_source text,
  p_file_name text,
  p_rows jsonb,
  p_supersedes_import_id uuid default null
) returns table(import_id uuid, row_count integer, duplicate boolean)
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_import public.retailer_sales_imports;
  v_superseded public.retailer_sales_imports;
  v_row jsonb;
  v_index integer := 0;
  v_book_id uuid;
  v_sold_on date;
  v_title text;
  v_currency text;
  v_units integer;
  v_proceeds bigint;
  v_royalty bigint;
  v_external_id text;
  v_marketplace text;
  v_format text;
  v_start date;
  v_end date;
  v_identity_rows jsonb := '[]'::jsonb;
  v_content_sha256 text;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_workspace_id is null or p_source not in ('amazon_kdp','barnes_noble','apple_books','google_play','lulu','other')
    or p_file_name is null or length(trim(p_file_name)) not between 1 and 255
    or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 2000 then
    raise exception 'invalid retailer sales import' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_uid and status = 'active'
      and role in ('owner','admin','editor','writer')
  ) then raise exception 'retailer import requires editing access' using errcode = '42501'; end if;
  -- Serialize imports per workspace. The database derives report identity,
  -- so direct RPC callers cannot choose a checksum to evade deduplication.
  perform id from public.workspaces where id = p_workspace_id for update;

  -- Validate rows before creating durable import state.
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_row) is distinct from 'object' then
      raise exception 'sales row % is invalid', v_index using errcode = '22023';
    end if;
    begin
      v_sold_on := (v_row->>'soldOn')::date;
      v_units := (v_row->>'units')::integer;
      v_royalty := (v_row->>'royaltyCents')::bigint;
      v_proceeds := nullif(v_row->>'reportedProceedsCents','')::bigint;
      v_book_id := nullif(v_row->>'bookId','')::uuid;
    exception when others then
      raise exception 'sales row % has invalid dates, amounts, or book ID', v_index using errcode = '22023';
    end;
    v_title := trim(coalesce(v_row->>'title',''));
    v_currency := upper(trim(coalesce(v_row->>'currency','')));
    v_external_id := nullif(trim(coalesce(v_row->>'externalId','')),'');
    v_marketplace := nullif(trim(coalesce(v_row->>'marketplace','')),'');
    v_format := nullif(trim(coalesce(v_row->>'format','')),'');
    if length(v_title) not between 1 and 500 or v_currency !~ '^[A-Z]{3}$'
      or v_units not between -1000000 and 1000000
      or v_royalty not between -1000000000000 and 1000000000000
      or (v_proceeds is not null and v_proceeds not between -1000000000000 and 1000000000000)
      or (v_external_id is not null and length(v_external_id) > 200)
      or (v_marketplace is not null and length(v_marketplace) > 100)
      or (v_format is not null and length(v_format) > 100) then
      raise exception 'sales row % is outside allowed limits', v_index using errcode = '22023';
    end if;
    if v_book_id is not null and not exists (
      select 1 from public.books where id = v_book_id and workspace_id = p_workspace_id
    ) then raise exception 'sales row % references a book outside this workspace', v_index using errcode = '42501'; end if;
    v_start := least(coalesce(v_start, v_sold_on), v_sold_on);
    v_end := greatest(coalesce(v_end, v_sold_on), v_sold_on);
    -- Bookworm book links are internal annotations, not retailer report identity.
    v_identity_rows := v_identity_rows || jsonb_build_array(jsonb_build_object(
      'soldOn', to_char(v_sold_on, 'YYYY-MM-DD'), 'title', v_title,
      'externalId', v_external_id, 'marketplace', v_marketplace, 'format', v_format,
      'units', v_units, 'reportedProceedsCents', v_proceeds,
      'royaltyCents', v_royalty, 'currency', v_currency
    ));
  end loop;

  select coalesce(jsonb_agg(value order by value::text), '[]'::jsonb) into v_identity_rows
    from jsonb_array_elements(v_identity_rows);
  v_content_sha256 := encode(digest(convert_to(jsonb_build_object('source',p_source,'rows',v_identity_rows)::text,'UTF8'),'sha256'),'hex');

  select * into v_import from public.retailer_sales_imports
    where workspace_id = p_workspace_id and source = p_source and content_sha256 = v_content_sha256;
  if found then
    if v_import.supersedes_import_id is not distinct from p_supersedes_import_id then
      return query select v_import.id, v_import.row_count, true;
      return;
    end if;
    raise exception 'retailer report already has a different replacement relationship' using errcode = '22023';
  end if;

  if p_supersedes_import_id is not null then
    select * into v_superseded from public.retailer_sales_imports
      where id = p_supersedes_import_id and workspace_id = p_workspace_id for update;
    if not found or v_superseded.superseded_at is not null or v_superseded.source <> p_source then
      raise exception 'retailer report cannot be replaced' using errcode = '22023';
    end if;
  end if;
  if exists (
    select 1 from public.retailer_sales_imports
    where workspace_id = p_workspace_id and source = p_source and superseded_at is null
      and id is distinct from p_supersedes_import_id
      and period_start <= v_end and period_end >= v_start
  ) then
    raise exception 'retailer report overlaps an active report; replace it explicitly' using errcode = '22023';
  end if;

  insert into public.retailer_sales_imports(workspace_id, source, file_name, content_sha256, row_count, period_start, period_end, supersedes_import_id, created_by)
  values(p_workspace_id, p_source, trim(p_file_name), v_content_sha256, jsonb_array_length(p_rows), v_start, v_end, p_supersedes_import_id, v_uid)
  returning * into v_import;

  v_index := 0;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_index := v_index + 1;
    insert into public.retailer_sales_rows(
      import_id, workspace_id, book_id, sold_on, title, external_id, marketplace, format,
      units, reported_proceeds_cents, royalty_cents, currency, source_row_number
    ) values (
      v_import.id, p_workspace_id, nullif(v_row->>'bookId','')::uuid, (v_row->>'soldOn')::date,
      trim(v_row->>'title'), nullif(trim(coalesce(v_row->>'externalId','')),''),
      nullif(trim(coalesce(v_row->>'marketplace','')),''), nullif(trim(coalesce(v_row->>'format','')),''),
      (v_row->>'units')::integer, nullif(v_row->>'reportedProceedsCents','')::bigint,
      (v_row->>'royaltyCents')::bigint, upper(trim(v_row->>'currency')), v_index
    );
  end loop;
  if p_supersedes_import_id is not null then
    update public.retailer_sales_imports set superseded_at = now(), superseded_by = v_import.id where id = p_supersedes_import_id;
  end if;
  insert into public.activity_events(workspace_id, actor_id, event_type, entity_type, entity_id, payload_json)
    values (p_workspace_id, v_uid, 'retailer_sales_imported', 'retailer_sales_import', v_import.id, jsonb_build_object('source', p_source, 'rowCount', v_import.row_count));
  return query select v_import.id, v_import.row_count, false;
end $$;

create function public.retailer_sales_summary(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_summary jsonb;
begin
  if v_uid is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'retailer sales summary requires workspace access' using errcode = '42501';
  end if;
  with import_stats as (
    select count(*)::integer as imports, max(created_at) as latest_imported_at
    from public.retailer_sales_imports where workspace_id = p_workspace_id and superseded_at is null
  ), grouped as (
    select currency, coalesce(sum(units), 0)::bigint as units,
      sum(reported_proceeds_cents)::bigint as reported_proceeds_cents,
      coalesce(sum(royalty_cents), 0)::bigint as royalty_cents
    from public.retailer_sales_rows r join public.retailer_sales_imports i on i.id = r.import_id
    where r.workspace_id = p_workspace_id and i.superseded_at is null group by currency
  ), totals as (
    select coalesce(sum(units), 0)::bigint as units, count(*)::integer as currencies from grouped
  )
  select jsonb_build_object(
    'status', case when import_stats.imports > 0 then 'imported' else 'not_connected' end,
    'imports', import_stats.imports,
    'latestImportedAt', import_stats.latest_imported_at,
    'units', case when import_stats.imports > 0 then totals.units else null end,
    'reportedProceedsCents', case when totals.currencies = 1 then (select reported_proceeds_cents from grouped limit 1) else null end,
    'royaltyCents', case when totals.currencies = 1 then (select royalty_cents from grouped limit 1) else null end,
    'currency', case when totals.currencies = 1 then (select currency from grouped limit 1) else null end,
    'currencies', coalesce((select jsonb_agg(jsonb_build_object(
      'currency', currency, 'units', units, 'reportedProceedsCents', reported_proceeds_cents, 'royaltyCents', royalty_cents
    ) order by currency) from grouped), '[]'::jsonb)
  ) into v_summary from import_stats cross join totals;
  return v_summary;
end $$;

revoke all on function public.import_retailer_sales(uuid,text,text,jsonb,uuid), public.retailer_sales_summary(uuid)
  from public, anon;
grant execute on function public.import_retailer_sales(uuid,text,text,jsonb,uuid), public.retailer_sales_summary(uuid) to authenticated, service_role;
