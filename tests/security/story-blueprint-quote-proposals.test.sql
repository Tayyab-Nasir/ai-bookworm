-- Paid Story Blueprint proposals are private snapshots. They never modify the
-- canonical blueprint, materialize chapters, or publish a book on their own.
begin;

create temp table story_blueprint_quote_ids (
  owner_id uuid,
  viewer_id uuid,
  outsider_id uuid,
  workspace_id uuid,
  book_id uuid,
  blueprint_id uuid,
  proposal_one_id uuid,
  proposal_two_id uuid,
  accepted_job_id uuid,
  source_revision integer
) on commit drop;
grant select, insert, update on story_blueprint_quote_ids to authenticated, service_role;

insert into auth.users(id, email) values
  ('e2000000-0000-4000-8000-000000000001', 'blueprint-quote-owner@local.test'),
  ('e2000000-0000-4000-8000-000000000002', 'blueprint-quote-viewer@local.test'),
  ('e2000000-0000-4000-8000-000000000003', 'blueprint-quote-outsider@local.test');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000001"}';
do $$
declare
  v_workspace public.workspaces;
  v_book uuid;
  v_blueprint public.story_blueprints;
  v_details jsonb := '{"workingTitle":"The Clockmaker''s Orchard","premise":"A forgotten orchard keeps time for a fading city.","readerPromise":"A tender, intricate mystery.","genre":"Literary fantasy","tone":"Warm and precise","pointOfView":"Close third","tense":"Past","targetWordCount":80000,"synopsis":"A clockmaker follows a broken bell into a buried season.","theme":"Memory and repair","notes":""}';
  v_plan jsonb := '[{"id":"e2000000-0000-4000-8000-000000000011","title":"The Bell","purpose":"Open the mystery","summary":"A bell rings from the orchard.","targetWords":1800}]';
begin
  select * into strict v_workspace from public.create_workspace_with_owner('Story Blueprint Quotes');
  insert into public.books(workspace_id, title, author_name, language, created_by)
    values(v_workspace.id, 'The Clockmaker''s Orchard', 'Quote Owner', 'en', auth.uid())
    returning id into v_book;
  select * into strict v_blueprint from public.save_story_blueprint(v_book, 0, v_details, v_plan);
  insert into story_blueprint_quote_ids(owner_id, viewer_id, outsider_id, workspace_id, book_id, blueprint_id, source_revision)
    values(auth.uid(), 'e2000000-0000-4000-8000-000000000002',
      'e2000000-0000-4000-8000-000000000003', v_workspace.id, v_book, v_blueprint.id, v_blueprint.revision);

  assert not has_table_privilege('authenticated', 'public.story_blueprint_quote_requests', 'select'),
    'authenticated has quote request read grant';
  assert not has_table_privilege('authenticated', 'public.story_blueprint_quote_proposals', 'insert'),
    'authenticated has quote proposal write grant';
  assert not has_table_privilege('authenticated', 'public.story_blueprint_generation_results', 'update'),
    'authenticated has candidate write grant';
  assert not has_function_privilege('authenticated',
    'public.request_story_blueprint_quote(uuid,uuid,jsonb,text)', 'execute'), 'authenticated can request quote RPC';
  assert not has_function_privilege('authenticated',
    'public.claim_story_blueprint_quote_request(integer)', 'execute'), 'authenticated can claim quote count RPC';
  assert not has_function_privilege('authenticated',
    'public.fail_story_blueprint_quote_request(uuid,uuid)', 'execute'), 'authenticated can fail quote count RPC';
  assert not has_function_privilege('authenticated',
    'public.create_story_blueprint_quote_proposal(uuid,uuid,jsonb)', 'execute'), 'authenticated can create quote proposal RPC';
  assert not has_function_privilege('authenticated',
    'public.accept_story_blueprint_quote(uuid,uuid,integer)', 'execute'), 'authenticated can accept quote RPC';
  assert not has_function_privilege('authenticated',
    'public.claim_quoted_story_blueprint_job(integer)', 'execute'), 'authenticated can claim quote job RPC';
  assert not has_function_privilege('authenticated',
    'public.complete_quoted_story_blueprint_generation(uuid,uuid)', 'execute'), 'authenticated can complete quote job RPC';
  assert not has_function_privilege('authenticated',
    'public.mark_story_blueprint_generation_requires_review(uuid,uuid,text,text)', 'execute'),
    'authenticated can mark a quoted generation for review';
  begin
    perform public.request_story_blueprint_quote(v_book, auth.uid(), jsonb_build_object(
      'version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai',
      'approved', true, 'expiresAt', clock_timestamp() + interval '20 minutes'
    ), 'authenticated-request');
    assert false, 'authenticated caller requested private quote';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.story_blueprint_quote_requests;
    assert false, 'authenticated caller deleted private quote request';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.story_blueprint_quote_proposals set reserved_credits = 1;
    assert false, 'authenticated caller updated private quote proposal';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.story_blueprint_generation_results(
      ai_job_id, proposal_id, workspace_id, book_id, source_revision, source_sha256,
      provider_receipt_json, candidate_json, candidate_sha256
    ) values (
      gen_random_uuid(), gen_random_uuid(), v_workspace.id, v_book, 1, repeat('a', 64),
      '{}', '{}', repeat('b', 64)
    );
    assert false, 'authenticated caller inserted private candidate';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

