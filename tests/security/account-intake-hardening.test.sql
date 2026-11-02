-- Direct PostgREST callers use the authenticated PostgreSQL role. This is a
-- disposable SQL-only fixture; it does not exercise the HTTP transport.
begin;
insert into auth.users(id,email) values
 ('a8920000-0000-4000-8000-000000000001','intake-owner@invalid.test'),
 ('a8920000-0000-4000-8000-000000000002','intake-other@invalid.test');
insert into public.organizations(id,name,slug,owner_user_id)
 values ('a8930000-0000-4000-8000-000000000001','Other org','intake-other-org','a8920000-0000-4000-8000-000000000002');
do $$ declare t text; r text; p text; begin
 foreach t in array array['public.support_tickets','public.data_rights_requests','public.book_import_receipts'] loop
  foreach r in array array['anon','authenticated'] loop
   foreach p in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    assert not has_table_privilege(r,t,p), r||' retains '||p||' on '||t;
   end loop;
  end loop;
  assert has_table_privilege('authenticated',t,'SELECT'), 'member select missing';
  foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
   assert has_table_privilege('service_role',t,p), 'service privilege changed: '||p||' on '||t;
  end loop;
 end loop;
 assert not exists(select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid=any(array['public.support_tickets'::regclass,'public.data_rights_requests'::regclass,'public.book_import_receipts'::regclass]) and a.grantee=0), 'PUBLIC table grant';
 assert not exists(select 1 from pg_attribute c, lateral aclexplode(c.attacl) a
  where c.attrelid=any(array['public.support_tickets'::regclass,'public.data_rights_requests'::regclass,'public.book_import_receipts'::regclass]) and a.grantee=0), 'PUBLIC column grant';
end $$;
set local role anon;
do $$ begin
 begin truncate public.book_import_receipts; assert false,'anon can truncate import receipts'; exception when insufficient_privilege then null; end;
 begin truncate public.data_rights_requests; assert false,'anon can truncate requests'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','a8920000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$ begin
 begin truncate public.book_import_receipts; assert false,'member can truncate receipts'; exception when insufficient_privilege then null; end;
 begin truncate public.data_rights_requests; assert false,'member can truncate requests'; exception when insufficient_privilege then null; end;
 begin insert into public.support_tickets(user_id,organization_id,subject,body) values
 ('a8920000-0000-4000-8000-000000000001','a8930000-0000-4000-8000-000000000001','Problem','A long enough description');
 assert false,'member forged another organization'; exception when insufficient_privilege then null; end;
 begin insert into public.support_tickets(id,user_id,subject,body) values
 (gen_random_uuid(),'a8920000-0000-4000-8000-000000000001','Problem','A long enough description');
 assert false,'member supplied server ID'; exception when insufficient_privilege then null; end;
 begin insert into public.support_tickets(user_id,subject,body,created_at) values
 ('a8920000-0000-4000-8000-000000000001','Problem','A long enough description','2000-01-01');
 assert false,'member supplied server timestamp'; exception when insufficient_privilege then null; end;
 begin insert into public.support_tickets(user_id,category,subject,body) values
 ('a8920000-0000-4000-8000-000000000001','forged','x','bad');
 assert false,'member bypassed support validation'; exception when insufficient_privilege then null; end;
 begin insert into public.data_rights_requests(user_id,request_type,status,requested_at,due_at) values
 ('a8920000-0000-4000-8000-000000000001','delete','submitted','2000-01-01','2100-01-01');
 assert false,'member supplied request timestamps'; exception when insufficient_privilege then null; end;
 begin insert into public.data_rights_requests(user_id,request_type,status,completed_at) values
 ('a8920000-0000-4000-8000-000000000001','delete','submitted',now());
 assert false,'member supplied completion timestamp'; exception when insufficient_privilege then null; end;
 begin insert into public.data_rights_requests(user_id,request_type,status,reason) values
 ('a8920000-0000-4000-8000-000000000001','delete','submitted',repeat(chr(128512),1001));
 assert false,'member bypassed reason length'; exception when insufficient_privilege then null; end;
 begin insert into public.data_rights_requests(user_id,request_type,status) values
 ('a8920000-0000-4000-8000-000000000002','delete','submitted');
 assert false,'member submitted another account request'; exception when insufficient_privilege then null; end;
end $$;
-- JS/Zod length counts UTF-16 code units; these are valid at the minimum.
insert into public.support_tickets(user_id,organization_id,category,subject,body,status,priority)
 values ('a8920000-0000-4000-8000-000000000001',null,'general',chr(128512)||'a',repeat(chr(128512),5),'open','normal');
-- U+0085 is not whitespace in ECMAScript trim.
insert into public.support_tickets(user_id,organization_id,category,subject,body,status,priority)
 values ('a8920000-0000-4000-8000-000000000001',null,'general',chr(133)||'ab','A long enough description','open','normal');
insert into public.data_rights_requests(user_id,request_type,status,reason)
 values ('a8920000-0000-4000-8000-000000000001','export','submitted',null);
select set_config('test.intake_id',id::text,true) from public.data_rights_requests where request_type='export';
do $$ declare v public.data_rights_requests; begin
 v:=public.cancel_data_rights_request(current_setting('test.intake_id')::uuid);
 assert v.status='cancelled','owner cancellation failed';
end $$;
select set_config('request.jwt.claim.sub','a8920000-0000-4000-8000-000000000002',true);
do $$ begin
 assert not exists(select 1 from public.support_tickets), 'cross-account ticket leak';
 assert not exists(select 1 from public.data_rights_requests), 'cross-account request leak';
 begin perform public.cancel_data_rights_request(current_setting('test.intake_id')::uuid); assert false,'cross-account cancellation'; exception when no_data_found then null; end;
end $$;
reset role;
rollback;
