-- REVIEW DRAFT ONLY: never auto-apply or execute inside an existing transaction.
-- Use a dedicated idle connection with ON_ERROR_STOP and reviewed maintenance controls.
-- Both lifecycle grants and readiness guards commit atomically, or neither does.
BEGIN;
-- Scratch enforcement stage, do not apply without quiescent legacy writers and independent review.
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.workspace_members, public.assets, public.asset_versions, public.approvals, public.folders, bookworm_private.asset_lifecycle_receipts in share row exclusive mode;

-- Refuse hidden custom-role grants on staged functions before enabling them.
do $function_acl$
declare entry record; fn oid; owner_oid oid;
begin
 for entry in select * from (values
  ('private.track_asset_lifecycle_revision()'),('private.track_asset_version_revision()'),
  ('private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'),
  ('public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'),
  ('private.asset_lifecycle_status_internal(uuid,uuid,uuid)'),('public.asset_lifecycle_status(uuid,uuid,uuid)'),
  ('private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'),('public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'),
  ('private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'),
  ('public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)')
 ) expected(signature) loop
  fn:=pg_catalog.to_regprocedure(entry.signature);
  if fn is null then raise exception 'asset cutover preflight: staged function missing' using errcode='55000'; end if;
  select p.proowner into owner_oid from pg_catalog.pg_proc p where p.oid=fn;
  if exists(select 1 from pg_catalog.pg_proc p
     cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
     where p.oid=fn and a.grantee<>owner_oid) then
   raise exception 'asset cutover preflight: staged function privilege drift' using errcode='55000';
  end if;
 end loop;
end $function_acl$;


-- Project-specific hosted observation, not a generic Supabase baseline.
-- A managed Auth upgrade may change these definitions; fail closed and review.
do $managed_auth$
declare entry record; fn oid;
begin
 for entry in select * from (values
   ('auth.uid()','uuid','9ab5ea099e74ec09e83b1505c51a3647791195aed7c742dcc3f257dfc7d2f300'),
   ('auth.role()','text','925a4caecb62a7b1f09af87e75465847e16ea0c2c13207448c2c1c180ab2b215')
 ) expected(signature,return_type,source_sha256) loop
   fn := pg_catalog.to_regprocedure(entry.signature);
   if fn is null or not exists (
     select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
     where p.oid=fn and pg_catalog.pg_get_userbyid(p.proowner)='supabase_auth_admin'
       and l.lanname='sql' and not p.prosecdef and p.provolatile='s' and not p.proleakproof
       and not p.proretset and not p.proisstrict and p.proconfig is null and p.pronargs=0
       and p.prorettype=pg_catalog.to_regtype(entry.return_type)
       and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)),'UTF8')),'hex')=entry.source_sha256
   ) then raise exception 'asset cutover preflight: managed auth baseline drift' using errcode='55000'; end if;
   if exists (select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
       where not pg_catalog.has_function_privilege(r.name,fn,'execute')
         or pg_catalog.pg_has_role(r.name,'supabase_auth_admin','member')
         or not pg_catalog.has_schema_privilege(r.name,'auth','usage')
         or pg_catalog.has_schema_privilege(r.name,'auth','create')) then
     raise exception 'asset cutover preflight: managed auth privilege drift' using errcode='55000';
   end if;
 end loop;
end $managed_auth$;

-- Reject pre-existing grants to any other database role, not just client roles.
do $receipt_acl$
begin
 if exists(select 1 from pg_catalog.pg_class c
   cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   where c.oid='bookworm_private.asset_lifecycle_receipts'::pg_catalog.regclass and a.grantee<>c.relowner) then
  raise exception 'asset cutover preflight: receipt privilege drift' using errcode='55000';
 end if;
end $receipt_acl$;

