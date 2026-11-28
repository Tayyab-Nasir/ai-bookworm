-- Keep direct database access aligned with the collaboration API contract.

drop policy if exists approvals_insert on public.approvals;
create policy approvals_insert on public.approvals for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and private.can_edit_workspace(workspace_id)
    and (
      reviewer_id is null
      or exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = approvals.workspace_id
          and wm.user_id = approvals.reviewer_id
          and wm.status = 'active'
          and wm.role in ('owner','admin','editor','writer','illustrator','designer','reviewer')
      )
    )
  );

-- Approval resolution is conditional and state-machine guarded by the API.
-- Removing the table grant prevents direct clients from changing reviewer,
-- target, requester, or status around that transition.
drop policy if exists approvals_update on public.approvals;
revoke update on table public.approvals from authenticated;
