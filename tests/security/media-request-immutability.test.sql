begin;
do $$
declare
  u uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); ws uuid:=gen_random_uuid();
  plan uuid:=gen_random_uuid(); job uuid; agent text; mutation text;
begin
  assert not has_function_privilege('authenticated','public.guard_media_request_identity()','execute');
  assert not has_function_privilege('anon','public.guard_media_request_identity()','execute');
  insert into auth.users(id,email) values(u,'immutable-media@local.test');
  insert into organizations(id,name,slug,owner_user_id) values(org,'Immutable media','immutable-media',u);
  insert into workspaces(id,organization_id,name,slug,created_by) values(ws,org,'Media','immutable-media',u);
  insert into workspace_members(workspace_id,user_id,role) values(ws,u,'editor');
  insert into plans(id,name,billing_period,price_cents,entitlements_json)
    values(plan,'Media test','month',1000,'{"audio_credits_monthly":5,"translation_credits_monthly":5}');
  insert into subscriptions(organization_id,plan_id,status) values(org,plan,'active');
  foreach agent in array array['narrator','translator'] loop
    insert into ai_jobs(workspace_id,agent_type,status,input_ref,idempotency_key,created_by)
      values(ws,agent,'queued','{"creditUnits":2,"text":"Original"}',agent||'-immutable',u) returning id into job;
    foreach mutation in array array[
      'input_ref=''{}''::jsonb',
      'input_ref=''null''::jsonb',
      'input_ref='' {"creditUnits":1,"text":"Original"}''::jsonb',
      'input_ref='' {"creditUnits":5,"text":"Original"}''::jsonb',
      'input_ref='' {"creditUnits":2,"text":"Changed"}''::jsonb',
      'agent_type=''writer''',
      'workspace_id=gen_random_uuid()',
      'book_id=gen_random_uuid()',
      'created_by=gen_random_uuid()',
      'idempotency_key=''changed-key'''
    ] loop
      begin
        execute 'update ai_jobs set '||mutation||' where id=$1' using job;
        raise exception 'accepted media request was mutable: %',mutation;
      exception when check_violation then
        assert sqlerrm='accepted media request is immutable';
      end;
    end loop;
    -- A no-op payload write and normal lifecycle updates remain valid.
    update ai_jobs set input_ref=input_ref,status='running' where id=job;
    update ai_jobs set status='failed',error_code='test_failure' where id=job;
    begin
      update ai_jobs set input_ref='{"creditUnits":1}',status='queued' where id=job;
      raise exception 'failed request changed before replay';
    exception when check_violation then assert sqlerrm='accepted media request is immutable'; end;
    update ai_jobs set status='queued' where id=job;
    update ai_jobs set status='succeeded',output_ref='{"receipt":"test"}' where id=job;
    begin
      update ai_jobs set input_ref='{"creditUnits":1}' where id=job;
      raise exception 'historical request was rewritten';
    exception when check_violation then assert sqlerrm='accepted media request is immutable'; end;
  end loop;
end $$;
rollback;
