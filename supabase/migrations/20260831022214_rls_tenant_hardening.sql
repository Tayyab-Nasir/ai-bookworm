-- 0014: tenant/RLS hardening
--
-- This migration is intentionally additive. The earlier migrations are already
-- deployable history, so their incomplete policies are replaced here rather
-- than edited in place. It also moves SECURITY DEFINER policy helpers out of
-- the exposed public schema and makes client grants explicit.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- RLS helpers must not be exposed through the Data API. They pin search_path,
-- return information about the caller only, and are callable only by the
-- authenticated database role from RLS policies.
create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = p_workspace_id
        and wm.user_id = (select auth.uid())
        and wm.status = 'active'
    );
$$;

create or replace function private.workspace_role(p_workspace_id uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = (select auth.uid())
    and wm.status = 'active'
  limit 1;
$$;

create or replace function private.can_edit_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.workspace_role(p_workspace_id)
      in ('owner', 'admin', 'editor', 'writer', 'illustrator', 'designer'),
    false
  );
$$;

create or replace function private.can_approve_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.workspace_role(p_workspace_id)
      in ('owner', 'admin', 'editor', 'writer', 'illustrator', 'designer', 'reviewer'),
    false
  );
$$;

create or replace function private.is_active_workspace_user(
  p_workspace_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
      and wm.status = 'active'
  );
$$;

create or replace function private.folder_belongs_to_workspace(
  p_folder_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.folders f
    where f.id = p_folder_id and f.workspace_id = p_workspace_id
  );
$$;

create or replace function private.shares_active_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_members mine
      join public.workspace_members theirs
        on theirs.workspace_id = mine.workspace_id
      where mine.user_id = (select auth.uid())
        and mine.status = 'active'
        and theirs.user_id = p_user_id
        and theirs.status = 'active'
    );
$$;

create or replace function private.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.organization_members om
      where om.organization_id = p_organization_id
        and om.user_id = (select auth.uid())
        and om.status = 'active'
    );
$$;

create or replace function private.can_manage_organization(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      exists (
        select 1
        from public.organizations o
        where o.id = p_organization_id
          and o.owner_user_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.organization_members om
        where om.organization_id = p_organization_id
          and om.user_id = (select auth.uid())
          and om.status = 'active'
          and om.role in ('owner', 'admin')
      )
    );
$$;

create or replace function private.is_community_member(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.community_members cm
      where cm.community_id = p_community_id
        and cm.user_id = (select auth.uid())
        and cm.status = 'active'
    );
$$;

create or replace function private.community_is_visible(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.communities c
    where c.id = p_community_id
      and (
        c.visibility = 'public'
        or c.owner_user_id = (select auth.uid())
        or private.is_community_member(c.id)
      )
  );
$$;

create or replace function private.can_moderate_community(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.communities c
      left join public.community_members cm
        on cm.community_id = c.id
       and cm.user_id = (select auth.uid())
       and cm.status = 'active'
      where c.id = p_community_id
        and (c.owner_user_id = (select auth.uid()) or cm.role in ('owner', 'moderator'))
    );
$$;

revoke all on function private.is_workspace_member(uuid) from public;
revoke all on function private.workspace_role(uuid) from public;
revoke all on function private.can_edit_workspace(uuid) from public;
revoke all on function private.can_approve_workspace(uuid) from public;
revoke all on function private.is_active_workspace_user(uuid, uuid) from public;
revoke all on function private.folder_belongs_to_workspace(uuid, uuid) from public;
revoke all on function private.shares_active_workspace_with(uuid) from public;
revoke all on function private.is_organization_member(uuid) from public;
revoke all on function private.can_manage_organization(uuid) from public;
revoke all on function private.is_community_member(uuid) from public;
revoke all on function private.community_is_visible(uuid) from public;
revoke all on function private.can_moderate_community(uuid) from public;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.workspace_role(uuid) to authenticated;
grant execute on function private.can_edit_workspace(uuid) to authenticated;
grant execute on function private.can_approve_workspace(uuid) to authenticated;
grant execute on function private.is_active_workspace_user(uuid, uuid) to authenticated;
grant execute on function private.folder_belongs_to_workspace(uuid, uuid) to authenticated;
grant execute on function private.shares_active_workspace_with(uuid) to authenticated;
grant execute on function private.is_organization_member(uuid) to authenticated;
grant execute on function private.can_manage_organization(uuid) to authenticated;
grant execute on function private.is_community_member(uuid) to authenticated;
grant execute on function private.community_is_visible(uuid) to authenticated;
grant execute on function private.can_moderate_community(uuid) to authenticated;

