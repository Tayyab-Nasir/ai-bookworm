-- Additive bridge after the deployed 45-migration baseline, before the pending
-- functions that resolve public.digest at CREATE FUNCTION time. Generated with
-- the CLI on 2026-10-13, then ordered at this undeployed dependency boundary.
-- Supabase normally owns pgcrypto in extensions; plain PostgreSQL may use public.
-- Never relocate the extension, replace an existing function, or rewrite data.
do $bridge$
declare
  crypto_schema text;
  crypto_oid oid;
  input_type text;
  target oid;
  existing oid;
  signature text;
begin
  select e.oid,n.nspname into crypto_oid,crypto_schema
    from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace
    where e.extname='pgcrypto';
  if crypto_oid is null then
    raise exception 'pgcrypto digest compatibility requires the installed pgcrypto extension';
  end if;
  foreach input_type in array array['bytea','text'] loop
    target:=pg_catalog.to_regprocedure(pg_catalog.format('%I.digest(%s,text)',crypto_schema,input_type));
    if target is null or not exists(select 1 from pg_catalog.pg_depend d
      where d.classid='pg_catalog.pg_proc'::regclass and d.objid=target
        and d.refclassid='pg_catalog.pg_extension'::regclass and d.refobjid=crypto_oid and d.deptype='e') then
      raise exception 'pgcrypto digest compatibility target is not extension-owned';
    end if;
    signature:=pg_catalog.format('public.digest(%s,text)',input_type);
    existing:=pg_catalog.to_regprocedure(signature);
    if crypto_schema='public' then
      -- Existing extension-owned functions, identities, grants and dependents
      -- stay exactly as they were in the plain-PostgreSQL installation.
      if existing is distinct from target then raise exception 'pgcrypto public digest identity drift'; end if;
    else
      if existing is not null then
        raise exception 'pgcrypto compatibility refuses a pre-existing public.digest overload: %', input_type;
      end if;
      if not pg_catalog.has_schema_privilege('authenticated',crypto_schema,'USAGE')
        or not pg_catalog.has_schema_privilege('service_role',crypto_schema,'USAGE')
        or not pg_catalog.has_function_privilege('authenticated',target,'EXECUTE')
        or not pg_catalog.has_function_privilege('service_role',target,'EXECUTE') then
        raise exception 'pgcrypto compatibility requires existing application access to the extension functions';
      end if;
      execute pg_catalog.format('create function public.digest(%s,text) returns bytea
        language sql immutable strict parallel safe security invoker
        set search_path=pg_catalog,pg_temp as %L',input_type,
        pg_catalog.format('select %I.digest($1,$2)',crypto_schema));
      execute pg_catalog.format('revoke all on function %s from public,anon',signature);
      execute pg_catalog.format('grant execute on function %s to authenticated,service_role',signature);
      execute pg_catalog.format('comment on function %s is %L',signature,
        'Bookworm invoker-only pgcrypto namespace bridge; no data access or extension relocation.');
    end if;
  end loop;
end
$bridge$;
