begin;
insert into auth.users(id,email) values
  ('a7200000-0000-4000-8000-000000000001','google-user@local.test');
do $$ begin
  assert exists(select 1 from public.profiles where id='a7200000-0000-4000-8000-000000000001'
    and display_name='' and avatar_url is null), 'auth identity did not receive a safe profile';
  assert not exists(select 1 from public.organization_members where user_id='a7200000-0000-4000-8000-000000000001'),
    'user metadata unexpectedly created authorization';
  assert not has_function_privilege('authenticated','public.create_profile_for_auth_user()','execute');
end $$;
delete from auth.users where id='a7200000-0000-4000-8000-000000000001';
do $$ begin
  assert not exists(select 1 from public.profiles where id='a7200000-0000-4000-8000-000000000001'),
    'profile did not cascade with Auth identity';
end $$;
rollback;