insert into public.workspace_members(workspace_id, user_id, role)
  select workspace_id, viewer_id, 'viewer'::public.member_role from story_blueprint_quote_ids;

set local role service_role;
do $$
declare
  v_ids story_blueprint_quote_ids;
  v_catalog jsonb := jsonb_build_object(
    'version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai',
    'approved', true, 'expiresAt', clock_timestamp() + interval '20 minutes'
  );
  v_request public.story_blueprint_quote_requests;
  v_replay public.story_blueprint_quote_requests;
  v_counting public.story_blueprint_quote_requests;
  v_proposal public.story_blueprint_quote_proposals;
  v_replay_proposal public.story_blueprint_quote_proposals;
  v_expired_request public.story_blueprint_quote_requests;
  v_expired_counting public.story_blueprint_quote_requests;
  v_quote jsonb;
  v_expired_quote jsonb;
  v_expired_proposal uuid := gen_random_uuid();
begin
  select * into strict v_ids from story_blueprint_quote_ids;
  -- A service caller still cannot manufacture a request for an editor from a
  -- different workspace or a viewer in this workspace.
  begin
    perform public.request_story_blueprint_quote(v_ids.book_id, v_ids.outsider_id, v_catalog, 'outsider-request');
    assert false, 'outsider requested a tenant quote';
  exception when insufficient_privilege then
    assert sqlerrm = 'story blueprint editing access required';
  end;
  begin
    perform public.request_story_blueprint_quote(v_ids.book_id, v_ids.viewer_id, v_catalog, 'viewer-request-a');
    assert false, 'viewer requested a paid quote';
  exception when insufficient_privilege then
    assert sqlerrm = 'story blueprint editing access required';
  end;

  select * into strict v_request from public.request_story_blueprint_quote(
    v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-request-one'
  );
  select * into strict v_replay from public.request_story_blueprint_quote(
    v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-request-one'
  );
  assert v_replay.id = v_request.id and v_request.source_revision = v_ids.source_revision
    and v_request.generation_job_id is not null
    and v_request.book_snapshot_json = jsonb_build_object(
      'title', 'The Clockmaker''s Orchard', 'author', 'Quote Owner', 'language', 'en'
    ), 'quote request did not persist an immutable book snapshot or replay';
  begin
    insert into public.story_blueprint_quote_requests(
      user_id, workspace_id, book_id, blueprint_id, source_revision, source_snapshot_json, book_snapshot_json,
      source_sha256, catalog_json, idempotency_key, generation_job_id, status
    ) values (
      v_request.user_id, v_request.workspace_id, v_request.book_id, v_request.blueprint_id,
      v_request.source_revision, v_request.source_snapshot_json,
      jsonb_build_object('title', '', 'author', 'Quote Owner', 'language', 'en'),
      v_request.source_sha256, v_request.catalog_json, 'invalid-book-snapshot', gen_random_uuid(), 'failed'
    );
    assert false, 'empty book title entered quote snapshot';
  exception when check_violation then null;
  end;
  begin
    insert into public.story_blueprint_quote_requests(
      user_id, workspace_id, book_id, blueprint_id, source_revision, source_snapshot_json, book_snapshot_json,
      source_sha256, catalog_json, idempotency_key, generation_job_id, status
    ) values (
      v_request.user_id, v_request.workspace_id, v_request.book_id, v_request.blueprint_id,
      v_request.source_revision, v_request.source_snapshot_json,
      jsonb_build_object('title', 'Valid title', 'author', repeat('a', 501), 'language', 'en'),
      v_request.source_sha256, v_request.catalog_json, 'invalid-book-author', gen_random_uuid(), 'failed'
    );
    assert false, 'overlong book author entered quote snapshot';
  exception when check_violation then null;
  end;
  begin
    insert into public.story_blueprint_quote_requests(
      user_id, workspace_id, book_id, blueprint_id, source_revision, source_snapshot_json, book_snapshot_json,
      source_sha256, catalog_json, idempotency_key, generation_job_id, status
    ) values (
      v_request.user_id, v_request.workspace_id, v_request.book_id, v_request.blueprint_id,
      v_request.source_revision, v_request.source_snapshot_json,
      jsonb_build_object('title', 'Valid title', 'author', 'Quote Owner', 'language', ''),
      v_request.source_sha256, v_request.catalog_json, 'invalid-book-language', gen_random_uuid(), 'failed'
    );
    assert false, 'empty book language entered quote snapshot';
  exception when check_violation then null;
  end;
  begin
    perform public.request_story_blueprint_quote(v_ids.book_id, v_ids.owner_id,
      jsonb_set(v_catalog, '{model}', '"other-model"'), 'owner-request-one');
    assert false, 'request key accepted a changed catalog';
  exception when unique_violation then
    assert sqlerrm = 'story blueprint quote key conflict';
  end;
  begin
    perform public.request_story_blueprint_quote(
      v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-request-one-other-key'
    );
    assert false, 'second active quote request entered the same user/book queue';
  exception when unique_violation then
    assert sqlerrm = 'story blueprint quote already preparing';
  end;

  v_quote := jsonb_build_object(
    'scope', jsonb_build_object('jobId', v_request.generation_job_id, 'userId', v_ids.owner_id,
      'workspaceId', v_ids.workspace_id, 'inputSha256', repeat('d', 64)),
    'reservedCredits', '5', 'fingerprint', repeat('a', 64),
    'policy', jsonb_build_object('approved', true, 'version', 'policy-v1'),
    'price', jsonb_build_object('version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai'),
    'createdAt', clock_timestamp() - interval '1 second', 'expiresAt', clock_timestamp() + interval '10 minutes'
  );
  select * into strict v_counting from public.claim_story_blueprint_quote_request(120);
  assert v_counting.id = v_request.id and v_counting.status = 'counting'
    and v_counting.attempts = 1 and v_counting.lease_token is not null
    and v_counting.lease_expires_at > clock_timestamp(), 'queued quote request did not receive a bounded count lease';
  begin
    perform public.create_story_blueprint_quote_proposal(v_request.id, gen_random_uuid(), v_quote);
    assert false, 'quote proposal accepted a mismatched count lease';
  exception when serialization_failure then
    assert sqlerrm = 'story blueprint quote request lease lost';
  end;
  select * into strict v_proposal from public.create_story_blueprint_quote_proposal(
    v_request.id, v_counting.lease_token, v_quote
  );
  select * into strict v_replay_proposal from public.create_story_blueprint_quote_proposal(
    v_request.id, v_counting.lease_token, v_quote
  );
  assert v_replay_proposal.id = v_proposal.id and v_proposal.reserved_credits = 5,
    'quote proposal did not replay exactly';
  assert (select status from public.story_blueprint_quote_requests where id = v_request.id) = 'ready'
    and not exists(select 1 from public.story_blueprint_quote_requests
      where id = v_request.id and (lease_token is not null or lease_expires_at is not null)),
    'leased proposal creation did not atomically mark request ready';
  assert v_proposal.generation_request_sha256 = v_quote#>>'{scope,inputSha256}'
    and v_proposal.generation_request_sha256 <> v_proposal.source_sha256,
    'proposal did not retain the canonical generation fingerprint separately from source snapshot hash';
  begin
    perform public.create_story_blueprint_quote_proposal(v_request.id, v_counting.lease_token,
      jsonb_set(v_quote, '{reservedCredits}', '"6"'));
    assert false, 'quote proposal accepted changed canonical quote';
  exception when unique_violation then
    assert sqlerrm = 'story blueprint quote proposal conflict';
  end;
  begin
    perform public.accept_story_blueprint_quote(v_proposal.id, v_ids.owner_id, 4);
    assert false, 'wrong credit confirmation accepted';
  exception when check_violation then
    assert sqlerrm = 'story blueprint proposal credit confirmation mismatch';
  end;

  -- Expiry is checked at acceptance even if a trusted quote producer stored an
  -- already-expired offer before its user-facing handoff.
  select * into strict v_expired_request from public.request_story_blueprint_quote(
    v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-expired-request'
  );
  select * into strict v_expired_counting from public.claim_story_blueprint_quote_request(120);
  assert v_expired_counting.id = v_expired_request.id and v_expired_counting.attempts = 1,
    'expired-offer fixture did not receive its original count lease';
  update public.story_blueprint_quote_requests
    set lease_expires_at = clock_timestamp() - interval '1 second'
    where id = v_expired_request.id;
  assert (select count(*) from public.claim_story_blueprint_quote_request(120)) = 0,
    'expired quote count lease was re-leased for a second provider count';
  assert (select status from public.story_blueprint_quote_requests where id = v_expired_request.id) = 'failed'
    and (select error_code from public.story_blueprint_quote_requests where id = v_expired_request.id) = 'counting_outcome_unknown'
    and not exists(select 1 from public.story_blueprint_quote_requests
      where id = v_expired_request.id and (lease_token is not null or lease_expires_at is not null)),
    'expired quote count did not terminalize as an unknown outcome';
  v_expired_quote := jsonb_build_object(
    'scope', jsonb_build_object('jobId', v_expired_request.generation_job_id, 'userId', v_ids.owner_id,
      'workspaceId', v_ids.workspace_id, 'inputSha256', repeat('e', 64)),
    'reservedCredits', '5', 'fingerprint', repeat('b', 64),
    'policy', jsonb_build_object('approved', true, 'version', 'policy-v1'),
    'price', jsonb_build_object('version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai'),
    'createdAt', clock_timestamp() - interval '10 minutes', 'expiresAt', clock_timestamp() - interval '5 minutes'
  );
  insert into public.story_blueprint_quote_proposals(
    id, request_id, user_id, workspace_id, book_id, blueprint_id, source_revision,
    source_snapshot_json, book_snapshot_json, source_sha256, generation_request_sha256, catalog_json, generation_job_id,
    usage_quote_json, reserved_credits, created_at, expires_at
  ) values (
    v_expired_proposal, v_expired_request.id, v_expired_request.user_id, v_expired_request.workspace_id,
    v_expired_request.book_id, v_expired_request.blueprint_id, v_expired_request.source_revision,
    v_expired_request.source_snapshot_json, v_expired_request.book_snapshot_json, v_expired_request.source_sha256,
    v_expired_quote#>>'{scope,inputSha256}', v_expired_request.catalog_json,
    v_expired_request.generation_job_id, v_expired_quote, 5,
    clock_timestamp() - interval '10 minutes', clock_timestamp() - interval '5 minutes'
  );
  begin
    perform public.accept_story_blueprint_quote(v_expired_proposal, v_ids.owner_id, 5);
    assert false, 'expired proposal accepted';
  exception when invalid_parameter_value then
    assert sqlerrm = 'story blueprint proposal expired';
  end;

  update story_blueprint_quote_ids set proposal_one_id = v_proposal.id;
