-- Opt-in quoted translation cannot accidentally run through legacy workers.
alter table public.ai_jobs add column billing_mode text not null default 'operational'
  check(billing_mode in ('operational','quoted'));
alter table public.ai_jobs add constraint quoted_agent_supported
  check(billing_mode<>'quoted' or agent_type='translator');

create function public.guard_job_billing_mode() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.billing_mode is distinct from old.billing_mode then
    raise exception 'job billing mode is immutable' using errcode='23514'; end if;
  if tg_op='INSERT' and new.billing_mode='quoted' and new.status<>'queued' then
    raise exception 'quoted job must enter queued' using errcode='23514'; end if;
  if new.billing_mode='quoted' and new.status='running' then
    if not exists(select 1 from public.funded_usage_quotes q where q.job_id=new.id
      and q.user_id=new.created_by and q.workspace_id=new.workspace_id and q.status='held'
      and ((q.quote_json->>'expiresAt')::timestamptz>clock_timestamp() or q.dispatched_at is not null)) then
      raise exception 'quoted job requires funded hold' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_job_billing_mode() from public,anon,authenticated;
create trigger ab_job_billing_mode before insert or update on public.ai_jobs
for each row execute function public.guard_job_billing_mode();

do $$
declare v_definition text; v_original text;
begin
  -- Keep the tested lease/retry logic but split the queues explicitly.
  select pg_get_functiondef('public.claim_translation_job(integer)'::regprocedure) into v_original;
  if position('where j.agent_type = ''translator''' in v_original)=0 then
    raise exception 'unexpected translation claim definition'; end if;
  v_definition:=replace(v_original,'FUNCTION public.claim_translation_job(', 'FUNCTION public.claim_quoted_translation_job(');
  v_definition:=replace(v_definition,'where j.agent_type = ''translator''',
    'where j.billing_mode = ''quoted'' and exists(select 1 from public.funded_usage_quotes q where q.job_id=j.id and q.status=''held'' and ((q.quote_json->>''expiresAt'')::timestamptz>clock_timestamp() or q.dispatched_at is not null)) and j.agent_type = ''translator''');
  execute v_definition;
  execute replace(v_original,'where j.agent_type = ''translator''',
    'where j.billing_mode = ''operational'' and j.agent_type = ''translator''');
  -- Quoted jobs fund through the ledger, not a second character-unit quota.
  select pg_get_functiondef('public.reserve_translation_job_credit()'::regprocedure) into v_original;
  if position('if new.agent_type <> ''translator''' in v_original)=0 then
    raise exception 'unexpected translation reservation definition'; end if;
  execute replace(v_original,'if new.agent_type <> ''translator''',
    'if new.billing_mode = ''quoted'' then return new; end if; if new.agent_type <> ''translator''');
end $$;
revoke all on function public.claim_quoted_translation_job(integer) from public,anon,authenticated;
grant execute on function public.claim_quoted_translation_job(integer) to service_role;
