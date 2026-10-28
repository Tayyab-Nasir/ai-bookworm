-- Private transactional maintenance intents; no generation or external sink.
create table bookworm_credentials.customer_ai_maintenance_attempts (
 attempt_id uuid primary key,
 job_id uuid not null references bookworm_credentials.customer_ai_jobs(job_id),
 action text not null check(action in ('reconcile','recover_receipt')),
 state text not null default 'pending' check(state in ('pending','completed','needs_review')),
 result text check(result in ('unchanged','settled','released','requires_review')),
 created_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,
 check((state='pending' and result is null and finished_at is null)
  or (state='completed' and result is not null and finished_at is not null)
  or (state='needs_review' and result is null and finished_at is not null))
);
create unique index customer_ai_one_pending_maintenance on bookworm_credentials.customer_ai_maintenance_attempts(job_id,action) where state='pending';
create index customer_ai_maintenance_list on bookworm_credentials.customer_ai_maintenance_attempts(created_at,attempt_id);
alter table bookworm_credentials.customer_ai_maintenance_attempts enable row level security;
revoke all on bookworm_credentials.customer_ai_maintenance_attempts from public,anon,authenticated,service_role;

create function bookworm_credentials.guard_customer_ai_maintenance_attempt() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then raise exception using errcode='23514',message='maintenance journal is immutable'; end if;
 if (to_jsonb(new)-array['state','result','finished_at']) is distinct from (to_jsonb(old)-array['state','result','finished_at'])
  or old.state<>'pending' or new.state not in ('completed','needs_review') then
  raise exception using errcode='23514',message='maintenance journal is immutable'; end if;
 return new;
end $$;
create trigger customer_ai_maintenance_immutable before update or delete on bookworm_credentials.customer_ai_maintenance_attempts
 for each row execute function bookworm_credentials.guard_customer_ai_maintenance_attempt();
revoke all on function bookworm_credentials.guard_customer_ai_maintenance_attempt() from public,anon,authenticated,service_role;

-- This call must commit before execution, so a lost response cannot erase intent.
create function public.begin_customer_ai_maintenance(p_attempt_id uuid,p_job_id uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; entry bookworm_credentials.customer_ai_maintenance_attempts;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_attempt_id is null or p_job_id is null or p_action is null or p_action not in ('reconcile','recover_receipt') then
  raise exception using errcode='22023',message='maintenance identity required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 perform job_id from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 perform id from public.ai_jobs where id=p_job_id for update;
 select * into entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=p_attempt_id for update;
 if not found then
  begin
   insert into bookworm_credentials.customer_ai_maintenance_attempts(attempt_id,job_id,action)
    values(p_attempt_id,p_job_id,p_action) on conflict(attempt_id) do nothing;
  exception when unique_violation then
   raise exception using errcode='40001',message='maintenance action already pending'; end;
  select * into strict entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=p_attempt_id for update;
 end if;
 if entry.job_id is distinct from p_job_id or entry.action is distinct from p_action then
  raise exception using errcode='40001',message='maintenance identity changed'; end if;
 return jsonb_build_object('attemptId',entry.attempt_id,'jobId',entry.job_id,'action',entry.action,'state',entry.state,'result',entry.result);
end $$;

create function public.execute_customer_ai_maintenance(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; entry bookworm_credentials.customer_ai_maintenance_attempts; outcome text;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_attempt_id is null then raise exception using errcode='22023',message='maintenance identity required'; end if;
 select * into entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=p_attempt_id;
 if not found then raise exception using errcode='P0002',message='maintenance attempt not found'; end if;
 select * into strict a from bookworm_credentials.customer_ai_jobs where job_id=entry.job_id;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 perform job_id from bookworm_credentials.customer_ai_jobs where job_id=a.job_id for update;
 perform id from public.ai_jobs where id=a.job_id for update;
 select * into strict entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=p_attempt_id for update;
 if entry.job_id is distinct from a.job_id then raise exception using errcode='40001',message='maintenance identity changed'; end if;
 if entry.state='pending' then
  begin
   if entry.action='reconcile' then outcome:=public.reconcile_customer_ai_job(entry.job_id);
   elsif entry.action='recover_receipt' then outcome:=public.recover_customer_ai_receipt(entry.job_id);
   else raise exception using errcode='22023',message='maintenance action unavailable'; end if;
   if outcome not in ('unchanged','settled','released','requires_review') or outcome is null then
    raise exception using errcode='23514',message='maintenance outcome unavailable'; end if;
   update bookworm_credentials.customer_ai_maintenance_attempts set state='completed',result=outcome,finished_at=clock_timestamp()
    where attempt_id=p_attempt_id returning * into entry;
  exception when serialization_failure or check_violation or invalid_parameter_value or no_data_found then
   -- The action subtransaction rolled back. No raw exception or payload is retained.
   update bookworm_credentials.customer_ai_maintenance_attempts set state='needs_review',finished_at=clock_timestamp()
    where attempt_id=p_attempt_id returning * into entry;
  when others then
   -- Unexpected failure rolls back this transaction; the previously committed intent remains pending.
   raise exception using errcode='P0001',message='customer maintenance unavailable';
  end;
 end if;
 return jsonb_build_object('attemptId',entry.attempt_id,'jobId',entry.job_id,'action',entry.action,'state',entry.state,'result',entry.result);
end $$;

-- Service-only restart/operator scan; no manuscript, credentials or error detail.
create function public.list_customer_ai_maintenance_attempts(p_limit integer default 20,p_after_created_at timestamptz default null,p_after_attempt_id uuid default null)
returns table(attempt_id uuid,job_id uuid,action text,state text,result text,created_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_limit is null or p_limit not between 1 and 100 or (p_after_created_at is null)<>(p_after_attempt_id is null)
  or (p_after_created_at is not null and not isfinite(p_after_created_at)) then
  raise exception using errcode='22023',message='invalid maintenance cursor'; end if;
 return query select m.attempt_id,m.job_id,m.action,m.state,m.result,m.created_at
  from bookworm_credentials.customer_ai_maintenance_attempts m
  where m.state in ('pending','needs_review')
   and (p_after_created_at is null or (m.created_at,m.attempt_id)>(p_after_created_at,p_after_attempt_id))
  order by m.created_at,m.attempt_id limit p_limit;
end $$;

revoke all on function public.begin_customer_ai_maintenance(uuid,uuid,text),public.execute_customer_ai_maintenance(uuid),
 public.list_customer_ai_maintenance_attempts(integer,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_customer_ai_maintenance(uuid,uuid,text),public.execute_customer_ai_maintenance(uuid),
 public.list_customer_ai_maintenance_attempts(integer,timestamptz,uuid) to service_role;
