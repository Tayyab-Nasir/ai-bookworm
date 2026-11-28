-- Private durable completion data. Never exposed as author-editable job input.
create table public.image_completion_receipts (
  job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  completion_json jsonb not null check (jsonb_typeof(completion_json) = 'object' and octet_length(completion_json::text) <= 100000),
  created_at timestamptz not null default now()
);
alter table public.image_completion_receipts enable row level security;
revoke all on public.image_completion_receipts from public, anon, authenticated, service_role;
grant select, insert on public.image_completion_receipts to service_role;