create or replace function private.preserve_comment_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.author_id is distinct from old.author_id
     or new.entity_type is distinct from old.entity_type
     or new.entity_id is distinct from old.entity_id
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '42501',
      message = 'comment identity fields are immutable';
  end if;

  -- Any workspace member may resolve/reopen a comment. Only its author may
  -- alter the comment body; the API has already checked workspace membership.
  if new.body is distinct from old.body
     and old.author_id is distinct from (select auth.uid()) then
    raise exception using
      errcode = '42501',
      message = 'only the comment author may edit its body';
  end if;
  return new;
end;
$$;

create or replace function private.preserve_created_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception using
      errcode = '42501',
      message = 'creator attribution is immutable';
  end if;
  return new;
end;
$$;

create or replace function private.finalize_asset_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.asset_id is distinct from old.asset_id
     or new.version_number is distinct from old.version_number
     or new.storage_path is distinct from old.storage_path
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '42501',
      message = 'asset version identity is immutable';
  end if;

  if old.checksum <> 'pending'
     or new.checksum !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '42501',
      message = 'an asset version may only be finalized once with a SHA-256 checksum';
  end if;
  return new;
end;
$$;

create or replace function private.preserve_organization_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception using
      errcode = '42501',
      message = 'organization ownership changes are server-mediated';
  end if;
  return new;
end;
$$;

create or replace function private.preserve_community_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception using
      errcode = '42501',
      message = 'community ownership changes are server-mediated';
  end if;
  return new;
end;
$$;

create or replace function private.preserve_community_post_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.author_id is distinct from old.author_id then
    raise exception using
      errcode = '42501',
      message = 'community post author is immutable';
  end if;
  return new;
end;
$$;

-- RLS checks both old/new membership, but membership in two workspaces must
-- not allow moving a row and all its children into another tenant/book.
create or replace function private.preserve_parent_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if to_jsonb(new)->tg_argv[0] is distinct from to_jsonb(old)->tg_argv[0] then
    raise exception using errcode = '42501', message = 'parent reference is immutable';
  end if;
  return new;
end;
$$;

create or replace function private.asset_path_matches(p_path text, p_workspace_id uuid, p_asset_id uuid)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(
    p_path ~ '^workspaces/[0-9a-f-]{36}/assets/[0-9a-f-]{36}/v[1-9][0-9]*/[A-Za-z0-9_.-]+$'
    and split_part(p_path, '/', 2) = p_workspace_id::text
    and split_part(p_path, '/', 4) = p_asset_id::text,
    false
  );
$$;
revoke all on function private.asset_path_matches(text, uuid, uuid) from public;
grant execute on function private.asset_path_matches(text, uuid, uuid) to authenticated;
revoke all on function private.preserve_parent_reference() from public;

create trigger workspaces_preserve_parent before update on public.workspaces
  for each row execute function private.preserve_parent_reference('organization_id');
create trigger books_preserve_parent before update on public.books
  for each row execute function private.preserve_parent_reference('workspace_id');
create trigger chapters_preserve_parent before update on public.chapters
  for each row execute function private.preserve_parent_reference('book_id');
create trigger metadata_preserve_parent before update on public.book_metadata
  for each row execute function private.preserve_parent_reference('book_id');
create trigger bible_preserve_parent before update on public.book_bible_items
  for each row execute function private.preserve_parent_reference('book_id');
create trigger style_guides_preserve_parent before update on public.style_guides
  for each row execute function private.preserve_parent_reference('book_id');
create trigger folders_preserve_parent before update on public.folders
  for each row execute function private.preserve_parent_reference('workspace_id');
create trigger assets_preserve_parent before update on public.assets
  for each row execute function private.preserve_parent_reference('workspace_id');