-- Source-derived baseline; rerun native and PGlite proof whenever stage one changes.
-- Non-cooperative privileged schema writers must be quiesced during cutover.
do $legacy_baseline$
declare prior_path text := current_setting('search_path'); actual text;
begin
 perform pg_catalog.set_config('search_path','',true);
 select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((-- Prototype only: deterministic metadata for the legacy authorization baseline.
-- Run in the owning synthetic transaction with an empty search path.
select pg_catalog.jsonb_build_object(
  'tables', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid::pg_catalog.regclass::text, c.relowner = (select oid from pg_catalog.pg_roles where rolname=current_user), c.relrowsecurity,c.relforcerowsecurity,
     (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.role_name,v.priv,pg_catalog.has_table_privilege(r.role_name,c.oid,v.priv)) order by r.role_name,v.priv)
      from (values ('anon'),('authenticated'),('service_role')) r(role_name) cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) v(priv)))
    order by c.oid::pg_catalog.regclass::text)
    from pg_catalog.pg_class c where c.oid in ('public.assets'::pg_catalog.regclass,'public.asset_versions'::pg_catalog.regclass,'public.workspace_members'::pg_catalog.regclass,'public.approvals'::pg_catalog.regclass,'public.folders'::pg_catalog.regclass)),
  'columns',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attrelid::pg_catalog.regclass::text,a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,a.attidentity,pg_catalog.pg_get_expr(d.adbin,d.adrelid),
     (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.role_name,v.priv,pg_catalog.has_column_privilege(r.role_name,a.attrelid,a.attnum,v.priv)) order by r.role_name,v.priv)
      from (values ('anon'),('authenticated'),('service_role')) r(role_name) cross join (values ('select'),('insert'),('update'),('references')) v(priv)))
    order by a.attrelid::pg_catalog.regclass::text,a.attnum)
    from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid in ('public.assets'::pg_catalog.regclass,'public.asset_versions'::pg_catalog.regclass,'public.workspace_members'::pg_catalog.regclass,'public.approvals'::pg_catalog.regclass,'public.folders'::pg_catalog.regclass) and a.attnum>0 and not a.attisdropped),
  'constraints',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.conrelid::pg_catalog.regclass::text,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_catalog.pg_get_constraintdef(c.oid)) order by c.conrelid::pg_catalog.regclass::text,c.conname)
    from pg_catalog.pg_constraint c where c.contype <> 'n' and c.conrelid in ('public.assets'::pg_catalog.regclass,'public.asset_versions'::pg_catalog.regclass,'public.workspace_members'::pg_catalog.regclass,'public.approvals'::pg_catalog.regclass,'public.folders'::pg_catalog.regclass)),
  'policies',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(p.polrelid::pg_catalog.regclass::text,p.polname,p.polcmd,p.polpermissive,
    (select pg_catalog.jsonb_agg(case when r=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(r) end order by case when r=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(r) end) from pg_catalog.unnest(p.polroles) r),
    pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polrelid::pg_catalog.regclass::text,p.polname)
    from pg_catalog.pg_policy p where p.polrelid in ('public.assets'::pg_catalog.regclass,'public.asset_versions'::pg_catalog.regclass,'public.workspace_members'::pg_catalog.regclass,'public.approvals'::pg_catalog.regclass,'public.folders'::pg_catalog.regclass)),
  'triggers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(t.tgrelid::pg_catalog.regclass::text,t.tgname,t.tgenabled,t.tgtype,t.tgnargs,pg_catalog.pg_get_triggerdef(t.oid),
    p.oid::pg_catalog.regprocedure::text,p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user),p.prosecdef,p.proconfig,p.provolatile,p.proisstrict,p.proleakproof,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)),'UTF8')),'hex'))
    order by t.tgrelid::pg_catalog.regclass::text,t.tgname)
    from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid where t.tgrelid in ('public.assets'::pg_catalog.regclass,'public.asset_versions'::pg_catalog.regclass,'public.workspace_members'::pg_catalog.regclass,'public.approvals'::pg_catalog.regclass,'public.folders'::pg_catalog.regclass) and not t.tgisinternal),
  'helpers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.signature,p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user),p.prosecdef,p.provolatile,p.proparallel,p.proisstrict,p.proleakproof,p.proretset,p.proconfig,p.proargnames,p.proargmodes,p.pronargdefaults,pg_catalog.pg_get_expr(p.proargdefaults,0),p.prorettype::pg_catalog.regtype::text,(select lanname from pg_catalog.pg_language where oid=p.prolang),
    case when p.oid is null then null else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)),'UTF8')),'hex') end,
    case when p.oid is null then null else pg_catalog.has_function_privilege('anon',p.oid,'execute') end,
    case when p.oid is null then null else pg_catalog.has_function_privilege('authenticated',p.oid,'execute') end,
    case when p.oid is null then null else pg_catalog.has_function_privilege('service_role',p.oid,'execute') end) order by s.signature)
    from (values ('private.is_workspace_member(uuid)'),('private.can_edit_workspace(uuid)'),('private.workspace_role(uuid)'),('private.can_approve_workspace(uuid)'),('private.is_active_workspace_user(uuid,uuid)'),('private.asset_path_matches(text,uuid,uuid)'),('private.folder_belongs_to_workspace(uuid,uuid)')) s(signature)
    left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(s.signature)),
  'roles',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.rolname,r.rolsuper,r.rolbypassrls,r.rolinherit) order by r.rolname) from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role')),
  'memberships',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(m.rolname,r.rolname,a.admin_option,a.inherit_option,a.set_option) order by m.rolname,r.rolname) from pg_catalog.pg_auth_members a join pg_catalog.pg_roles m on m.oid=a.member join pg_catalog.pg_roles r on r.oid=a.roleid where m.rolname in ('anon','authenticated','service_role')),
  'schemas',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(n.nspname,n.nspowner=(select oid from pg_catalog.pg_roles where rolname=current_user),
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.role_name,v.priv,pg_catalog.has_schema_privilege(r.role_name,n.oid,v.priv)) order by r.role_name,v.priv)
      from (values ('anon'),('authenticated'),('service_role')) r(role_name) cross join (values ('usage'),('create')) v(priv))) order by n.nspname)
    from pg_catalog.pg_namespace n where n.nspname in ('public','private','bookworm_private'))
)::text),'UTF8')),'hex') into actual;
 perform pg_catalog.set_config('search_path',prior_path,true);
 if actual is distinct from '45556d586362187e4d286012d20c7d8a09fb37ac8e75c4291b0c7106fbcb6742' then raise exception 'asset cutover preflight: legacy authorization baseline drift' using errcode='55000'; end if;
end $legacy_baseline$;


