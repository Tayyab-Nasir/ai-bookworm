-- A paid Book Bible extraction result is saved privately before the AI service
-- replies. A null result is an unresolved dispatch, never permission to call
-- OpenAI again with the same saved job ID.
create table public.book_bible_service_receipts (
  job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb check (result_json is null or
    (jsonb_typeof(result_json) = 'object' and octet_length(result_json::text) <= 6000000)),
  created_at timestamptz not null default now()
);
alter table public.book_bible_service_receipts enable row level security;
revoke all on public.book_bible_service_receipts from public, anon, authenticated;
grant select, insert, update on public.book_bible_service_receipts to service_role;
