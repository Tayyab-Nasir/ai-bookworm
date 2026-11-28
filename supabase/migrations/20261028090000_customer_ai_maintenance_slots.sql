-- DB-owned scanner identity. No provider action or external notification.
create table bookworm_credentials.customer_ai_maintenance_slots (
 job_id uuid not null references bookworm_credentials.customer_ai_jobs(job_id),
 action text not null check(action in ('reconcile','recover_receipt')),
 version integer not null check(version>0),
 attempt_id uuid not null references bookworm_credentials.customer_ai_maintenance_attempts(attempt_id),
 closed boolean not null default false,
 primary key(job_id,action), unique(attempt_id)
);
create table bookworm_credentials.customer_ai_maintenance_observations (
 attempt_id uuid primary key references bookworm_credentials.customer_ai_maintenance_attempts(attempt_id),
 job_id uuid not null references bookworm_credentials.customer_ai_jobs(job_id),
 action text not null check(action in ('reconcile','recover_receipt')),
 slot_version integer not null check(slot_version>0),
 result text not null check(result in ('unchanged','settled','released')),
 created_at timestamptz not null default clock_timestamp(),
 unique(job_id,action,slot_version)
);
create index customer_ai_maintenance_observations_list on bookworm_credentials.customer_ai_maintenance_observations(created_at,attempt_id);
create index customer_ai_maintenance_open_slots on bookworm_credentials.customer_ai_maintenance_slots(job_id,action) where not closed;
alter table bookworm_credentials.customer_ai_maintenance_slots enable row level security;
alter table bookworm_credentials.customer_ai_maintenance_observations enable row level security;
revoke all on bookworm_credentials.customer_ai_maintenance_slots,bookworm_credentials.customer_ai_maintenance_observations from public,anon,authenticated,service_role;

create function bookworm_credentials.guard_customer_ai_maintenance_slot() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' or new.job_id is distinct from old.job_id or new.action is distinct from old.action
  or not ((not old.closed and new.closed and new.version=old.version and new.attempt_id=old.attempt_id)
    or (old.closed and not new.closed and new.version=old.version+1 and new.attempt_id<>old.attempt_id)) then
  raise exception using errcode='23514',message='maintenance slot is immutable'; end if;
 return new;
end $$;
create trigger customer_ai_maintenance_slot_guard before update or delete on bookworm_credentials.customer_ai_maintenance_slots
 for each row execute function bookworm_credentials.guard_customer_ai_maintenance_slot();
create function bookworm_credentials.guard_customer_ai_maintenance_observation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin raise exception using errcode='23514',message='maintenance observation is immutable'; end $$;
create trigger customer_ai_maintenance_observation_guard before update or delete on bookworm_credentials.customer_ai_maintenance_observations
 for each row execute function bookworm_credentials.guard_customer_ai_maintenance_observation();
revoke all on function bookworm_credentials.guard_customer_ai_maintenance_slot(),bookworm_credentials.guard_customer_ai_maintenance_observation() from public,anon,authenticated,service_role;

