-- Author consent for a single frozen retailer package. Operator handling is a separate boundary.
create table public.managed_publishing_requests (
  package_job_id uuid primary key references public.publishing_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  package_sha256 text not null check (package_sha256 ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz not null default now(),
  withdrawn_at timestamptz check (withdrawn_at >= requested_at),
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz check (claimed_at >= requested_at),
  confirmed_at timestamptz check (confirmed_at >= claimed_at),
  listing_url text,
  check (claimed_by is null or claimed_at is not null),
  check ((confirmed_at is null) = (listing_url is null)),
  check (confirmed_at is null or (claimed_at is not null and withdrawn_at is null))
);

alter table public.managed_publishing_requests enable row level security;
revoke all on table public.managed_publishing_requests from public, anon, authenticated, service_role;
grant select on table public.managed_publishing_requests to authenticated;
create policy managed_publishing_requests_select on public.managed_publishing_requests
  for select to authenticated using (
    private.workspace_role(workspace_id) in ('owner', 'admin') and exists (
      select 1 from public.publishing_jobs job join public.books book on book.id = job.book_id
      where job.id = managed_publishing_requests.package_job_id
        and book.workspace_id = managed_publishing_requests.workspace_id
    )
  );

create function private.request_managed_publishing_internal(p_job_id uuid, p_sha256 text, p_withdraw boolean)
returns public.managed_publishing_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_workspace uuid;
  v_request public.managed_publishing_requests;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid package checksum' using errcode = '22023';
  end if;

  select book.workspace_id into v_workspace
  from public.publishing_jobs job
  join public.books book on book.id = job.book_id
  join public.editions edition on edition.id = job.edition_id and edition.book_id = book.id
  join public.workspace_members member
    on member.workspace_id = book.workspace_id and member.user_id = v_actor
    and member.status = 'active' and member.role in ('owner', 'admin')
  where job.id = p_job_id and job.status = 'succeeded'
    and job.channel in ('kdp', 'apple', 'barnesnoble', 'lulu', 'googleplay')
    and job.request_json ->> 'action' = 'export_package'
  for share of job, book, edition, member;
  if not found then
    raise exception 'Completed retailer package not found' using errcode = 'PT404';
  end if;

  if p_withdraw then
    update public.managed_publishing_requests
      set withdrawn_at = coalesce(withdrawn_at, greatest(clock_timestamp(), requested_at))
      where package_job_id = p_job_id and workspace_id = v_workspace and package_sha256 = p_sha256
        and confirmed_at is null
      returning * into v_request;
    if not found then
      raise exception 'Matching managed publishing request not found' using errcode = 'PT409';
    end if;
    return v_request;
  end if;

  select * into v_request from public.managed_publishing_requests where package_job_id = p_job_id;
  if found then
    if v_request.workspace_id <> v_workspace or v_request.requested_by is distinct from v_actor
      or v_request.package_sha256 <> p_sha256 then
      raise exception 'Package already has a managed publishing request' using errcode = 'PT409';
    end if;
    return v_request;
  end if;

  perform 1
  from public.publishing_jobs job
  join public.assets asset on asset.id::text = job.response_json #>> '{artifact,assetId}'
  join public.asset_versions version on version.asset_id = asset.id and version.version_number = 1
  where job.id = p_job_id and asset.workspace_id = v_workspace
    and asset.type = 'publishing_package' and asset.deleted_at is null
    and asset.status in ('draft', 'in_review', 'approved')
    and version.scan_status in ('clean', 'trusted_generated')
    and asset.mime_type = 'application/zip' and version.mime_type = asset.mime_type
    and asset.size_bytes > 0 and version.size_bytes = asset.size_bytes
    and asset.storage_path = format('workspaces/%s/assets/%s/v1/%s-export.zip', v_workspace, asset.id, job.channel)
    and asset.storage_path = version.storage_path and asset.storage_path = job.response_json #>> '{artifact,storagePath}'
    and asset.checksum = p_sha256 and version.checksum = p_sha256
    and p_sha256 = job.response_json #>> '{artifact,checksum}'
  for share of asset, version;
  if not found then
    raise exception 'Package no longer matches the reviewed file' using errcode = 'PT409';
  end if;

  insert into public.managed_publishing_requests (package_job_id, workspace_id, requested_by, package_sha256)
    values (p_job_id, v_workspace, v_actor, p_sha256) on conflict (package_job_id) do nothing;
  select * into strict v_request from public.managed_publishing_requests where package_job_id = p_job_id;
  if v_request.workspace_id <> v_workspace or v_request.requested_by is distinct from v_actor
    or v_request.package_sha256 <> p_sha256 then
    raise exception 'Package already has a managed publishing request' using errcode = 'PT409';
  end if;
  return v_request;
end;
$$;

create function public.request_managed_publishing(p_job_id uuid, p_sha256 text)
returns public.managed_publishing_requests
language sql security invoker set search_path = '' as $$
  select private.request_managed_publishing_internal(p_job_id, p_sha256, false);
$$;

create function public.withdraw_managed_publishing(p_job_id uuid, p_sha256 text)
returns public.managed_publishing_requests
language sql security invoker set search_path = '' as $$
  select private.request_managed_publishing_internal(p_job_id, p_sha256, true);
$$;

revoke all on function private.request_managed_publishing_internal(uuid,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.request_managed_publishing(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.withdraw_managed_publishing(uuid,text) from public, anon, authenticated, service_role;
grant execute on function private.request_managed_publishing_internal(uuid,text,boolean) to authenticated;
grant execute on function public.request_managed_publishing(uuid,text) to authenticated;
grant execute on function public.withdraw_managed_publishing(uuid,text) to authenticated;

-- Called only by a server that verifies and authorizes the individual operator.
-- Claim and withdrawal contend on the same row.
create function public.claim_managed_publishing(p_job_id uuid, p_sha256 text, p_operator uuid)
returns public.managed_publishing_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.managed_publishing_requests;
  v_workspace uuid;
begin
  if auth.role() is distinct from 'service_role' or p_operator is null then
    raise exception 'Publishing operator authority required' using errcode = '42501';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid package checksum' using errcode = '22023';
  end if;

  select book.workspace_id into v_workspace
  from public.publishing_jobs job
  join public.books book on book.id = job.book_id
  join public.editions edition on edition.id = job.edition_id and edition.book_id = book.id
  where job.id = p_job_id and job.status = 'succeeded' and job.request_json ->> 'action' = 'export_package'
  for share of job, book, edition;

  update public.managed_publishing_requests request
    set claimed_by = p_operator,
        claimed_at = case when request.claimed_by = p_operator then request.claimed_at
          else greatest(clock_timestamp(), request.requested_at) end
    where request.package_job_id = p_job_id and request.package_sha256 = p_sha256
      and request.withdrawn_at is null and (request.claimed_by is null or request.claimed_by = p_operator)
      and request.confirmed_at is null
      and request.workspace_id = v_workspace
    returning * into v_request;
  if not found then
    raise exception 'The active request could not be assigned' using errcode = 'PT409';
  end if;
  return v_request;
end;
$$;

revoke all on function public.claim_managed_publishing(uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_managed_publishing(uuid,text,uuid) to service_role;

create function public.list_managed_publishing_queue(p_operator uuid, p_limit integer, p_offset integer)
returns table (package_job_id uuid, channel text, title text, package_sha256 text, requested_at timestamptz, claimed_at timestamptz,
  confirmed_at timestamptz, listing_url text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' or p_operator is null then
    raise exception 'Publishing operator authority required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 51 or p_offset is null or p_offset not between 0 and 10000 then
    raise exception 'Invalid queue page' using errcode = '22023';
  end if;
  return query
    select request.package_job_id, job.channel, book.title, request.package_sha256, request.requested_at, request.claimed_at,
      request.confirmed_at, request.listing_url
    from public.managed_publishing_requests request
    join public.publishing_jobs job on job.id = request.package_job_id
    join public.books book on book.id = job.book_id and book.workspace_id = request.workspace_id
    join public.editions edition on edition.id = job.edition_id and edition.book_id = book.id
    where request.withdrawn_at is null and (request.claimed_by = p_operator
      or (request.claimed_by is null and request.confirmed_at is null))
      and job.status = 'succeeded' and job.request_json ->> 'action' = 'export_package'
    order by request.requested_at, request.package_job_id
    limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_managed_publishing_queue(uuid,integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.list_managed_publishing_queue(uuid,integer,integer) to service_role;

create function public.read_managed_publishing_package(p_job_id uuid, p_operator uuid)
returns table (storage_path text, filename text, package_sha256 text, size_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' or p_operator is null then
    raise exception 'Publishing operator authority required' using errcode = '42501';
  end if;
  return query
    select asset.storage_path, job.channel || '-export.zip', request.package_sha256, asset.size_bytes
    from public.managed_publishing_requests request
    join public.publishing_jobs job on job.id = request.package_job_id
    join public.books book on book.id = job.book_id and book.workspace_id = request.workspace_id
    join public.editions edition on edition.id = job.edition_id and edition.book_id = book.id
    join public.assets asset on asset.id::text = job.response_json #>> '{artifact,assetId}'
    join public.asset_versions version on version.asset_id = asset.id and version.version_number = 1
    where request.package_job_id = p_job_id and request.claimed_by = p_operator and request.withdrawn_at is null
      and request.confirmed_at is null
      and job.status = 'succeeded' and job.channel in ('kdp', 'apple', 'barnesnoble', 'lulu', 'googleplay')
      and job.request_json ->> 'action' = 'export_package'
      and asset.workspace_id = request.workspace_id and asset.type = 'publishing_package' and asset.deleted_at is null
      and asset.status in ('draft', 'in_review', 'approved') and version.scan_status in ('clean', 'trusted_generated')
      and asset.mime_type = 'application/zip' and version.mime_type = asset.mime_type
      and asset.size_bytes between 1 and 209715200 and version.size_bytes = asset.size_bytes
      and asset.storage_path = format('workspaces/%s/assets/%s/v1/%s-export.zip', request.workspace_id, asset.id, job.channel)
      and asset.storage_path = version.storage_path and asset.storage_path = job.response_json #>> '{artifact,storagePath}'
      and asset.checksum = request.package_sha256 and version.checksum = request.package_sha256
      and request.package_sha256 = job.response_json #>> '{artifact,checksum}';
end;
$$;

revoke all on function public.read_managed_publishing_package(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_managed_publishing_package(uuid,uuid) to service_role;

create function public.confirm_managed_publishing(p_job_id uuid, p_sha256 text, p_operator uuid, p_listing_url text)
returns public.managed_publishing_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_workspace uuid;
  v_channel text;
  v_host text;
  v_request public.managed_publishing_requests;
begin
  if auth.role() is distinct from 'service_role' or p_operator is null then
    raise exception 'Publishing operator authority required' using errcode = '42501';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid package checksum' using errcode = '22023';
  end if;
  select book.workspace_id, job.channel into v_workspace, v_channel
  from public.publishing_jobs job
  join public.books book on book.id = job.book_id
  join public.editions edition on edition.id = job.edition_id and edition.book_id = book.id
  where job.id = p_job_id and job.status = 'succeeded' and job.request_json ->> 'action' = 'export_package'
  for share of job, book, edition;
  if not found then
    raise exception 'Completed retailer package not found' using errcode = 'PT404';
  end if;

  -- Store a clean public listing reference. Neither the database nor the API
  -- fetches it; the operator verifies the listing in the retailer account.
  v_host := substring(p_listing_url from '^https://([a-z0-9.]+)/[A-Za-z0-9/_~.%+-]+$');
  if v_channel = 'googleplay' and p_listing_url ~ '^https://play\.google\.com/store/books/details(/[A-Za-z0-9_~.%+-]+)?\?id=[A-Za-z0-9_-]+$' then
    v_host := 'play.google.com';
  end if;
  if p_listing_url is null or length(p_listing_url) > 1024 or v_host is null or not (
    case v_channel
      when 'kdp' then v_host in ('www.amazon.com', 'www.amazon.co.uk', 'www.amazon.ca', 'www.amazon.com.au',
        'www.amazon.de', 'www.amazon.fr', 'www.amazon.it', 'www.amazon.es', 'www.amazon.co.jp',
        'www.amazon.com.br', 'www.amazon.com.mx', 'www.amazon.nl', 'www.amazon.in', 'www.amazon.pl', 'www.amazon.se')
        and p_listing_url ~ '/(dp|gp/product)/[A-Z0-9]{10}/?$'
      when 'apple' then v_host = 'books.apple.com' and p_listing_url ~ '^https://books\.apple\.com/([a-z]{2}/)?book/([A-Za-z0-9_~.%+-]+/)?id[0-9]+/?$'
      when 'barnesnoble' then v_host = 'www.barnesandnoble.com' and p_listing_url like 'https://www.barnesandnoble.com/w/%'
      when 'lulu' then v_host = 'www.lulu.com' and p_listing_url like 'https://www.lulu.com/shop/%'
      when 'googleplay' then v_host = 'play.google.com'
        and p_listing_url ~ '^https://play\.google\.com/store/books/details(/[A-Za-z0-9_~.%+-]+)?\?id=[A-Za-z0-9_-]+$'
      else false
    end
  ) then
    raise exception 'Enter a public HTTPS listing URL for this retailer' using errcode = '22023';
  end if;

  select * into v_request
  from public.managed_publishing_requests request
  where request.package_job_id = p_job_id and request.workspace_id = v_workspace
    and request.package_sha256 = p_sha256 and request.claimed_by = p_operator and request.withdrawn_at is null
  for update;
  if not found or (v_request.confirmed_at is not null and v_request.listing_url is distinct from p_listing_url) then
    raise exception 'The active assignment could not be confirmed' using errcode = 'PT409';
  end if;
  if v_request.confirmed_at is null then
    update public.managed_publishing_requests
      set confirmed_at = greatest(clock_timestamp(), v_request.claimed_at), listing_url = p_listing_url
      where package_job_id = p_job_id returning * into v_request;
  end if;
  return v_request;
end;
$$;

revoke all on function public.confirm_managed_publishing(uuid,text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.confirm_managed_publishing(uuid,text,uuid,text) to service_role;
