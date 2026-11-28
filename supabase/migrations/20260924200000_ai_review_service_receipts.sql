-- A paid review response can be saved before the worker settles its ledger.
-- A null result is an unresolved dispatch reservation, never permission to
-- call the provider again. Service-only access keeps candidate text private.
create table public.ai_review_service_receipts (
  job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb check (result_json is null or
    (jsonb_typeof(result_json) = 'object' and octet_length(result_json::text) <= 6000000)),
  created_at timestamptz not null default now()
);
alter table public.ai_review_service_receipts enable row level security;
revoke all on public.ai_review_service_receipts from public, anon, authenticated;
grant select, insert, update on public.ai_review_service_receipts to service_role;
