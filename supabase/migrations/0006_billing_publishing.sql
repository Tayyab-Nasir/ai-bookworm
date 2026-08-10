-- 0006_billing_publishing.sql
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  billing_period text not null,
  price_cents integer not null,
  currency text not null default 'USD',
  entitlements_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  provider_customer_id text,
  provider_subscription_id text unique,
  plan_id uuid references public.plans(id),
  status text not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id),
  workspace_id uuid references public.workspaces(id) on delete set null,
  meter text not null,
  quantity numeric(18,6) not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.editions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  type text not null check (type in ('ebook','print','audiobook')),
  trim_size text,
  language text,
  edition_metadata_json jsonb not null default '{}',
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.publishing_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel text not null,
  credentials_ref text,
  status text not null default 'unconfigured',
  created_at timestamptz not null default now()
);

create table public.publishing_jobs (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  edition_id uuid references public.editions(id),
  channel text not null,
  status public.job_status not null default 'queued',
  request_json jsonb not null default '{}',
  response_json jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table public.publishing_validations (
  id uuid primary key default gen_random_uuid(),
  publishing_job_id uuid not null references public.publishing_jobs(id) on delete cascade,
  rule_version text not null,
  severity text not null check (severity in ('error','warning','info')),
  code text not null,
  message text not null,
  location_json jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);
