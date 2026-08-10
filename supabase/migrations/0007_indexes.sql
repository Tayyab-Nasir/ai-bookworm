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