end;
$$;
reset role;

-- Change the saved source after the first quote. It must not be accepted.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000001"}';
do $$
declare v_ids story_blueprint_quote_ids; v_updated public.story_blueprints;
  v_details jsonb := '{"workingTitle":"The Clockmaker''s Orchard","premise":"A forgotten orchard keeps time for a fading city.","readerPromise":"A tender, intricate mystery.","genre":"Literary fantasy","tone":"Warm and precise","pointOfView":"Close third","tense":"Past","targetWordCount":80000,"synopsis":"A clockmaker follows a broken bell into a buried season.","theme":"Memory and repair","notes":"Source changed after quote."}';
  v_plan jsonb := '[{"id":"e2000000-0000-4000-8000-000000000011","title":"The Bell","purpose":"Open the mystery","summary":"A bell rings from the orchard.","targetWords":1800}]';
begin
  select * into strict v_ids from story_blueprint_quote_ids;
  select * into strict v_updated from public.save_story_blueprint(v_ids.book_id, v_ids.source_revision, v_details, v_plan);
  update story_blueprint_quote_ids set source_revision = v_updated.revision;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_ids story_blueprint_quote_ids;
  v_first public.story_blueprint_quote_proposals;
  v_catalog jsonb := jsonb_build_object(
    'version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai',
    'approved', true, 'expiresAt', clock_timestamp() + interval '20 minutes'
  );
  v_request public.story_blueprint_quote_requests;
  v_counting public.story_blueprint_quote_requests;
  v_proposal public.story_blueprint_quote_proposals;
  v_quote jsonb;
  v_unfunded public.ai_jobs;
  v_job public.ai_jobs;