-- Requires an explicit transaction; LOCK TABLE fails outside one.
-- Compare source and security properties separately so formatting differences in
-- pg_get_functiondef across PostgreSQL engines do not define safety.
do $$
declare entry record; fn oid;
begin
 for entry in select * from (values
 ('private.asset_lifecycle_status_internal(uuid,uuid,uuid)','1da4691d485af139b86c4c6c2164912734701aaf9ab9a6194aa663b7580cf214',true,'plpgsql','jsonb',array['p_workspace_id','p_asset_id','p_operation_id'],0),
 ('private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','66b581a76b15c5d33353cb47a7e5288f7b5f3e6e62cb45fd680f6082e8204007',true,'plpgsql','jsonb',array['p_workspace_id','p_asset_id','p_operation_id','p_action','p_expected_deleted_at','p_expected_revision'],0),
 ('private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','6e0fe2e27fbf032f7769f2bf0083efeca9efff2e75a3903da53985c0abc451ac',true,'plpgsql','jsonb',array['p_actor_id','p_workspace_id','p_asset_id','p_operation_id','p_expected_deleted_at','p_expected_revision','p_version_id','p_storage_path','p_checksum','p_size_bytes'],0),
 ('private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','2ce23c21ee4d9c29f229ca72c18d55980ceef80e1e6091609be33522b277958b',true,'plpgsql','jsonb',array['p_workspace_id','p_asset_id','p_operation_id','p_action','p_expected_deleted_at','p_expected_revision'],0),
 ('public.asset_lifecycle_status(uuid,uuid,uuid)','0da8f8c7d687c6cd87955277bab258e3f16a588064751febe5f51a2263b10c1d',false,'sql','jsonb',array['p_workspace_id','p_asset_id','p_operation_id'],0),
 ('public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','59775f3d5f1175bdb4e604fdf9124fd1f782f54af3a51798d92f8f7b2ffdaac8',false,'sql','jsonb',array['p_workspace_id','p_asset_id','p_operation_id','p_action','p_expected_deleted_at','p_expected_revision'],0),
 ('public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','9794356d909c60864854863e401fa75ec4367267665f74c81ba201ba0dffa23c',false,'sql','jsonb',array['p_actor_id','p_workspace_id','p_asset_id','p_operation_id','p_expected_deleted_at','p_expected_revision','p_version_id','p_storage_path','p_checksum','p_size_bytes'],0),
 ('public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','50cb178212f3cfd4e2f67126a6c70df8b6c802972997c896aec0514f2ad0bd94',false,'sql','jsonb',array['p_workspace_id','p_asset_id','p_operation_id','p_action','p_expected_deleted_at','p_expected_revision'],0),
 ('public.record_asset_scan_verdict(uuid,integer,text,text,text,bigint,text,text,text)','989c56ed45ac4357b4529ceeb6dc9f4e886363d93d70fd6967e12657ff295fbb',false,'plpgsql','public.asset_versions',array['p_asset_id','p_version_number','p_verdict','p_checksum','p_detected_mime_type','p_size_bytes','p_scanner','p_signature','p_error_code'],2)
 ) as expected(signature,source_sha256,is_definer,language_name,return_type,arg_names,default_count) loop
  fn := to_regprocedure(entry.signature);
  if fn is null then raise exception 'asset cutover preflight: required function missing' using errcode='55000'; end if;
  if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
    where p.oid=fn and encode(sha256(convert_to(replace(p.prosrc,chr(13)||chr(10),chr(10)),'UTF8')),'hex')=entry.source_sha256
      and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)
      and p.prosecdef=entry.is_definer and l.lanname=entry.language_name and p.prorettype=to_regtype(entry.return_type)
      and p.proargnames=entry.arg_names and p.proargmodes is null and p.pronargdefaults=entry.default_count
      and p.provolatile='v' and p.proparallel='u' and not p.proleakproof and not p.proretset and not p.proisstrict and p.prokind='f'
      and p.proconfig=case when entry.default_count=2 then array['search_path=public, pg_temp'] else array['search_path=""'] end
      and ((entry.default_count=0 and p.proargdefaults is null) or (entry.default_count=2 and pg_get_expr(p.proargdefaults,0)='NULL::text, NULL::text'))) then
    raise exception 'asset cutover preflight: function drift' using errcode='55000';
  end if;
  if has_function_privilege('anon',fn,'execute') or has_function_privilege('authenticated',fn,'execute')
    or (entry.default_count=0 and has_function_privilege('service_role',fn,'execute'))
    or (entry.default_count=2 and not has_function_privilege('service_role',fn,'execute')) then
    raise exception 'asset cutover preflight: unexpected RPC privilege' using errcode='55000';
  end if;
 end loop;
 if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('private.asset_path_matches(text,uuid,uuid)')
    and encode(sha256(convert_to(replace(p.prosrc,chr(13)||chr(10),chr(10)),'UTF8')),'hex')='ef187ed80f70953a891c6e457e1251cf51ec50b02b159b5f8087ccc1a40e0ac6'
    and p.proowner=(select oid from pg_roles where rolname=current_user) and not p.prosecdef and l.lanname='sql' and p.prorettype='boolean'::regtype
    and p.proargnames=array['p_path','p_workspace_id','p_asset_id'] and p.proargmodes is null and p.pronargdefaults=0 and p.proargdefaults is null
    and p.provolatile='i' and p.proparallel='u' and not p.proleakproof and not p.proretset and not p.proisstrict and p.prokind='f' and p.proconfig=array['search_path=""'])
    or has_function_privilege('anon','private.asset_path_matches(text,uuid,uuid)','execute')
    or not has_function_privilege('authenticated','private.asset_path_matches(text,uuid,uuid)','execute') then
   raise exception 'asset cutover preflight: path function drift' using errcode='55000';
 end if;
 if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.assets'::regclass and a.attname='lifecycle_revision' and not a.attisdropped and a.atttypid='uuid'::regtype and not a.attnotnull and pg_get_expr(d.adbin,d.adrelid)='gen_random_uuid()')
    or not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('private.track_asset_lifecycle_revision()') and encode(sha256(convert_to(replace(p.prosrc,chr(13)||chr(10),chr(10)),'UTF8')),'hex')='085abf120fb3a55005a6f1dec41be6322f079a0475f18c1a475352db41738d1b'
      and p.proowner=(select oid from pg_roles where rolname=current_user) and not p.prosecdef and l.lanname='plpgsql' and p.prorettype='trigger'::regtype and p.proargmodes is null and p.pronargdefaults=0 and p.provolatile='v' and p.proparallel='u' and not p.proleakproof and not p.proretset and not p.proisstrict and p.prokind='f' and p.proconfig=array['search_path=""'])
    or exists(select 1 from (values ('anon'),('authenticated'),('service_role')) roles(name) where has_function_privilege(roles.name,'private.track_asset_lifecycle_revision()','execute'))
    or not exists(select 1 from pg_trigger t where t.tgrelid='public.assets'::regclass and t.tgname='aa_track_asset_lifecycle_revision' and not t.tgisinternal and t.tgfoid='private.track_asset_lifecycle_revision()'::regprocedure and t.tgenabled='O' and t.tgtype=23 and t.tgnargs=0 and t.tgqual is null) then
  raise exception 'asset cutover preflight: lifecycle revision protection drift' using errcode='55000'; end if;
 if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure('private.track_asset_version_revision()') and encode(sha256(convert_to(replace(p.prosrc,chr(13)||chr(10),chr(10)),'UTF8')),'hex')='68438ec756b2563438adec283dac54451945b7ee8a996e9184ee21cea3ca5608'
      and p.proowner=(select oid from pg_roles where rolname=current_user) and p.prosecdef and l.lanname='plpgsql' and p.prorettype='trigger'::regtype and p.proargmodes is null and p.pronargdefaults=0 and p.provolatile='v' and p.proparallel='u' and not p.proleakproof and not p.proretset and not p.proisstrict and p.prokind='f' and p.proconfig=array['search_path=""'])
    or exists(select 1 from (values ('anon'),('authenticated'),('service_role')) roles(name) where has_function_privilege(roles.name,'private.track_asset_version_revision()','execute'))
    or not exists(select 1 from pg_trigger t where t.tgrelid='public.asset_versions'::regclass and t.tgname='aa_track_asset_version_revision' and not t.tgisinternal and t.tgfoid='private.track_asset_version_revision()'::regprocedure and t.tgenabled='O' and t.tgtype=7 and t.tgnargs=0 and t.tgqual is null) then
  raise exception 'asset cutover preflight: asset version revision protection drift' using errcode='55000'; end if;
 if exists(select 1 from pg_trigger where not tgisinternal and tgname in ('aa_guard_removed_asset_bytes','aa_guard_removed_asset_version_insert')) then raise exception 'asset cutover preflight: trigger already present' using errcode='55000'; end if;
 if (select array_agg(concat_ws('|',a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull::text,coalesce(pg_get_expr(d.adbin,d.adrelid),'<null>')) order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
       where a.attrelid='bookworm_private.asset_lifecycle_receipts'::regclass and a.attnum>0 and not a.attisdropped) is distinct from array[
       'actor_id|uuid|true|<null>','operation_id|uuid|true|<null>','workspace_id|uuid|true|<null>','asset_id|uuid|true|<null>',
       'action|text|true|<null>',E'outcome|text|true|\'committed\'::text','expected_deleted_at|timestamp with time zone|false|<null>',
       'expected_revision|uuid|false|<null>','expected_version_id|uuid|false|<null>','expected_storage_path|text|false|<null>','expected_checksum|text|false|<null>',
       'expected_size_bytes|bigint|false|<null>','committed_at|timestamp with time zone|true|clock_timestamp()']
    or (select array_agg(pg_get_constraintdef(c.oid) order by pg_get_constraintdef(c.oid)) from pg_constraint c
       where c.conrelid='bookworm_private.asset_lifecycle_receipts'::regclass and c.contype in ('c','p','u','f','x'))
       is distinct from array[E'CHECK ((action = ANY (ARRAY[\'remove\'::text, \'restore\'::text])))',E'CHECK ((outcome = ANY (ARRAY[\'committed\'::text, \'closed\'::text])))','PRIMARY KEY (actor_id, operation_id)']
    or exists(select 1 from pg_trigger where tgrelid='bookworm_private.asset_lifecycle_receipts'::regclass and not tgisinternal)
    or exists(select 1 from bookworm_private.asset_lifecycle_receipts) then
   raise exception 'asset cutover preflight: receipt structure drift' using errcode='55000';
 end if;
 if not exists(select 1 from pg_class where oid='bookworm_private.asset_lifecycle_receipts'::regclass and relrowsecurity and relowner=(select oid from pg_roles where rolname=current_user))
    or exists(select 1 from pg_attribute a where a.attrelid='bookworm_private.asset_lifecycle_receipts'::regclass and a.attnum>0 and not a.attisdropped and a.attacl is not null)
    or exists(select 1 from pg_attribute a cross join (values ('anon'),('authenticated'),('service_role')) roles(name) cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) privs(name) where a.attrelid='bookworm_private.asset_lifecycle_receipts'::regclass and a.attnum>0 and not a.attisdropped and has_column_privilege(roles.name,a.attrelid,a.attnum,privs.name))
    or exists(select 1 from pg_policy where polrelid='bookworm_private.asset_lifecycle_receipts'::regclass)
    or exists(select 1 from (values ('anon'),('authenticated'),('service_role')) roles(name) cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) privs(name) where has_table_privilege(roles.name,'bookworm_private.asset_lifecycle_receipts',privs.name)) then
  raise exception 'asset cutover preflight: receipt protection drift' using errcode='55000'; end if;
