begin;
insert into auth.users(id, email) values
  ('f4100000-0000-4000-8000-000000000001', 'community-operation-owner@local.test'),
  ('f4100000-0000-4000-8000-000000000002', 'community-operation-author@local.test'),
  ('f4100000-0000-4000-8000-000000000003', 'community-operation-other@local.test');
insert into public.communities(id, owner_user_id, name, slug, visibility) values
  ('f4100000-0000-4000-8000-000000000011', 'f4100000-0000-4000-8000-000000000001', 'Public', 'community-operation-public', 'public'),
  ('f4100000-0000-4000-8000-000000000012', 'f4100000-0000-4000-8000-000000000001', 'Private', 'community-operation-private', 'private'),
  ('f4100000-0000-4000-8000-000000000013', 'f4100000-0000-4000-8000-000000000001', 'Inactive', 'community-operation-inactive', 'public');
insert into public.community_members(community_id, user_id, role, status) values
  ('f4100000-0000-4000-8000-000000000013', 'f4100000-0000-4000-8000-000000000002', 'member', 'inactive');

do $$ begin
  assert not has_table_privilege('authenticated', 'public.community_join_operations', 'select');
  assert not has_table_privilege('authenticated', 'public.community_join_operations', 'insert');
  assert has_table_privilege('service_role', 'public.community_join_operations', 'select');
  assert has_table_privilege('service_role', 'public.community_join_operations', 'insert');
  assert not has_table_privilege('service_role', 'public.community_join_operations', 'update');
  assert not has_table_privilege('service_role', 'public.community_join_operations', 'delete');
  assert not has_function_privilege('authenticated', 'public.request_community_join(uuid,uuid,uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.read_community_join_operation(uuid,uuid,uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.close_community_join_operation(uuid,uuid,uuid)', 'execute');
  assert not has_function_privilege('anon', 'public.request_community_join(uuid,uuid,uuid)', 'execute');
end $$;

set local role service_role;
do $$
declare
  author_id uuid := 'f4100000-0000-4000-8000-000000000002';
  other_id uuid := 'f4100000-0000-4000-8000-000000000003';
  public_id uuid := 'f4100000-0000-4000-8000-000000000011';
  private_id uuid := 'f4100000-0000-4000-8000-000000000012';
  inactive_id uuid := 'f4100000-0000-4000-8000-000000000013';
  missing_id uuid := 'f4100000-0000-4000-8000-000000000014';
  closed_id uuid := 'f4100000-0000-4000-8000-000000000101';
  joined_id uuid := 'f4100000-0000-4000-8000-000000000102';
  new_id uuid := 'f4100000-0000-4000-8000-000000000103';
  private_op uuid := 'f4100000-0000-4000-8000-000000000104';
  inactive_op uuid := 'f4100000-0000-4000-8000-000000000105';
  missing_op uuid := 'f4100000-0000-4000-8000-000000000106';
  missing_closed uuid := 'f4100000-0000-4000-8000-000000000107';
  result jsonb;
begin
  assert public.read_community_join_operation(public_id, author_id, closed_id) = '{"state":"not_seen"}'::jsonb;
  assert public.close_community_join_operation(public_id, author_id, closed_id) = '{"state":"closed"}'::jsonb;
  assert public.close_community_join_operation(public_id, author_id, closed_id) = '{"state":"closed"}'::jsonb;
  assert public.request_community_join(public_id, author_id, closed_id) = '{"state":"closed"}'::jsonb;
  assert not exists(select 1 from public.community_members where community_id = public_id and user_id = author_id),
    'a delayed join crossed its closure';
  assert public.read_community_join_operation(public_id, other_id, closed_id) = '{"state":"not_seen"}'::jsonb,
    'one actor could read another actor receipt';

  result := public.request_community_join(public_id, author_id, joined_id);
  assert result = '{"state":"joined","role":"member","alreadyMember":false}'::jsonb;
  assert public.request_community_join(public_id, author_id, joined_id) = result;
  assert public.read_community_join_operation(public_id, author_id, joined_id) = result;
  assert public.close_community_join_operation(public_id, author_id, joined_id) = result;
  assert public.request_community_join(public_id, author_id, new_id)
    = '{"state":"joined","role":"member","alreadyMember":true}'::jsonb;
  assert (select count(*) from public.community_members where community_id = public_id and user_id = author_id) = 1;
  begin
    perform public.request_community_join(private_id, author_id, joined_id);
    assert false, 'an operation identity was reused for another community';
  exception when unique_violation then null;
  end;
  begin
    perform public.close_community_join_operation(private_id, author_id, joined_id);
    assert false, 'another community closed this operation identity';
  exception when unique_violation then null;
  end;

  assert public.request_community_join(private_id, author_id, private_op)
    = '{"state":"rejected","reason":"not_open"}'::jsonb;
  assert public.request_community_join(inactive_id, author_id, inactive_op)
    = '{"state":"rejected","reason":"inactive"}'::jsonb;
  assert (select status from public.community_members where community_id = inactive_id and user_id = author_id) = 'inactive';
  assert public.request_community_join(missing_id, author_id, missing_op)
    = '{"state":"rejected","reason":"not_found"}'::jsonb;
  assert public.close_community_join_operation(missing_id, author_id, missing_op)
    = '{"state":"rejected","reason":"not_found"}'::jsonb;
  assert public.close_community_join_operation(missing_id, author_id, missing_closed) = '{"state":"closed"}'::jsonb;
  assert public.request_community_join(public_id, other_id, null)
    = '{"state":"joined","role":"member","alreadyMember":false}'::jsonb;
  assert public.request_community_join(public_id, other_id, null)
    = '{"state":"joined","role":"member","alreadyMember":true}'::jsonb;
end $$;
reset role;
-- Even if a deleted resource ID is later recreated, its closure remains a fence.
insert into public.communities(id, owner_user_id, name, slug, visibility) values
  ('f4100000-0000-4000-8000-000000000014', 'f4100000-0000-4000-8000-000000000001', 'Recreated', 'community-operation-recreated', 'public');
set local role service_role;
do $$ begin
  assert public.request_community_join('f4100000-0000-4000-8000-000000000014', 'f4100000-0000-4000-8000-000000000002', 'f4100000-0000-4000-8000-000000000107') = '{"state":"closed"}'::jsonb;
  assert not exists(select 1 from public.community_members where community_id='f4100000-0000-4000-8000-000000000014' and user_id='f4100000-0000-4000-8000-000000000002');
end $$;
reset role;
rollback;
