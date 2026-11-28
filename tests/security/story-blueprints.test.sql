-- Story Blueprint is a member-readable, editor-written plan. Its only effect
-- is an idempotent empty chapter; it must never enter an AI or credit workflow.
begin;
create temp table story_blueprint_ids(
  book_id uuid, other_book_id uuid, blueprint_id uuid,
  first_plan_id uuid, second_plan_id uuid, chapter_id uuid
) on commit drop;
grant select, insert, update on story_blueprint_ids to authenticated, service_role;

insert into auth.users(id,email) values
  ('d5000000-0000-4000-8000-000000000001','blueprint-owner@local.test'),
  ('d5000000-0000-4000-8000-000000000002','blueprint-viewer@local.test'),
  ('d5000000-0000-4000-8000-000000000003','blueprint-outsider@local.test');

set local role authenticated;
set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000001"}';
do $$
declare
  ws public.workspaces; b uuid; other_b uuid; bp public.story_blueprints;
  first_chapter public.chapters; replay public.chapters; n int;
  first_plan uuid := 'd5000000-0000-4000-8000-000000000011';
  second_plan uuid := 'd5000000-0000-4000-8000-000000000012';
  details jsonb := '{"workingTitle":"The Glass Road","premise":"A cartographer crosses a broken empire.","readerPromise":"A tense, hopeful journey.","genre":"Fantasy","tone":"Luminous","pointOfView":"Close third","tense":"Past","targetWordCount":80000,"synopsis":"A map reveals a road no one remembers.","theme":"Belonging","notes":""}';
  plan jsonb := '[{"id":"d5000000-0000-4000-8000-000000000011","title":"The Map","purpose":"Set the promise","summary":"A hidden route appears.","targetWords":1800},{"id":"d5000000-0000-4000-8000-000000000012","title":"The Crossing","purpose":"Raise stakes","summary":"The road demands a price.","targetWords":2200}]';
begin
  select * into strict ws from public.create_workspace_with_owner('Story Blueprint');
  insert into public.books(workspace_id,title,author_name,created_by)
    values(ws.id,'The Glass Road','Owner',auth.uid()) returning id into b;
  insert into public.books(workspace_id,title,author_name,created_by)
    values(ws.id,'Other book','Owner',auth.uid()) returning id into other_b;

  select * into strict bp from public.save_story_blueprint(b,0,details,plan);
  assert bp.revision=1 and bp.created_by=auth.uid() and bp.updated_by=auth.uid(), 'initial blueprint save failed';
  assert (select count(*) from public.story_blueprints where id=bp.id)=1, 'blueprint row missing';
  begin
    perform public.save_story_blueprint(b,0,details,plan);
    assert false, 'create-only revision overwrote blueprint';
  exception when serialization_failure then null; end;
  select * into strict bp from public.save_story_blueprint(b,1,jsonb_set(details,'{notes}','"Edited outline note"'),plan);
  assert bp.revision=2 and bp.details_json->>'notes'='Edited outline note', 'revisioned update failed';
  begin
    perform public.save_story_blueprint(b,1,details,plan);
    assert false, 'stale blueprint save overwrote newer revision';
  exception when serialization_failure then null; end;
  begin
    perform public.save_story_blueprint(b,2,details,'[{"id":"d5000000-0000-4000-8000-000000000011","title":"One","purpose":"","summary":"","targetWords":100},{"id":"d5000000-0000-4000-8000-000000000011","title":"Two","purpose":"","summary":"","targetWords":100}]');
    assert false, 'duplicate plan IDs accepted';
  exception when invalid_parameter_value then null; end;

  select count(*) into n from public.usage_events where user_id=auth.uid();
  select * into strict first_chapter from public.materialize_story_blueprint_chapter(b,first_plan,2,'blueprint-request-one');
  assert (select count(*) from public.chapters where book_id=b)=1, 'materialization duplicated a chapter';
  assert (select count(*) from public.document_versions where chapter_id=first_chapter.id)=1, 'materialization did not create one empty version';
  assert (select plain_text from public.document_versions where chapter_id=first_chapter.id)='', 'materialization wrote plan text into manuscript';
  assert (select count(*) from public.story_blueprint_materializations where blueprint_id=bp.id)=1, 'materialization receipt missing';
  assert not exists(select 1 from public.ai_jobs where book_id=b), 'materialization queued AI work';
  assert n=(select count(*) from public.usage_events where user_id=auth.uid()), 'materialization consumed usage';
  assert not exists(select 1 from public.credit_ledger where user_id=auth.uid()), 'materialization changed credits';

  -- Retry wins before stale-revision validation so a lost response never asks
  -- an author to retry a potentially completed write.
  select * into strict replay from public.materialize_story_blueprint_chapter(b,first_plan,1,'blueprint-request-one');
  assert replay.id=first_chapter.id, 'same materialization request did not replay';
  select * into strict replay from public.materialize_story_blueprint_chapter(b,first_plan,0,'blueprint-request-two');
  assert replay.id=first_chapter.id and (select count(*) from public.chapters where book_id=b)=1, 'plan item materialized twice';
  begin
    perform public.materialize_story_blueprint_chapter(b,second_plan,2,'blueprint-request-one');
    assert false, 'request key reused for different plan chapter';
  exception when serialization_failure then null; end;
  begin
    perform public.materialize_story_blueprint_chapter(b,second_plan,1,'blueprint-request-three');
    assert false, 'stale plan materialization accepted';
  exception when serialization_failure then null; end;
  begin
    perform public.materialize_story_blueprint_chapter(b,'d5000000-0000-4000-8000-000000000099',2,'blueprint-request-four');
    assert false, 'unknown plan chapter materialized';
  exception when no_data_found then null; end;
  assert (select count(*) from public.chapters where book_id=b)=1, 'failed materialization changed chapters';
  begin
    perform public.save_story_blueprint(b,2,details,jsonb_build_array(plan->1));
    assert false, 'materialized plan item could be removed';
  exception when check_violation then null; end;

  begin
    insert into public.story_blueprints(book_id,details_json,chapter_plan_json,created_by,updated_by)
      values(other_b,details,plan,auth.uid(),auth.uid());
    assert false, 'authenticated user can directly create blueprint';
  exception when insufficient_privilege then null; end;
  begin
    update public.story_blueprints set revision=99 where id=bp.id;
    assert false, 'authenticated user can directly update blueprint';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.story_blueprint_materializations where blueprint_id=bp.id;
    assert false, 'authenticated user can directly delete materialization receipt';
  exception when insufficient_privilege then null; end;

  insert into story_blueprint_ids values(b,other_b,bp.id,first_plan,second_plan,first_chapter.id);
