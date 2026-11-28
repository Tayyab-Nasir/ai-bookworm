begin;
insert into auth.users (id, email) values
  ('d7710000-0000-4000-8000-000000000001', 'submission-author@local.test'),
  ('d7710000-0000-4000-8000-000000000002', 'submission-viewer@local.test'),
  ('d7710000-0000-4000-8000-000000000003', 'submission-outsider@local.test');
set local request.jwt.claims = '{"sub":"d7710000-0000-4000-8000-000000000001"}';
do $$
declare
  workspace public.workspaces;
  book_id uuid;
  edition_id uuid;
begin
  select * into strict workspace from public.create_workspace_with_owner('Retailer submission acceptance');
  insert into public.workspace_members (workspace_id, user_id, role)
    values (workspace.id, 'd7710000-0000-4000-8000-000000000002', 'viewer');
  insert into public.books (workspace_id, title, author_name, created_by)
    values (workspace.id, 'Example book', 'Test author', auth.uid()) returning id into book_id;
  insert into public.editions (book_id, type) values (book_id, 'ebook') returning id into edition_id;
  insert into public.publishing_jobs (id, book_id, edition_id, channel, status, request_json, idempotency_key) values
    ('d7710000-0000-4000-8000-000000000011', book_id, edition_id, 'kdp', 'succeeded', '{"action":"export_package"}', 'test-submission-package'),
    ('d7710000-0000-4000-8000-000000000012', book_id, edition_id, 'kdp', 'running', '{"action":"export_package"}', 'test-submission-running'),
    ('d7710000-0000-4000-8000-000000000013', book_id, edition_id, 'kdp', 'succeeded', '{"action":"validate"}', 'test-submission-preflight');
  assert not has_function_privilege('anon', 'public.save_retailer_submission(uuid,text,uuid)', 'EXECUTE');
  assert not has_function_privilege('anon', 'private.save_retailer_submission_internal(uuid,text,uuid)', 'EXECUTE');
  assert not has_function_privilege('service_role', 'public.save_retailer_submission(uuid,text,uuid)', 'EXECUTE');
  assert not has_table_privilege('anon', 'public.retailer_submissions', 'SELECT');
  assert not has_table_privilege('authenticated', 'public.retailer_submissions', 'INSERT');
  assert not has_table_privilege('authenticated', 'public.retailer_submissions', 'UPDATE');
  assert not has_table_privilege('authenticated', 'public.retailer_submissions', 'DELETE');
end;
$$;

set local role authenticated;
do $$
declare
  completed uuid := 'd7710000-0000-4000-8000-000000000011';
  unavailable uuid;
  first public.retailer_submissions;
  latest public.retailer_submissions;
begin
  assert not exists (select 1 from public.retailer_submissions where publishing_job_id = completed);
  select * into strict first from public.save_retailer_submission(completed, 'submitted', null);
  assert first.status = 'submitted' and first.publishing_job_id = completed and first.reported_by = auth.uid();
  select * into strict latest from public.save_retailer_submission(completed, 'in_review', first.revision);
  assert latest.status = 'in_review' and latest.revision <> first.revision;
  begin
    perform public.save_retailer_submission(completed, 'published', null);
    assert false, 'a second initial write overwrote the first record';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.save_retailer_submission(completed, 'withdrawn', first.revision);
    assert false, 'a stale write overwrote newer status';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.save_retailer_submission(completed, 'unknown', latest.revision);
    assert false, 'an invalid status was accepted';
  exception when invalid_parameter_value then null;
  end;
  foreach unavailable in array array['d7710000-0000-4000-8000-000000000012'::uuid, 'd7710000-0000-4000-8000-000000000013'::uuid] loop
    begin
      perform public.save_retailer_submission(unavailable, 'submitted', null);
      assert false, 'a running export or preflight accepted a status';
    exception when sqlstate 'PT404' then null;
    end;
  end loop;
  assert (select revision from public.retailer_submissions where publishing_job_id = completed) = latest.revision;
  assert (select status from public.publishing_jobs where id = completed) = 'succeeded';

  perform set_config('request.jwt.claims','{"sub":"d7710000-0000-4000-8000-000000000002"}', true);
  assert (select status from public.retailer_submissions where publishing_job_id = completed) = 'in_review';
  begin
    perform public.save_retailer_submission(completed, 'published', latest.revision);
    assert false, 'viewer saved a submission status';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claims','{"sub":"d7710000-0000-4000-8000-000000000003"}', true);
  assert not exists (select 1 from public.retailer_submissions where publishing_job_id = completed);
  begin
    perform public.save_retailer_submission(completed, 'published', latest.revision);
    assert false, 'cross-workspace save succeeded';
  exception when sqlstate 'PT404' then null;
  end;
end;
$$;
rollback;