create trigger tasks_preserve_parent before update on public.tasks
  for each row execute function private.preserve_parent_reference('workspace_id');
create trigger approvals_preserve_parent before update on public.approvals
  for each row execute function private.preserve_parent_reference('workspace_id');
create trigger approvals_preserve_requester before update on public.approvals
  for each row execute function private.preserve_parent_reference('requested_by');
create trigger approvals_preserve_entity_id before update on public.approvals
  for each row execute function private.preserve_parent_reference('entity_id');
create trigger approvals_preserve_entity_type before update on public.approvals
  for each row execute function private.preserve_parent_reference('entity_type');
create trigger editions_preserve_parent before update on public.editions
  for each row execute function private.preserve_parent_reference('book_id');
create trigger community_posts_preserve_parent before update on public.community_posts
  for each row execute function private.preserve_parent_reference('community_id');

revoke all on function private.preserve_comment_identity() from public;
revoke all on function private.preserve_created_by() from public;
revoke all on function private.finalize_asset_version() from public;
revoke all on function private.preserve_organization_owner() from public;
revoke all on function private.preserve_community_owner() from public;
revoke all on function private.preserve_community_post_author() from public;

drop trigger if exists comments_preserve_identity on public.comments;
create trigger comments_preserve_identity
  before update on public.comments
  for each row execute function private.preserve_comment_identity();

drop trigger if exists workspaces_preserve_creator on public.workspaces;
create trigger workspaces_preserve_creator
  before update on public.workspaces
  for each row execute function private.preserve_created_by();

drop trigger if exists books_preserve_creator on public.books;
create trigger books_preserve_creator
  before update on public.books
  for each row execute function private.preserve_created_by();

drop trigger if exists folders_preserve_creator on public.folders;
create trigger folders_preserve_creator
  before update on public.folders
  for each row execute function private.preserve_created_by();

drop trigger if exists assets_preserve_creator on public.assets;
create trigger assets_preserve_creator
  before update on public.assets
  for each row execute function private.preserve_created_by();

drop trigger if exists asset_versions_finalize_once on public.asset_versions;
create trigger asset_versions_finalize_once
  before update on public.asset_versions
  for each row execute function private.finalize_asset_version();

drop trigger if exists tasks_preserve_creator on public.tasks;
create trigger tasks_preserve_creator
  before update on public.tasks
  for each row execute function private.preserve_created_by();

drop trigger if exists organizations_preserve_owner on public.organizations;
create trigger organizations_preserve_owner
  before update on public.organizations
  for each row execute function private.preserve_organization_owner();

drop trigger if exists communities_preserve_owner on public.communities;
create trigger communities_preserve_owner
  before update on public.communities
  for each row execute function private.preserve_community_owner();

drop trigger if exists community_posts_preserve_author on public.community_posts;
create trigger community_posts_preserve_author
  before update on public.community_posts
  for each row execute function private.preserve_community_post_author();

-- Tables introduced before the original RLS pass were inadvertently left
-- exposed. The rest already have RLS enabled by 0008/0012/0013.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.comment_mentions enable row level security;
alter table public.stripe_events enable row level security;

-- A book/chapter may only point at a version that belongs to itself. The
-- original single-column foreign keys verified existence but allowed an
-- accidental cross-book version pointer.
alter table public.book_versions
  add constraint book_versions_book_id_id_key unique (book_id, id);
alter table public.books
  add constraint books_current_version_same_book_fk
  foreign key (id, current_version_id)
  references public.book_versions (book_id, id)
  deferrable initially deferred;

alter table public.document_versions
  add constraint document_versions_chapter_id_id_key unique (chapter_id, id);
alter table public.chapters
  add constraint chapters_current_document_version_same_chapter_fk
  foreign key (id, current_document_version_id)
  references public.document_versions (chapter_id, id)
  deferrable initially deferred;

