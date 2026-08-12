-- ==== 0001_extensions.sql ====
-- 0001_extensions.sql
create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.member_role as enum ('owner','admin','editor','writer','illustrator','designer','reviewer','viewer');
create type public.book_status as enum ('draft','in_review','approved','published','archived');
create type public.asset_status as enum ('draft','in_review','approved','rejected','archived');
create type public.job_status as enum ('queued','running','succeeded','failed','cancelled');
create type public.approval_status as enum ('pending','approved','rejected','cancelled');
create type public.task_status as enum ('todo','in_progress','blocked','done','cancelled');


-- ==== 0002_core.sql ====
-- 0002_core.sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  locale text not null default 'en-US',
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  owner_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  status text not null default 'active' check (status in ('invited','active','suspended')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug citext not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table public.workspace_members (
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role public.member_role not null default 'viewer',
  status text not null default 'active' check (status in ('invited','active','suspended')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.books (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  subtitle text,
  author_name text not null,
  language text not null default 'en',
  genre text,
  status public.book_status not null default 'draft',
  current_version_id uuid,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.book_versions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  version_number integer not null,
  source_type text not null,
  created_by uuid not null references auth.users(id),
  change_summary text,
  created_at timestamptz not null default now(),
  unique (book_id, version_number)
);

alter table public.books
  add constraint books_current_version_fk
  foreign key (current_version_id) references public.book_versions(id);

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  order_index integer not null,
  title text not null,
  status text not null default 'draft',
  current_document_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, order_index)
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  version_number integer not null,
  content_json jsonb not null,
  plain_text text not null default '',
  word_count integer not null default 0,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (chapter_id, version_number)
);

alter table public.chapters
  add constraint chapters_current_document_version_fk
  foreign key (current_document_version_id) references public.document_versions(id);

create table public.book_metadata (
  book_id uuid primary key references public.books(id) on delete cascade,
  isbn13 text,
  description text,
  keywords jsonb not null default '[]',
  categories jsonb not null default '[]',
  edition text,
  publication_date date,
  contributors jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.style_guides (
  id uuid primary key default gen_random_uuid(),
  book_id uuid unique references public.books(id) on delete cascade,
  rules_json jsonb not null default '{}',
  tone text,
  spelling_variant text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.book_bible_items (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.books(id) on delete cascade,
  type text not null,
  name text not null,
  description text,
  attributes_json jsonb not null default '{}',
  source_refs_json jsonb not null default '[]',
  confidence numeric(5,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


-- ==== 0003_assets_collaboration.sql ====
-- 0003_assets_collaboration.sql
create table public.folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_folder_id uuid references public.folders(id) on delete cascade,
  name text not null,
  folder_type text not null default 'custom',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  type text not null,
  name text not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  checksum text not null,
  status public.asset_status not null default 'draft',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.asset_versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  version_number integer not null,
  storage_path text not null,
  checksum text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (asset_id, version_number)
);

create table public.asset_links (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  usage_role text,
  created_at timestamptz not null default now()
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  author_id uuid not null references auth.users(id),
  body text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.comment_mentions (
  comment_id uuid references public.comments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  primary key (comment_id, user_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text,
  entity_id uuid,
  title text not null,
  description text,
  assignee_id uuid references auth.users(id),
  status public.task_status not null default 'todo',
  priority text not null default 'medium',
  due_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  requested_by uuid not null references auth.users(id),
  reviewer_id uuid references auth.users(id),
  status public.approval_status not null default 'pending',
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activity_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id),
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);


-- ==== 0004_ai.sql ====
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


-- ==== 0005_community.sql ====
-- 0005_community.sql
create table public.communities (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id),
  name text not null,
  slug citext not null unique,
  description text,
  visibility text not null default 'public' check (visibility in ('private','public','unlisted')),
  rules_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.community_members (
  community_id uuid references public.communities(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table public.community_posts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  title text,
  body text not null,
  status text not null default 'published',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code citext not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users(id),
  referred_user_id uuid references auth.users(id),
  code_id uuid not null references public.referral_codes(id),
  status text not null default 'attributed',
  qualified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  workspace_id uuid references public.workspaces(id) on delete set null,
  source text not null,
  amount integer not null,
  balance_after integer not null,
  reference_type text,
  reference_id uuid,
  created_at timestamptz not null default now()
);


-- ==== 0006_billing_publishing.sql ====
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


-- ==== 0007_indexes.sql ====
-- 0007_indexes.sql
create index idx_workspace_members_user on public.workspace_members(user_id);
create index idx_books_workspace on public.books(workspace_id);
create index idx_chapters_book on public.chapters(book_id, order_index);
create index idx_doc_versions_chapter on public.document_versions(chapter_id, version_number desc);
create index idx_assets_workspace on public.assets(workspace_id);
create index idx_assets_folder on public.assets(folder_id);
create index idx_ai_jobs_workspace_status on public.ai_jobs(workspace_id, status);
create index idx_activity_workspace_time on public.activity_events(workspace_id, created_at desc);
create index idx_usage_org_time on public.usage_events(organization_id, created_at desc);
create index idx_publish_jobs_book on public.publishing_jobs(book_id, created_at desc);

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

create or replace function public.workspace_role(p_workspace_id uuid)
returns public.member_role
language sql stable
security definer
set search_path = public
as $$
  select role from public.workspace_members
  where workspace_id = p_workspace_id
    and user_id = auth.uid()
    and status = 'active'
  limit 1;
$$;

create or replace function public.can_edit_workspace(p_workspace_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce(
    public.workspace_role(p_workspace_id) in ('owner','admin','editor','writer','illustrator','designer'),
    false
  );
$$;


-- ==== 0008_rls.sql ====
-- 0008_rls.sql
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.books enable row level security;
alter table public.book_versions enable row level security;
alter table public.chapters enable row level security;
alter table public.document_versions enable row level security;
alter table public.book_metadata enable row level security;
alter table public.style_guides enable row level security;
alter table public.book_bible_items enable row level security;
alter table public.folders enable row level security;
alter table public.assets enable row level security;
alter table public.asset_versions enable row level security;
alter table public.asset_links enable row level security;
alter table public.comments enable row level security;
alter table public.tasks enable row level security;
alter table public.approvals enable row level security;
alter table public.activity_events enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_suggestions enable row level security;
alter table public.ai_runs enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;
alter table public.editions enable row level security;
alter table public.publishing_profiles enable row level security;
alter table public.publishing_jobs enable row level security;
alter table public.publishing_validations enable row level security;
alter table public.audit_logs enable row level security;

create policy profile_self on public.profiles for all
  using (id = auth.uid())
  with check (id = auth.uid());

create policy workspace_select on public.workspaces for select
  using (public.is_workspace_member(id));

create policy workspace_update on public.workspaces for update
  using (public.workspace_role(id) in ('owner','admin'))
  with check (public.workspace_role(id) in ('owner','admin'));

create policy members_select on public.workspace_members for select
  using (public.is_workspace_member(workspace_id));

create policy books_select on public.books for select
  using (public.is_workspace_member(workspace_id));

create policy books_insert on public.books for insert
  with check (public.can_edit_workspace(workspace_id));

create policy books_update on public.books for update
  using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id));

create policy chapters_select on public.chapters for select
  using (exists(
    select 1 from public.books b
    where b.id = book_id and public.is_workspace_member(b.workspace_id)
  ));

create policy chapters_write on public.chapters for all
  using (exists(
    select 1 from public.books b
    where b.id = book_id and public.can_edit_workspace(b.workspace_id)
  ))
  with check (exists(
    select 1 from public.books b
    where b.id = book_id and public.can_edit_workspace(b.workspace_id)
  ));

create policy doc_select on public.document_versions for select
  using (exists(
    select 1 from public.chapters c
    join public.books b on b.id = c.book_id
    where c.id = chapter_id and public.is_workspace_member(b.workspace_id)
  ));

create policy doc_insert on public.document_versions for insert
  with check (exists(
    select 1 from public.chapters c
    join public.books b on b.id = c.book_id
    where c.id = chapter_id and public.can_edit_workspace(b.workspace_id)
  ));

create policy folders_select on public.folders for select
  using (public.is_workspace_member(workspace_id));

create policy folders_write on public.folders for all
  using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id));

create policy assets_select on public.assets for select
  using (public.is_workspace_member(workspace_id));

create policy assets_write on public.assets for all
  using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id));

create policy comments_select on public.comments for select
  using (public.is_workspace_member(workspace_id));

create policy comments_insert on public.comments for insert
  with check (public.is_workspace_member(workspace_id));

create policy tasks_select on public.tasks for select
  using (public.is_workspace_member(workspace_id));

create policy tasks_write on public.tasks for all
  using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id));

