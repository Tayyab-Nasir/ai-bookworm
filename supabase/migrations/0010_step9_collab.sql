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