-- Replace policies that depend on public SECURITY DEFINER helpers or allowed
-- actor attribution to be spoofed. Client writes that require business-level
-- validation (billing, jobs, publishing and role administration) stay
-- server-mediated and receive no authenticated write policy.
drop policy if exists profile_self on public.profiles;
drop policy if exists workspace_select on public.workspaces;
drop policy if exists workspace_update on public.workspaces;
drop policy if exists members_select on public.workspace_members;
drop policy if exists members_insert on public.workspace_members;
drop policy if exists members_update on public.workspace_members;
drop policy if exists books_select on public.books;
drop policy if exists books_insert on public.books;
drop policy if exists books_update on public.books;
drop policy if exists chapters_select on public.chapters;
drop policy if exists chapters_write on public.chapters;
drop policy if exists doc_select on public.document_versions;
drop policy if exists doc_insert on public.document_versions;
drop policy if exists folders_select on public.folders;
drop policy if exists folders_write on public.folders;
drop policy if exists assets_select on public.assets;
drop policy if exists assets_write on public.assets;
drop policy if exists comments_select on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_update on public.comments;
drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_write on public.tasks;
drop policy if exists ai_job_select on public.ai_jobs;
drop policy if exists publishing_job_select on public.publishing_jobs;
drop policy if exists validation_select on public.publishing_validations;
drop policy if exists credits_select on public.credit_ledger;
drop policy if exists usage_select on public.usage_events;
drop policy if exists referral_self on public.referral_codes;
drop policy if exists mentions_select on public.comment_mentions;
drop policy if exists activity_select on public.activity_events;
drop policy if exists asset_object_read on storage.objects;
drop policy if exists community_select on public.communities;
drop policy if exists community_insert on public.communities;
drop policy if exists community_update on public.communities;
drop policy if exists community_members_select on public.community_members;
drop policy if exists community_members_insert on public.community_members;
drop policy if exists community_members_delete on public.community_members;
drop policy if exists community_posts_select on public.community_posts;
drop policy if exists community_posts_insert on public.community_posts;
drop policy if exists community_posts_update on public.community_posts;
drop policy if exists community_comments_select on public.community_comments;
drop policy if exists community_comments_insert on public.community_comments;
drop policy if exists reactions_select on public.community_post_reactions;
drop policy if exists reactions_write on public.community_post_reactions;
drop policy if exists reports_insert on public.reports;
drop policy if exists reports_select on public.reports;
drop policy if exists referrals_select on public.referrals;

create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or private.shares_active_workspace_with(id)
  );
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy organizations_select on public.organizations for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or private.is_organization_member(id)
  );
create policy organizations_insert on public.organizations for insert to authenticated
  with check (owner_user_id = (select auth.uid()));
create policy organizations_update on public.organizations for update to authenticated
  using (private.can_manage_organization(id))
  with check (private.can_manage_organization(id));

create policy organization_members_select on public.organization_members for select to authenticated
  using (private.is_organization_member(organization_id));

create policy workspaces_select on public.workspaces for select to authenticated
  using (private.is_workspace_member(id));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.can_manage_organization(organization_id)
  );
create policy workspaces_update on public.workspaces for update to authenticated
  using (private.workspace_role(id) in ('owner', 'admin'))
  with check (
    private.workspace_role(id) in ('owner', 'admin')
    and private.can_manage_organization(organization_id)
  );

create policy workspace_members_select on public.workspace_members for select to authenticated
  using (private.is_workspace_member(workspace_id));

create policy books_select on public.books for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy books_insert on public.books for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.can_edit_workspace(workspace_id)
  );
create policy books_update on public.books for update to authenticated
  using (private.can_edit_workspace(workspace_id))
  with check (private.can_edit_workspace(workspace_id));

create policy book_versions_select on public.book_versions for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy book_versions_insert on public.book_versions for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.books b
      where b.id = book_id and private.can_edit_workspace(b.workspace_id)
    )
  );

create policy chapters_select on public.chapters for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy chapters_insert on public.chapters for insert to authenticated
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy chapters_update on public.chapters for update to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ))
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy chapters_delete on public.chapters for delete to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));

create policy document_versions_select on public.document_versions for select to authenticated
  using (exists (
    select 1 from public.chapters c
    join public.books b on b.id = c.book_id
    where c.id = chapter_id and private.is_workspace_member(b.workspace_id)
  ));
create policy document_versions_insert on public.document_versions for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.chapters c
      join public.books b on b.id = c.book_id
      where c.id = chapter_id and private.can_edit_workspace(b.workspace_id)
    )
  );

