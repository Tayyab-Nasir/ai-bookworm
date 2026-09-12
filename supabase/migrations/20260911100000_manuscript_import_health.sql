-- Aggregate queue diagnostics without exposing manuscript identity or lease data.
create function public.get_manuscript_import_health()
returns table(
  generated_at timestamptz,
  queued bigint,
  due_queued bigint,
  running bigint,
  expired_running bigint,
  succeeded bigint,
  failed bigint,
  dead_letters bigint,
  oldest_queued_at timestamptz,
  oldest_running_at timestamptz
) language sql stable security invoker set search_path = public,pg_temp as $$
  select
    clock_timestamp(),
    count(*) filter (where j.status='queued'),
    count(*) filter (where j.status='queued' and j.available_at<=clock_timestamp()),
    count(*) filter (where j.status='running'),
    count(*) filter (where j.status='running' and j.lease_expires_at<=clock_timestamp()),
    count(*) filter (where j.status='succeeded'),
    count(*) filter (where j.status='failed'),
    (select count(*) from public.dead_letter_jobs d
      where d.queue='jobs.document' and d.job_type='manuscript_import'),
    min(j.created_at) filter (where j.status='queued'),
    min(j.created_at) filter (where j.status='running')
  from public.manuscript_import_jobs j;
$$;

revoke all on function public.get_manuscript_import_health() from public,anon,authenticated;
grant execute on function public.get_manuscript_import_health() to service_role;
