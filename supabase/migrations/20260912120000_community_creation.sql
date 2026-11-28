-- Community creation and owner membership must succeed or roll back together.
create function public.create_community_with_owner(
  p_name text, p_slug text, p_description text default null,
  p_visibility text default 'public'
) returns public.communities
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_community public.communities;
begin
  if v_user is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 200
    or p_slug is null or length(p_slug) not between 2 and 80
    or p_slug !~ '^[a-z0-9-]+$'
    or length(coalesce(p_description,''))>2000
    or p_visibility is null or p_visibility not in ('public','private','unlisted') then
    raise exception 'invalid community' using errcode='22023';
  end if;
  insert into public.communities(owner_user_id,name,slug,description,visibility)
    values(v_user,trim(p_name),p_slug,p_description,p_visibility)
    returning * into v_community;
  insert into public.community_members(community_id,user_id,role,status)
    values(v_community.id,v_user,'owner','active');
  return v_community;
end $$;
revoke all on function public.create_community_with_owner(text,text,text,text) from public,anon;
grant execute on function public.create_community_with_owner(text,text,text,text) to authenticated;
