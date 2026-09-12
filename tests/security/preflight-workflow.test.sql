-- Preflight completion is service-only, atomic, and replay-safe.
begin;

insert into auth.users(id,email) values
  ('a8000000-0000-0000-0000-000000000001','preflight-editor@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('18000000-0000-4000-8000-000000000001','Preflight Org','preflight-org','a8000000-0000-0000-0000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
  ('18000000-0000-4000-8000-000000000001','a8000000-0000-0000-0000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('28000000-0000-4000-8000-000000000001','18000000-0000-4000-8000-000000000001','Preflight Workspace','preflight-ws','a8000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
  ('28000000-0000-4000-8000-000000000001','a8000000-0000-0000-0000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
  ('38000000-0000-4000-8000-000000000001','28000000-0000-4000-8000-000000000001','Validated Book','Author','a8000000-0000-0000-0000-000000000001');
insert into public.editions(id,book_id,type,language) values
  ('48000000-0000-4000-8000-000000000001','38000000-0000-4000-8000-000000000001','ebook','en');
insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,idempotency_key,created_by,started_at) values
  ('58000000-0000-4000-8000-000000000001','38000000-0000-4000-8000-000000000001','48000000-0000-4000-8000-000000000001','kdp','running','{"action":"validate"}','preflight-success','a8000000-0000-0000-0000-000000000001',now()),
  ('58000000-0000-4000-8000-000000000002','38000000-0000-4000-8000-000000000001','48000000-0000-4000-8000-000000000001','kdp','running','{"action":"validate"}','preflight-invalid','a8000000-0000-0000-0000-000000000001',now());

do $$
begin
  assert not has_function_privilege('anon', 'public.complete_preflight_job(uuid,jsonb)', 'execute'), 'anon can complete preflight';
  assert not has_function_privilege('authenticated', 'public.complete_preflight_job(uuid,jsonb)', 'execute'), 'authenticated can complete preflight';
  assert has_function_privilege('service_role', 'public.complete_preflight_job(uuid,jsonb)', 'execute'), 'service role cannot complete preflight';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a8000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  begin
    perform public.complete_preflight_job('58000000-0000-4000-8000-000000000001',
      '{"ruleVersion":"core-1","errors":0,"warnings":0,"findings":[]}'::jsonb);
    assert false, 'authenticated completed preflight';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
select public.complete_preflight_job(
  '58000000-0000-4000-8000-000000000001',
  '{"ruleVersion":"core-1+kdp-1","requestedChannel":"kdp","channel":"kdp","errors":1,"warnings":0,"findings":[{"code":"NO_ALT_TEXT","message":"image lacks alt text","location":"chapter:1","severity":"error","category":"accessibility","rule_id":"CORE-A11Y-001","rule_version":"core-1+kdp-1"}]}'::jsonb
);

do $$
begin
  assert (select status = 'succeeded' from public.publishing_jobs where id='58000000-0000-4000-8000-000000000001'), 'job did not succeed';
  assert (select count(*) = 1 from public.publishing_validations where publishing_job_id='58000000-0000-4000-8000-000000000001'), 'finding not stored';
  assert (select count(*) = 1 from public.activity_events where event_type='edition_validated' and entity_id='48000000-0000-4000-8000-000000000001'), 'activity missing';
end $$;

-- A replay returns the completed row without duplicating findings or activity.
select public.complete_preflight_job(
  '58000000-0000-4000-8000-000000000001',
  '{"ruleVersion":"other","errors":0,"warnings":0,"findings":[]}'::jsonb
);
do $$
begin
  assert (select count(*) = 1 from public.publishing_validations where publishing_job_id='58000000-0000-4000-8000-000000000001'), 'replay duplicated findings';
  assert (select count(*) = 1 from public.activity_events where event_type='edition_validated' and entity_id='48000000-0000-4000-8000-000000000001'), 'replay duplicated activity';
end $$;

do $$
begin
  begin
    perform public.complete_preflight_job(
      '58000000-0000-4000-8000-000000000002',
      '{"ruleVersion":"core-1","errors":1,"warnings":0,"findings":[{"code":"BAD","message":"bad finding","location":"x","severity":"critical","rule_id":"R","rule_version":"core-1"}]}'::jsonb
    );
    assert false, 'invalid finding was accepted';
  exception when invalid_parameter_value then null;
  end;
  assert (select status = 'running' from public.publishing_jobs where id='58000000-0000-4000-8000-000000000002'), 'invalid completion mutated job';
  assert (select count(*) = 0 from public.publishing_validations where publishing_job_id='58000000-0000-4000-8000-000000000002'), 'invalid completion left findings';
end $$;

rollback;
