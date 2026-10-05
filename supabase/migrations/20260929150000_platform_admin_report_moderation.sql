-- Platform-admin resolution for community post/comment reports.
-- Report content is soft-hidden; community moderation history stays auditable.

alter table public.community_comments
  add column if not exists moderation_state text not null default 'visible';

alter table public.community_comments
  drop constraint if exists community_comments_moderation_state_check;
alter table public.community_comments
  add constraint community_comments_moderation_state_check
  check (moderation_state in ('visible', 'removed'));

alter table public.reports
  add column if not exists resolution_action text,
  add column if not exists resolved_by uuid references auth.users(id),
  add column if not exists resolved_at timestamptz;
alter table public.reports
  drop constraint if exists reports_resolution_action_check;
alter table public.reports
  add constraint reports_resolution_action_check
  check (resolution_action is null or resolution_action in ('remove', 'dismiss'));

create index if not exists idx_reports_status_created
  on public.reports(status, created_at desc);
create index if not exists idx_reports_entity
  on public.reports(entity_type, entity_id);

-- Enforce new writes without assuming historical data is clean. Operators must
-- audit legacy reasons before validating this constraint in a hosted rollout.
alter table public.reports add constraint reports_reason_bounded
  check (char_length(reason) between 1 and 1000 and btrim(reason)<>'') not valid;

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (reporter_id=(select auth.uid()) and status='open'
    and resolution_action is null and resolved_by is null and resolved_at is null
    and (
      entity_type='post' and exists(select 1 from public.community_posts p
        where p.id=entity_id and p.status='published' and private.community_is_visible(p.community_id))
      or entity_type='comment' and exists(select 1 from public.community_comments c
        join public.community_posts p on p.id=c.post_id where c.id=entity_id
          and c.moderation_state='visible' and p.status='published' and private.community_is_visible(p.community_id))
    ));

drop policy if exists community_comments_select on public.community_comments;
create policy community_comments_select on public.community_comments for select to authenticated
  using (
    moderation_state = 'visible'
    and exists (
      select 1 from public.community_posts p
      where p.id = post_id and p.status = 'published' and private.community_is_visible(p.community_id)
    )
  );

-- A public client cannot undo soft removal or add to a hidden discussion.
drop policy if exists community_posts_update on public.community_posts;
create policy community_posts_update on public.community_posts for update to authenticated
  using (status <> 'removed' and (
    author_id = (select auth.uid()) or private.can_moderate_community(community_id)
  ))
  with check (private.is_community_member(community_id) and (
    author_id = (select auth.uid()) or private.can_moderate_community(community_id)
  ));

drop policy if exists community_comments_insert on public.community_comments;
create policy community_comments_insert on public.community_comments for insert to authenticated
  with check (author_id = (select auth.uid()) and moderation_state = 'visible' and exists (
    select 1 from public.community_posts p
    where p.id = post_id and p.status = 'published' and private.is_community_member(p.community_id)
  ));

