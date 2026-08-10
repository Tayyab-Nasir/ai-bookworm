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
