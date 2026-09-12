begin;
insert into auth.users(id,email) values ('a8500000-0000-4000-8000-000000000001','admin-flags@local.test');

set local role authenticated;
do $$ begin
  begin
    perform public.set_admin_feature_flag('a8500000-0000-4000-8000-000000000001','editor','global',null,true);
    assert false, 'authenticated user changed a platform flag';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role service_role;
do $$ declare v_first jsonb; v_second jsonb; v_scoped jsonb; begin
  v_first := public.set_admin_feature_flag('a8500000-0000-4000-8000-000000000001','editor','global',null,true,'{"rollout":50}');
  v_second := public.set_admin_feature_flag('a8500000-0000-4000-8000-000000000001','editor','global',null,false);
  assert v_first->>'id' = v_second->>'id', 'null scope produced duplicate flags';
  assert v_second->'config_json' = '{"rollout":50}'::jsonb, 'toggle erased configuration';
  assert v_second->>'enabled' = 'false', 'toggle did not persist';
  v_scoped := public.set_admin_feature_flag('a8500000-0000-4000-8000-000000000001','editor','workspace','workspace-1',true);
  assert v_scoped->>'id' <> v_first->>'id', 'scoped flag changed global flag';
  assert (select count(*) from public.audit_logs where action='flag.update' and actor_id='a8500000-0000-4000-8000-000000000001') = 3, 'missing atomic audit';
  begin
    perform public.set_admin_feature_flag('a8500000-0000-4000-8000-000000000099','editor','global',null,true);
    assert false, 'invalid audit actor accepted';
  exception when foreign_key_violation then null; end;
  assert not (select enabled from public.feature_flags where id=(v_first->>'id')::uuid), 'failed audit did not roll back flag';
end $$;
reset role;
rollback;
