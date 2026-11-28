begin;
create temp table moderation_ids (
  owner_id uuid,
  reporter_id uuid,
  other_reporter_id uuid,
  admin_id uuid,
  community_id uuid,
  post_remove_id uuid,
  post_keep_id uuid,
  comment_remove_id uuid,
  comment_keep_id uuid,
  report_post_id uuid,
  report_comment_id uuid,
  report_dismiss_id uuid,
  other_report_id uuid
) on commit drop;
grant select on moderation_ids to authenticated, service_role;

insert into auth.users(id, email) values
  ('e5000000-0000-4000-8000-000000000001', 'moderation-owner@local.test'),
  ('e5000000-0000-4000-8000-000000000002', 'moderation-reporter@local.test'),
  ('e5000000-0000-4000-8000-000000000003', 'moderation-outsider@local.test'),
  ('e5000000-0000-4000-8000-000000000004', 'moderation-admin@local.test');

do $$
declare
  v_owner uuid := 'e5000000-0000-4000-8000-000000000001';
  v_reporter uuid := 'e5000000-0000-4000-8000-000000000002';
  v_other uuid := 'e5000000-0000-4000-8000-000000000003';
  v_admin uuid := 'e5000000-0000-4000-8000-000000000004';
  v_community uuid;
  v_post_remove uuid;
  v_post_keep uuid;
  v_comment_remove uuid;
  v_comment_keep uuid;
  v_report_post uuid;
  v_report_comment uuid;
  v_report_dismiss uuid;
  v_other_report uuid;
begin
  insert into public.communities(owner_user_id, name, slug, visibility)
  values(v_owner, 'Moderation fixture', 'moderation-fixture', 'public')
  returning id into v_community;
  insert into public.community_members(community_id, user_id, role, status)
  values(v_community, v_owner, 'owner', 'active');
  insert into public.community_posts(community_id, author_id, title, body, status)
  values(v_community, v_owner, 'Reported', 'reported post body', 'published')
  returning id into v_post_remove;
  insert into public.community_posts(community_id, author_id, title, body, status)
  values(v_community, v_owner, 'Keep', 'dismissed post body', 'published')
  returning id into v_post_keep;
  insert into public.community_comments(post_id, author_id, body)
  values(v_post_remove, v_owner, 'reported comment body')
  returning id into v_comment_remove;
  insert into public.community_comments(post_id, author_id, body)
  values(v_post_remove, v_owner, 'unreported reply under removed parent');
  insert into public.community_comments(post_id, author_id, body)
  values(v_post_keep, v_owner, 'dismissed comment body')
  returning id into v_comment_keep;

  insert into public.reports(reporter_id, entity_type, entity_id, reason)
  values(v_reporter, 'post', v_post_remove, 'post reason')
  returning id into v_report_post;
  insert into public.reports(reporter_id, entity_type, entity_id, reason)
  values(v_reporter, 'comment', v_comment_remove, 'comment reason')
  returning id into v_report_comment;
  insert into public.reports(reporter_id, entity_type, entity_id, reason)
  values(v_reporter, 'comment', v_comment_keep, 'dismiss reason')
  returning id into v_report_dismiss;
  insert into public.reports(reporter_id, entity_type, entity_id, reason)
  values(v_other, 'post', v_post_keep, 'other reporter reason')
  returning id into v_other_report;
  insert into public.reports(reporter_id, entity_type, entity_id, reason)
  values(v_reporter, 'comment', 'c5000000-0000-4000-8000-000000000099', 'missing target fixture');

  insert into moderation_ids values(
    v_owner, v_reporter, v_other, v_admin, v_community,
    v_post_remove, v_post_keep, v_comment_remove, v_comment_keep,
    v_report_post, v_report_comment, v_report_dismiss, v_other_report
  );
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v moderation_ids; v_toggle jsonb;
begin
  select * into strict v from moderation_ids;
  assert (select count(*)=4 from public.community_moderation_queue()),
    'current moderator sees post and comment reports in their own community, not orphan targets';
  assert exists(select 1 from public.community_moderation_queue() where entity_type='comment' and target->>'body'='reported comment body'),
    'comment review includes its authorized content context';
  assert (select count(*)=1 from public.community_moderation_queue(1,1)), 'moderator queue window is bounded and pageable';
  v_toggle := public.toggle_community_reaction(v.post_keep_id,'like');
  assert v_toggle->>'postId'=v.post_keep_id::text and (v_toggle->>'active')::boolean, 'reaction toggles on for this caller';
  v_toggle := public.toggle_community_reaction(v.post_keep_id,'like');
  assert not (v_toggle->>'active')::boolean, 'reaction toggles off without duplicate rows';
  begin
    insert into public.reports(reporter_id,entity_type,entity_id,reason,status,resolution_action,resolved_by)
    values(auth.uid(),'post',v.post_keep_id,'forged decision','actioned','remove',v.admin_id);
    assert false, 'a reporter cannot forge a saved moderation decision';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Report admission must not bypass content visibility or accept malformed reasons.