end $$;

-- Prototype: serialize version allocation with removal and freeze the current
-- byte identity while the asset is deleted. Actual object retention is separate.
create function private.guard_removed_asset_version_insert() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare removed_at timestamptz;
begin
  select deleted_at into removed_at from public.assets where id = new.asset_id for update;
  if not found then raise exception 'asset not found' using errcode='23503'; end if;
  if removed_at is not null then raise exception 'asset is removed' using errcode='40001'; end if;
  return new;
end $$;
revoke all on function private.guard_removed_asset_version_insert() from public,anon,authenticated,service_role;
create trigger aa_guard_removed_asset_version_insert before insert on public.asset_versions
for each row execute function private.guard_removed_asset_version_insert();

create function private.guard_removed_asset_bytes() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  -- An invoker trigger sees the security-definer lifecycle function owner,
  -- but a direct service-role or authenticated UPDATE retains that caller.
  if new.deleted_at is distinct from old.deleted_at and current_user <>
     pg_get_userbyid((select proowner from pg_proc where oid = 'private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure)) then
    raise exception 'asset lifecycle must use its atomic operation' using errcode='42501';
  end if;
  if old.deleted_at is not null and (
    new.storage_path is distinct from old.storage_path or new.checksum is distinct from old.checksum
    or new.mime_type is distinct from old.mime_type or new.size_bytes is distinct from old.size_bytes
  ) then raise exception 'removed asset bytes cannot change' using errcode='40001'; end if;
  return new;
end $$;
revoke all on function private.guard_removed_asset_bytes() from public,anon,authenticated,service_role;
create trigger aa_guard_removed_asset_bytes before update on public.assets
for each row execute function private.guard_removed_asset_bytes();

-- Scratch: keep scanner completion from finalizing any removed version.
create or replace function public.record_asset_scan_verdict(
  p_asset_id uuid,
  p_version_number integer,
  p_verdict text,
  p_checksum text,
  p_detected_mime_type text,
  p_size_bytes bigint,
  p_scanner text,
  p_signature text default null,
  p_error_code text default null
) returns public.asset_versions
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_version public.asset_versions;
  v_asset public.assets;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_asset_id is null
    or p_version_number is null or p_version_number < 1
    or p_verdict not in ('clean', 'infected', 'error')
    or p_checksum !~ '^[a-f0-9]{64}$'
    or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 104857600
    or coalesce(length(trim(p_scanner)), 0) not between 1 and 100
    or p_scanner ~ '[[:cntrl:]]'
    or length(coalesce(p_signature, '')) > 200
    or coalesce(p_signature, '') ~ '[[:cntrl:]]'
    or length(coalesce(p_error_code, '')) > 100
    or coalesce(p_error_code, '') ~ '[^a-z0-9_]'
    or (p_verdict in ('clean', 'infected') and (
      p_detected_mime_type is null
      or p_detected_mime_type !~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$'
      or coalesce(length(trim(p_signature)), 0) < 1
      or (p_verdict = 'clean' and p_error_code is not null)
      or (p_verdict = 'infected' and p_error_code is distinct from 'malware_detected')
    ))
    or (p_verdict = 'error' and (
      p_error_code is null or p_error_code not in (
        'size_mismatch', 'checksum_mismatch', 'unsupported_content',
        'content_type_mismatch', 'scanner_unavailable'
      )
    ))
  then
    raise exception 'invalid asset scan verdict' using errcode = '22023';
  end if;

  select * into v_asset from public.assets where id = p_asset_id for update;
  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;
  if v_asset.deleted_at is not null and p_verdict = 'clean' then
    raise exception 'asset is removed' using errcode = '40001';
  end if;
  select * into v_version
  from public.asset_versions
  where asset_id = p_asset_id and version_number = p_version_number
  for update;
  if not found then
    raise exception 'asset version not found' using errcode = 'P0002';
  end if;
  if v_version.checksum <> 'pending'
     or v_version.scan_status not in ('pending', 'error') then
    raise exception 'asset scan verdict is already terminal' using errcode = '40001';
  end if;

  if p_verdict = 'error' then
    update public.asset_versions
    set scan_status = 'error',
        detected_mime_type = p_detected_mime_type,
        scan_scanner = trim(p_scanner),
        scan_signature = nullif(trim(coalesce(p_signature, '')), ''),
        scan_error_code = p_error_code,
        scanned_at = now()
    where id = v_version.id
    returning * into v_version;
    return v_version;
  end if;

  update public.asset_versions
  set checksum = p_checksum,
      mime_type = p_detected_mime_type,
      size_bytes = p_size_bytes,
      scan_status = p_verdict,
      detected_mime_type = p_detected_mime_type,
      scan_scanner = trim(p_scanner),
      scan_signature = trim(p_signature),
      scan_error_code = p_error_code,
      scanned_at = now()
  where id = v_version.id
  returning * into v_version;

  if p_verdict = 'clean' then
    update public.assets
    set storage_path = v_version.storage_path,
        checksum = p_checksum,
        mime_type = p_detected_mime_type,
        size_bytes = p_size_bytes,
        updated_at = now()
    where id = p_asset_id
      and p_version_number = (
        select max(av.version_number) from public.asset_versions av where av.asset_id = p_asset_id
      );
  end if;
  return v_version;
end;
$$;



-- Make all entry points callable only after trigger and scanner changes succeed.
grant execute on function private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid) to authenticated;
grant execute on function public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid) to authenticated;
grant execute on function private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint) to service_role;
grant execute on function public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint) to service_role;
grant execute on function private.asset_lifecycle_status_internal(uuid,uuid,uuid) to authenticated;
grant execute on function public.asset_lifecycle_status(uuid,uuid,uuid) to authenticated;