end $$;
reset role;

insert into public.workspace_members(workspace_id,user_id,role)
  select workspace_id,'d5000000-0000-4000-8000-000000000002','viewer' from public.books
  where id=(select book_id from story_blueprint_ids);

-- Triggers keep immutable tenant and creator linkage even for a privileged
-- maintenance role. The supported API never exposes direct table writes.
set local role service_role;
do $$
declare v story_blueprint_ids;
begin
  select * into strict v from story_blueprint_ids;
  begin
    update public.story_blueprints set book_id=v.other_book_id where id=v.blueprint_id;
    assert false, 'blueprint moved between books';
  exception when insufficient_privilege then null; end;
  begin
    update public.story_blueprints set created_by='d5000000-0000-4000-8000-000000000002' where id=v.blueprint_id;
    assert false, 'blueprint creator changed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000002"}';
do $$
declare v story_blueprint_ids;
begin
  select * into strict v from story_blueprint_ids;
  assert exists(select 1 from public.story_blueprints where id=v.blueprint_id), 'viewer cannot read blueprint';
  assert exists(select 1 from public.story_blueprint_materializations where chapter_id=v.chapter_id), 'viewer cannot read materialization status';
  begin
    perform public.save_story_blueprint(v.book_id,2,'{"workingTitle":"No","premise":"","readerPromise":"","genre":"","tone":"","pointOfView":"","tense":"","targetWordCount":null,"synopsis":"","theme":"","notes":""}','[]');
    assert false, 'viewer can save blueprint';
  exception when insufficient_privilege then null; end;
  begin
    perform public.materialize_story_blueprint_chapter(v.book_id,v.second_plan_id,2,'viewer-request-one');
    assert false, 'viewer can materialize chapter';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-000000000003"}';
do $$
declare v story_blueprint_ids;
begin
  select * into strict v from story_blueprint_ids;
  assert not exists(select 1 from public.story_blueprints where id=v.blueprint_id), 'outsider can read blueprint';
  begin
    perform public.save_story_blueprint(v.book_id,2,'{"workingTitle":"No","premise":"","readerPromise":"","genre":"","tone":"","pointOfView":"","tense":"","targetWordCount":null,"synopsis":"","theme":"","notes":""}','[]');
    assert false, 'outsider can save blueprint';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
