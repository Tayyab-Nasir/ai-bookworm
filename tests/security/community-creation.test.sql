begin;
insert into auth.users(id,email) values('a7000000-0000-4000-8000-000000000001','community-create@local.test');
set local role authenticated;
set local request.jwt.claims='{"sub":"a7000000-0000-4000-8000-000000000001"}';
do $$
declare v_community public.communities;
begin
  v_community := public.create_community_with_owner(' Writers ','writers-transaction',null,'private');
  assert v_community.name='Writers' and v_community.owner_user_id=auth.uid();
  assert exists(select 1 from public.community_members where community_id=v_community.id
    and user_id=auth.uid() and role='owner' and status='active');
  assert exists(select 1 from public.communities where id=v_community.id);
  begin
    perform public.create_community_with_owner('Duplicate','writers-transaction');
    raise exception 'duplicate slug accepted';
  exception when unique_violation then null; end;
  begin
    perform public.create_community_with_owner('   ','blank-community');
    raise exception 'blank name accepted';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
create function pg_temp.reject_community_owner() returns trigger language plpgsql as $$
begin raise exception 'injected owner failure' using errcode='23514'; end $$;
create trigger test_community_owner_failure before insert on public.community_members
for each row execute function pg_temp.reject_community_owner();
set local role authenticated;
do $$ begin
  begin
    perform public.create_community_with_owner('Must roll back','community-rollback');
    raise exception 'membership failure ignored';
  exception when check_violation then assert sqlerrm='injected owner failure'; end;
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from public.communities where slug='community-rollback');
  assert not has_function_privilege('anon','public.create_community_with_owner(text,text,text,text)','execute');
end $$;
set local role authenticated;
set local request.jwt.claims='{}';
do $$ begin
  begin
    perform public.create_community_with_owner('No user','no-user');
    raise exception 'missing auth accepted';
  exception when insufficient_privilege then assert sqlerrm='authentication required'; end;
end $$;
reset role;
rollback;