begin
  select * into strict v_ids from story_blueprint_quote_ids;
  select * into strict v_first from public.story_blueprint_quote_proposals where id = v_ids.proposal_one_id;
  begin
    perform public.accept_story_blueprint_quote(v_first.id, v_ids.owner_id, 5);
    assert false, 'stale source quote accepted';
  exception when check_violation then
    assert sqlerrm = 'story blueprint source unavailable or changed';
  end;

  -- Even a trusted service cannot start a preallocated but unfunded proposal.
  insert into public.ai_jobs(
    id, workspace_id, book_id, agent_type, billing_mode, status, input_ref, idempotency_key, created_by
  ) values (
    v_first.generation_job_id, v_first.workspace_id, v_first.book_id, 'story_blueprint', 'quoted', 'queued',
    jsonb_build_object('proposalId', v_first.id, 'requestId', v_first.request_id,
      'blueprintId', v_first.blueprint_id, 'sourceRevision', v_first.source_revision,
      'sourceSha256', v_first.source_sha256,
      'generationRequestSha256', v_first.generation_request_sha256),
    'story-blueprint:' || v_first.id::text, v_first.user_id
  ) returning * into v_unfunded;
  assert (select count(*) from public.claim_quoted_story_blueprint_job(180)) = 0,
    'unaccepted or unfunded proposal entered worker queue';
  begin
    update public.ai_jobs set status = 'running' where id = v_unfunded.id;
    assert false, 'unfunded quoted job entered running state';
  exception when check_violation then
    assert sqlerrm = 'quoted job requires funded hold';
  end;
  begin
    update public.ai_jobs set status = 'succeeded' where id = v_unfunded.id;
    assert false, 'unfunded quoted job bypassed private-result settlement';
  exception when check_violation then
    assert sqlerrm = 'story blueprint success requires settled private result';
  end;

  select * into strict v_request from public.request_story_blueprint_quote(
    v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-request-two'
  );
  assert v_request.source_revision = v_ids.source_revision, 'new quote did not use current saved blueprint';
  v_quote := jsonb_build_object(
    'scope', jsonb_build_object('jobId', v_request.generation_job_id, 'userId', v_ids.owner_id,
      'workspaceId', v_ids.workspace_id, 'inputSha256', repeat('f', 64)),
    'reservedCredits', '5', 'fingerprint', repeat('c', 64),
    'policy', jsonb_build_object('approved', true, 'version', 'policy-v1'),
    'price', jsonb_build_object('version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai'),
    'createdAt', clock_timestamp() - interval '1 second', 'expiresAt', clock_timestamp() + interval '10 minutes'
  );
  select * into strict v_counting from public.claim_story_blueprint_quote_request(120);
  assert v_counting.id = v_request.id and v_counting.status = 'counting',
    'second quote request did not receive a count lease';
  select * into strict v_proposal from public.create_story_blueprint_quote_proposal(
    v_request.id, v_counting.lease_token, v_quote
  );
  insert into public.credit_ledger(user_id, workspace_id, source, amount, balance_after)
    values(v_ids.owner_id, v_ids.workspace_id, 'purchase', 5, 0);
  select * into strict v_job from public.accept_story_blueprint_quote(v_proposal.id, v_ids.owner_id, 5);
  assert v_job.id = v_proposal.generation_job_id and v_job.agent_type = 'story_blueprint'
    and v_job.billing_mode = 'quoted' and v_job.status = 'queued', 'acceptance did not create quoted job';
  assert v_job.input_ref ?& array['proposalId', 'requestId', 'blueprintId', 'sourceRevision', 'sourceSha256', 'generationRequestSha256']
    and not (v_job.input_ref ? 'details') and not (v_job.input_ref ? 'chapterPlan'),
    'queued job contains source text instead of pointers';
  assert (select status from public.funded_usage_quotes where job_id = v_job.id) = 'held',
    'accepted proposal lacks funded hold';
  assert (select sum(amount) from public.credit_ledger where user_id = v_ids.owner_id) = 0,
    'acceptance did not atomically reserve confirmed credits';
  assert not exists(select 1 from public.story_blueprint_materializations where blueprint_id = v_ids.blueprint_id),
    'acceptance materialized a chapter';
  assert not exists(select 1 from public.usage_events where user_id = v_ids.owner_id),
    'acceptance inserted usage before generation';
  update story_blueprint_quote_ids set proposal_two_id = v_proposal.id, accepted_job_id = v_job.id;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_ids story_blueprint_quote_ids;
  v_proposal public.story_blueprint_quote_proposals;
  v_job public.ai_jobs;
  v_claimed public.ai_jobs;
  v_recovered public.ai_jobs;
  v_result public.story_blueprint_generation_results;
  v_replay public.story_blueprint_generation_results;
  v_settlement jsonb;
  v_receipt jsonb := '{"provider":"openai","model":"gpt-6-astra","requestId":"local-story-blueprint-1","usage":{"inputTokens":120,"outputTokens":240}}';
  v_candidate jsonb := '{"details":{"workingTitle":"Candidate title","premise":"Candidate premise"},"chapterPlan":[{"id":"e2000000-0000-4000-8000-000000000021","title":"Candidate opening"}]}';