savepoint report_admission;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare v moderation_ids;
begin
  select * into strict v from moderation_ids;
  insert into public.reports(reporter_id,entity_type,entity_id,reason)
  values(auth.uid(),'post',v.post_keep_id,'Public post report'),(auth.uid(),'comment',v.comment_keep_id,'Public reply report');
  begin
    insert into public.reports(reporter_id,entity_type,entity_id,reason)
    values(auth.uid(),'post','b5000000-0000-4000-8000-000000000099','Unknown target');
    assert false, 'unknown targets must not enter the public reporting queue';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.communities set visibility='private' where id=(select community_id from moderation_ids);
set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare v moderation_ids;
begin
  select * into strict v from moderation_ids;
  begin
    insert into public.reports(reporter_id,entity_type,entity_id,reason) values(auth.uid(),'post',v.post_keep_id,'Private post');
    assert false, 'a nonmember cannot report an unreadable private post';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.reports(reporter_id,entity_type,entity_id,reason) values(auth.uid(),'comment',v.comment_keep_id,'Private reply');
    assert false, 'a nonmember cannot report an unreadable private reply';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$
declare v moderation_ids;
begin
  select * into strict v from moderation_ids;
  for i in 1..2 loop
    begin
      insert into public.reports(reporter_id,entity_type,entity_id,reason)
      values(v.reporter_id,'post',v.post_keep_id,case when i=1 then '   ' else repeat('x',1001) end);
      assert false, 'all new reports require a bounded nonblank reason, including service inserts';
    exception when check_violation then null; end;
  end loop;
end $$;
reset role;
rollback to savepoint report_admission;

do $$
begin
  assert not has_function_privilege('anon', 'public.admin_resolve_community_report(uuid,text,uuid)', 'execute'),
    'anonymous callers cannot resolve community reports';
  assert not has_function_privilege('authenticated', 'public.admin_resolve_community_report(uuid,text,uuid)', 'execute'),
    'authenticated users cannot invoke the service-only resolver';
  assert has_function_privilege('service_role', 'public.admin_resolve_community_report(uuid,text,uuid)', 'execute'),
    'service role can invoke the resolver behind the API admin guard';
  assert not has_function_privilege('anon', 'public.toggle_community_reaction(uuid,text)', 'execute'), 'anonymous reaction RPC is denied';
  assert not has_function_privilege('anon', 'public.community_moderation_queue(integer,integer)', 'execute'), 'anonymous queue is denied';
  assert not has_function_privilege('authenticated', 'private.lock_community_discussion(uuid,uuid)', 'execute'), 'caller cannot spoof the private lock principal';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare v moderation_ids;
begin
  select * into strict v from moderation_ids;
  assert (select count(*) = 4 from public.reports), 'reporter sees only reports they filed';
  assert (select count(*) = 3 from public.community_comments), 'visible community comments are readable';
  assert not has_table_privilege('authenticated', 'public.audit_logs', 'select'),
    'community users cannot read admin report audit details';
  assert (select count(*)=0 from public.community_moderation_queue()), 'non-moderators cannot read any moderation queue';
  begin
    insert into public.community_post_reactions(post_id,user_id,kind) values(v.post_keep_id,auth.uid(),'like');
    assert false, 'public visibility does not grant non-member reaction writes';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.admin_resolve_community_report(v.report_post_id, 'remove', v.admin_id);
    assert false, 'authenticated users cannot resolve a report';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role service_role;
do $$
declare
  v moderation_ids;
  v_outcome record;