create policy book_metadata_select on public.book_metadata for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy book_metadata_insert on public.book_metadata for insert to authenticated
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy book_metadata_update on public.book_metadata for update to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ))
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));

create policy style_guides_select on public.style_guides for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy style_guides_insert on public.style_guides for insert to authenticated
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy style_guides_update on public.style_guides for update to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ))
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));

create policy book_bible_items_select on public.book_bible_items for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy book_bible_items_insert on public.book_bible_items for insert to authenticated
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy book_bible_items_update on public.book_bible_items for update to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ))
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy book_bible_items_delete on public.book_bible_items for delete to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));

create policy folders_select on public.folders for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy folders_insert on public.folders for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.can_edit_workspace(workspace_id)
    and (parent_folder_id is null or private.folder_belongs_to_workspace(parent_folder_id, workspace_id))
  );
create policy folders_update on public.folders for update to authenticated
  using (private.can_edit_workspace(workspace_id))
  with check (
    private.can_edit_workspace(workspace_id)
    and (parent_folder_id is null or private.folder_belongs_to_workspace(parent_folder_id, workspace_id))
  );
create policy folders_delete on public.folders for delete to authenticated
  using (private.can_edit_workspace(workspace_id));

create policy assets_select on public.assets for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy assets_insert on public.assets for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.can_edit_workspace(workspace_id)
    and (
      folder_id is null
      or private.folder_belongs_to_workspace(folder_id, workspace_id)
    )
  );
create policy assets_update on public.assets for update to authenticated
  using (private.can_edit_workspace(workspace_id))
  with check (
    private.can_edit_workspace(workspace_id)
    and (
      folder_id is null
      or private.folder_belongs_to_workspace(folder_id, workspace_id)
    )
  );
create policy assets_delete on public.assets for delete to authenticated
  using (private.can_edit_workspace(workspace_id));

create policy asset_versions_select on public.asset_versions for select to authenticated
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id and private.is_workspace_member(a.workspace_id)
  ));
create policy asset_versions_insert on public.asset_versions for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.assets a
      where a.id = asset_id and private.can_edit_workspace(a.workspace_id)
    )
  );
create policy asset_versions_update on public.asset_versions for update to authenticated
  using (
    checksum = 'pending'
    and exists (
      select 1 from public.assets a
      where a.id = asset_id and private.can_edit_workspace(a.workspace_id)
    )
  )
  with check (
    checksum ~ '^[a-f0-9]{64}$'
    and exists (
      select 1 from public.assets a
      where a.id = asset_id and private.can_edit_workspace(a.workspace_id)
    )
  );

create policy asset_links_select on public.asset_links for select to authenticated
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id and private.is_workspace_member(a.workspace_id)
  ));
create policy asset_links_insert on public.asset_links for insert to authenticated
  with check (exists (
    select 1 from public.assets a
    where a.id = asset_id and private.can_edit_workspace(a.workspace_id)
  ));
create policy asset_links_delete on public.asset_links for delete to authenticated
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id and private.can_edit_workspace(a.workspace_id)
  ));

create policy comments_select on public.comments for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy comments_insert on public.comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and private.is_workspace_member(workspace_id)
  );
create policy comments_update on public.comments for update to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id));

create policy comment_mentions_select on public.comment_mentions for select to authenticated
  using (exists (
    select 1 from public.comments c
    where c.id = comment_id and private.is_workspace_member(c.workspace_id)
  ));

create policy tasks_select on public.tasks for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and private.can_edit_workspace(workspace_id)
    and (
      assignee_id is null
      or private.is_active_workspace_user(workspace_id, assignee_id)
    )
  );
create policy tasks_update on public.tasks for update to authenticated
  using (private.can_edit_workspace(workspace_id))
  with check (
    private.can_edit_workspace(workspace_id)
    and (
      assignee_id is null
      or private.is_active_workspace_user(workspace_id, assignee_id)
    )
  );
create policy tasks_delete on public.tasks for delete to authenticated
  using (private.can_edit_workspace(workspace_id));

create policy approvals_select on public.approvals for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and private.is_workspace_member(workspace_id)
    and (
      reviewer_id is null
      or private.is_active_workspace_user(workspace_id, reviewer_id)
    )
  );