begin
  select * into strict v_ids from story_blueprint_quote_ids;
  select * into strict v_proposal from public.story_blueprint_quote_proposals where id = v_ids.proposal_two_id;
  select * into strict v_job from public.ai_jobs where id = v_ids.accepted_job_id;
  select * into strict v_claimed from public.claim_quoted_story_blueprint_job(180);
  assert v_claimed.id = v_job.id and v_claimed.status = 'running' and v_claimed.lease_token is not null,
    'held proposal was not claimed with a lease';
  assert public.renew_story_blueprint_generation_lease(v_job.id, v_claimed.lease_token, 180),
    'held proposal lease did not renew';
  assert not public.renew_story_blueprint_generation_lease(v_job.id, gen_random_uuid(), 180),
    'wrong lease token renewed proposal';
  assert public.claim_funded_dispatch(v_job.id, v_claimed.lease_token, v_proposal.generation_request_sha256, 'gpt-6-astra'),
    'held proposal did not authorize one provider dispatch';
  assert not public.claim_funded_dispatch(v_job.id, v_claimed.lease_token, v_proposal.generation_request_sha256, 'gpt-6-astra'),
    'proposal authorized a second provider dispatch';
  select * into strict v_result from public.record_story_blueprint_generation_result(
    v_job.id, v_claimed.lease_token, v_receipt, v_candidate
  );
  select * into strict v_replay from public.record_story_blueprint_generation_result(
    v_job.id, v_claimed.lease_token, v_receipt, v_candidate
  );
  assert v_replay.ai_job_id = v_result.ai_job_id and v_result.proposal_id = v_proposal.id,
    'generation receipt did not replay exactly';
  assert (select status from public.ai_jobs where id = v_job.id) = 'running'
    and (select output_ref from public.ai_jobs where id = v_job.id) is null,
    'candidate auto-completed or exposed through public job output';
  -- A process can die after storing the private provider receipt but before
  -- settlement. Its next lease must recover only that receipt, never issue a
  -- second provider dispatch or count against the pre-dispatch retry budget.
  update public.ai_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
    where id = v_job.id;
  select * into strict v_recovered from public.claim_quoted_story_blueprint_job(180);
  assert v_recovered.id = v_job.id and v_recovered.lease_token is distinct from v_claimed.lease_token
    and v_recovered.attempts = v_claimed.attempts,
    'private receipt recovery did not receive a no-redispatch lease';
  v_claimed := v_recovered;
  assert not public.claim_funded_dispatch(v_job.id, v_claimed.lease_token, v_proposal.generation_request_sha256, 'gpt-6-astra'),
    'receipt recovery authorized a second provider dispatch';
  begin
    perform public.record_story_blueprint_generation_result(
      v_job.id, v_claimed.lease_token, v_receipt, jsonb_set(v_candidate, '{details,workingTitle}', '"Changed"')
    );
    assert false, 'different candidate overwrote immutable receipt';
  exception when unique_violation then
    assert sqlerrm = 'story blueprint generation result conflict';
  end;
  begin
    update public.story_blueprint_generation_results set candidate_json = '{}' where ai_job_id = v_job.id;
    assert false, 'service overwrote immutable receipt';
  exception when insufficient_privilege then null;
  end;
  -- A financial-review hold must never make a private candidate successful.
  -- Roll back this local branch, then settle the same held quote normally.
  begin
    perform public.settle_funded_usage_quote(v_job.id, jsonb_build_object(
      'status', 'requires_review', 'fingerprint', v_proposal.usage_quote_json->>'fingerprint',
      'requestId', 'local-story-blueprint-review', 'heldCredits', '5'
    ));
    begin
      perform public.complete_quoted_story_blueprint_generation(v_job.id, v_claimed.lease_token);
      raise exception 'review completion unexpectedly succeeded';
    exception when check_violation then
      assert sqlerrm = 'story blueprint completion requires settled funded quote';
    end;
    raise exception 'rollback review settlement assertion';
  exception when raise_exception then
    if sqlerrm <> 'rollback review settlement assertion' then raise; end if;
  end;
  assert (select status from public.funded_usage_quotes where job_id = v_job.id) = 'held',
    'review-settlement assertion did not roll back to held quote';
  v_settlement := jsonb_build_object(
    'status', 'settle', 'fingerprint', v_proposal.usage_quote_json->>'fingerprint',
    'requestId', 'local-story-blueprint-1',
    'priceVersion', v_proposal.usage_quote_json#>>'{price,version}',
    'policyVersion', v_proposal.usage_quote_json#>>'{policy,version}',
    'debitCredits', '5', 'releaseCredits', '0'
  );
  perform public.settle_funded_usage_quote(v_job.id, v_settlement);
  select * into strict v_job from public.complete_quoted_story_blueprint_generation(v_job.id, v_claimed.lease_token);
  assert v_job.status = 'succeeded' and v_job.lease_token is null and v_job.lease_expires_at is null
    and v_job.output_ref is null and (select status from public.funded_usage_quotes where job_id = v_job.id) = 'settled',
    'settled private candidate did not complete safely';
