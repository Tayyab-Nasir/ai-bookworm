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