grant execute on function private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid) to authenticated;
grant execute on function public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid) to authenticated;

-- Isolated readiness prototype; never apply to a live database without review.
create table bookworm_private.asset_lifecycle_manifest (singleton boolean primary key default true check (singleton), fingerprint jsonb not null);
alter table bookworm_private.asset_lifecycle_manifest enable row level security;
revoke all on bookworm_private.asset_lifecycle_manifest from public, anon, authenticated, service_role;
do $manifest_acl$
begin
 if exists(select 1 from pg_catalog.pg_class c
   cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
   where c.oid='bookworm_private.asset_lifecycle_manifest'::pg_catalog.regclass and a.grantee<>c.relowner)
   or exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='bookworm_private.asset_lifecycle_manifest'::pg_catalog.regclass and a.attnum>0 and not a.attisdropped and a.attacl is not null) then
  raise exception 'asset cutover preflight: manifest privilege drift' using errcode='55000';
 end if;
end $manifest_acl$;

create function private.asset_lifecycle_fingerprint() returns jsonb language sql security definer set search_path = '' as $$
 select jsonb_build_object(
 'functions', (select jsonb_agg(jsonb_build_array(s.signature,p.proowner,p.prosecdef,p.proconfig,p.proacl::text,
             case when p.oid is null then null else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex') end,
             case when p.oid is null then null else pg_catalog.has_function_privilege('anon',p.oid,'execute') end,
             case when p.oid is null then null else pg_catalog.has_function_privilege('authenticated',p.oid,'execute') end,
             case when p.oid is null then null else pg_catalog.has_function_privilege('service_role',p.oid,'execute') end) order by s.signature)
   from (values ('private.asset_lifecycle_fingerprint()'),('private.assert_asset_lifecycle_ready()'),('private.asset_lifecycle_readiness_internal()'),('public.asset_lifecycle_readiness()'),
        ('private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'),('public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'),
        ('private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'),('public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)'),
        ('private.asset_lifecycle_status_internal(uuid,uuid,uuid)'),('public.asset_lifecycle_status(uuid,uuid,uuid)'),
        ('private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)'),('public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)'),
        ('private.track_asset_lifecycle_revision()'),('private.track_asset_version_revision()'),('private.guard_removed_asset_bytes()'),('private.guard_removed_asset_version_insert()'),('private.asset_path_matches(text,uuid,uuid)'),
        ('private.folder_belongs_to_workspace(uuid,uuid)'),('private.is_workspace_member(uuid)'),('private.can_edit_workspace(uuid)'),('private.workspace_role(uuid)'),('private.can_approve_workspace(uuid)'),('private.is_active_workspace_user(uuid,uuid)'),('auth.uid()'),('auth.role()'),
        ('public.record_asset_scan_verdict(uuid,integer,text,text,text,bigint,text,text,text)')) s(signature)
   left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(s.signature)),
 'triggers', (select jsonb_agg(jsonb_build_array(s.name,t.tgenabled,t.tgfoid,
           case when t.oid is null then null else pg_catalog.pg_get_triggerdef(t.oid) end) order by s.name)
   from (values ('aa_guard_removed_asset_bytes','public.assets'),('aa_guard_removed_asset_version_insert','public.asset_versions')) s(name,relation)
   left join pg_catalog.pg_trigger t on t.tgname=s.name and t.tgrelid=pg_catalog.to_regclass(s.relation) and not t.tgisinternal),
 'tables', (select jsonb_agg(jsonb_build_array(s.name,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
           case when c.oid is null then null else (select jsonb_agg(jsonb_build_array(x.priv,pg_catalog.has_table_privilege('anon',c.oid,x.priv)) order by x.priv) from (values ('select'),('insert'),('update'),('delete'),('truncate'),('trigger'),('references')) x(priv)) end,
           case when c.oid is null then null else (select jsonb_agg(jsonb_build_array(x.priv,pg_catalog.has_table_privilege('authenticated',c.oid,x.priv)) order by x.priv) from (values ('select'),('insert'),('update'),('delete'),('truncate'),('trigger'),('references')) x(priv)) end,
           case when c.oid is null then null else (select jsonb_agg(jsonb_build_array(x.priv,pg_catalog.has_table_privilege('service_role',c.oid,x.priv)) order by x.priv) from (values ('select'),('insert'),('update'),('delete'),('truncate'),('trigger'),('references')) x(priv)) end) order by s.name)
   from (values ('bookworm_private.asset_lifecycle_receipts'),('bookworm_private.asset_lifecycle_manifest'),('public.assets'),('public.asset_versions'),('public.workspace_members'),('public.approvals'),('public.folders')) s(name)
   left join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass(s.name)),
 'constraints', (select jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_catalog.pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname) from pg_catalog.pg_constraint c where c.conrelid in ('bookworm_private.asset_lifecycle_receipts'::regclass,'bookworm_private.asset_lifecycle_manifest'::regclass,'public.assets'::regclass,'public.asset_versions'::regclass,'public.workspace_members'::regclass,'public.approvals'::regclass,'public.folders'::regclass)),
 'columns', (select jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attgenerated,a.attidentity,a.attacl::text,pg_catalog.pg_get_expr(d.adbin,d.adrelid), (select jsonb_agg(jsonb_build_array(r.name,x.priv,pg_catalog.has_column_privilege(r.name,a.attrelid,a.attnum,x.priv)) order by r.name,x.priv) from (values ('anon'),('authenticated'),('service_role')) r(name) cross join (values ('select'),('insert'),('update'),('references')) x(priv))) order by a.attrelid::regclass::text,a.attnum) from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid in ('bookworm_private.asset_lifecycle_receipts'::regclass,'bookworm_private.asset_lifecycle_manifest'::regclass,'public.assets'::regclass,'public.asset_versions'::regclass,'public.workspace_members'::regclass,'public.approvals'::regclass,'public.folders'::regclass) and a.attnum>0 and not a.attisdropped),
 'policies', (select jsonb_agg(jsonb_build_array(p.polrelid::regclass::text,p.polname,p.polcmd,p.polpermissive,p.polroles,pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polrelid::regclass::text,p.polname) from pg_catalog.pg_policy p where p.polrelid in ('bookworm_private.asset_lifecycle_receipts'::regclass,'bookworm_private.asset_lifecycle_manifest'::regclass,'public.assets'::regclass,'public.asset_versions'::regclass,'public.workspace_members'::regclass,'public.approvals'::regclass,'public.folders'::regclass)),
 'all_user_triggers', (select jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid),pg_catalog.pg_get_functiondef(t.tgfoid),(select p.proowner from pg_catalog.pg_proc p where p.oid=t.tgfoid),(select p.proacl::text from pg_catalog.pg_proc p where p.oid=t.tgfoid)) order by t.tgrelid::regclass::text,t.tgname) from pg_catalog.pg_trigger t where t.tgrelid in ('bookworm_private.asset_lifecycle_receipts'::regclass,'bookworm_private.asset_lifecycle_manifest'::regclass,'public.assets'::regclass,'public.asset_versions'::regclass,'public.workspace_members'::regclass,'public.approvals'::regclass,'public.folders'::regclass) and not t.tgisinternal),
 'roles', (select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolbypassrls,rolinherit) order by rolname) from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role')),
 'memberships', (select jsonb_agg(jsonb_build_array(m.rolname,r.rolname,a.admin_option,a.inherit_option,a.set_option) order by m.rolname,r.rolname) from pg_catalog.pg_auth_members a join pg_catalog.pg_roles m on m.oid=a.member join pg_catalog.pg_roles r on r.oid=a.roleid where m.rolname in ('anon','authenticated','service_role')),
 'schemas', (select jsonb_agg(jsonb_build_array(s.nspname,s.nspowner,s.nspacl::text,pg_catalog.has_schema_privilege('anon',s.oid,'usage'),pg_catalog.has_schema_privilege('authenticated',s.oid,'usage'),pg_catalog.has_schema_privilege('service_role',s.oid,'usage'),pg_catalog.has_schema_privilege('anon',s.oid,'create'),pg_catalog.has_schema_privilege('authenticated',s.oid,'create'),pg_catalog.has_schema_privilege('service_role',s.oid,'create')) order by s.nspname) from pg_catalog.pg_namespace s where s.nspname in ('public','private','bookworm_private','auth'))
 )
