-- Private result receipts survive AI-service restarts. A null result reserves
-- the job before provider execution; it must never be expired by age alone.
create table public.metadata_service_receipts (
  job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb check (result_json is null or
    (jsonb_typeof(result_json) = 'object' and octet_length(result_json::text) <= 2000000)),
  created_at timestamptz not null default now()
);
alter table public.metadata_service_receipts enable row level security;
revoke all on public.metadata_service_receipts from public, anon, authenticated;
grant select, insert, update on public.metadata_service_receipts to service_role;
