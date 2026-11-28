-- Private, immutable image offers. This does not accept, fund or dispatch jobs.
create table public.image_quote_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid references public.books(id) on delete cascade,
  generation_job_id uuid not null unique,
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
  request_json jsonb not null check(jsonb_typeof(request_json)='object' and octet_length(request_json::text)<=524288),
  catalog_version text not null check(length(catalog_version) between 1 and 128),
  model_option_id text not null check(length(model_option_id) between 1 and 128),
  quote_json jsonb not null check(jsonb_typeof(quote_json)='object' and octet_length(quote_json::text)<=65536),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,idempotency_key),
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour'),
  check((request_json->>'jobId') is not distinct from generation_job_id::text
    and (request_json->>'workspaceId') is not distinct from workspace_id::text
    and (request_json->>'userId') is not distinct from user_id::text
    and (request_json->>'bookId') is not distinct from book_id::text),
  check((quote_json#>>'{scope,jobId}') is not distinct from generation_job_id::text
    and (quote_json#>>'{scope,workspaceId}') is not distinct from workspace_id::text
    and (quote_json#>>'{scope,userId}') is not distinct from user_id::text
    and (quote_json#>>'{scope,inputSha256}') is not distinct from request_sha256),
  check((quote_json#>>'{price,model}') is not distinct from request_json->>'model'
    and (quote_json#>>'{price,provider}') is not distinct from 'openai'
    and (quote_json#>'{policy,approved}') is not distinct from 'true'::jsonb)
);
create index image_quote_snapshot_history on public.image_quote_snapshots(user_id,workspace_id,created_at desc);
alter table public.image_quote_snapshots enable row level security;
revoke all on public.image_quote_snapshots from public,anon,authenticated,service_role;
grant select on public.image_quote_snapshots to service_role;

create function public.guard_image_quote_snapshot() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'image quote snapshots are immutable' using errcode='23514'; end $$;
create trigger image_quote_snapshot_immutable before update on public.image_quote_snapshots
  for each row execute function public.guard_image_quote_snapshot();
revoke all on function public.guard_image_quote_snapshot() from public,anon,authenticated,service_role;

create function public.save_image_quote_snapshot(
  p_user_id uuid,p_workspace_id uuid,p_book_id uuid,p_job_id uuid,p_idempotency_key text,
  p_request_sha256 text,p_request jsonb,p_catalog_version text,p_model_option_id text,p_quote jsonb
) returns public.image_quote_snapshots language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text; v_row public.image_quote_snapshots; v_expiry timestamptz;
begin
  select role::text into v_role from public.workspace_members
    where workspace_id=p_workspace_id and user_id=p_user_id and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'image quote requires writing access' using errcode='42501'; end if;
  if p_book_id is not null and not exists(select 1 from public.books
    where id=p_book_id and workspace_id=p_workspace_id) then
    raise exception 'image quote book scope mismatch' using errcode='42501'; end if;
  -- Serialize a retry key; idempotency never relies on a pre-insert read alone.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_idempotency_key,0));
  select * into v_row from public.image_quote_snapshots where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if found then
    if v_row.workspace_id is distinct from p_workspace_id or v_row.book_id is distinct from p_book_id
      or v_row.request_json is distinct from p_request or v_row.request_sha256 is distinct from p_request_sha256
      or v_row.model_option_id is distinct from p_model_option_id then
      raise exception 'image quote retry key belongs to another request' using errcode='23505'; end if;
    return v_row;
  end if;
  v_expiry:=(p_quote->>'expiresAt')::timestamptz;
  if v_expiry is null or v_expiry<=clock_timestamp() or v_expiry>clock_timestamp()+interval '1 hour'
    or coalesce(p_quote->>'reservedCredits','') !~ '^[1-9][0-9]{0,9}$'
    or (p_quote->>'reservedCredits')::numeric>2147483647
    or coalesce(p_quote->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_quote#>>'{price,model}','')='' then
    raise exception 'invalid image quote offer' using errcode='22023'; end if;
  insert into public.image_quote_snapshots(user_id,workspace_id,book_id,generation_job_id,idempotency_key,
    request_sha256,request_json,catalog_version,model_option_id,quote_json,expires_at)
    values(p_user_id,p_workspace_id,p_book_id,p_job_id,p_idempotency_key,p_request_sha256,p_request,
      p_catalog_version,p_model_option_id,p_quote,v_expiry) returning * into v_row;
  return v_row;
end $$;
revoke all on function public.save_image_quote_snapshot(uuid,uuid,uuid,uuid,text,text,jsonb,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_image_quote_snapshot(uuid,uuid,uuid,uuid,text,text,jsonb,text,text,jsonb) to service_role;