$$;
revoke all on function private.asset_lifecycle_fingerprint() from public,anon,authenticated,service_role;

create function private.assert_asset_lifecycle_ready() returns void language plpgsql security definer set search_path = '' as $$
declare expected jsonb; prior_timeout text := current_setting('lock_timeout'); prior_ms integer; remaining_ms integer; relation regclass; deadline timestamptz := clock_timestamp() + interval '1500 milliseconds';
begin
 select setting::integer into prior_ms from pg_catalog.pg_settings where name='lock_timeout';
 if prior_ms=0 or prior_ms>1500 then perform pg_catalog.set_config('lock_timeout','1500ms',true); end if;
 -- Cooperative changes must take the exclusive version of this advisory lock.
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('bookworm-asset-lifecycle-schema-v1',0));
 foreach relation in array array['public.workspace_members'::regclass,'public.assets'::regclass,'public.asset_versions'::regclass,'public.approvals'::regclass,'public.folders'::regclass,'bookworm_private.asset_lifecycle_receipts'::regclass,'bookworm_private.asset_lifecycle_manifest'::regclass] loop
   remaining_ms := ceil(extract(epoch from (deadline-clock_timestamp())) * 1000)::integer;
   if remaining_ms<=0 then raise exception 'asset lifecycle readiness lock deadline' using errcode='55P03'; end if;
   if prior_ms>0 then remaining_ms := least(remaining_ms,prior_ms); end if;
   perform pg_catalog.set_config('lock_timeout',remaining_ms::text||'ms',true);
   execute format('lock table %s in row exclusive mode',relation);
 end loop;
 select fingerprint into expected from bookworm_private.asset_lifecycle_manifest where singleton;
 if expected is null or expected is distinct from private.asset_lifecycle_fingerprint() then
   raise exception 'asset lifecycle capability unavailable' using errcode='55000';
 end if;
 perform pg_catalog.set_config('lock_timeout',prior_timeout,true);
end $$;
revoke all on function private.assert_asset_lifecycle_ready() from public,anon,authenticated,service_role;

create function private.asset_lifecycle_readiness_internal() returns text language plpgsql security definer set search_path = '' as $$
begin
 if current_setting('role',true) is distinct from 'service_role' or auth.role() is distinct from 'service_role' then
   raise exception 'service role required' using errcode='42501';
 end if;
 perform private.assert_asset_lifecycle_ready();
 return 'asset-lifecycle-v1';
end $$;
revoke all on function private.asset_lifecycle_readiness_internal() from public,anon,authenticated,service_role;
grant execute on function private.asset_lifecycle_readiness_internal() to service_role;
create function public.asset_lifecycle_readiness() returns text language sql security invoker set search_path = '' as $$ select private.asset_lifecycle_readiness_internal(); $$;
revoke all on function public.asset_lifecycle_readiness() from public,anon,authenticated,service_role;
grant execute on function public.asset_lifecycle_readiness() to service_role;


create or replace function private.mutate_asset_lifecycle_internal(
 p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_action text,p_expected_deleted_at timestamptz,p_expected_revision uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid := auth.uid();
 v_role text;
 v_asset public.assets;
 v_receipt bookworm_private.asset_lifecycle_receipts;
 v_previous_setting text;
 v_event text;
begin
 if current_setting('role',true) is distinct from 'authenticated'
   or auth.role() is distinct from 'authenticated' or v_actor is null then
   raise exception 'authenticated actor required' using errcode='42501';
 end if;
 if p_workspace_id is null or p_asset_id is null or p_operation_id is null
   or p_action not in ('remove','restore') or p_action is null
   or (p_action='remove' and p_expected_deleted_at is not null)
   or (p_action='restore' and (p_expected_deleted_at is null or not isfinite(p_expected_deleted_at))) then
   raise exception 'invalid asset lifecycle request' using errcode='22023';
 end if;
 -- Only the server may restore after verifying the actual private object bytes.
 if p_action='restore' then raise exception 'verified server restore required' using errcode='42501'; end if;
 if not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' and wm.role::text in ('owner','admin','editor','writer','illustrator','designer')) then raise exception 'asset editing access required' using errcode='42501'; end if;
 perform private.assert_asset_lifecycle_ready();
 select wm.role::text into v_role from public.workspace_members wm
 where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' for share;
 if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
   raise exception 'asset editing access required' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('asset-lifecycle:'||v_actor::text||':'||p_operation_id::text,0));
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r
 where r.actor_id=v_actor and r.operation_id=p_operation_id;
 if found then
   if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.asset_id is distinct from p_asset_id
      or v_receipt.action is distinct from p_action or v_receipt.expected_deleted_at is distinct from p_expected_deleted_at or v_receipt.expected_revision is distinct from p_expected_revision then
     raise exception 'asset lifecycle operation conflict' using errcode='23505';
   end if;
   if v_receipt.outcome='closed' then raise exception 'asset operation was closed' using errcode='40001'; end if;
   return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',p_action,'expectedRevision',p_expected_revision,'replayed',true);
 end if;
 select a.* into v_asset from public.assets a where a.id=p_asset_id and a.workspace_id=p_workspace_id for update;
 if not found then raise exception 'asset not found' using errcode='P0002'; end if;
 if v_asset.lifecycle_revision is distinct from p_expected_revision then raise exception 'asset lifecycle revision changed' using errcode='40001'; end if;
 if p_action='remove' and v_asset.deleted_at is not null then
   raise exception 'asset already removed' using errcode='40001';
 end if;
 if p_action='restore' and v_asset.deleted_at is distinct from p_expected_deleted_at then
   raise exception 'asset state changed' using errcode='40001';
 end if;
 if p_action='restore' then
   perform av.id from public.asset_versions av
   where av.asset_id=v_asset.id and av.storage_path=v_asset.storage_path and av.checksum=v_asset.checksum
     and av.scan_status in ('clean','trusted_generated') for share;
   if not found or v_asset.checksum is null or v_asset.checksum !~ '^[a-fA-F0-9]{64}$' then
     raise exception 'asset cannot be restored without a confirmed clean current version' using errcode='23514';
   end if;
 end if;
 -- Review decisions predating removal/restoration must never authorize the restored asset.
 update public.approvals a set superseded_at=clock_timestamp(),
   status=case when a.status='pending' then 'cancelled'::public.approval_status else a.status end,
   resolved_at=case when a.status='pending' then clock_timestamp() else a.resolved_at end,
   resolved_by=case when a.status='pending' then null else a.resolved_by end,
   resolution_note=case when a.status='pending' then 'Superseded by asset removal or restoration.' else a.resolution_note end,
   updated_at=clock_timestamp()
 where a.entity_type='asset' and a.entity_id=v_asset.id and a.workspace_id=p_workspace_id and a.superseded_at is null;
 v_previous_setting := current_setting('bookworm.asset_review_internal',true);
 perform set_config('bookworm.asset_review_internal','on',true);
 if p_action='remove' then
   update public.assets set deleted_at=clock_timestamp(),status='archived' where id=v_asset.id;
   v_event:='asset_deleted';
 else
   update public.assets set deleted_at=null,status='draft' where id=v_asset.id;
   v_event:='asset_restored';
 end if;
 perform set_config('bookworm.asset_review_internal',coalesce(v_previous_setting,''),true);
 insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id)
 values(p_workspace_id,v_actor,v_event,'asset',v_asset.id);
 insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,expected_deleted_at,expected_revision)
 values(v_actor,p_operation_id,p_workspace_id,p_asset_id,p_action,p_expected_deleted_at,p_expected_revision);
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',p_action,'expectedRevision',p_expected_revision,'replayed',false);
end $$;

