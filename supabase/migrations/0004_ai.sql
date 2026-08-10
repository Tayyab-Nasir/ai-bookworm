-- 0004_ai.sql
create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid references public.books(id) on delete cascade,
  agent_type text not null,
  status public.job_status not null default 'queued',
  input_ref jsonb not null default '{}',
  output_ref jsonb,
  model text,
  usage_json jsonb not null default '{}',
  idempotency_key text not null unique,
  error_code text,
  error_message text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table public.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  ai_job_id uuid not null references public.ai_jobs(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  operation_json jsonb not null,
  rationale text,
  confidence numeric(5,4),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','edited','expired')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz
);

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  model text not null,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  estimated_cost numeric(14,6) not null default 0,
  latency_ms integer,
  status text not null,
  created_at timestamptz not null default now()
);
