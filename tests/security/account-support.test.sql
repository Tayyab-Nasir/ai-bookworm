begin;
insert into auth.users(id,email) values
  ('a8900000-0000-4000-8000-000000000001','rights-one@local.test'),
  ('a8900000-0000-4000-8000-000000000002','rights-two@local.test');

set local role authenticated;
select set_config('request.jwt.claim.sub','a8900000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);

insert into public.support_tickets(user_id,category,subject,body,status,priority)
values ('a8900000-0000-4000-8000-000000000001','privacy','Export question','Please explain the export process.','open','normal');
do $$ begin
  assert (select count(*) from public.support_tickets) = 1, 'author cannot read own support ticket';
  begin
    insert into public.support_tickets(user_id,subject,body,status,priority)
    values ('a8900000-0000-4000-8000-000000000002','Forged','This must be rejected.','open','normal');
    assert false, 'author created another user support ticket';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.support_tickets(user_id,subject,body,status,priority)
    values ('a8900000-0000-4000-8000-000000000001','Escalated','This must be rejected.','open','urgent');
    assert false, 'author chose privileged support priority';
  exception when insufficient_privilege then null; end;
  begin
    update public.support_tickets set status='resolved';
    assert false, 'author resolved their own support ticket';
  exception when insufficient_privilege then null; end;
end $$;

insert into public.data_rights_requests(id,user_id,request_type,status,reason)
values ('a8910000-0000-4000-8000-000000000001','a8900000-0000-4000-8000-000000000001','export','submitted','Portability');
do $$ declare v_request public.data_rights_requests; begin
  assert (select count(*) from public.data_rights_requests) = 1, 'author cannot read own request';
  begin
    insert into public.data_rights_requests(user_id,request_type,status)
    values ('a8900000-0000-4000-8000-000000000002','delete','submitted');
    assert false, 'author created another user data request';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.data_rights_requests(user_id,request_type,status)
    values ('a8900000-0000-4000-8000-000000000001','delete','completed');
    assert false, 'author bypassed the review state';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.data_rights_requests(user_id,request_type,status)
    values ('a8900000-0000-4000-8000-000000000001','export','submitted');
    assert false, 'duplicate open export request accepted';
  exception when unique_violation then null; end;
  v_request := public.cancel_data_rights_request('a8910000-0000-4000-8000-000000000001');
  assert v_request.status = 'cancelled', 'submitted request did not cancel';
  begin
    perform public.cancel_data_rights_request('a8910000-0000-4000-8000-000000000001');
    assert false, 'terminal request cancelled twice';
  exception when invalid_parameter_value then null; end;
end $$;

select set_config('request.jwt.claim.sub','a8900000-0000-4000-8000-000000000002',true);
do $$ begin
  assert (select count(*) from public.support_tickets) = 0, 'support ticket leaked cross-user';
  assert (select count(*) from public.data_rights_requests) = 0, 'data request leaked cross-user';
  begin
    perform public.cancel_data_rights_request('a8910000-0000-4000-8000-000000000001');
    assert false, 'other user cancelled private request';
  exception when no_data_found then null; end;
end $$;

reset role;
set local role service_role;
do $$ begin
  assert (select count(*) from public.support_tickets) = 1, 'support ticket was unexpectedly removed';
  assert (select count(*) from public.data_rights_requests where status='cancelled') = 1, 'cancel status not durable';
end $$;
reset role;
rollback;
