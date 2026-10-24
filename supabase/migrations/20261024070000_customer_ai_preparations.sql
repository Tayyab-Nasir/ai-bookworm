-- Durable prepare -> explicit consent -> existing customer job. No fee/policy
-- publication, worker activation, provider request or credential resolution.
create table bookworm_credentials.customer_ai_preparations (
 owner_id uuid not null references auth.users(id),
 operation_id uuid not null,
 job_id uuid not null unique default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 book_id uuid not null references public.books(id),
 connection_id uuid not null references public.ai_connections(id),
 credential_revision integer not null check(credential_revision>0),
 policy_id uuid not null references bookworm_credentials.customer_ai_policies(id),
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 request_snapshot jsonb not null check(jsonb_typeof(request_snapshot)='object' and octet_length(request_snapshot::text)<=400000),
 source_versions jsonb not null check(jsonb_typeof(source_versions)='array' and jsonb_array_length(source_versions) between 1 and 100),
 context_omitted integer not null check(context_omitted between 0 and 121),
 state text not null default 'prepared' check(state in ('prepared','confirmed','closed')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null check(isfinite(expires_at)),
 primary key(owner_id,operation_id),
 check(expires_at>created_at and expires_at<=created_at+interval '15 minutes')
);
create index customer_ai_preparation_rate on bookworm_credentials.customer_ai_preparations(owner_id,created_at);
alter table bookworm_credentials.customer_ai_preparations enable row level security;
revoke all on bookworm_credentials.customer_ai_preparations from public,anon,authenticated,service_role;

create function bookworm_credentials.guard_customer_ai_preparation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then raise exception using errcode='23514',message='Customer request retention requires an explicit workflow'; end if;
 if (to_jsonb(new)-'state') is distinct from (to_jsonb(old)-'state')
  or (new.state is distinct from old.state and not(old.state='prepared' and new.state in ('confirmed','closed'))) then
  raise exception using errcode='23514',message='Customer request preparation is immutable'; end if;
 if new.state='confirmed' and not exists(select 1 from bookworm_credentials.customer_ai_jobs
    where job_id=new.job_id and owner_id=new.owner_id and operation_id=new.operation_id and policy_id=new.policy_id
     and connection_id=new.connection_id and credential_revision=new.credential_revision
     and workspace_id=new.workspace_id and book_id=new.book_id and request_sha256=new.request_sha256
     and request_snapshot=new.request_snapshot and source_versions=new.source_versions) then
  raise exception using errcode='23514',message='Customer confirmation requires its exact job'; end if;
 return new;
end $$;
create trigger customer_ai_preparation_immutable before update or delete on bookworm_credentials.customer_ai_preparations
 for each row execute function bookworm_credentials.guard_customer_ai_preparation();

-- Read-only recovery needs current book access, not a still-valid provider key.
-- This private helper returns no source, hash, grant, key suffix or credentials.
create function bookworm_credentials.customer_ai_preparation_receipt(p_owner uuid,p_operation uuid) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare r bookworm_credentials.customer_ai_preparations; p bookworm_credentials.customer_ai_policies; j public.ai_jobs; state text;
begin
 select * into r from bookworm_credentials.customer_ai_preparations where owner_id=p_owner and operation_id=p_operation;
 if not found then return jsonb_build_object('operationId',p_operation,'status','not_found'); end if;
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
  'policyId',p.id,'provider',p.provider,'agentType',p.agent_type,'model',p.model_policy->>'model',
  'maxOutputTokens',case when p.agent_type='bookbible' then least((p.model_policy->>'maxOutputTokens')::integer,6000) else (p.model_policy->>'maxOutputTokens')::integer end,
  'platformFee',jsonb_build_object('mode',p.fee_mode,'credits',p.fee_credits),'providerCostStatus','unknown',
  'contextOmitted',r.context_omitted,'chapterCount',jsonb_array_length(r.source_versions),
  'status',state,'createdAt',r.created_at,'expiresAt',r.expires_at);
end $$;

