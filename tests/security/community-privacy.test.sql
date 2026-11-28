begin;
create temp table community_ids (public_id uuid, private_id uuid, draft_id uuid, published_id uuid, secret_id uuid) on commit drop;
grant select on community_ids to authenticated;
insert into auth.users(id,email) values
  ('a3000000-0000-0000-0000-000000000001','community-a@local.test'),
  ('b3000000-0000-0000-0000-000000000001','community-b@local.test');
do $$
declare pub uuid; priv uuid; draft uuid; published uuid; secret uuid; a uuid := 'a3000000-0000-0000-0000-000000000001';
begin
  insert into public.communities(owner_user_id,name,slug,visibility) values(a,'Public','pub-test','public') returning id into pub;
  insert into public.communities(owner_user_id,name,slug,visibility) values(a,'Private','priv-test','private') returning id into priv;
  insert into public.community_members(community_id,user_id,role) values(pub,a,'owner'),(priv,a,'owner');
  insert into public.community_posts(community_id,author_id,body,status) values(pub,a,'Secret draft','draft') returning id into draft;
  insert into public.community_posts(community_id,author_id,body,status) values(pub,a,'Published','published') returning id into published;
  insert into public.community_posts(community_id,author_id,body,status) values(priv,a,'Private published','published') returning id into secret;
  insert into community_ids values(pub,priv,draft,published,secret);
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b3000000-0000-0000-0000-000000000001"}';
do $$
declare v community_ids;
begin
  select * into strict v from community_ids;
  assert exists(select 1 from public.communities where id=v.public_id), 'public community invisible';
  assert not exists(select 1 from public.communities where id=v.private_id), 'private community leaks';
  assert exists(select 1 from public.community_posts where id=v.published_id), 'published post invisible';
  assert not exists(select 1 from public.community_posts where id in(v.draft_id,v.secret_id)), 'private/draft post leaks';
  begin
    insert into public.community_members(community_id,user_id,role) values(v.public_id,auth.uid(),'moderator');
    assert false, 'public self-join grants moderator';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.community_members(community_id,user_id,role) values(v.private_id,auth.uid(),'member');
    assert false, 'user self-joined private community';
  exception when insufficient_privilege then null; end;
  insert into public.community_members(community_id,user_id,role) values(v.public_id,auth.uid(),'member');
  assert not private.can_moderate_community(v.public_id), 'ordinary member can moderate';
  insert into public.community_post_reactions(post_id,user_id,kind) values(v.published_id,auth.uid(),'like');
  begin
    insert into public.community_post_reactions(post_id,user_id,kind) values(v.secret_id,auth.uid(),'like');
    assert false, 'user can react to inaccessible post';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a3000000-0000-0000-0000-000000000001"}';
do $$
declare v community_ids;
begin
  select * into strict v from community_ids;
  assert exists(select 1 from public.community_posts where id=v.draft_id), 'author cannot see own draft';
  assert exists(select 1 from public.community_posts where id=v.secret_id), 'owner cannot see private post';
end $$;
reset role;
rollback;
