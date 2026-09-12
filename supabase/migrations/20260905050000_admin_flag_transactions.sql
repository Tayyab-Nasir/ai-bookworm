-- Keep nullable flag scopes unique and audit mutations in the same transaction.
create or replace function public.set_admin_feature_flag(
  p_actor_id uuid, p_key text, p_scope_type text, p_scope_id text,
  p_enabled boolean, p_config jsonb default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_flag public.feature_flags;
begin
  if p_actor_id is null or p_key is null or length(p_key) not between 1 and 120
    or p_scope_type is null or length(p_scope_type) not between 1 and 40
    or length(p_scope_id) > 120 or p_enabled is null
    or (p_config is not null and jsonb_typeof(p_config) <> 'object') then
    raise exception 'invalid feature flag' using errcode = '22023';
  end if;

  insert into public.feature_flags(key, scope_type, scope_id, enabled, config_json)
  values (p_key, p_scope_type, p_scope_id, p_enabled, coalesce(p_config, '{}'::jsonb))
  on conflict (key, scope_type, (coalesce(scope_id, ''))) do update
  set enabled = excluded.enabled,
      config_json = coalesce(p_config, feature_flags.config_json),
      updated_at = clock_timestamp()
  returning * into v_flag;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, after_json)
  values (p_actor_id, 'flag.update', 'feature_flag', v_flag.id,
    jsonb_build_object('key', v_flag.key, 'scopeType', v_flag.scope_type,
      'scopeId', v_flag.scope_id, 'enabled', v_flag.enabled));
  return to_jsonb(v_flag);
end;
$$;

revoke all on function public.set_admin_feature_flag(uuid,text,text,text,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.set_admin_feature_flag(uuid,text,text,text,boolean,jsonb) to service_role;
