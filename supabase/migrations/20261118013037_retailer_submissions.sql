-- Author-reported retailer status belongs to a completed package.
create table public.retailer_submissions (
  publishing_job_id uuid primary key references public.publishing_jobs(id) on delete cascade,
  status text not null check (status in (
    'not_submitted', 'submitted', 'in_review', 'changes_requested', 'published', 'withdrawn'
  )),
  revision uuid not null default gen_random_uuid(),
  reported_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.retailer_submissions enable row level security;
revoke all on table public.retailer_submissions from public, anon, authenticated, service_role;
grant select on table public.retailer_submissions to authenticated;
create policy retailer_submissions_select on public.retailer_submissions
  for select to authenticated
  using (exists (
    select 1 from public.publishing_jobs job
    where job.id = retailer_submissions.publishing_job_id
  ));

-- Keep the privileged write private. The caller's current book and membership
-- stay locked through the revision check and write.
create function private.save_retailer_submission_internal(
  p_job_id uuid, p_status text, p_expected_revision uuid
) returns public.retailer_submissions
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_workspace uuid;
  v_result public.retailer_submissions;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in (
    'not_submitted', 'submitted', 'in_review', 'changes_requested', 'published', 'withdrawn'
  ) then
    raise exception 'Invalid submission status' using errcode = '22023';
  end if;

  select book.workspace_id into v_workspace
  from public.publishing_jobs job
  join public.books book on book.id = job.book_id
  join public.editions edition on edition.id = job.edition_id and edition.book_id = book.id
  join public.workspace_members member
    on member.workspace_id = book.workspace_id and member.user_id = v_actor and member.status = 'active'
  where job.id = p_job_id and job.status = 'succeeded'
    and job.channel in ('kdp', 'apple', 'barnesnoble', 'lulu', 'googleplay')
    and job.request_json ->> 'action' = 'export_package'
  for share of job, book, edition, member;
  if not found then
    raise exception 'Completed retailer package not found' using errcode = 'PT404';
  end if;
  if not private.can_edit_workspace(v_workspace) then
    raise exception 'This workspace role cannot update submission status' using errcode = '42501';
  end if;

  if p_expected_revision is null then
    insert into public.retailer_submissions (publishing_job_id, status, reported_by)
      values (p_job_id, p_status, v_actor)
      on conflict (publishing_job_id) do nothing
      returning * into v_result;
  else
    update public.retailer_submissions
      set status = p_status, revision = gen_random_uuid(), reported_by = v_actor, updated_at = now()
      where publishing_job_id = p_job_id and revision = p_expected_revision
      returning * into v_result;
  end if;
  if not found then
    raise exception 'Submission status changed' using errcode = 'PT409';
  end if;
  return v_result;
end;
$$;

create function public.save_retailer_submission(
  p_job_id uuid, p_status text, p_expected_revision uuid
) returns public.retailer_submissions
language sql security invoker set search_path = '' as $$
  select private.save_retailer_submission_internal(p_job_id, p_status, p_expected_revision);
$$;

revoke all on function private.save_retailer_submission_internal(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_retailer_submission(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function private.save_retailer_submission_internal(uuid, text, uuid) to authenticated;
grant execute on function public.save_retailer_submission(uuid, text, uuid) to authenticated;