-- Return the same active identity after lost responses or restart. The caller
-- need not retain a UUID. New attempts are admitted only on current DB state.
create function public.open_customer_ai_maintenance_slot(p_job_id uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs; slot bookworm_credentials.customer_ai_maintenance_slots;
 entry bookworm_credentials.customer_ai_maintenance_attempts; next_id uuid; next_version integer; eligible boolean:=false;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_job_id is null or p_action is null or p_action not in ('reconcile','recover_receipt') then
  raise exception using errcode='22023',message='maintenance identity required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 select * into strict a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into strict j from public.ai_jobs where id=p_job_id for update;
 select * into slot from bookworm_credentials.customer_ai_maintenance_slots where job_id=p_job_id and action=p_action for update;
 if found and not slot.closed then
  select * into strict entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=slot.attempt_id;
  if entry.job_id is distinct from p_job_id or entry.action is distinct from p_action then
   raise exception using errcode='23514',message='maintenance slot identity unavailable'; end if;
  return jsonb_build_object('status','open','version',slot.version,'attempt',jsonb_build_object(
   'attemptId',entry.attempt_id,'jobId',entry.job_id,'action',entry.action,'state',entry.state,'result',entry.result));
 end if;
 next_version:=case when slot.version is null then 1 else slot.version+1 end;
 -- Adopt a pre-existing pending intent before creating a new one.
 select * into entry from bookworm_credentials.customer_ai_maintenance_attempts
  where job_id=p_job_id and action=p_action and state='pending';
 if found then next_id:=entry.attempt_id;
 else
  if j.billing_mode='customer_key' and a.state='held' and j.status in ('queued','running') and p_action='reconcile' then
   eligible:=((j.status='running' and j.lease_expires_at is not null and j.lease_expires_at<=clock_timestamp())
     or j.status='queued') and (a.dispatched_at is not null or a.expires_at<=clock_timestamp() or j.attempts>=5)
     and (a.dispatched_at is null or (j.status='running' and j.lease_token=a.dispatch_lease_token));
  elsif j.billing_mode='customer_key' and p_action='recover_receipt' and a.dispatched_at is not null
    and ((a.state='held' and j.status='running' and j.lease_token=a.dispatch_lease_token)
      or (a.state='review' and j.status='failed' and j.error_code='customer_provider_outcome_unknown')) then
   eligible:=exists(select 1 from public.ai_review_service_receipts r where r.job_id=a.job_id
    and r.request_sha256=a.receipt_fingerprint and r.result_json is not null);
  end if;
  if eligible is not true then return jsonb_build_object('status','not_actionable'); end if;
  next_id:=gen_random_uuid();
 end if;
 perform public.begin_customer_ai_maintenance(next_id,p_job_id,p_action);
 if slot.version is null then
  insert into bookworm_credentials.customer_ai_maintenance_slots(job_id,action,version,attempt_id)
   values(p_job_id,p_action,next_version,next_id) returning * into slot;
 else
  update bookworm_credentials.customer_ai_maintenance_slots set version=next_version,attempt_id=next_id,closed=false
   where job_id=p_job_id and action=p_action returning * into slot;
 end if;
 select * into strict entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=next_id;
 return jsonb_build_object('status','open','version',slot.version,'attempt',jsonb_build_object(
  'attemptId',entry.attempt_id,'jobId',entry.job_id,'action',entry.action,'state',entry.state,'result',entry.result));
end $$;

-- Internal acknowledgement preserves a durable observation before closing.
-- Review outcomes remain open for a separately authorized operator workflow.
create function public.ack_customer_ai_maintenance_slot(p_job_id uuid,p_action text,p_attempt_id uuid,p_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; slot bookworm_credentials.customer_ai_maintenance_slots;
 entry bookworm_credentials.customer_ai_maintenance_attempts; observation bookworm_credentials.customer_ai_maintenance_observations;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_job_id is null or p_attempt_id is null or p_version is null or p_version<1 or p_action is null or p_action not in ('reconcile','recover_receipt') then
  raise exception using errcode='22023',message='maintenance identity required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 perform job_id from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 perform id from public.ai_jobs where id=p_job_id for update;
 select * into slot from bookworm_credentials.customer_ai_maintenance_slots where job_id=p_job_id and action=p_action for update;
 if not found then raise exception using errcode='P0002',message='maintenance slot not found'; end if;
 select * into observation from bookworm_credentials.customer_ai_maintenance_observations where attempt_id=p_attempt_id;
 if found then
  if observation.job_id is distinct from p_job_id or observation.action is distinct from p_action or observation.slot_version is distinct from p_version then
   raise exception using errcode='40001',message='maintenance identity changed'; end if;
  return jsonb_build_object('status','observed','attemptId',p_attempt_id,'version',p_version,'result',observation.result);
 end if;
 if slot.closed or slot.attempt_id is distinct from p_attempt_id or slot.version is distinct from p_version then
  raise exception using errcode='40001',message='maintenance identity changed'; end if;
 select * into strict entry from bookworm_credentials.customer_ai_maintenance_attempts where attempt_id=p_attempt_id for update;
 if entry.job_id is distinct from p_job_id or entry.action is distinct from p_action or entry.state<>'completed'
  or entry.result not in ('unchanged','settled','released') or entry.result is null then
  raise exception using errcode='40001',message='maintenance requires review or completion'; end if;
 insert into bookworm_credentials.customer_ai_maintenance_observations(attempt_id,job_id,action,slot_version,result)
  values(p_attempt_id,p_job_id,p_action,p_version,entry.result);
 update bookworm_credentials.customer_ai_maintenance_slots set closed=true where job_id=p_job_id and action=p_action;
 return jsonb_build_object('status','observed','attemptId',p_attempt_id,'version',p_version,'result',entry.result);
end $$;

-- Restart/operator scan includes review outcomes even if the underlying job
-- later settles and drops out of ordinary job discovery.
create function public.list_customer_ai_maintenance_slots(p_limit integer default 20,p_after_job_id uuid default null,p_after_action text default null)
returns table(job_id uuid,action text,version integer,attempt_id uuid,state text,result text)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_limit is null or p_limit not between 1 and 100 or (p_after_job_id is null)<>(p_after_action is null)
  or (p_after_action is not null and p_after_action not in ('reconcile','recover_receipt')) then
  raise exception using errcode='22023',message='invalid maintenance cursor'; end if;
 return query select s.job_id,s.action,s.version,s.attempt_id,a.state,a.result
  from bookworm_credentials.customer_ai_maintenance_slots s
  join bookworm_credentials.customer_ai_maintenance_attempts a on a.attempt_id=s.attempt_id
  where not s.closed and (p_after_job_id is null or (s.job_id,s.action)>(p_after_job_id,p_after_action))
  order by s.job_id,s.action limit p_limit;
end $$;

create function public.list_customer_ai_maintenance_observations(p_limit integer default 20,p_after_created_at timestamptz default null,p_after_attempt_id uuid default null)
returns table(attempt_id uuid,job_id uuid,action text,slot_version integer,result text,created_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_limit is null or p_limit not between 1 and 100 or (p_after_created_at is null)<>(p_after_attempt_id is null)
  or (p_after_created_at is not null and not isfinite(p_after_created_at)) then
  raise exception using errcode='22023',message='invalid maintenance cursor'; end if;
 return query select o.attempt_id,o.job_id,o.action,o.slot_version,o.result,o.created_at
  from bookworm_credentials.customer_ai_maintenance_observations o
  where p_after_created_at is null or (o.created_at,o.attempt_id)>(p_after_created_at,p_after_attempt_id)
  order by o.created_at,o.attempt_id limit p_limit;
end $$;
revoke all on function public.open_customer_ai_maintenance_slot(uuid,text),public.ack_customer_ai_maintenance_slot(uuid,text,uuid,integer),
 public.list_customer_ai_maintenance_slots(integer,uuid,text),public.list_customer_ai_maintenance_observations(integer,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.open_customer_ai_maintenance_slot(uuid,text),public.ack_customer_ai_maintenance_slot(uuid,text,uuid,integer),
 public.list_customer_ai_maintenance_slots(integer,uuid,text),public.list_customer_ai_maintenance_observations(integer,timestamptz,uuid) to service_role;