create or replace function public.admin_resolve_community_report(
  p_report_id uuid,
  p_action text,
  p_actor_id uuid
)
returns table (
  report_id uuid,
  status text,
  resolution_action text,
  already_resolved boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_report public.reports%rowtype;
begin
  if p_report_id is null or p_actor_id is null
     or p_action is null or p_action not in ('remove', 'dismiss') then
    raise exception 'invalid moderation decision' using errcode = '22023';
  end if;

  select r.* into v_report
  from public.reports r
  where r.id = p_report_id
  for update;
  if not found then
    raise exception 'report not found' using errcode = 'P0002';
  end if;

  if v_report.status <> 'open' then
    return query select v_report.id, v_report.status, v_report.resolution_action, true;
    return;
  end if;

  if v_report.entity_type not in ('post', 'comment') then
    raise exception 'unsupported report entity' using errcode = '22023';
  end if;

  if p_action = 'remove' then
    if v_report.entity_type = 'post' then
      update public.community_posts
      set status = 'removed', updated_at = now()
      where id = v_report.entity_id;
    else
      update public.community_comments
      set moderation_state = 'removed'
      where id = v_report.entity_id;
    end if;
    if not found then
      raise exception 'reported content not found' using errcode = 'P0002';
    end if;
  end if;

  update public.reports r
  set status = case when p_action = 'remove' then 'actioned' else 'dismissed' end,
      resolution_action = p_action,
      resolved_by = p_actor_id,
      resolved_at = now()
  where r.id = p_report_id
  returning r.* into v_report;

  -- Deliberately omit reason and content: the audit retains only decision IDs
  -- and status, never community text, manuscript text, or reporter identity.
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, after_json)
  values (
    p_actor_id,
    'moderation.report.resolve',
    'community_report',
    v_report.id,
    jsonb_build_object(
      'action', p_action,
      'status', v_report.status,
      'reportedEntityType', v_report.entity_type,
      'reportedEntityId', v_report.entity_id
    )
  );

  return query select v_report.id, v_report.status, v_report.resolution_action, false;
end;
$$;