create policy approvals_update on public.approvals for update to authenticated
  using (
    private.can_approve_workspace(workspace_id)
    and (reviewer_id is null or reviewer_id = (select auth.uid()))
  )
  with check (
    private.can_approve_workspace(workspace_id)
    and (
      reviewer_id is null
      or private.is_active_workspace_user(workspace_id, reviewer_id)
    )
  );

create policy activity_events_select on public.activity_events for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy ai_jobs_select on public.ai_jobs for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy ai_suggestions_select on public.ai_suggestions for select to authenticated
  using (exists (
    select 1 from public.ai_jobs j
    where j.id = ai_job_id and private.is_workspace_member(j.workspace_id)
  ));
create policy ai_runs_select on public.ai_runs for select to authenticated
  using (private.is_workspace_member(workspace_id));

create policy plans_select on public.plans for select to anon, authenticated
  using (true);
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (private.can_manage_organization(organization_id));
create policy usage_events_select on public.usage_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy editions_select on public.editions for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy editions_insert on public.editions for insert to authenticated
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy editions_update on public.editions for update to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ))
  with check (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));
create policy editions_delete on public.editions for delete to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.can_edit_workspace(b.workspace_id)
  ));

create policy publishing_jobs_select on public.publishing_jobs for select to authenticated
  using (exists (
    select 1 from public.books b
    where b.id = book_id and private.is_workspace_member(b.workspace_id)
  ));
create policy publishing_validations_select on public.publishing_validations for select to authenticated
  using (exists (
    select 1
    from public.publishing_jobs p
    join public.books b on b.id = p.book_id
    where p.id = publishing_job_id and private.is_workspace_member(b.workspace_id)
  ));

create policy credit_ledger_select on public.credit_ledger for select to authenticated
  using (user_id = (select auth.uid()));
create policy referral_codes_select on public.referral_codes for select to authenticated
  using (user_id = (select auth.uid()));
create policy referral_codes_insert on public.referral_codes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy referral_codes_update on public.referral_codes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy referral_codes_delete on public.referral_codes for delete to authenticated
  using (user_id = (select auth.uid()));
create policy referrals_select on public.referrals for select to authenticated
  using (
    referrer_id = (select auth.uid())
    or referred_user_id = (select auth.uid())
  );

create policy communities_select on public.communities for select to authenticated
  using (private.community_is_visible(id));
create policy communities_insert on public.communities for insert to authenticated
  with check (owner_user_id = (select auth.uid()));
create policy communities_update on public.communities for update to authenticated
  using (private.can_moderate_community(id))
  with check (private.can_moderate_community(id));

create policy community_members_select on public.community_members for select to authenticated
  using (private.community_is_visible(community_id));
create policy community_members_insert on public.community_members for insert to authenticated
  with check (
    exists (
      select 1 from public.communities c
      where c.id = community_id and c.owner_user_id = (select auth.uid())
    )
    or (
      user_id = (select auth.uid())
      and role = 'member' and status = 'active'
      and exists (
        select 1 from public.communities c
        where c.id = community_id and c.visibility = 'public'
      )
    )
  );
create policy community_members_delete on public.community_members for delete to authenticated
  using (user_id = (select auth.uid()));

create policy community_posts_select on public.community_posts for select to authenticated
  using (
    private.community_is_visible(community_id)
    and (
      status = 'published'
      or author_id = (select auth.uid())
      or private.can_moderate_community(community_id)
    )
  );
create policy community_posts_insert on public.community_posts for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and private.is_community_member(community_id)
  );
create policy community_posts_update on public.community_posts for update to authenticated
  using (
    author_id = (select auth.uid())
    or private.can_moderate_community(community_id)
  )
  with check (
    private.is_community_member(community_id)
    and (
      author_id = (select auth.uid())
      or private.can_moderate_community(community_id)
    )
  );

create policy community_comments_select on public.community_comments for select to authenticated
  using (exists (
    select 1 from public.community_posts p
    where p.id = post_id and private.community_is_visible(p.community_id)
  ));
create policy community_comments_insert on public.community_comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (
      select 1 from public.community_posts p
      where p.id = post_id and private.is_community_member(p.community_id)
    )
  );

