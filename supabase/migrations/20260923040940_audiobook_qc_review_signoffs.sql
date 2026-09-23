-- Persist objective QC reports for exact assembled files and immutable author
-- attestations that they listened to that exact file. Audio bytes stay private
-- in existing Storage paths and are never copied into this metadata table.
create table public.audiobook_qc_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.audiobook_projects(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id),
  audio_sha256 text not null check (audio_sha256 ~ '^[a-f0-9]{64}$'),
  source_manifest_sha256 text not null check (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  quality_report jsonb not null check (
    jsonb_typeof(quality_report) = 'object'
    and octet_length(quality_report::text) <= 8192
  ),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (project_id, audio_sha256)
);

create index audiobook_qc_reports_project_created
  on public.audiobook_qc_reports(project_id, created_at desc);

create table public.audiobook_qc_signoffs (
  report_id uuid not null references public.audiobook_qc_reports(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  listened_to_exact_audio boolean not null check (listened_to_exact_audio),
  signed_at timestamptz not null default clock_timestamp(),
  primary key (report_id, reviewer_id)
);

alter table public.audiobook_qc_reports enable row level security;
alter table public.audiobook_qc_signoffs enable row level security;

create policy audiobook_qc_reports_member_select
  on public.audiobook_qc_reports for select to authenticated
  using (exists (
    select 1 from public.audiobook_projects p
    where p.id = project_id and private.is_workspace_member(p.workspace_id)
  ));

create policy audiobook_qc_signoffs_member_select
  on public.audiobook_qc_signoffs for select to authenticated
  using (exists (
    select 1
    from public.audiobook_qc_reports r
    join public.audiobook_projects p on p.id = r.project_id
    where r.id = report_id and private.is_workspace_member(p.workspace_id)
  ));

create policy audiobook_qc_signoffs_approver_insert
  on public.audiobook_qc_signoffs for insert to authenticated
  with check (
    reviewer_id = (select auth.uid())
    and listened_to_exact_audio
    and exists (
      select 1
      from public.audiobook_qc_reports r
      join public.audiobook_projects p on p.id = r.project_id
      where r.id = report_id and private.can_approve_workspace(p.workspace_id)
    )
  );

revoke all on public.audiobook_qc_reports, public.audiobook_qc_signoffs
  from public, anon, authenticated, service_role;
grant select on public.audiobook_qc_reports, public.audiobook_qc_signoffs
  to authenticated;
grant insert on public.audiobook_qc_signoffs to authenticated;
grant select, insert on public.audiobook_qc_reports to service_role;
