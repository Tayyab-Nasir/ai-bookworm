begin;
insert into auth.users(id,email) values
 ('ac240000-0000-4000-8000-000000000001','vault-owner@local.test'),
 ('ac240000-0000-4000-8000-000000000002','vault-other@local.test');
do $$ begin
 assert not has_schema_privilege('anon','bookworm_credentials','usage');
 assert not has_schema_privilege('authenticated','bookworm_credentials','usage');
 assert not has_schema_privilege('service_role','bookworm_credentials','usage');
 assert not has_table_privilege('authenticated','public.ai_connections','insert');
 assert not has_table_privilege('authenticated','public.ai_connections','update');
 assert not has_table_privilege('authenticated','public.ai_connections','delete');
 assert not has_table_privilege('service_role','bookworm_credentials.ai_connection_secrets','select');
 assert not has_function_privilege('authenticated','public.mutate_ai_connection(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)','execute');
 assert not has_function_privilege('anon','public.recover_ai_connection_operation(uuid,text,uuid,integer,uuid,text,boolean)','execute');
 -- Existing private settlement functions retain their service schema grant.
 assert has_schema_privilege('service_role','bookworm_private','usage');
end $$;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare u uuid:='ac240000-0000-4000-8000-000000000001'; c uuid:='ac240000-0000-4000-8000-000000000003';
 op uuid:='ac240000-0000-4000-8000-000000000004'; v public.ai_connections; r jsonb;
 n text:=encode(decode(repeat('ab',12),'hex'),'base64'); t text:=encode(decode(repeat('cd',16),'hex'),'base64');
 ciphertext text:=encode(decode(repeat('ef',32),'hex'),'base64');
begin
 v:=public.mutate_ai_connection(u,'openai',c,null,op,'save','1234','test',n,ciphertext,t);
 assert v.status='saved' and v.revision=1 and v.owner_id=u and v.key_suffix='1234';
 begin
  perform public.mutate_ai_connection(u,'openai',c,null,op,'save','9876','test',n,ciphertext,t);
  assert false,'same operation replay replaced key';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_ai_connection(u,'openai',c,null,gen_random_uuid(),'save','9876','test',n,ciphertext,t);
  assert false,'concurrent create replaced existing connection';
 exception when serialization_failure then null; end;
 r:=public.recover_ai_connection_operation(u,'openai',c,null,op,'save',false);
 assert r->>'status'='saved' and (r->>'revision')::integer=1 and not r ? 'ciphertext';
 r:=public.recover_ai_connection_operation(u,'openai',c,null,op,'save',true);
 assert r->>'status'='saved','close erased an already completed save';
 begin
  perform public.recover_ai_connection_operation(u,'anthropic',c,null,op,'save',true);
  assert false,'changed intent reused receipt';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_ai_connection('ac240000-0000-4000-8000-000000000002','openai',c,null,gen_random_uuid(),'save','9876','test',n,ciphertext,t);
  assert false,'foreign owner reused connection id';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_ai_connection(u,'openai',c,1,gen_random_uuid(),'save','9876','test','invalid',ciphertext,t);
  assert false,'bad envelope accepted';
 exception when check_violation or invalid_parameter_value then null; end;
 assert (select revision from public.ai_connections where id=c)=1,'partial metadata survived failed envelope write';
 v:=public.mutate_ai_connection(u,'openai',c,1,gen_random_uuid(),'save','9876','next',n,ciphertext,t);
 assert v.id=c and v.revision=2;
 begin
  perform public.mutate_ai_connection(u,'openai',c,1,gen_random_uuid(),'revoke');
  assert false,'stale revocation removed newer key';
 exception when serialization_failure then null; end;
 op:=gen_random_uuid();
 r:=public.recover_ai_connection_operation(u,'openai',c,2,op,'save',false);
 assert r->>'status'='not_found','read-only recovery created a record';
 r:=public.recover_ai_connection_operation(u,'openai',c,2,op,'save',true);
 assert r->>'status'='closed';
 begin
  perform public.mutate_ai_connection(u,'openai',c,2,op,'save','late','test',n,ciphertext,t);
  assert false,'late save resurrected closed operation';
 exception when serialization_failure then null; end;
 v:=public.mutate_ai_connection(u,'openai',c,2,gen_random_uuid(),'revoke');
 assert v.status='revoked' and v.revision=3 and v.key_suffix is null;
 v:=public.mutate_ai_connection(u,'openai',c,3,gen_random_uuid(),'save','back','next',n,ciphertext,t);
 assert v.revision=4 and v.id=c;
 -- Five successful changes above; closures and mutations share the limit.
 for i in 1..5 loop perform public.recover_ai_connection_operation(u,'google',gen_random_uuid(),null,gen_random_uuid(),'save',true); end loop;
 begin
  perform public.recover_ai_connection_operation(u,'google',gen_random_uuid(),null,gen_random_uuid(),'save',true);
  assert false,'write rate limit not enforced';
 exception when sqlstate 'P0429' then null; end;
end $$;
reset role;
do $$ begin
 assert (select revision from bookworm_credentials.ai_connection_secrets where connection_id='ac240000-0000-4000-8000-000000000003')=4;
 assert (select count(*) from bookworm_credentials.ai_connection_secrets)=1;
end $$;
set local role authenticated;
set local request.jwt.claims='{"sub":"ac240000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$ begin assert (select count(*) from public.ai_connections)=0,'another user read masked key metadata'; end $$;
set local request.jwt.claims='{"sub":"ac240000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
 assert (select count(*) from public.ai_connections)=1;
 begin perform * from bookworm_credentials.ai_connection_secrets; assert false,'browser read secret envelopes'; exception when insufficient_privilege then null; end;
 begin delete from public.ai_connections; assert false,'browser bypassed revocation'; exception when insufficient_privilege then null; end;
 begin perform public.mutate_ai_connection(auth.uid(),'openai',gen_random_uuid(),null,gen_random_uuid(),'save'); assert false,'browser called server writer'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Remove the rate-test fixtures so a final revoke proves physical deletion.
delete from bookworm_credentials.ai_connection_operations where action='save' and revision is null;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
select public.mutate_ai_connection('ac240000-0000-4000-8000-000000000001','openai','ac240000-0000-4000-8000-000000000003',4,gen_random_uuid(),'revoke');
reset role;
do $$ begin assert (select count(*) from bookworm_credentials.ai_connection_secrets)=0,'revoked ciphertext retained'; end $$;
delete from auth.users where id='ac240000-0000-4000-8000-000000000001';
do $$ begin
 assert (select count(*) from public.ai_connections)=0;
 assert (select count(*) from bookworm_credentials.ai_connection_operations)=0,'account deletion retained operations';
end $$;
rollback;