create policy community_reactions_select on public.community_post_reactions for select to authenticated
  using (exists (
    select 1 from public.community_posts p
    where p.id = post_id and private.community_is_visible(p.community_id)
  ));
create policy community_reactions_insert on public.community_post_reactions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.community_posts p where p.id = post_id)
  );
create policy community_reactions_delete on public.community_post_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy reports_insert on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));
create policy reports_select on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()));

create policy asset_object_read on storage.objects for select to authenticated
  using (
    bucket_id = 'book-assets'
    and (
      exists (
        select 1
        from public.assets a
        where a.storage_path = storage.objects.name
          and private.asset_path_matches(storage.objects.name, a.workspace_id, a.id)
          and private.is_workspace_member(a.workspace_id)
      )
      or exists (
        select 1
        from public.asset_versions av
        join public.assets a on a.id = av.asset_id
        where av.storage_path = storage.objects.name
          and private.asset_path_matches(storage.objects.name, a.workspace_id, a.id)
          and private.is_workspace_member(a.workspace_id)
      )
    )
  );
create policy asset_object_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'book-assets'
    and exists (
      select 1
      from public.asset_versions av
      join public.assets a on a.id = av.asset_id
      where av.storage_path = storage.objects.name
        and private.asset_path_matches(storage.objects.name, a.workspace_id, a.id)
        and av.checksum = 'pending'
        and private.can_edit_workspace(a.workspace_id)
    )
  );

-- Client grants are explicit. Server/service-role workflows retain their
-- existing privileged path; no client write grant is issued for finance,
-- publishing, job processing, support, feature flags, or role management.
revoke all on table public.organizations, public.organization_members,
  public.workspaces, public.workspace_members, public.profiles,
  public.books, public.book_versions, public.chapters, public.document_versions,
  public.book_metadata, public.style_guides, public.book_bible_items,
  public.folders, public.assets, public.asset_versions, public.asset_links,
  public.comments, public.comment_mentions, public.tasks, public.approvals,
  public.activity_events, public.ai_jobs, public.ai_suggestions, public.ai_runs,
  public.communities, public.community_members, public.community_posts,
  public.community_comments, public.community_post_reactions, public.reports,
  public.referral_codes, public.referrals, public.credit_ledger, public.plans,
  public.subscriptions, public.usage_events, public.editions,
  public.publishing_profiles, public.publishing_jobs,
  public.publishing_validations, public.audit_logs, public.stripe_events,
  public.feature_flags, public.support_tickets, public.dead_letter_jobs
from anon, authenticated;
revoke all on table storage.objects from anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.organizations to authenticated;
grant select on public.organization_members, public.workspace_members,
  public.comment_mentions, public.activity_events, public.ai_jobs,
  public.ai_suggestions, public.ai_runs, public.referrals, public.credit_ledger,
  public.subscriptions, public.usage_events, public.publishing_jobs,
  public.publishing_validations to authenticated;
grant select, insert, update on public.workspaces, public.books,
  public.book_metadata, public.style_guides, public.book_bible_items,
  public.comments, public.approvals, public.community_posts,
  public.communities, public.referral_codes to authenticated;
grant select, insert on public.book_versions, public.document_versions,
  public.community_comments, public.reports,
  public.community_post_reactions to authenticated;
grant select, insert, update on public.asset_versions to authenticated;
grant select, insert, update, delete on public.chapters, public.folders,
  public.assets, public.tasks, public.editions to authenticated;
grant select, insert, delete on public.asset_links,
  public.community_members to authenticated;
grant select, insert, update, delete on public.referral_codes to authenticated;
grant delete on public.book_bible_items to authenticated;
grant select on public.plans to anon, authenticated;
grant select, insert on storage.objects to authenticated;

-- Policies above no longer depend on public helpers. Removing them prevents
-- SECURITY DEFINER functions from being callable via the exposed schema.
drop function if exists public.can_edit_workspace(uuid);
drop function if exists public.workspace_role(uuid);
drop function if exists public.is_workspace_member(uuid);
drop function if exists public.community_is_visible(uuid);
drop function if exists public.community_visible(uuid);
drop function if exists public.is_community_member(uuid);