create function public.customer_ai_preparation_options(p_owner_id uuid,p_workspace_id uuid,p_book_id uuid,
 p_connection_id uuid,p_revision integer,p_agent_type text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_provider text; org uuid; result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_owner_id is null or p_agent_type is null or p_agent_type not in ('writer','proofreader','copyeditor','consistency','metadata','bookbible') then
  raise exception using errcode='22023',message='Customer request selection required'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(p_owner_id);
 select c.provider into v_provider from public.ai_connections c where c.id=p_connection_id and c.owner_id=p_owner_id;
 org:=bookworm_credentials.customer_ai_access(p_owner_id,p_workspace_id,p_book_id,p_connection_id,p_revision,v_provider);
 perform bookworm_credentials.customer_ai_allowance(org);
 select coalesce(jsonb_agg(value order by created_at desc,id),'[]') into result from (
  select p.id,p.created_at,jsonb_build_object('id',p.id,'provider',p.provider,'agentType',p.agent_type,'policy',p.model_policy,
   'platformFee',jsonb_build_object('mode',p.fee_mode,'credits',p.fee_credits),'expiresAt',p.expires_at) as value
  from bookworm_credentials.customer_ai_policies p where p.provider=v_provider and p.agent_type=p_agent_type
   and p.enabled and p.expires_at>clock_timestamp() order by p.created_at desc,p.id limit 51) choices;
 -- Do not silently truncate an operator catalog; the API rejects >50 options.
 return result;
end $$;

create function public.prepare_customer_ai_request(p_operation_id uuid,p_owner_id uuid,p_workspace_id uuid,p_book_id uuid,
 p_connection_id uuid,p_revision integer,p_policy_id uuid,p_request_sha256 text,p_request jsonb,p_sources jsonb,p_context_omitted integer)
 returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r bookworm_credentials.customer_ai_preparations; p bookworm_credentials.customer_ai_policies; org uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_owner_id is null or p_operation_id is null or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$'
  or p_context_omitted is null or p_context_omitted not between 0 and 121 then
  raise exception using errcode='22023',message='Customer request identity required'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(p_owner_id);
 select * into r from bookworm_credentials.customer_ai_preparations where owner_id=p_owner_id and operation_id=p_operation_id;
 if found then
  if r.workspace_id is distinct from p_workspace_id or r.book_id is distinct from p_book_id or r.connection_id is distinct from p_connection_id
   or r.credential_revision is distinct from p_revision or r.policy_id is distinct from p_policy_id
   or r.request_sha256 is distinct from p_request_sha256 or r.request_snapshot is distinct from p_request
   or r.source_versions is distinct from p_sources or r.context_omitted is distinct from p_context_omitted then
   raise exception using errcode='40001',message='Customer preparation retry identity changed'; end if;
  return bookworm_credentials.customer_ai_preparation_receipt(p_owner_id,p_operation_id);
 end if;
 select * into p from bookworm_credentials.customer_ai_policies where id=p_policy_id and enabled and expires_at>clock_timestamp() for share;
 if not found then raise exception using errcode='23514',message='Approved customer policy required'; end if;
 org:=bookworm_credentials.customer_ai_access(p_owner_id,p_workspace_id,p_book_id,p_connection_id,p_revision,p.provider);
 perform bookworm_credentials.customer_ai_allowance(org);
 if (select count(*) from bookworm_credentials.customer_ai_preparations where owner_id=p_owner_id and created_at>clock_timestamp()-interval '1 minute')>=10
  or (select count(*) from bookworm_credentials.customer_ai_preparations where owner_id=p_owner_id and created_at>clock_timestamp()-interval '1 hour')>=50 then
  raise exception using errcode='P0429',message='Customer preparation rate limit reached'; end if;
 if jsonb_typeof(p_request) is distinct from 'object' or (p_request-array['input','contextPolicy'])<>'{}'
  or jsonb_typeof(p_request->'input') is distinct from 'object'
  or ((p_request->'input')-array['chapterIds','chapters','book','styleGuide','bookBible','relatedContext','userInstruction'])<>'{}'
  or jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources) not between 1 and 100 then
  raise exception using errcode='22023',message='Invalid customer preparation source'; end if;
 perform bookworm_credentials.check_customer_ai_sources(p_book_id,p_sources,p_request);
 insert into bookworm_credentials.customer_ai_preparations(owner_id,operation_id,workspace_id,book_id,connection_id,
  credential_revision,policy_id,request_sha256,request_snapshot,source_versions,context_omitted,expires_at)
 values(p_owner_id,p_operation_id,p_workspace_id,p_book_id,p_connection_id,p_revision,p.id,p_request_sha256,p_request,p_sources,
  p_context_omitted,least(p.expires_at,clock_timestamp()+interval '15 minutes'));
 return bookworm_credentials.customer_ai_preparation_receipt(p_owner_id,p_operation_id);