create or replace function private.restore_verified_asset_internal(
 p_actor_id uuid,p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_expected_deleted_at timestamptz,p_expected_revision uuid,
 p_version_id uuid,p_storage_path text,p_checksum text,p_size_bytes bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_role text;
 v_asset public.assets;
 v_version public.asset_versions;
 v_receipt bookworm_private.asset_lifecycle_receipts;
 v_previous_setting text;
begin
 if current_setting('role',true) is distinct from 'service_role' or auth.role() is distinct from 'service_role' then
   raise exception 'service role required' using errcode='42501';
 end if;
 if p_actor_id is null or p_workspace_id is null or p_asset_id is null or p_operation_id is null
   or p_expected_deleted_at is null or not isfinite(p_expected_deleted_at) or p_version_id is null
   or p_storage_path is null or p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 104857600 then
   raise exception 'invalid verified restore' using errcode='22023';
 end if;
 if not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=p_actor_id and wm.status='active' and wm.role::text in ('owner','admin','editor','writer','illustrator','designer')) then raise exception 'asset editing access required' using errcode='42501'; end if;
 perform private.assert_asset_lifecycle_ready();
 select wm.role::text into v_role from public.workspace_members wm
 where wm.workspace_id=p_workspace_id and wm.user_id=p_actor_id and wm.status='active' for share;
 if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
   raise exception 'asset editing access required' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('asset-lifecycle:'||p_actor_id::text||':'||p_operation_id::text,0));
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r where r.actor_id=p_actor_id and r.operation_id=p_operation_id;
 if found then
   if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.asset_id is distinct from p_asset_id
      or v_receipt.action is distinct from 'restore' or v_receipt.expected_deleted_at is distinct from p_expected_deleted_at or v_receipt.expected_revision is distinct from p_expected_revision then
     raise exception 'asset lifecycle operation conflict' using errcode='23505';
   end if;
   if v_receipt.outcome='closed' then raise exception 'asset operation was closed' using errcode='40001'; end if;
   if v_receipt.expected_version_id is distinct from p_version_id or v_receipt.expected_storage_path is distinct from p_storage_path
      or v_receipt.expected_checksum is distinct from p_checksum or v_receipt.expected_size_bytes is distinct from p_size_bytes then
     raise exception 'asset lifecycle operation conflict' using errcode='23505';
   end if;
   return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action','restore','expectedRevision',p_expected_revision,'replayed',true);
 end if;
 select * into v_asset from public.assets where id=p_asset_id and workspace_id=p_workspace_id for update;
 if not found then raise exception 'asset not found' using errcode='P0002'; end if;
 if v_asset.lifecycle_revision is distinct from p_expected_revision or v_asset.deleted_at is distinct from p_expected_deleted_at or v_asset.storage_path is distinct from p_storage_path
    or lower(v_asset.checksum) is distinct from p_checksum or v_asset.size_bytes is distinct from p_size_bytes then
   raise exception 'asset state changed during verification' using errcode='40001';
 end if;
 select * into v_version from public.asset_versions where id=p_version_id and asset_id=p_asset_id for share;
 if not found or v_version.storage_path is distinct from p_storage_path or lower(v_version.checksum) is distinct from p_checksum
    or v_version.size_bytes is distinct from p_size_bytes or v_version.mime_type is distinct from v_asset.mime_type
    or coalesce(v_version.scan_status, '') not in ('clean','trusted_generated')
    or not private.asset_path_matches(p_storage_path,p_workspace_id,p_asset_id) then
   raise exception 'asset does not have a confirmed clean current version' using errcode='23514';
 end if;
 update public.approvals a set superseded_at=clock_timestamp(),
   status=case when a.status='pending' then 'cancelled'::public.approval_status else a.status end,
   resolved_at=case when a.status='pending' then clock_timestamp() else a.resolved_at end,
   resolved_by=case when a.status='pending' then null else a.resolved_by end,
   resolution_note=case when a.status='pending' then 'Superseded by asset restoration.' else a.resolution_note end,
   updated_at=clock_timestamp()
 where a.entity_type='asset' and a.entity_id=v_asset.id and a.workspace_id=p_workspace_id and a.superseded_at is null;
 v_previous_setting:=current_setting('bookworm.asset_review_internal',true);
 perform set_config('bookworm.asset_review_internal','on',true);
 update public.assets set deleted_at=null,status='draft' where id=v_asset.id;
 perform set_config('bookworm.asset_review_internal',coalesce(v_previous_setting,''),true);
 insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id)
 values(p_workspace_id,p_actor_id,'asset_restored','asset',p_asset_id);
 insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,expected_deleted_at,expected_revision,
  expected_version_id,expected_storage_path,expected_checksum,expected_size_bytes)
 values(p_actor_id,p_operation_id,p_workspace_id,p_asset_id,'restore',p_expected_deleted_at,p_expected_revision,p_version_id,p_storage_path,p_checksum,p_size_bytes);
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action','restore','expectedRevision',p_expected_revision,'replayed',false);
end $$;

