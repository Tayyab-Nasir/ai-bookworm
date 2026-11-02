-- STAGE-2 tests: only run after explicitly applying stage-2-enforce.source-only.sql.
begin;
insert into auth.users(id,email) values
 ('a8950000-0000-4000-8000-000000000001','enforced-owner@invalid.test');
set local role authenticated;
select set_config('request.jwt.claim.sub','a8950000-0000-4000-8000-000000000001',true);
do $$ declare v public.data_rights_requests; begin
 begin insert into public.data_rights_requests(user_id,request_type,status) values
 ('a8950000-0000-4000-8000-000000000001','delete','submitted');
 assert false,'direct delete intake bypassed confirmation'; exception when insufficient_privilege then null; end;
 begin perform public.submit_delete_data_rights_request(null,null); assert false,'confirmation bypassed'; exception when invalid_parameter_value then null; end;
 v:=public.submit_delete_data_rights_request('DELETE MY ACCOUNT','  goodbye  ');
 assert v.user_id='a8950000-0000-4000-8000-000000000001' and v.reason='goodbye' and v.status='submitted','confirmed delete failed';
end $$;
-- Old direct export and support callers continue using their current contract.
insert into public.data_rights_requests(user_id,request_type,status,reason)
 values ('a8950000-0000-4000-8000-000000000001','export','submitted',null);
insert into public.support_tickets(user_id,organization_id,category,subject,body,status,priority)
 values ('a8950000-0000-4000-8000-000000000001',null,'general','Question','A valid support question.','open','normal');
reset role;
rollback;
