begin;
set local role authenticated;
do $$ begin
  assert encode(public.digest('abc','sha256'),'hex')='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert public.digest('abc','sha256')=public.digest(convert_to('abc','UTF8'),'sha256');
  assert public.digest(null::text,'sha256') is null;
end $$;
reset role;
set local role service_role;
do $$ begin
  assert encode(public.digest('abc','sha256'),'hex')='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
end $$;
reset role;
do $$ declare n text; t text; p pg_proc; begin
  select ns.nspname into n from pg_extension e join pg_namespace ns on ns.oid=e.extnamespace where e.extname='pgcrypto';
  foreach t in array array['bytea','text'] loop
    select * into p from pg_proc where oid=to_regprocedure(format('public.digest(%s,text)',t));
    assert not p.prosecdef and p.proisstrict and p.provolatile='i';
    if n<>'public' then
      assert p.proparallel='s' and p.proconfig=array['search_path=pg_catalog, pg_temp'];
      assert not has_function_privilege('anon',p.oid,'EXECUTE');
      assert has_function_privilege('authenticated',p.oid,'EXECUTE');
      assert has_function_privilege('service_role',p.oid,'EXECUTE');
    end if;
  end loop;
end $$;
rollback;
