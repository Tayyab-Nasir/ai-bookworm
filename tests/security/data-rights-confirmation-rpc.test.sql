-- Stage-one RPC: this test does not assume direct DELETE intake is fenced yet.
begin;
insert into auth.users(id,email) values
 ('a8940000-0000-4000-8000-000000000001','confirm-owner@invalid.test'),
 ('a8940000-0000-4000-8000-000000000002','confirm-other@invalid.test');
do $$ begin
 assert not has_function_privilege('anon','public.submit_delete_data_rights_request(text,text)','execute'),'anon can execute';
 assert not has_function_privilege('service_role','public.submit_delete_data_rights_request(text,text)','execute'),'service role can execute';
 assert has_function_privilege('authenticated','public.submit_delete_data_rights_request(text,text)','execute'),'member cannot execute';
 assert not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid='public.submit_delete_data_rights_request(text,text)'::regprocedure and a.grantee=0),'PUBLIC can execute';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 begin perform public.submit_delete_data_rights_request('DELETE MY ACCOUNT',null); assert false,'null identity accepted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','a8940000-0000-4000-8000-000000000001',true);
do $$ declare v public.data_rights_requests; begin
 begin perform public.submit_delete_data_rights_request(null,null); assert false,'null confirmation accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.submit_delete_data_rights_request('delete my account',null); assert false,'inexact confirmation accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.submit_delete_data_rights_request('DELETE MY ACCOUNT',repeat(chr(128512),1001)); assert false,'overlong reason accepted'; exception when invalid_parameter_value then null; end;
 v:=public.submit_delete_data_rights_request('DELETE MY ACCOUNT',chr(160)||repeat(chr(128512),1000)||chr(65279));
 assert v.user_id='a8940000-0000-4000-8000-000000000001' and v.request_type='delete' and v.status='submitted','request identity or status invalid';
 assert v.reason=repeat(chr(128512),1000), 'ECMAScript trim mismatch';
 assert v.id is not null and v.requested_at is not null and v.due_at is not null and v.completed_at is null,'server defaults missing';
 perform set_config('test.confirm_request',v.id::text,true);
 begin perform public.submit_delete_data_rights_request('DELETE MY ACCOUNT','different'); assert false,'duplicate open delete accepted'; exception when unique_violation then null; end;
end $$;
select set_config('request.jwt.claim.sub','a8940000-0000-4000-8000-000000000002',true);
do $$ declare v public.data_rights_requests; begin
 assert not exists(select 1 from public.data_rights_requests where id=current_setting('test.confirm_request')::uuid),'other account saw request';
 v:=public.submit_delete_data_rights_request('DELETE MY ACCOUNT',null);
 assert v.user_id='a8940000-0000-4000-8000-000000000002','RPC actor overridden';
 begin perform public.cancel_data_rights_request(current_setting('test.confirm_request')::uuid); assert false,'other actor cancelled request'; exception when no_data_found then null; end;
end $$;
reset role;
rollback;