create policy ai_job_select on public.ai_jobs for select
  using (public.is_workspace_member(workspace_id));

create policy publishing_job_select on public.publishing_jobs for select
  using (exists(
    select 1 from public.books b
    where b.id = book_id and public.is_workspace_member(b.workspace_id)
  ));

create policy validation_select on public.publishing_validations for select
  using (exists(
    select 1 from public.publishing_jobs p
    join public.books b on b.id = p.book_id
    where p.id = publishing_job_id and public.is_workspace_member(b.workspace_id)
  ));

create policy credits_select on public.credit_ledger for select
  using (user_id = auth.uid());

create policy usage_select on public.usage_events for select
  using (user_id = auth.uid());

create policy referral_self on public.referral_codes for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ==== 0009_storage.sql ====
-- 0009_storage.sql
-- Private bucket
insert into storage.buckets (id, name, public)
values ('book-assets', 'book-assets', false)
on conflict (id) do nothing;

create policy asset_object_read on storage.objects for select
  using (
    bucket_id = 'book-assets'
    and exists (
      select 1 from public.assets a
      where a.storage_path = name
        and public.is_workspace_member(a.workspace_id)
    )
  );

-- Upload/delete are mediated by the API using signed URLs and authorization.
-- Storage path:
-- workspaces/{workspace_id}/assets/{asset_id}/v{version}/{safe_filename}


