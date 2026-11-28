begin;
insert into auth.users (id, email) values
  ('d7720000-0000-4000-8000-000000000001', 'managed-author@local.test'),
  ('d7720000-0000-4000-8000-000000000002', 'managed-editor@local.test'),
  ('d7720000-0000-4000-8000-000000000003', 'managed-outsider@local.test'),
  ('d7720000-0000-4000-8000-000000000004', 'managed-operator@local.test');
set local request.jwt.claims = '{"sub":"d7720000-0000-4000-8000-000000000001","role":"service_role"}';
do $$
declare
  workspace public.workspaces;
  book_id uuid;
  edition_id uuid;
  asset_id uuid := 'd7720000-0000-4000-8000-000000000021';
  path text;
  sha text := repeat('a', 64);
begin
  select * into strict workspace from public.create_workspace_with_owner('Managed publishing acceptance');
  insert into public.workspace_members (workspace_id, user_id, role)
    values (workspace.id, 'd7720000-0000-4000-8000-000000000002', 'editor');
  insert into public.books (workspace_id, title, author_name, created_by)
    values (workspace.id, 'Example book', 'Test author', auth.uid()) returning id into book_id;
  insert into public.editions (book_id, type) values (book_id, 'ebook') returning id into edition_id;
  path := format('workspaces/%s/assets/%s/v1/kdp-export.zip', workspace.id, asset_id);
  insert into public.assets (id, workspace_id, type, name, storage_path, mime_type, size_bytes, checksum, created_by)
    values (asset_id, workspace.id, 'publishing_package', 'kdp-export.zip', path, 'application/zip', 40, sha, auth.uid());
  insert into public.asset_versions (asset_id, version_number, storage_path, checksum, created_by, mime_type, size_bytes, scan_status)
    values (asset_id, 1, path, sha, auth.uid(), 'application/zip', 40, 'trusted_generated');
  insert into public.publishing_jobs (id, book_id, edition_id, channel, status, request_json, response_json, idempotency_key)
    values ('d7720000-0000-4000-8000-000000000011', book_id, edition_id, 'kdp', 'succeeded', '{"action":"export_package"}',
      jsonb_build_object('artifact', jsonb_build_object('assetId', asset_id, 'storagePath', path, 'checksum', sha)), 'managed-publishing-package');
  insert into public.publishing_jobs (id, book_id, edition_id, channel, status, request_json, response_json, idempotency_key)
    select 'd7720000-0000-4000-8000-000000000012', job.book_id, job.edition_id, job.channel, job.status,
      job.request_json, job.response_json, 'managed-confirmation-package'
    from public.publishing_jobs job where job.id = 'd7720000-0000-4000-8000-000000000011';
  assert not has_function_privilege('anon', 'public.request_managed_publishing(uuid,text,uuid)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.request_managed_publishing(uuid,text,uuid)', 'EXECUTE');
  assert not has_function_privilege('service_role', 'public.withdraw_managed_publishing(uuid,text)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'private.request_managed_publishing_internal(uuid,text,boolean,uuid)', 'EXECUTE');
  assert not has_table_privilege('authenticated', 'public.managed_publishing_requests', 'INSERT');
  assert not has_table_privilege('service_role', 'public.managed_publishing_requests', 'SELECT');
  assert not has_function_privilege('authenticated', 'public.claim_managed_publishing(uuid,text,uuid)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.list_managed_publishing_queue(uuid,integer,integer)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.read_managed_publishing_package(uuid,uuid)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.confirm_managed_publishing(uuid,text,uuid,text)', 'EXECUTE');
  assert not has_table_privilege('authenticated', 'private.managed_publication_notifications', 'SELECT');
  assert not has_table_privilege('service_role', 'private.managed_publication_notifications', 'INSERT');
  assert not has_function_privilege('authenticated', 'public.claim_managed_publication_notification()', 'EXECUTE');
end;
$$;

set local request.jwt.claims = '{"sub":"d7720000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
do $$
begin
  perform public.request_managed_publishing('d7720000-0000-4000-8000-000000000011', repeat('a', 64), auth.uid());
  assert false, 'Authenticated direct request bypassed the application';
exception when insufficient_privilege then null;
end;
$$;

reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
do $$
declare
  job uuid := 'd7720000-0000-4000-8000-000000000011';
  sha text := repeat('a', 64);
  first public.managed_publishing_requests;
begin
  begin
    perform public.request_managed_publishing(job, repeat('b', 64), 'd7720000-0000-4000-8000-000000000001'::uuid);
    assert false, 'A different package hash was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  select * into strict first from public.request_managed_publishing(job, sha, 'd7720000-0000-4000-8000-000000000001'::uuid);
  assert first.package_job_id = job and first.requested_by = 'd7720000-0000-4000-8000-000000000001'::uuid and first.package_sha256 = sha;
  assert (select row_to_json(r) from public.request_managed_publishing(job, sha, 'd7720000-0000-4000-8000-000000000001'::uuid) r)::text = row_to_json(first)::text;
  assert first.withdrawn_at is null;
  begin
    perform public.request_managed_publishing(job, sha, 'd7720000-0000-4000-8000-000000000002');
    assert false, 'Service request accepted an editor as author';
  exception when sqlstate 'PT404' then null;
  end;
  begin
    perform public.request_managed_publishing(job, sha, 'd7720000-0000-4000-8000-000000000003');
    assert false, 'Service request accepted an outsider as author';
  exception when sqlstate 'PT404' then null;
  end;
  perform public.request_managed_publishing('d7720000-0000-4000-8000-000000000012', sha, 'd7720000-0000-4000-8000-000000000001'::uuid);
end;
$$;

reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
do $$
declare
  job uuid := 'd7720000-0000-4000-8000-000000000011';
  operator_id uuid := 'd7720000-0000-4000-8000-000000000004';
  sha text := repeat('a', 64);
  claimed public.managed_publishing_requests;
  completed_job uuid := 'd7720000-0000-4000-8000-000000000012';
  published public.managed_publishing_requests;
  listing text := 'https://www.amazon.com/dp/B000000001';
begin
  assert exists (select 1 from public.list_managed_publishing_queue(operator_id, 1, 0) where package_job_id = job and claimed_at is null);
  assert not exists (select 1 from public.read_managed_publishing_package(job, operator_id));
  select * into strict claimed from public.claim_managed_publishing(job, sha, operator_id);
  assert claimed.claimed_by = operator_id and claimed.claimed_at is not null;
  assert (select claimed_at from public.claim_managed_publishing(job, sha, operator_id)) = claimed.claimed_at;
  assert not exists (select 1 from public.list_managed_publishing_queue('d7720000-0000-4000-8000-000000000003', 2, 0) where package_job_id = job);
  assert exists (select 1 from public.read_managed_publishing_package(job, operator_id) where package_sha256 = sha and filename = 'kdp-export.zip');
  assert not exists (select 1 from public.read_managed_publishing_package(job, 'd7720000-0000-4000-8000-000000000003'));
  begin
    perform public.claim_managed_publishing(job, sha, 'd7720000-0000-4000-8000-000000000003');
    assert false, 'A competing operator replaced the claim';
  exception when sqlstate 'PT409' then null;
  end;
  perform public.claim_managed_publishing(completed_job, sha, operator_id);
  begin
    perform public.confirm_managed_publishing(completed_job, sha, operator_id, 'https://www.amazon.com.example.test/dp/B000000001');
    assert false, 'A foreign retailer hostname was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.confirm_managed_publishing(completed_job, sha, 'd7720000-0000-4000-8000-000000000003', listing);
    assert false, 'A competing operator confirmed the publication';
  exception when sqlstate 'PT409' then null;
  end;
  select * into strict published from public.confirm_managed_publishing(completed_job, sha, operator_id, listing);
  assert published.confirmed_at is not null and published.listing_url = listing;
  assert (select confirmed_at from public.confirm_managed_publishing(completed_job, sha, operator_id, listing)) = published.confirmed_at;
  begin
    perform public.confirm_managed_publishing(completed_job, sha, operator_id, 'https://www.amazon.com/dp/B000000002');
    assert false, 'An earlier completion was overwritten';
  exception when sqlstate 'PT409' then null;
  end;
  assert not exists (select 1 from public.read_managed_publishing_package(completed_job, operator_id));
end;
$$;

reset role;
set local request.jwt.claims = '{"sub":"d7720000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
do $$
declare
  job uuid := 'd7720000-0000-4000-8000-000000000011';
  sha text := repeat('a', 64);
  first public.managed_publishing_requests;
  withdrawn public.managed_publishing_requests;
begin
  select * into strict first from public.managed_publishing_requests where package_job_id = job;
  begin
    perform public.withdraw_managed_publishing(job, repeat('b', 64));
    assert false, 'Withdrawal accepted a different checksum';
  exception when sqlstate 'PT409' then null;
  end;
  select * into strict withdrawn from public.withdraw_managed_publishing(job, sha);
  assert withdrawn.withdrawn_at is not null and withdrawn.requested_at = first.requested_at;
  assert (select withdrawn_at from public.withdraw_managed_publishing(job, sha)) = withdrawn.withdrawn_at;
  assert (select count(*) from public.managed_publishing_requests) = 2;
  assert (select listing_url from public.managed_publishing_requests where package_job_id = 'd7720000-0000-4000-8000-000000000012')
    = 'https://www.amazon.com/dp/B000000001';
  begin
    perform public.withdraw_managed_publishing('d7720000-0000-4000-8000-000000000012', sha);
    assert false, 'A completed publication was withdrawn as consent';
  exception when sqlstate 'PT409' then null;
  end;
  perform set_config('request.jwt.claims','{"sub":"d7720000-0000-4000-8000-000000000002"}', true);
  assert not exists (select 1 from public.managed_publishing_requests);
  begin
    perform public.withdraw_managed_publishing(job, sha);
    assert false, 'Editor withdrew consent';
  exception when sqlstate 'PT404' then null;
  end;
  perform set_config('request.jwt.claims','{"sub":"d7720000-0000-4000-8000-000000000003"}', true);
  assert not exists (select 1 from public.managed_publishing_requests);
end;
$$;

reset role;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
do $$
begin
  assert not exists (
    select 1 from public.list_managed_publishing_queue('d7720000-0000-4000-8000-000000000004', 2, 0)
    where package_job_id = 'd7720000-0000-4000-8000-000000000011'
  );
  assert not exists (select 1 from public.read_managed_publishing_package('d7720000-0000-4000-8000-000000000011', 'd7720000-0000-4000-8000-000000000004'));
  begin
    perform public.claim_managed_publishing('d7720000-0000-4000-8000-000000000011', repeat('a', 64), 'd7720000-0000-4000-8000-000000000004');
    assert false, 'A withdrawn request was claimed';
  exception when sqlstate 'PT409' then null;
  end;
end;
$$;
reset role;
do $$
begin
  assert (select count(*) from private.managed_publication_notifications) = 1;
  assert exists (
    select 1 from private.managed_publication_notifications notice
    join public.managed_publishing_requests request on request.package_job_id = notice.package_job_id
    where request.package_job_id = 'd7720000-0000-4000-8000-000000000012'
      and request.confirmed_at = notice.queued_at
  );
end;
$$;
set local request.jwt.claims = '{"role":"service_role"}';
set local role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_managed_publication_notification());
end;
$$;
reset role;
update auth.users set email_confirmed_at = now() where id = 'd7720000-0000-4000-8000-000000000001';
set local role service_role;
do $$
declare
  dispatch record;
begin
  select * into strict dispatch from public.claim_managed_publication_notification();
  assert dispatch.recipient_email = 'managed-author@local.test';
  assert dispatch.package_job_id = 'd7720000-0000-4000-8000-000000000012';
  assert not exists (select 1 from public.claim_managed_publication_notification());
  assert not public.settle_managed_publication_notification(dispatch.package_job_id, gen_random_uuid(), 'accepted', 'wrong');
  assert public.settle_managed_publication_notification(dispatch.package_job_id, dispatch.dispatch_id, 'accepted', 'synthetic-message-id');
  assert public.settle_managed_publication_notification(dispatch.package_job_id, dispatch.dispatch_id, 'accepted', 'synthetic-message-id');
  assert not public.settle_managed_publication_notification(dispatch.package_job_id, dispatch.dispatch_id, 'unconfirmed', null);
end;
$$;
rollback;
