-- 0013_admin_ops.sql — Step 14: admin console + operations
-- feature_flags + support_tickets per PRD-SOW section 8 Security/Ops.
-- Admin-only data: RLS enabled with NO user policies => service role only.
create table if not exists public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  scope_type text not null default 'global',
  scope_id text,
  enabled boolean not null default false,
  config_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- scope_id nullable: unique treats nulls as distinct, coalesce backstop
create unique index if not exists uq_feature_flags_scope
  on public.feature_flags(key, scope_type, coalesce(scope_id, ''));

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  category text not null default 'general',
  status text not null default 'open' check (status in ('open','pending','resolved','closed')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  subject text not null default '',
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dead-letter record: workers land failed-after-max-attempts jobs here.
create table if not exists public.dead_letter_jobs (
  id uuid primary key default gen_random_uuid(),
  queue text not null,
  job_type text not null,
  job_id uuid,
  payload_json jsonb not null default '{}', -- never manuscript text; refs only
  attempts int not null default 0,
  error text,
  failed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.feature_flags enable row level security;
alter table public.support_tickets enable row level security;
alter table public.dead_letter_jobs enable row level security;
-- No policies: service role bypasses RLS, all other roles denied.

-- Job retry bookkeeping + admin list scans
alter table public.ai_jobs add column if not exists attempts int not null default 0;
alter table public.publishing_jobs add column if not exists attempts int not null default 0;
create index if not exists idx_audit_logs_org_time on public.audit_logs(organization_id, created_at desc);
create index if not exists idx_audit_logs_created on public.audit_logs(created_at desc);
create index if not exists idx_support_tickets_status on public.support_tickets(status, created_at desc);
create index if not exists idx_org_members_user on public.organization_members(user_id);