-- ==== 0010_step9_collab.sql ====
-- 0010_step9_collab.sql — Step 9 gaps: soft delete, workspace-scoped asset list,
-- comment/task/approval updates, activity/mentions RLS.

alter table public.assets add column if not exists deleted_at timestamptz;
-- ponytail: folder/asset type filters + timeline reads use these btree scans;
-- add composite/partial indexes only if workspaces grow past ~100k rows.
create index if not exists assets_workspace_idx on public.assets (workspace_id) where deleted_at is null;
create index if not exists activity_events_workspace_idx on public.activity_events (workspace_id, created_at desc);
create index if not exists comments_entity_idx on public.comments (entity_type, entity_id);

-- comments: resolve/unresolve by any member (reviewers included).
create policy comments_update on public.comments for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- comment_mentions + activity_events: rows are written by the API via the
-- service-role client (bypasses RLS); members only need read.
create policy mentions_select on public.comment_mentions for select
  using (exists(
    select 1 from public.comments c
    where c.id = comment_id and public.is_workspace_member(c.workspace_id)
  ));

create policy activity_select on public.activity_events for select
  using (public.is_workspace_member(workspace_id));

-- workspace_members: invitations (insert) + role changes (update) by owner/admin.
-- API also enforces server-side; RLS is the backstop.
create policy members_insert on public.workspace_members for insert
  with check (public.workspace_role(workspace_id) in ('owner','admin'));
create policy members_update on public.workspace_members for update
  using (public.workspace_role(workspace_id) in ('owner','admin'))
  with check (public.workspace_role(workspace_id) in ('owner','admin'));


-- ==== 0011_stripe_events.sql ====
-- 0011_stripe_events.sql — webhook idempotency + ledger concurrency guard
create table public.stripe_events (
  id text primary key,          -- Stripe event id (evt_...)
  type text not null,
  created_at timestamptz not null default now()
);

-- One ledger entry per (source, reference): makes consumption/ grant retries
-- a unique-violation no-op instead of a double post.
create unique index credit_ledger_reference_uniq
  on public.credit_ledger (source, reference_id)
  where reference_id is not null;

-- credit_ledger is append-only: block updates/deletes at the DB level.
create or replace function public.credit_ledger_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'credit_ledger is append-only';
end;
$$;
create trigger credit_ledger_no_update before update or delete on public.credit_ledger
  for each row execute function public.credit_ledger_immutable();


