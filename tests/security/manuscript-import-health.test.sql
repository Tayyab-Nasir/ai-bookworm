begin;
set local role service_role;

do $$ declare h record;
begin
  assert not has_function_privilege('authenticated','public.get_manuscript_import_health()','execute'),
    'authenticated must not read platform queue health';
  assert has_function_privilege('service_role','public.get_manuscript_import_health()','execute'),
    'service role must read queue health';

  select * into h from public.get_manuscript_import_health();
  assert h.generated_at is not null, 'health timestamp missing';
  assert h.queued >= 0 and h.due_queued >= 0 and h.running >= 0,
    'active queue counters must be non-negative';
  assert h.succeeded >= 0 and h.failed >= 0 and h.dead_letters >= 0,
    'terminal queue counters must be non-negative';
end $$;

rollback;
