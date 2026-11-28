-- Author review metadata and durable close-before-prepare. No policy, worker,
-- provider activity or entitlement is enabled by this migration.
create table bookworm_credentials.customer_ai_preparation_closures (
 owner_id uuid not null references auth.users(id), operation_id uuid not null,
 book_id uuid not null references public.books(id),
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,operation_id)
);
create index customer_ai_closure_rate on bookworm_credentials.customer_ai_preparation_closures(owner_id,created_at);
alter table bookworm_credentials.customer_ai_preparation_closures enable row level security;
revoke all on bookworm_credentials.customer_ai_preparation_closures from public,anon,authenticated,service_role;

create function bookworm_credentials.guard_customer_ai_closure() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin raise exception using errcode='23514',message='Customer closure is immutable'; end $$;
create trigger customer_ai_closure_immutable before update or delete on bookworm_credentials.customer_ai_preparation_closures
 for each row execute function bookworm_credentials.guard_customer_ai_closure();

create function bookworm_credentials.reject_closed_customer_ai_preparation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 perform bookworm_credentials.lock_customer_ai_owner(new.owner_id);
 if exists(select 1 from bookworm_credentials.customer_ai_preparation_closures
   where owner_id=new.owner_id and operation_id=new.operation_id) then
  raise exception using errcode='40001',message='Customer preparation was closed before arrival'; end if;
 return new;
end $$;
create trigger customer_ai_preparation_not_closed before insert on bookworm_credentials.customer_ai_preparations
 for each row execute function bookworm_credentials.reject_closed_customer_ai_preparation();

-- Only canonical revision identifiers leave the server, never source text,
-- prompts, fingerprints, credentials, grants or key suffixes.
create or replace function bookworm_credentials.customer_ai_preparation_receipt(p_owner uuid,p_operation uuid) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare r bookworm_credentials.customer_ai_preparations; p bookworm_credentials.customer_ai_policies;
 c bookworm_credentials.customer_ai_preparation_closures; j public.ai_jobs; state text;
begin
 select * into r from bookworm_credentials.customer_ai_preparations where owner_id=p_owner and operation_id=p_operation;
 if not found then
  select * into c from bookworm_credentials.customer_ai_preparation_closures where owner_id=p_owner and operation_id=p_operation;
  if not found then return jsonb_build_object('operationId',p_operation,'status','not_found'); end if;
  if not exists(select 1 from public.books b join public.workspace_members m on m.workspace_id=b.workspace_id
    where b.id=c.book_id and m.user_id=p_owner and m.status='active') then
   raise exception using errcode='42501',message='Customer request access unavailable'; end if;
  return jsonb_build_object('operationId',p_operation,'bookId',c.book_id,'status','closed_before_prepare');
 end if;
 if not exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=p_owner and status='active')
  or not exists(select 1 from public.books where id=r.book_id and workspace_id=r.workspace_id) then
  raise exception using errcode='42501',message='Customer request access unavailable'; end if;
 select * into strict p from bookworm_credentials.customer_ai_policies where id=r.policy_id;
 state:=case when r.state='prepared' and r.expires_at<=clock_timestamp() then 'expired' else r.state end;
 if r.state='confirmed' then
  select * into strict j from public.ai_jobs where id=r.job_id and created_by=p_owner and billing_mode='customer_key';
  state:=case when j.status='failed' then 'requires_review' else j.status::text end;
 end if;
 return jsonb_build_object('operationId',r.operation_id,'jobId',case when r.state='confirmed' then r.job_id else null end,
  'workspaceId',r.workspace_id,'bookId',r.book_id,'connectionId',r.connection_id,'credentialRevision',r.credential_revision,
  'policyId',p.id,'provider',p.provider,'agentType',p.agent_type,'model',p.model_policy->>'model','upstream',p.model_policy->'upstream',
  'maxOutputTokens',case when p.agent_type='bookbible' then least((p.model_policy->>'maxOutputTokens')::integer,6000) else (p.model_policy->>'maxOutputTokens')::integer end,
  'platformFee',jsonb_build_object('mode',p.fee_mode,'credits',p.fee_credits),'providerCostStatus','unknown',
  'contextOmitted',r.context_omitted,'chapterCount',jsonb_array_length(r.source_versions),'sourceVersions',r.source_versions,
  'status',state,'createdAt',r.created_at,'expiresAt',r.expires_at);
end $$;

create function public.close_customer_ai_preparation(p_owner_id uuid,p_book_id uuid,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r bookworm_credentials.customer_ai_preparations; c bookworm_credentials.customer_ai_preparation_closures;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_owner_id is null or p_book_id is null or p_operation_id is null then
  raise exception using errcode='22023',message='Customer closure identity required'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(p_owner_id);
 select * into r from bookworm_credentials.customer_ai_preparations where owner_id=p_owner_id and operation_id=p_operation_id;
 if found then
  if r.book_id is distinct from p_book_id then raise exception using errcode='40001',message='Customer closure identity changed'; end if;
  -- Existing requests use the reviewed cancellation authority. In particular,
  -- dispatched/unknown outcomes cannot become a successful cancellation/refund.
  return public.customer_ai_request_action(p_owner_id,p_operation_id,'cancel');
 end if;
 select * into c from bookworm_credentials.customer_ai_preparation_closures where owner_id=p_owner_id and operation_id=p_operation_id;
 if found then
  if c.book_id is distinct from p_book_id then raise exception using errcode='40001',message='Customer closure identity changed'; end if;
  return bookworm_credentials.customer_ai_preparation_receipt(p_owner_id,p_operation_id);
 end if;
 if not exists(select 1 from public.books b join public.workspace_members m on m.workspace_id=b.workspace_id
   where b.id=p_book_id and m.user_id=p_owner_id and m.status='active' and m.role in ('owner','admin','editor','writer')) then
  raise exception using errcode='42501',message='Current customer book write access required'; end if;
 if (select count(*) from bookworm_credentials.customer_ai_preparation_closures
   where owner_id=p_owner_id and created_at>clock_timestamp()-interval '1 minute')>=10
  or (select count(*) from bookworm_credentials.customer_ai_preparation_closures
   where owner_id=p_owner_id and created_at>clock_timestamp()-interval '1 hour')>=50 then
  raise exception using errcode='P0429',message='Customer closure rate limit reached'; end if;
 insert into bookworm_credentials.customer_ai_preparation_closures(owner_id,book_id,operation_id) values(p_owner_id,p_book_id,p_operation_id);
 return bookworm_credentials.customer_ai_preparation_receipt(p_owner_id,p_operation_id);
end $$;

revoke all on function bookworm_credentials.guard_customer_ai_closure(),
 bookworm_credentials.reject_closed_customer_ai_preparation(),bookworm_credentials.customer_ai_preparation_receipt(uuid,uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.close_customer_ai_preparation(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.close_customer_ai_preparation(uuid,uuid,uuid) to service_role;