begin
  select * into strict v from moderation_ids;
  select * into strict v_outcome
  from public.admin_resolve_community_report(v.report_post_id, 'remove', v.admin_id);
  assert v_outcome.status = 'actioned' and v_outcome.resolution_action = 'remove'
    and not v_outcome.already_resolved, 'post report is removed and actioned once';

  select * into strict v_outcome
  from public.admin_resolve_community_report(v.report_post_id, 'dismiss', v.admin_id);
  assert v_outcome.status = 'actioned' and v_outcome.resolution_action = 'remove'
    and v_outcome.already_resolved, 'replay returns the first decision and ignores a changed action';

  select * into strict v_outcome
  from public.admin_resolve_community_report(v.report_comment_id, 'remove', v.admin_id);
  assert v_outcome.status = 'actioned' and v_outcome.resolution_action = 'remove'
    and not v_outcome.already_resolved, 'comment report is soft-removed and actioned';

  select * into strict v_outcome
  from public.admin_resolve_community_report(v.report_dismiss_id, 'dismiss', v.admin_id);
  assert v_outcome.status = 'dismissed' and v_outcome.resolution_action = 'dismiss'
    and not v_outcome.already_resolved, 'dismiss preserves content while resolving report';

  assert (select status = 'removed' from public.community_posts where id=v.post_remove_id),
    'removed post is retained in audit storage with removed status';
  assert (select moderation_state = 'removed' from public.community_comments where id=v.comment_remove_id),
    'removed comment is retained with removed moderation state';
  assert (select moderation_state = 'visible' from public.community_comments where id=v.comment_keep_id),
    'dismiss does not change comment visibility';
  assert (select count(*) = 3 from public.audit_logs where action='moderation.report.resolve'),
    'each new decision writes exactly one audit event';
  assert not exists(
    select 1 from public.audit_logs
    where action='moderation.report.resolve'
      and (after_json ? 'reason' or after_json ? 'content' or after_json ? 'body')
  ), 'audit event omits report and community text';
  begin
    perform * from public.admin_resolve_community_report(
      (select id from public.reports where reason='missing target fixture'),
      'remove',
      v.admin_id
    );
    assert false, 'remove cannot resolve a report whose target no longer exists';
  exception when no_data_found then null; end;
  assert (select status='open' from public.reports where reason='missing target fixture'),
    'failed removal leaves the report open for a different safe decision';
  begin
    insert into public.community_comments(post_id,author_id,body)
    values(v.post_remove_id,v.owner_id,'service reply after removal');
    assert false, 'service-role writes must also recheck a published parent inside the transaction';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.community_post_reactions(post_id,user_id,kind)
    values(v.post_remove_id,v.owner_id,'like');
    assert false, 'service-role reactions must also respect parent removal';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$
declare v moderation_ids;
begin
  select * into strict v from moderation_ids;
  begin
    perform * from public.moderate_community_report(v.report_post_id,'dismiss');
    assert false, 'closed-report recovery cannot bypass community moderator authorization';
  exception when insufficient_privilege then null; end;
  assert not exists(select 1 from public.community_posts where id=v.post_remove_id),
    'removed post is hidden from ordinary readers by RLS';
  assert not exists(select 1 from public.community_comments where id=v.comment_remove_id),
    'removed comment is hidden from ordinary readers by RLS';
  assert exists(select 1 from public.community_posts where id=v.post_keep_id),
    'published post remains visible';
  assert exists(select 1 from public.community_comments where id=v.comment_keep_id),
    'visible comment remains visible';
end $$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare v moderation_ids; v_outcome record;
begin
  select * into strict v from moderation_ids;
  select * into strict v_outcome from public.moderate_community_report(v.report_post_id,'dismiss');
  assert v_outcome.status='actioned' and v_outcome.resolution_action='remove' and v_outcome.already_resolved,
    'scoped moderator recovery returns the platform first decision without another audit';
  assert not exists(select 1 from public.community_comments where post_id=v.post_remove_id),
    'even the author cannot read unreported replies beneath a removed post';
  update public.community_posts set status='published' where id=v.post_remove_id;
  assert not found, 'an author cannot undo a saved moderation removal via direct table writes';
  begin
    insert into public.community_comments(post_id,author_id,body)
    values(v.post_remove_id,auth.uid(),'new reply to removed parent');
    assert false, 'direct comment writes cannot bypass parent moderation';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
declare v moderation_ids;
begin
  select * into strict v from moderation_ids;
  assert (select count(*)=3 from public.audit_logs where action='moderation.report.resolve'),
    'ordinary moderator receipt recovery is also audit-idempotent';
end $$;
rollback;
