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
