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
