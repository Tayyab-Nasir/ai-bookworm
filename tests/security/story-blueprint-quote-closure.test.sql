begin;
insert into auth.users(id,email) values
  ('f3100000-0000-4000-8000-000000000001','blueprint-closure-owner@local.test'),
  ('f3100000-0000-4000-8000-000000000002','blueprint-closure-outsider@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('f3100000-0000-4000-8000-000000000003','Synthetic','blueprint-closure','f3100000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('f3100000-0000-4000-8000-000000000004','f3100000-0000-4000-8000-000000000003','Synthetic','blueprint-closure','f3100000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
  ('f3100000-0000-4000-8000-000000000004','f3100000-0000-4000-8000-000000000001','writer','active');
insert into public.books(id,workspace_id,title,author_name,language,created_by) values
  ('f3100000-0000-4000-8000-000000000005','f3100000-0000-4000-8000-000000000004','Synthetic','Author','en','f3100000-0000-4000-8000-000000000001');
insert into public.story_blueprints(book_id,created_by,updated_by) values
  ('f3100000-0000-4000-8000-000000000005','f3100000-0000-4000-8000-000000000001','f3100000-0000-4000-8000-000000000001');

do $$ begin
  assert not has_function_privilege('authenticated','public.close_story_blueprint_quote_request(uuid,uuid,text)','execute');
  assert not has_table_privilege('authenticated','public.story_blueprint_quote_identities','select');
  assert not has_table_privilege('service_role','public.story_blueprint_quote_identities','update');
  assert not has_table_privilege('service_role','public.story_blueprint_quote_identities','delete');
  assert to_regclass('public.story_blueprint_quote_identities_book') is not null;
  assert to_regclass('public.story_blueprint_quote_proposals_author_book_created') is not null;
end $$;

set local role service_role;
do $$
declare
  v_book uuid := 'f3100000-0000-4000-8000-000000000005';
  v_user uuid := 'f3100000-0000-4000-8000-000000000001';
  v_outsider uuid := 'f3100000-0000-4000-8000-000000000002';
  v_catalog jsonb := jsonb_build_object('version','fixture','model','synthetic','provider','openai',
    'approved',true,'expiresAt',clock_timestamp() + interval '1 hour');
  v_result jsonb;
  v_request public.story_blueprint_quote_requests;
  v_replay public.story_blueprint_quote_requests;
begin
  v_result := public.close_story_blueprint_quote_request(v_book,v_user,'closed-request-key');
  assert v_result = '{"state":"closed"}'::jsonb;
  assert public.close_story_blueprint_quote_request(v_book,v_user,'closed-request-key') = v_result;
  begin
    perform public.request_story_blueprint_quote(v_book,v_user,v_catalog,'closed-request-key');
    assert false, 'a delayed request bypassed the closure';
  exception when unique_violation then null;
  end;
  assert not exists(select 1 from public.story_blueprint_quote_requests where idempotency_key='closed-request-key');

  select * into strict v_request from public.request_story_blueprint_quote(v_book,v_user,v_catalog,'existing-request-key');
  select * into strict v_replay from public.request_story_blueprint_quote(v_book,v_user,v_catalog,'existing-request-key');
  assert v_replay.id = v_request.id, 'an original request must replay despite its identity marker';
  v_result := public.close_story_blueprint_quote_request(v_book,v_user,'existing-request-key');
  assert v_result = jsonb_build_object('state','exists','requestId',v_request.id);
  assert exists(select 1 from public.story_blueprint_quote_identities where idempotency_key='existing-request-key' and kind='requested');
  assert not exists(select 1 from public.story_blueprint_quote_identities where idempotency_key='existing-request-key' and kind='closed');
  begin
    perform public.request_story_blueprint_quote(v_book,v_user,v_catalog,'competing-request-key');
    assert false, 'a second active quote was queued';
  exception when unique_violation then null;
  end;
  assert not exists(select 1 from public.story_blueprint_quote_identities where idempotency_key='competing-request-key'),
    'a rejected request must not leave a phantom identity';
  begin
    perform public.close_story_blueprint_quote_request(v_book,v_outsider,'outsider-request-key');
    assert false, 'an outsider closed a quote identity';
  exception when insufficient_privilege then null;
  end;
  for i in 1..19 loop
    perform public.close_story_blueprint_quote_request(v_book,v_user,'closure-limit-' || i::text);
  end loop;
  assert public.close_story_blueprint_quote_request(v_book,v_user,'closed-request-key') = '{"state":"closed"}'::jsonb,
    'an existing closure must remain recoverable at the rate limit';
  begin
    perform public.close_story_blueprint_quote_request(v_book,v_user,'closure-limit-overflow');
    assert false, 'closure rate limit was bypassed';
  exception when program_limit_exceeded then null;
  end;
end $$;
reset role;
rollback;