revoke all on function public.admin_resolve_community_report(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_resolve_community_report(uuid, text, uuid)
  to service_role;

-- The ordinary moderator path delegates to the same report lock and atomic
-- decision/audit. Scope authorization occurs before closed-report replay and
-- locks active moderator membership until the decision commits.
create function public.moderate_community_report(p_report_id uuid, p_action text)
returns table (report_id uuid, status text, resolution_action text, already_resolved boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_report public.reports%rowtype;
  v_community_id uuid;
begin
  if v_uid is null then
    raise exception 'community moderator required' using errcode = '42501';
  end if;
  if p_report_id is null or p_action is null or p_action not in ('remove', 'dismiss') then
    raise exception 'invalid moderation decision' using errcode = '22023';
  end if;
  select r.* into v_report from public.reports r where r.id = p_report_id for update;
  if not found then raise exception 'report not found' using errcode = 'P0002'; end if;
  if v_report.entity_type = 'post' then
    select p.community_id into v_community_id from public.community_posts p
      where p.id = v_report.entity_id for share;
  elsif v_report.entity_type = 'comment' then
    select p.community_id into v_community_id
      from public.community_comments c join public.community_posts p on p.id = c.post_id
      where c.id = v_report.entity_id for share of c, p;
  else
    raise exception 'unsupported report entity' using errcode = '22023';
  end if;
  if v_community_id is null then raise exception 'reported content not found' using errcode = 'P0002'; end if;
  perform 1 from public.community_members m
    where m.community_id = v_community_id and m.user_id = v_uid
      and m.status = 'active' and m.role in ('owner', 'moderator') for share;
  if not found then raise exception 'community moderator required' using errcode = '42501'; end if;
  return query select * from public.admin_resolve_community_report(p_report_id, p_action, v_uid);
end $$;
revoke all on function public.moderate_community_report(uuid, text) from public, anon;
grant execute on function public.moderate_community_report(uuid, text) to authenticated;

-- Final write authorization must not rely on an earlier HTTP read. The same
-- locks protect authenticated and trusted service-role table inserts.
create function private.lock_community_discussion(p_post_id uuid, p_actor_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_post public.community_posts%rowtype;
begin
  select p.* into v_post from public.community_posts p where p.id=p_post_id for share;
  if not found or v_post.status <> 'published' or p_actor_id is null then
    raise exception 'active discussion access required' using errcode='42501';
  end if;
  perform 1 from public.community_members m where m.community_id=v_post.community_id
    and m.user_id=p_actor_id and m.status='active' for share;
  if not found then raise exception 'active discussion access required' using errcode='42501'; end if;
end $$;
revoke all on function private.lock_community_discussion(uuid,uuid) from public, anon, authenticated;

create function private.guard_community_discussion_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name='community_comments' then
    if new.body is null or char_length(new.body) not between 1 and 5000 then
      raise exception 'invalid community reply' using errcode='22023';
    end if;
    perform private.lock_community_discussion(new.post_id,new.author_id);
  else
    perform private.lock_community_discussion(new.post_id,new.user_id);
  end if;
  return new;
end $$;
revoke all on function private.guard_community_discussion_insert() from public, anon, authenticated;
create trigger community_comment_active_discussion before insert on public.community_comments
  for each row execute function private.guard_community_discussion_insert();
create trigger community_reaction_active_discussion before insert on public.community_post_reactions
  for each row execute function private.guard_community_discussion_insert();

drop policy if exists community_reactions_select on public.community_post_reactions;
create policy community_reactions_select on public.community_post_reactions for select to authenticated
  using (exists (select 1 from public.community_posts p where p.id=post_id
    and p.status='published' and private.community_is_visible(p.community_id)));
drop policy if exists community_reactions_insert on public.community_post_reactions;
create policy community_reactions_insert on public.community_post_reactions for insert to authenticated
  with check (user_id=(select auth.uid()) and exists (select 1 from public.community_posts p
    where p.id=post_id and p.status='published' and private.is_community_member(p.community_id)));

create function public.toggle_community_reaction(p_post_id uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_active boolean;
begin
  if v_uid is null then raise exception 'active discussion access required' using errcode='42501'; end if;
  if p_post_id is null or p_kind is null or p_kind not in ('like','love','insightful','celebrate') then
    raise exception 'invalid community reaction' using errcode='22023';
  end if;
  perform private.lock_community_discussion(p_post_id,v_uid);
  perform pg_advisory_xact_lock(hashtextextended(p_post_id::text || ':' || v_uid::text || ':' || p_kind,0));
  delete from public.community_post_reactions where post_id=p_post_id and user_id=v_uid and kind=p_kind;
  v_active := not found;
  if v_active then insert into public.community_post_reactions(post_id,user_id,kind) values(p_post_id,v_uid,p_kind); end if;
  return jsonb_build_object('postId',p_post_id,'kind',p_kind,'active',v_active);
end $$;
revoke all on function public.toggle_community_reaction(uuid,text) from public, anon;
grant execute on function public.toggle_community_reaction(uuid,text) to authenticated;

-- Caller-scoped, bounded queue covers both post and comment reports. A single
-- statement checks current membership and never returns reporter identity.
create function public.community_moderation_queue(p_limit integer default 51, p_offset integer default 0)
returns table(id uuid, entity_type text, entity_id uuid, reason text, status text, created_at timestamptz, target jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'community access required' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 101 or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception 'invalid moderation queue window' using errcode='22023';
  end if;
  return query select r.id,r.entity_type,r.entity_id,r.reason,r.status,r.created_at,
    case when r.entity_type='post' then jsonb_build_object('type','post','title',direct_post.title,
      'body',direct_post.body,'status',direct_post.status,'communityName',community.name)
    else jsonb_build_object('type','comment','body',c.body,'moderationState',c.moderation_state,
      'parentTitle',parent_post.title,'parentBody',parent_post.body,'communityName',community.name) end
    from public.reports r
    left join public.community_posts direct_post on r.entity_type='post' and direct_post.id=r.entity_id
    left join public.community_comments c on r.entity_type='comment' and c.id=r.entity_id
    left join public.community_posts parent_post on parent_post.id=c.post_id
    join public.community_members m on m.community_id=coalesce(direct_post.community_id,parent_post.community_id)
      and m.user_id=v_uid and m.status='active' and m.role in ('owner','moderator')
    join public.communities community on community.id=m.community_id
    where r.status='open' order by r.created_at,r.id limit p_limit offset p_offset;
end $$;
revoke all on function public.community_moderation_queue(integer,integer) from public, anon;
grant execute on function public.community_moderation_queue(integer,integer) to authenticated;