end;
$$;
reset role;

-- A later manual blueprint save cannot turn an exact accepted retry into a
-- second debit or a stale rejection. The private candidate still is not applied.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000001"}';
do $$
declare v_ids story_blueprint_quote_ids; v_updated public.story_blueprints;
  v_details jsonb := '{"workingTitle":"The Clockmaker''s Orchard","premise":"A forgotten orchard keeps time for a fading city.","readerPromise":"A tender, intricate mystery.","genre":"Literary fantasy","tone":"Warm and precise","pointOfView":"Close third","tense":"Past","targetWordCount":80000,"synopsis":"A clockmaker follows a broken bell into a buried season.","theme":"Memory and repair","notes":"Saved after accepted quote."}';
  v_plan jsonb := '[{"id":"e2000000-0000-4000-8000-000000000011","title":"The Bell","purpose":"Open the mystery","summary":"A bell rings from the orchard.","targetWords":1800}]';
begin
  select * into strict v_ids from story_blueprint_quote_ids;
  select * into strict v_updated from public.save_story_blueprint(v_ids.book_id, v_ids.source_revision, v_details, v_plan);
  assert v_updated.revision = v_ids.source_revision + 1, 'manual blueprint revision did not advance';
  assert not exists(select 1 from public.story_blueprint_materializations where blueprint_id = v_ids.blueprint_id),
    'private candidate materialized a chapter';
  begin
    update public.story_blueprint_generation_results set candidate_json = '{}' where ai_job_id = v_ids.accepted_job_id;
    assert false, 'authenticated caller changed private candidate';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
 declare
  v_ids story_blueprint_quote_ids;
  v_job public.ai_jobs;
  v_catalog jsonb := jsonb_build_object(
    'version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai',
    'approved', true, 'expiresAt', clock_timestamp() + interval '20 minutes'
  );
  v_review_request public.story_blueprint_quote_requests;
  v_review_counting public.story_blueprint_quote_requests;
  v_review_proposal public.story_blueprint_quote_proposals;
  v_review_job public.ai_jobs;
  v_review_claimed public.ai_jobs;
  v_review_quote jsonb;
  v_rate_request public.story_blueprint_quote_requests;
  v_rate_counting public.story_blueprint_quote_requests;
 begin
  select * into strict v_ids from story_blueprint_quote_ids;
  select * into strict v_job from public.accept_story_blueprint_quote(v_ids.proposal_two_id, v_ids.owner_id, 5);
  assert v_job.id = v_ids.accepted_job_id, 'accepted proposal replay created another job';
  assert (select count(*) from public.ai_jobs where id = v_ids.accepted_job_id) = 1,
    'accepted proposal replay duplicated job';
  assert (select count(*) from public.funded_usage_quotes where job_id = v_ids.accepted_job_id) = 1,
    'accepted proposal replay duplicated hold';
  assert (select count(*) from public.credit_ledger
    where user_id = v_ids.owner_id and source = 'generation_reservation' and reference_id = v_ids.accepted_job_id) = 1,
    'accepted proposal replay duplicated reservation';

  -- A provider outcome can be unknown after the irreversible dispatch marker
  -- but before there is a durable private receipt. It must retain the full
  -- hold, stop ordinary retries, and never expose a variable provider error.
  select * into strict v_review_request from public.request_story_blueprint_quote(
    v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-review-request'
  );
  select * into strict v_review_counting from public.claim_story_blueprint_quote_request(120);
  assert v_review_counting.id = v_review_request.id and v_review_counting.status = 'counting',
    'review fixture did not receive a quote count lease';
  v_review_quote := jsonb_build_object(
    'scope', jsonb_build_object('jobId', v_review_request.generation_job_id, 'userId', v_ids.owner_id,
      'workspaceId', v_ids.workspace_id, 'inputSha256', repeat('1', 64)),
    'reservedCredits', '5', 'fingerprint', repeat('2', 64),
    'policy', jsonb_build_object('approved', true, 'version', 'policy-v1'),
    'price', jsonb_build_object('version', 'catalog-v1', 'model', 'gpt-6-astra', 'provider', 'openai'),
    'createdAt', clock_timestamp() - interval '1 second', 'expiresAt', clock_timestamp() + interval '10 minutes'
  );
  select * into strict v_review_proposal from public.create_story_blueprint_quote_proposal(
    v_review_request.id, v_review_counting.lease_token, v_review_quote
  );
  insert into public.credit_ledger(user_id, workspace_id, source, amount, balance_after)
    values(v_ids.owner_id, v_ids.workspace_id, 'purchase', 5, 0);
  select * into strict v_review_job from public.accept_story_blueprint_quote(
    v_review_proposal.id, v_ids.owner_id, 5
  );
  select * into strict v_review_claimed from public.claim_quoted_story_blueprint_job(180);
  assert v_review_claimed.id = v_review_job.id and v_review_claimed.lease_token is not null,
    'review fixture did not receive a quoted generation lease';
  assert public.claim_funded_dispatch(
    v_review_job.id, v_review_claimed.lease_token, v_review_proposal.generation_request_sha256, 'gpt-6-astra'
  ), 'review fixture did not receive its one dispatch marker';
  begin
    perform public.mark_story_blueprint_generation_requires_review(
      v_review_job.id, gen_random_uuid(), 'local-story-blueprint-unknown-1', 'provider_outcome_unknown'
    );
    assert false, 'review marker accepted a mismatched generation lease';
  exception when serialization_failure then
    assert sqlerrm = 'story blueprint generation lease lost';
  end;
  assert public.mark_story_blueprint_generation_requires_review(
    v_review_job.id, v_review_claimed.lease_token,
    'local-story-blueprint-unknown-1', 'provider_outcome_unknown'
  ), 'unknown dispatched outcome could not enter financial review';
  assert (select status from public.ai_jobs where id = v_review_job.id) = 'failed'
    and (select lease_token from public.ai_jobs where id = v_review_job.id) is null
    and (select lease_expires_at from public.ai_jobs where id = v_review_job.id) is null
    and (select error_code from public.ai_jobs where id = v_review_job.id) = 'story_blueprint_generation_requires_review'
    and (select error_message from public.ai_jobs where id = v_review_job.id) = 'Story Blueprint generation requires review',
    'unknown dispatched outcome did not terminalize with a safe constant job error';
  assert (select status from public.funded_usage_quotes where job_id = v_review_job.id) = 'requires_review'
    and (select settlement_json->>'heldCredits' from public.funded_usage_quotes where job_id = v_review_job.id) = '5'
    and (select settlement_json->>'reason' from public.funded_usage_quotes where job_id = v_review_job.id) = 'provider_outcome_unknown'
    and not exists(select 1 from public.credit_ledger
      where reference_id = v_review_job.id and source = 'generation_release')
    and not exists(select 1 from public.story_blueprint_generation_results where ai_job_id = v_review_job.id),
    'unknown dispatched outcome refunded, exposed, or fabricated a private result';
  begin
    perform public.claim_funded_dispatch(
      v_review_job.id, v_review_claimed.lease_token, v_review_proposal.generation_request_sha256, 'gpt-6-astra'
    );
    assert false, 'review-marked job authorized a second provider dispatch';
  exception when serialization_failure then
    assert sqlerrm = 'funded dispatch lease lost';
  end;

  -- The first five requests in this transaction are: proposal one, the
  -- terminalized expired-count fixture, proposal two, review fixture, and this
  -- explicitly failed rate fixture. A sixth random key is still rate limited.
  select * into strict v_rate_request from public.request_story_blueprint_quote(
    v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-rate-request-one'
  );
  select * into strict v_rate_counting from public.claim_story_blueprint_quote_request(120);
  assert v_rate_counting.id = v_rate_request.id and v_rate_counting.attempts = 1,
    'rate fixture did not receive its first bounded count attempt';
  assert not public.fail_story_blueprint_quote_request(v_rate_request.id, gen_random_uuid()),
    'quote count failure accepted a mismatched lease';
  assert public.fail_story_blueprint_quote_request(v_rate_request.id, v_rate_counting.lease_token),
    'lease-fenced quote count failure rejected its matching lease';
  assert (select status from public.story_blueprint_quote_requests where id = v_rate_request.id) = 'failed',
    'lease-fenced quote count failure did not terminalize';
  assert (select error_code from public.story_blueprint_quote_requests where id = v_rate_request.id)
      = 'story_blueprint_quote_count_failed',
    'lease-fenced quote count failure did not record its stable code';
  assert not exists(select 1 from public.story_blueprint_quote_requests
      where id = v_rate_request.id and (lease_token is not null or lease_expires_at is not null)),
    'lease-fenced quote count failure retained its lease';
  begin
    perform public.request_story_blueprint_quote(
      v_ids.book_id, v_ids.owner_id, v_catalog, 'owner-rate-request-two'
    );
    assert false, 'server quote request rate limit was bypassed';
  exception when program_limit_exceeded then
    assert sqlerrm = 'story blueprint quote request limit reached';
  end;
end;
$$;
reset role;

rollback;