create or replace function private.asset_lifecycle_status_internal(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_receipt bookworm_private.asset_lifecycle_receipts;
begin
 if current_setting('role',true) is distinct from 'authenticated' or auth.role() is distinct from 'authenticated' or v_actor is null then
   raise exception 'authenticated actor required' using errcode='42501';
 end if;
 if p_workspace_id is null or p_asset_id is null or p_operation_id is null then
   raise exception 'invalid asset lifecycle request' using errcode='22023';
 end if;
 if not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active') then raise exception 'workspace unavailable' using errcode='42501'; end if;
 perform private.assert_asset_lifecycle_ready();
 perform wm.user_id from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' for share;
 if not found then raise exception 'workspace unavailable' using errcode='42501'; end if;
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r
 where r.actor_id=v_actor and r.workspace_id=p_workspace_id and r.asset_id=p_asset_id and r.operation_id=p_operation_id;
 if not found then return null; end if;
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',v_receipt.action,
  'expectedDeletedAt',v_receipt.expected_deleted_at,'expectedRevision',v_receipt.expected_revision,'committedAt',case when v_receipt.outcome='committed' then v_receipt.committed_at else null end,'closedAt',case when v_receipt.outcome='closed' then v_receipt.committed_at else null end,'outcome',v_receipt.outcome);
end $$;

create or replace function private.close_asset_lifecycle_internal(p_workspace_id uuid,p_asset_id uuid,p_operation_id uuid,p_action text,p_expected_deleted_at timestamptz,p_expected_revision uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_receipt bookworm_private.asset_lifecycle_receipts; v_count bigint; v_role text;
begin
 if current_setting('role',true) is distinct from 'authenticated' or auth.role() is distinct from 'authenticated' or v_actor is null then raise exception 'authenticated actor required' using errcode='42501'; end if;
 if p_workspace_id is null or p_asset_id is null or p_operation_id is null or p_action not in ('remove','restore') or p_action is null
   or (p_action='remove' and p_expected_deleted_at is not null) or (p_action='restore' and (p_expected_deleted_at is null or not isfinite(p_expected_deleted_at))) then raise exception 'invalid asset lifecycle request' using errcode='22023'; end if;
 if not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active') then raise exception 'workspace unavailable' using errcode='42501'; end if;
 if not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' and wm.role::text in ('owner','admin','editor','writer','illustrator','designer')) then raise exception 'asset editing access required' using errcode='42501'; end if;
 perform private.assert_asset_lifecycle_ready();
 select wm.role::text into v_role from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=v_actor and wm.status='active' for share;
 if not found then raise exception 'workspace unavailable' using errcode='42501'; end if;
 if v_role not in ('owner','admin','editor','writer','illustrator','designer') then raise exception 'asset editing access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('asset-close:'||v_actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended('asset-lifecycle:'||v_actor::text||':'||p_operation_id::text,0));
 select * into v_receipt from bookworm_private.asset_lifecycle_receipts r where r.actor_id=v_actor and r.operation_id=p_operation_id;
 if found then
   if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.asset_id is distinct from p_asset_id or v_receipt.action is distinct from p_action or v_receipt.expected_deleted_at is distinct from p_expected_deleted_at or v_receipt.expected_revision is distinct from p_expected_revision then raise exception 'asset lifecycle operation conflict' using errcode='23505'; end if;
 else
   select count(*) into v_count from bookworm_private.asset_lifecycle_receipts r where r.actor_id=v_actor and r.outcome='closed' and r.committed_at > clock_timestamp()-interval '1 hour';
   if v_count >= 60 then raise exception 'asset close limit reached' using errcode='54000'; end if;
   insert into bookworm_private.asset_lifecycle_receipts(actor_id,operation_id,workspace_id,asset_id,action,expected_deleted_at,expected_revision,outcome) values(v_actor,p_operation_id,p_workspace_id,p_asset_id,p_action,p_expected_deleted_at,p_expected_revision,'closed') returning * into v_receipt;
 end if;
 return jsonb_build_object('operationId',p_operation_id,'assetId',p_asset_id,'action',p_action,'outcome',v_receipt.outcome,'expectedDeletedAt',v_receipt.expected_deleted_at,'expectedRevision',v_receipt.expected_revision,'committedAt',case when v_receipt.outcome='committed' then v_receipt.committed_at else null end,'closedAt',case when v_receipt.outcome='closed' then v_receipt.committed_at else null end);
end $$;

-- Do not bless custom-role EXECUTE inherited from altered default privileges.
do $lifecycle_acl$
declare entry record; fn oid; owner_oid oid;
begin
 for entry in select * from (values
  ('private.asset_lifecycle_fingerprint()',null::text),('private.assert_asset_lifecycle_ready()',null::text),
  ('private.asset_lifecycle_readiness_internal()','service_role'),('public.asset_lifecycle_readiness()','service_role'),
  ('private.track_asset_lifecycle_revision()',null::text),('private.track_asset_version_revision()',null::text),
  ('private.guard_removed_asset_bytes()',null::text),('private.guard_removed_asset_version_insert()',null::text),
  ('private.mutate_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','authenticated'),
  ('public.mutate_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','authenticated'),
  ('private.asset_lifecycle_status_internal(uuid,uuid,uuid)','authenticated'),('public.asset_lifecycle_status(uuid,uuid,uuid)','authenticated'),
  ('private.close_asset_lifecycle_internal(uuid,uuid,uuid,text,timestamptz,uuid)','authenticated'),('public.close_asset_lifecycle(uuid,uuid,uuid,text,timestamptz,uuid)','authenticated'),
  ('private.restore_verified_asset_internal(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','service_role'),
  ('public.restore_verified_asset(uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,text,text,bigint)','service_role'),
  ('public.record_asset_scan_verdict(uuid,integer,text,text,text,bigint,text,text,text)','service_role')
 ) expected(signature,allowed_role) loop
  fn:=pg_catalog.to_regprocedure(entry.signature);
  if fn is null then raise exception 'asset cutover preflight: lifecycle function missing' using errcode='55000'; end if;
  select p.proowner into owner_oid from pg_catalog.pg_proc p where p.oid=fn;
  if exists(select 1 from pg_catalog.pg_proc p
     cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
     where p.oid=fn and a.grantee<>owner_oid and (a.is_grantable or entry.allowed_role is null or a.grantee<>pg_catalog.to_regrole(entry.allowed_role)))
    or (entry.allowed_role is not null and not pg_catalog.has_function_privilege(entry.allowed_role,fn,'execute')) then
   raise exception 'asset cutover preflight: lifecycle function privilege drift' using errcode='55000';
  end if;
 end loop;
end $lifecycle_acl$;

insert into bookworm_private.asset_lifecycle_manifest(singleton,fingerprint) values(true, private.asset_lifecycle_fingerprint());

COMMIT;