-- ==== 0012_community_extras.sql ====
-- 0012_community_extras.sql — reactions, reports, referral anti-fraud, RLS

-- Post reactions: one row per (post, user, kind) — toggles are delete/insert.
create table public.community_post_reactions (
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('like','love','insightful','celebrate')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

-- Reports: any authed user can report a post/comment; moderation resolves.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id),
  entity_type text not null check (entity_type in ('post','comment')),
  entity_id uuid not null,
  reason text not null,
  status text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at timestamptz not null default now()
);

-- Removed posts stay in the table (audit) but are hidden from feeds.
alter table public.community_posts
  drop constraint if exists community_posts_status_check;
alter table public.community_posts
  add constraint community_posts_status_check
  check (status in ('published','removed','draft'));

-- Referral anti-fraud: flags set by automatic checks, cleared by review.
alter table public.referrals
  add column if not exists flagged boolean not null default false,
  add column if not exists flag_reason text,
  add column if not exists reviewed_at timestamptz;
alter table public.referrals
  drop constraint if exists referrals_status_check;
alter table public.referrals
  add constraint referrals_status_check
  check (status in ('attributed','qualified','rewarded','held','rejected','reversed'));

-- One referral attribution per referred user.
create unique index if not exists referrals_referred_user_uniq
  on public.referrals (referred_user_id) where referred_user_id is not null;

-- RLS ----------------------------------------------------------------------
alter table public.community_post_reactions enable row level security;
alter table public.reports enable row level security;

create or replace function public.is_community_member(p_community_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.community_members
    where community_id = p_community_id and user_id = auth.uid() and status = 'active');
$$;

create or replace function public.community_visible(p_community_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.communities c
    where c.id = p_community_id
      and (c.visibility = 'public' or public.is_community_member(c.id) or c.owner_user_id = auth.uid()));
$$;

-- Communities: public readable by any authed user; private/unlisted members only.
create policy community_select on public.communities for select
  using (visibility = 'public' or public.is_community_member(id) or owner_user_id = auth.uid());
create policy community_insert on public.communities for insert
  with check (owner_user_id = auth.uid());
create policy community_update on public.communities for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

-- Members: readable when the community is visible; users insert/remove own row.
create policy community_members_select on public.community_members for select
  using (public.community_visible(community_id));
create policy community_members_insert on public.community_members for insert
  with check (user_id = auth.uid());
create policy community_members_delete on public.community_members for delete
  using (user_id = auth.uid());

-- Posts: members/public read (removed hidden from non-moderators is enforced
-- at the API layer); members write their own.
create policy community_posts_select on public.community_posts for select
  using (public.community_visible(community_id));
create policy community_posts_insert on public.community_posts for insert
  with check (author_id = auth.uid() and public.is_community_member(community_id));
create policy community_posts_update on public.community_posts for update
  using (author_id = auth.uid() or exists(select 1 from public.community_members m
    where m.community_id = community_id and m.user_id = auth.uid()
      and m.role in ('owner','moderator') and m.status = 'active'));

-- Comments: same visibility as their post; members write their own.
create policy community_comments_select on public.community_comments for select
  using (exists(select 1 from public.community_posts p
    where p.id = post_id and public.community_visible(p.community_id)));
create policy community_comments_insert on public.community_comments for insert
  with check (author_id = auth.uid() and exists(select 1 from public.community_posts p
    where p.id = post_id and public.is_community_member(p.community_id)));

create policy reactions_select on public.community_post_reactions for select
  using (exists(select 1 from public.community_posts p
    where p.id = post_id and public.community_visible(p.community_id)));
create policy reactions_write on public.community_post_reactions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Reports: reporter sees own; moderators handled via service role at API layer.
create policy reports_insert on public.reports for insert
  with check (reporter_id = auth.uid());
create policy reports_select on public.reports for select
  using (reporter_id = auth.uid());

-- Referrals: referrer and referred user see their own rows.
create policy referrals_select on public.referrals for select
  using (referrer_id = auth.uid() or referred_user_id = auth.uid());


-- ==== 0013_admin_ops.sql ====
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