end $$;

create function public.customer_ai_request_action(p_owner_id uuid,p_operation_id uuid,p_action text,
 p_expected_fee integer default null,p_consent boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r bookworm_credentials.customer_ai_preparations; p bookworm_credentials.customer_ai_policies;
 a bookworm_credentials.customer_ai_jobs; j public.ai_jobs; receipt jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_owner_id is null or p_operation_id is null or p_action is null or p_action not in ('status','confirm','cancel','recover')
  or (p_action<>'confirm' and (p_expected_fee is not null or p_consent is distinct from false)) then
  raise exception using errcode='22023',message='Explicit customer request action required'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(p_owner_id);
 receipt:=bookworm_credentials.customer_ai_preparation_receipt(p_owner_id,p_operation_id);
 if p_action='status' then return receipt; end if;
 select * into r from bookworm_credentials.customer_ai_preparations where owner_id=p_owner_id and operation_id=p_operation_id;
 if not found then raise exception using errcode='P0002',message='Customer preparation not found'; end if;
 if p_action='confirm' then
  select * into strict p from bookworm_credentials.customer_ai_policies where id=r.policy_id;
  if p_consent is distinct from true or p_expected_fee is distinct from p.fee_credits then
   raise exception using errcode='22023',message='Exact platform fee and provider-charge consent required'; end if;
  if r.state='closed' or (r.state='prepared' and r.expires_at<=clock_timestamp()) then
   raise exception using errcode='40001',message='Customer preparation closed or expired'; end if;
  select * into j from public.create_customer_ai_job(r.job_id,r.operation_id,r.owner_id,r.workspace_id,r.book_id,r.connection_id,
   r.credential_revision,r.policy_id,r.request_sha256,r.request_snapshot,r.source_versions,p_expected_fee,true);
  if r.state='prepared' then update bookworm_credentials.customer_ai_preparations set state='confirmed'
   where owner_id=p_owner_id and operation_id=p_operation_id; end if;
 elsif p_action='cancel' then
  if r.state='prepared' then update bookworm_credentials.customer_ai_preparations set state='closed'
   where owner_id=p_owner_id and operation_id=p_operation_id;
  elsif r.state='confirmed' then perform public.cancel_customer_ai_job(r.job_id,p_owner_id); end if;
 else
  if r.state<>'confirmed' then raise exception using errcode='40001',message='No confirmed customer request to recover'; end if;
  select * into strict a from bookworm_credentials.customer_ai_jobs where job_id=r.job_id and owner_id=p_owner_id;
  if a.receipt_fingerprint is null or not exists(select 1 from public.ai_review_service_receipts
    where job_id=r.job_id and request_sha256=a.receipt_fingerprint and result_json is not null) then
   raise exception using errcode='40001',message='No completed customer receipt is available'; end if;
  perform public.complete_customer_ai_job(r.job_id,p_owner_id,a.receipt_fingerprint);
 end if;
 return bookworm_credentials.customer_ai_preparation_receipt(p_owner_id,p_operation_id);
end $$;

revoke all on function bookworm_credentials.guard_customer_ai_preparation(),
 bookworm_credentials.customer_ai_preparation_receipt(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.customer_ai_preparation_options(uuid,uuid,uuid,uuid,integer,text),
 public.prepare_customer_ai_request(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer),
 public.customer_ai_request_action(uuid,uuid,text,integer,boolean) from public,anon,authenticated,service_role;
grant execute on function public.customer_ai_preparation_options(uuid,uuid,uuid,uuid,integer,text),
 public.prepare_customer_ai_request(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer),
 public.customer_ai_request_action(uuid,uuid,text,integer,boolean) to service_role;
