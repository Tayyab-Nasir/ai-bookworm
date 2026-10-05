-- Preserve original PCM identity, transcript and itemized provider usage before
-- encoding or settlement. Unsupported usage is evidence, not permission to bill.
create table public.quoted_narration_receipts (
  job_id uuid primary key references public.ai_jobs(id) on delete restrict,
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_sha256 text not null check(receipt_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_json jsonb not null check(jsonb_typeof(receipt_json)='object' and octet_length(receipt_json::text)<=100000),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.quoted_narration_receipts enable row level security;
revoke all on public.quoted_narration_receipts from public,anon,authenticated,service_role;
grant select on public.quoted_narration_receipts to service_role;
create trigger narration_provider_receipt_immutable before update on public.quoted_narration_receipts
  for each row execute function public.guard_narration_quote_snapshot();

create function public.save_quoted_narration_receipt(p_job_id uuid,p_lease_token uuid,p_request_sha256 text,p_receipt jsonb)
returns public.quoted_narration_receipts language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; saved public.quoted_narration_receipts; field text; size bigint;
begin
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.billing_mode<>'quoted' or j.agent_type<>'narrator' or j.status<>'running'
    or p_lease_token is null or j.lease_token is distinct from p_lease_token
    or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then
    raise exception 'narration receipt lease lost' using errcode='40001'; end if;
  select * into f from public.funded_usage_quotes where job_id=j.id for update;
  if not found or f.status<>'held' or f.dispatched_at is null
    or p_request_sha256 is distinct from j.input_ref->>'requestSha256'
    or p_request_sha256 is distinct from f.quote_json#>>'{scope,inputSha256}' then
    raise exception 'narration receipt requires matching dispatched hold' using errcode='23514'; end if;
  perform bookworm_private.validate_funded_narration_job(j.id,false);
  if jsonb_typeof(p_receipt) is distinct from 'object' or octet_length(p_receipt::text)>100000
    or not(p_receipt ?& array['version','provider','model','requestId','sourceSha256','storagePath','mimeType','sizeBytes',
      'checksum','sampleRateHz','channels','bitDepth','durationSeconds','transcript','rawUsage','latencyMs'])
    or p_receipt-array['version','provider','model','requestId','sourceSha256','storagePath','mimeType','sizeBytes',
      'checksum','sampleRateHz','channels','bitDepth','durationSeconds','transcript','rawUsage','latencyMs']<>'{}'::jsonb then
    raise exception 'invalid narration PCM receipt shape' using errcode='22023'; end if;
  foreach field in array array['version','provider','model','requestId','sourceSha256','storagePath','mimeType','checksum','transcript'] loop
    if jsonb_typeof(p_receipt->field) is distinct from 'string' then
      raise exception 'invalid narration PCM receipt scalar' using errcode='22023'; end if;
  end loop;
  foreach field in array array['sizeBytes','sampleRateHz','channels','bitDepth','durationSeconds','latencyMs'] loop
    if jsonb_typeof(p_receipt->field) is distinct from 'number' then
      raise exception 'invalid narration PCM receipt scalar' using errcode='22023'; end if;
  end loop;
  if p_receipt->>'version' is distinct from 'bookworm-narration-pcm-v1'
    or p_receipt->>'provider' is distinct from 'openai' or p_receipt->>'model' is distinct from j.model
    or p_receipt->>'sourceSha256' is distinct from j.input_ref#>>'{generationRequest,textSha256}'
    or coalesce(length(trim(p_receipt->>'requestId')),0) not between 1 and 256
    or p_receipt->>'requestId' is distinct from trim(p_receipt->>'requestId')
    or p_receipt->>'mimeType' is distinct from 'audio/pcm'
    or p_receipt->>'checksum' !~ '^[a-f0-9]{64}$'
    or p_receipt->>'sizeBytes' !~ '^[1-9][0-9]{0,7}$'
    or p_receipt->'sampleRateHz' is distinct from '24000'::jsonb
    or p_receipt->'channels' is distinct from '1'::jsonb or p_receipt->'bitDepth' is distinct from '16'::jsonb
    or p_receipt->>'latencyMs' !~ '^(0|[1-9][0-9]{0,5})$'
    or (p_receipt->>'latencyMs')::numeric>200000
    or length(p_receipt->>'transcript')>8192 or octet_length(p_receipt->>'transcript')>32768
    or octet_length((p_receipt->'rawUsage')::text)>65536
    or p_receipt->>'storagePath' is distinct from format('private/narration/%s/%s/%s.pcm',j.workspace_id,j.id,f.dispatched_lease) then
    raise exception 'invalid bound narration PCM receipt' using errcode='22023'; end if;
  size:=(p_receipt->>'sizeBytes')::bigint;
  if size not between 2 and 12582912 or size%2<>0
    or abs((p_receipt->>'durationSeconds')::numeric-size::numeric/48000)>0.000001 then
    raise exception 'invalid narration PCM size or duration' using errcode='22023'; end if;
  select * into saved from public.quoted_narration_receipts where job_id=j.id;
  if found then
    if saved.request_sha256 is distinct from p_request_sha256 or saved.receipt_json is distinct from p_receipt then
      raise exception 'narration PCM receipt conflict' using errcode='23505'; end if;
    return saved;
  end if;
  -- A replacement worker can read/replay a saved original receipt. It cannot
  -- invent a new provider result after the original dispatch lease was lost.
  if f.dispatched_lease is distinct from p_lease_token then
    raise exception 'original narration capture lease lost' using errcode='40001'; end if;
  insert into public.quoted_narration_receipts(job_id,request_sha256,receipt_sha256,receipt_json)
    values(j.id,p_request_sha256,encode(public.digest(convert_to(p_receipt::text,'UTF8'),'sha256'),'hex'),p_receipt)
    returning * into saved;
  return saved;
end $$;
revoke all on function public.save_quoted_narration_receipt(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_quoted_narration_receipt(uuid,uuid,text,jsonb) to service_role;

comment on table public.quoted_narration_receipts is
  'PRIVATE original provider evidence only. Metadata validation is not Storage-byte verification, audio fidelity, encoding or measured settlement.';
