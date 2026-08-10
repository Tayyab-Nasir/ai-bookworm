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
