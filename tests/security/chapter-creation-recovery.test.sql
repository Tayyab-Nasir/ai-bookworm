begin;
insert into auth.users(id,email) values
  ('a6000000-0000-0000-0000-000000000001','chapter-recovery@local.test'),
  ('a6000000-0000-0000-0000-000000000002','chapter-foreign@local.test'),
  ('a6000000-0000-0000-0000-000000000003','chapter-collaborator@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
  ('b6000000-0000-4000-8000-000000000001','Chapter recovery','chapter-recovery','a6000000-0000-0000-0000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
  ('c6000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000001','Chapter recovery','chapter-recovery','a6000000-0000-0000-0000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
  ('c6000000-0000-4000-8000-000000000001','a6000000-0000-0000-0000-000000000001','owner','active'),
  ('c6000000-0000-4000-8000-000000000001','a6000000-0000-0000-0000-000000000003','editor','active');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6000000-0000-0000-0000-000000000001"}';
do $$
declare b uuid; c public.chapters; result jsonb;
begin
  insert into public.books(workspace_id,title,author_name,created_by)
    values('c6000000-0000-4000-8000-000000000001','Recovery book','Author',auth.uid()) returning id into b;
  result := public.chapter_creation_status(b,'request-one',false);
  assert result->>'status'='not_found', 'missing request must remain unconfirmed';
  result := public.chapter_creation_status(b,'request-one',true);
  assert result->>'status'='closed', 'closing missing request must leave a fence';
  begin
    perform public.create_book_chapter_once(b,'Late',null,'request-one');
    assert false, 'closed request accepted a late create';
  exception when sqlstate 'PT409' then null; end;
  perform set_config('request.jwt.claims','{"sub":"a6000000-0000-0000-0000-000000000003"}',true);
  result := public.chapter_creation_status(b,'request-one',false);
  assert result->>'status'='not_found', 'other member must not read the original actor receipt';
  result := public.chapter_creation_status(b,'request-one',true);
  assert result->>'status'='closed', 'other member closes only its own scoped key';
  perform set_config('request.jwt.claims','{"sub":"a6000000-0000-0000-0000-000000000001"}',true);
  select * into strict c from public.create_book_chapter_once(b,'Created',null,'request-two');
  result := public.chapter_creation_status(b,'request-two',true);
  assert result->>'status'='created' and (result->>'chapterId')::uuid=c.id, 'close must not undo a committed creation';
  delete from public.chapters where id=c.id;
  result := public.chapter_creation_status(b,'request-two',false);
  assert result->>'status'='removed' and result->'chapterId'='null'::jsonb, 'deleted chapter must retain its receipt';
  begin
    perform public.create_book_chapter_once(b,'Created',null,'request-two');
    assert false, 'removed chapter was recreated by retry';
  exception when sqlstate 'PT409' then null; end;
  perform set_config('request.jwt.claims','{"sub":"a6000000-0000-0000-0000-000000000002"}',true);
  begin
    perform public.chapter_creation_status(b,'request-one',false);
    assert false, 'foreign actor read a request';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
