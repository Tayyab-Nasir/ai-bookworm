-- An uploaded generated image and its provider usage receipt survive worker
-- restarts independently of final billing/asset publication.
create table public.quoted_image_receipts (
 job_id uuid primary key references public.ai_jobs(id) on delete restrict,
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_json jsonb not null check(jsonb_typeof(receipt_json)='object' and octet_length(receipt_json::text)<=100000),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.quoted_image_receipts enable row level security;
revoke all on public.quoted_image_receipts from public,anon,authenticated,service_role;
grant select on public.quoted_image_receipts to service_role;
create function public.save_quoted_image_receipt(p_job_id uuid,p_lease_token uuid,p_request_sha256 text,p_receipt jsonb)
returns public.quoted_image_receipts language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; saved public.quoted_image_receipts;
begin
 select * into j from public.ai_jobs where id=p_job_id for update;
 if not found or j.billing_mode<>'quoted' or j.agent_type not in ('illustrator','cover_designer')
  or j.status<>'running' or j.lease_token is distinct from p_lease_token
  or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then
  raise exception 'image receipt lease lost' using errcode='40001'; end if;
 select * into q from public.funded_usage_quotes where job_id=j.id for update;
 if not found or q.status<>'held' or q.dispatched_at is null
  or p_request_sha256 is distinct from j.input_ref->>'requestSha256'
  or p_request_sha256 is distinct from q.quote_json#>>'{scope,inputSha256}' then
  raise exception 'image receipt requires matching dispatched hold' using errcode='23514'; end if;
 if jsonb_typeof(p_receipt) is distinct from 'object' or octet_length(p_receipt::text)>100000
  or coalesce(p_receipt->>'assetId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  or coalesce(length(trim(p_receipt->>'name')),0) not between 1 and 256
  or p_receipt->>'provider' is distinct from 'openai' or p_receipt->>'model' is distinct from j.model
  or coalesce(length(trim(p_receipt->>'requestId')),0) not between 1 and 256
  or p_receipt->>'mimeType' is distinct from 'image/png'
  or coalesce(p_receipt->>'checksum','') !~ '^[a-f0-9]{64}$'
  or coalesce(p_receipt->>'sizeBytes','') !~ '^[1-9][0-9]{0,7}$'
  or (p_receipt->>'sizeBytes')::bigint>26214400
  or jsonb_typeof(p_receipt->'usage') is distinct from 'object'
  or p_receipt->>'storagePath' is distinct from format('workspaces/%s/assets/%s/v1/generated.png',j.workspace_id,p_receipt->>'assetId')
  or exists(select 1 from jsonb_object_keys(p_receipt) k where k not in
    ('assetId','name','provider','model','requestId','mimeType','checksum','sizeBytes','storagePath','usage')) then
  raise exception 'invalid image receipt' using errcode='22023'; end if;
 select * into saved from public.quoted_image_receipts where job_id=j.id;
 if found then
  if saved.request_sha256 is distinct from p_request_sha256 or saved.receipt_json is distinct from p_receipt then
   raise exception 'image receipt conflict' using errcode='23505'; end if;
  return saved;
 end if;
 insert into public.quoted_image_receipts(job_id,request_sha256,receipt_json)
  values(j.id,p_request_sha256,p_receipt) returning * into saved;
 return saved;
end $$;
revoke all on function public.save_quoted_image_receipt(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_quoted_image_receipt(uuid,uuid,text,jsonb) to service_role;
