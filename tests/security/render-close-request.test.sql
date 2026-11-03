begin;
do $$ begin
 assert (select prosecdef from pg_proc where oid='private.close_render_request_internal(uuid,uuid,text)'::regprocedure);
 assert has_schema_privilege('authenticated', 'private', 'usage');
 assert not has_schema_privilege('anon', 'private', 'usage');
 assert not (select prosecdef from pg_proc where oid='public.close_render_request(uuid,uuid,text)'::regprocedure);
 assert has_function_privilege('authenticated','private.close_render_request_internal(uuid,uuid,text)','execute');
 assert not has_function_privilege('anon','private.close_render_request_internal(uuid,uuid,text)','execute');
 assert not has_function_privilege('service_role','private.close_render_request_internal(uuid,uuid,text)','execute');
 assert (select proconfig @> array['search_path=""'] from pg_proc where oid='private.close_render_request_internal(uuid,uuid,text)'::regprocedure);
 assert has_function_privilege('authenticated','public.close_render_request(uuid,uuid,text)','execute');
 assert not has_function_privilege('anon','public.close_render_request(uuid,uuid,text)','execute');
 assert not has_function_privilege('service_role','public.close_render_request(uuid,uuid,text)','execute');
end $$;
insert into auth.users(id,email) values
 ('a1900000-0000-4000-8000-000000000001','editor@local.test'),
 ('a1900000-0000-4000-8000-000000000002','viewer@local.test'),
 ('a1900000-0000-4000-8000-000000000003','foreign@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('b1900000-0000-4000-8000-000000000001','Fixture','render-close','a1900000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('c1900000-0000-4000-8000-000000000001','b1900000-0000-4000-8000-000000000001','Fixture','render-close','a1900000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
 ('c1900000-0000-4000-8000-000000000001','a1900000-0000-4000-8000-000000000001','editor','active'),
 ('c1900000-0000-4000-8000-000000000001','a1900000-0000-4000-8000-000000000002','viewer','active');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('d1900000-0000-4000-8000-000000000001','c1900000-0000-4000-8000-000000000001','Fixture','Author','a1900000-0000-4000-8000-000000000001'),
 ('d1900000-0000-4000-8000-000000000002','c1900000-0000-4000-8000-000000000001','Other','Author','a1900000-0000-4000-8000-000000000001');
insert into public.editions(id,book_id,type,language) values
 ('e1900000-0000-4000-8000-000000000001','d1900000-0000-4000-8000-000000000001','ebook','en'),
 ('e1900000-0000-4000-8000-000000000002','d1900000-0000-4000-8000-000000000002','ebook','en');
insert into public.publishing_jobs(id,book_id,edition_id,channel,status,idempotency_key,created_by,request_json,response_json) values
 ('f1900000-0000-4000-8000-000000000001','d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','render','running','01900000-0000-4000-8000-000000000001','a1900000-0000-4000-8000-000000000001','{"action":"render","private":"must not return"}','{"private":"must not return"}'),
 ('f1900000-0000-4000-8000-000000000002','d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','render','succeeded','01900000-0000-4000-8000-000000000002','a1900000-0000-4000-8000-000000000001','{"action":"render"}','{}'),
 ('f1900000-0000-4000-8000-000000000003','d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','render','running','01900000-0000-4000-8000-000000000003','a1900000-0000-4000-8000-000000000003','{"action":"render"}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1900000-0000-4000-8000-000000000003"}',true);
do $$ declare message_existing text; message_missing text; begin
 begin
  perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000011');
  raise exception 'nonmember allowed';
 exception when no_data_found then get stacked diagnostics message_existing = message_text; end;
 begin
  perform public.close_render_request('d1900000-0000-4000-8000-000000000099','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000011');
  raise exception 'missing book allowed';
 exception when no_data_found then get stacked diagnostics message_missing = message_text; end;
 assert message_existing = message_missing and message_missing = 'book unavailable';
end $$;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1900000-0000-4000-8000-000000000002"}',true);
do $$ begin
 begin perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010');
 raise exception 'viewer allowed'; exception when insufficient_privilege then null; end;
 begin perform private.close_render_request_internal('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010');
 raise exception 'viewer private call allowed'; exception when insufficient_privilege then null; end;
end $$;
-- An authenticated database role cannot substitute a non-authenticated JWT role.
select set_config('request.jwt.claims','{"role":"service_role","sub":"a1900000-0000-4000-8000-000000000001"}',true);
do $$ begin
 begin perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000099');
 raise exception 'wrong JWT role allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1900000-0000-4000-8000-000000000001"}',true);
do $$ declare message_other text; message_missing text; begin
 begin
  perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000002','01900000-0000-4000-8000-000000000011');
  raise exception 'foreign edition allowed';
 exception when no_data_found then get stacked diagnostics message_other = message_text; end;
 begin
  perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000099','01900000-0000-4000-8000-000000000011');
  raise exception 'missing edition allowed';
 exception when no_data_found then get stacked diagnostics message_missing = message_text; end;
 assert message_other = message_missing and message_missing = 'edition unavailable';
end $$;
do $$ declare r jsonb; begin
 r:=public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010');
 assert r->'job'->>'status'='cancelled' and (r->>'closedBeforeAcceptance')::boolean;
 assert public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010')=r;
 assert private.close_render_request_internal('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010')=r;
 r:=public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','A1900000-0000-4000-8000-000000000010');
 assert r->>'requestId'='A1900000-0000-4000-8000-000000000010';
 begin perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','not-a-uuid');
 raise exception 'invalid key allowed'; exception when invalid_parameter_value then null; end;
 r:=public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000001');
 assert r->'job'->>'status'='running' and not (r->>'closedBeforeAcceptance')::boolean and r::text not like '%private%';
 r:=public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000002');
 assert r->'job'->>'status'='succeeded' and not (r->>'closedBeforeAcceptance')::boolean;
 begin perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000003');
 raise exception 'foreign operation allowed'; exception when unique_violation then null; end;
 begin perform public.close_render_request(null,'e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010');
 raise exception 'null request allowed'; exception when invalid_parameter_value then null; end;
end $$;
do $$ declare i int; r jsonb; begin
 for i in 1..58 loop
  perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001',
    '01900000-0000-4000-8001-'||lpad(i::text,12,'0'));
 end loop;
 begin
  perform public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8001-999999999999');
  raise exception 'close budget not enforced';
 exception when program_limit_exceeded then null; end;
 r:=public.close_render_request('d1900000-0000-4000-8000-000000000001','e1900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000010');
 assert (r->>'closedBeforeAcceptance')::boolean, 'recovery must remain available at the limit';
end $$;
reset role;
do $$ begin
 assert (select count(*)=1 from public.publishing_jobs where idempotency_key='01900000-0000-4000-8000-000000000010' and status='cancelled');
 assert (select status='running' from public.publishing_jobs where id='f1900000-0000-4000-8000-000000000001');
end $$;
rollback;
