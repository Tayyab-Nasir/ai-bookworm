-- Customer-key jobs are a separate payer contract, never managed OpenAI quotes.
-- No policy/plan is seeded: this migration grants no free or paid generation.
create function bookworm_credentials.valid_customer_ai_policy(p_provider text,p_policy jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog,public as $$
declare item jsonb;
begin
 if jsonb_typeof(p_policy) is distinct from 'object' or octet_length(p_policy::text)>8000
   or not p_policy ?& array['model','responseModels','maxOutputTokens','upstream','responseUpstreams']
   or (p_policy-array['model','responseModels','maxOutputTokens','upstream','responseUpstreams'])<>'{}'::jsonb
   or jsonb_typeof(p_policy->'model') is distinct from 'string'
   or (p_policy->>'model') !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$'
   or jsonb_typeof(p_policy->'maxOutputTokens') is distinct from 'number'
   or (p_policy->>'maxOutputTokens') !~ '^[1-9][0-9]{0,5}$'
   or (p_policy->>'maxOutputTokens')::integer>128000
   or jsonb_typeof(p_policy->'responseModels') is distinct from 'array'
   or jsonb_typeof(p_policy->'responseUpstreams') is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_policy->'responseModels') not between 1 and 16
   or jsonb_array_length(p_policy->'responseUpstreams')>16 then return false; end if;
 for item in select value from jsonb_array_elements(p_policy->'responseModels') loop
  if jsonb_typeof(item)<>'string' or (item#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$' then return false; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_policy->'responseUpstreams') loop
  if jsonb_typeof(item)<>'string' or (item#>>'{}') !~ '^[ -~]{1,100}$' then return false; end if;
 end loop;
 if p_provider='openrouter' then
  return jsonb_typeof(p_policy->'upstream')='string' and (p_policy->>'upstream') ~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$'
    and jsonb_array_length(p_policy->'responseUpstreams')>0;
 end if;
 return p_provider in ('openai','anthropic','google','xai') and p_policy->'upstream'='null'::jsonb
   and p_policy->'responseUpstreams'='[]'::jsonb;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create table bookworm_credentials.customer_ai_policies (
 id uuid primary key,
 provider text not null check(provider in ('openai','anthropic','google','openrouter','xai')),
 agent_type text not null check(agent_type in ('writer','proofreader','copyeditor','consistency','metadata','bookbible')),
 model_policy jsonb not null check(bookworm_credentials.valid_customer_ai_policy(provider,model_policy)),
 fee_mode text not null check(fee_mode in ('platform_plan','per_request_credits')),
 fee_credits integer not null check(fee_credits between 0 and 1000000),
 enabled boolean not null default false,
 expires_at timestamptz not null check(isfinite(expires_at)),
 created_at timestamptz not null default clock_timestamp(),
 check((fee_mode='platform_plan' and fee_credits=0) or (fee_mode='per_request_credits' and fee_credits>0))
);
alter table bookworm_credentials.customer_ai_policies enable row level security;
revoke all on bookworm_credentials.customer_ai_policies from public,anon,authenticated,service_role;

create table bookworm_credentials.customer_ai_jobs (
 job_id uuid primary key references public.ai_jobs(id) on delete restrict deferrable initially deferred,
 grant_id uuid not null unique,
 operation_id uuid not null,
 owner_id uuid not null references auth.users(id),
 workspace_id uuid not null references public.workspaces(id),
 book_id uuid not null references public.books(id),
 organization_id uuid not null references public.organizations(id),
 connection_id uuid not null references public.ai_connections(id),
 credential_revision integer not null check(credential_revision>0),
 policy_id uuid not null references bookworm_credentials.customer_ai_policies(id),
 provider text not null,
 agent_type text not null,
 model_policy jsonb not null,
 request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 request_snapshot jsonb not null check(jsonb_typeof(request_snapshot)='object' and octet_length(request_snapshot::text)<=400000),
 source_versions jsonb not null check(jsonb_typeof(source_versions)='array' and jsonb_array_length(source_versions)<=100),
 fee_credits integer not null check(fee_credits between 0 and 1000000),
 state text not null default 'held' check(state in ('held','review','released','settled')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null check(isfinite(expires_at)),
 dispatched_at timestamptz,
 dispatch_lease_token uuid,
 receipt_fingerprint text check(receipt_fingerprint ~ '^[a-f0-9]{64}$'),
 unique(owner_id,operation_id),
 check((dispatched_at is null)=(dispatch_lease_token is null)),
 check((dispatched_at is null)=(receipt_fingerprint is null))
);
create index customer_ai_monthly_capacity on bookworm_credentials.customer_ai_jobs(organization_id,created_at) where state<>'released';
alter table bookworm_credentials.customer_ai_jobs enable row level security;
revoke all on bookworm_credentials.customer_ai_jobs from public,anon,authenticated,service_role;

create function bookworm_credentials.guard_customer_ai_policy() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-'enabled') is distinct from (to_jsonb(old)-'enabled') then
  raise exception using errcode='23514',message='customer AI policy version is immutable'; end if;
 return new;
end $$;
create trigger customer_ai_policy_immutable before update on bookworm_credentials.customer_ai_policies
 for each row execute function bookworm_credentials.guard_customer_ai_policy();

create function bookworm_credentials.guard_customer_ai_authority() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-array['state','dispatched_at','dispatch_lease_token','receipt_fingerprint']) is distinct from
    (to_jsonb(old)-array['state','dispatched_at','dispatch_lease_token','receipt_fingerprint'])
   or (old.dispatched_at is not null and (new.dispatched_at is distinct from old.dispatched_at
       or new.dispatch_lease_token is distinct from old.dispatch_lease_token or new.receipt_fingerprint is distinct from old.receipt_fingerprint))
   or (new.state is distinct from old.state and not (old.state='held' and new.state in ('review','released','settled')))
   or (new.state='released' and new.dispatched_at is not null) then
  raise exception using errcode='23514',message='customer AI authority is immutable'; end if;
 return new;
end $$;
create trigger customer_ai_authority_immutable before update on bookworm_credentials.customer_ai_jobs
 for each row execute function bookworm_credentials.guard_customer_ai_authority();

-- New explicit billing mode. The existing billing-mode immutability trigger stays.
alter table public.ai_jobs drop constraint ai_jobs_billing_mode_check;
alter table public.ai_jobs add constraint ai_jobs_billing_mode_check check(billing_mode in ('operational','quoted','customer_key'));
alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check(
 (billing_mode='quoted' and agent_type in ('translator','story_blueprint','metadata','writer','proofreader','copyeditor','consistency','bookbible','illustrator','cover_designer','narrator'))
 or (billing_mode='operational' and agent_type<>'story_blueprint')
 or (billing_mode='customer_key' and agent_type in ('writer','proofreader','copyeditor','consistency','metadata','bookbible')));

create function public.guard_customer_ai_job() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs;
begin
 if new.billing_mode<>'customer_key' then return new; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=new.id;
 if not found or a.owner_id is distinct from new.created_by or a.workspace_id is distinct from new.workspace_id
   or a.book_id is distinct from new.book_id or a.agent_type is distinct from new.agent_type
   or a.model_policy->>'model' is distinct from new.model
   or new.input_ref is distinct from jsonb_build_object('customerGrantId',a.grant_id,'requestSha256',a.request_sha256)
   or new.idempotency_key is distinct from 'customer-ai:'||a.owner_id::text||':'||a.operation_id::text then
  raise exception using errcode='23514',message='customer job requires exact private authority'; end if;
 if tg_op='INSERT' and (new.status<>'queued' or new.provider_dispatched_at is not null) then
  raise exception using errcode='23514',message='customer job must enter queued'; end if;
 if tg_op='UPDATE' and (new.id is distinct from old.id or new.created_at is distinct from old.created_at
   or new.input_ref is distinct from old.input_ref or new.agent_type is distinct from old.agent_type
   or new.created_by is distinct from old.created_by or new.workspace_id is distinct from old.workspace_id
   or new.book_id is distinct from old.book_id or new.model is distinct from old.model
   or new.idempotency_key is distinct from old.idempotency_key) then
  raise exception using errcode='23514',message='customer job identity is immutable'; end if;
 if new.provider_dispatched_at is distinct from a.dispatched_at
   or (new.status in ('queued','running') and a.state<>'held')
   or (new.status='cancelled' and a.state<>'released')
   or (new.status='succeeded' and a.state<>'settled')
   or (new.status='failed' and a.state<>'review')
   or (a.dispatched_at is not null and new.status in ('queued','running') and new.lease_token is distinct from a.dispatch_lease_token) then
  raise exception using errcode='23514',message='customer job transition does not match its authority'; end if;
 return new;
end $$;

-- Reject the legacy debit BEFORE it takes organization/accounting locks. The
-- ledger trigger below also guards direct inserts and exact one-time releases.
do $$ declare definition text; needle text:='v_request:=jsonb_build_object(''userId'',p_user_id'; begin
 definition:=pg_get_functiondef('public.deduct_job_credits(uuid,uuid,uuid,text,integer,uuid)'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))<>length(needle) then
  raise exception 'unexpected legacy deduction definition'; end if;
 execute replace(definition,needle,
  'if exists(select 1 from public.ai_jobs where id=p_job_id and billing_mode=''customer_key'') then
    raise exception using errcode=''23514'',message=''customer AI fees require their own lifecycle''; end if;
  '||needle);
end $$;

create function public.guard_customer_ai_fee() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs;
begin
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=new.reference_id;
 if not found then
  if new.reference_type='customer_ai_platform_fee' then
   raise exception using errcode='23514',message='customer AI fee authority required'; end if;
  return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('credits:'||a.owner_id::text,0));
 if new.reference_type is distinct from 'customer_ai_platform_fee' or new.user_id is distinct from a.owner_id
   or new.workspace_id is distinct from a.workspace_id or a.fee_credits=0 or a.dispatched_at is not null
   or not ((new.source='generation_reservation' and new.amount=-a.fee_credits and a.state='held')
        or (new.source='generation_release' and new.amount=a.fee_credits and a.state='released'))
   or exists(select 1 from public.credit_ledger where reference_id=a.job_id and source=new.source)
   or (new.source='generation_release' and not exists(select 1 from public.credit_ledger
       where reference_id=a.job_id and source='generation_reservation' and amount=-a.fee_credits)) then
  raise exception using errcode='23514',message='customer AI fees require their own lifecycle'; end if;
 return new;
end $$;
create trigger a_customer_ai_fee before insert on public.credit_ledger for each row execute function public.guard_customer_ai_fee();
revoke all on function public.guard_customer_ai_fee() from public,anon,authenticated,service_role;
create trigger aa_customer_ai_job_guard before insert or update on public.ai_jobs
 for each row execute function public.guard_customer_ai_job();
revoke all on function public.guard_customer_ai_job() from public,anon,authenticated,service_role;

-- Preserve every other reservation rule and abort on unexpected source drift.
do $$ declare definition text; needle text:='if new.billing_mode=''quoted'' then return new; end if;'; begin
 definition:=pg_get_functiondef('public.reserve_text_job_credit()'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))<>length(needle) then
  raise exception 'unexpected text reservation definition'; end if;
 execute replace(definition,needle,'if new.billing_mode in (''quoted'',''customer_key'') then return new; end if;');
end $$;

-- All customer mutators lock in owner-vault -> credits -> organization -> job
-- order. Existing legacy workers explicitly exclude customer_key billing.
create function bookworm_credentials.lock_customer_ai_owner(p_owner uuid) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('ai-connection:'||p_owner::text,0));
 perform pg_advisory_xact_lock(hashtextextended('credits:'||p_owner::text,0));
end $$;

create function bookworm_credentials.customer_ai_access(p_owner uuid,p_workspace uuid,p_book uuid,p_connection uuid,p_revision integer,p_provider text)
returns uuid language plpgsql set search_path=pg_catalog,public as $$
declare org uuid;
begin
 if not exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=p_owner
     and status='active' and role in ('owner','admin','editor','writer') for share)
   or not exists(select 1 from public.books where id=p_book and workspace_id=p_workspace for share)
   or not exists(select 1 from public.ai_connections where id=p_connection and owner_id=p_owner
     and revision=p_revision and provider=p_provider and status='saved' for share) then
  raise exception using errcode='42501',message='customer AI authorization unavailable'; end if;
 select organization_id into org from public.workspaces where id=p_workspace for share;
 perform id from public.organizations where id=org for update;
 if not found then raise exception using errcode='42501',message='customer AI organization unavailable'; end if;
 return org;
end $$;

create function bookworm_credentials.customer_ai_allowance(p_org uuid) returns integer
language plpgsql set search_path=pg_catalog,public as $$
declare value jsonb; allowance text; paid boolean; subscription public.subscriptions; plan public.plans;
begin
 select * into subscription from public.subscriptions where organization_id=p_org order by created_at desc,id desc limit 1 for share;
 select * into plan from public.plans where id=subscription.plan_id for share;
 value:=plan.entitlements_json;
 paid:=subscription.status='active' and subscription.current_period_end>clock_timestamp() and plan.is_active and plan.price_cents>0;
 allowance:=value->>'customer_ai_requests_monthly';
 if paid is distinct from true or value->'customer_ai_enabled' is distinct from 'true'::jsonb or allowance is null
   or allowance !~ '^[1-9][0-9]{0,6}$' then
  raise exception using errcode='23514',message='paid customer AI entitlement required'; end if;
 return allowance::integer;
end $$;

create function bookworm_credentials.check_customer_ai_sources(p_book uuid,p_sources jsonb,p_request jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare s jsonb; ids jsonb;
begin
 ids:=p_request#>'{input,chapterIds}';
 if jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources)>100
   or jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)<>jsonb_array_length(p_sources)
   or jsonb_typeof(p_request#>'{input,chapters}') is distinct from 'object'
   or (select count(*) from jsonb_object_keys(p_request#>'{input,chapters}'))<>jsonb_array_length(p_sources)
   or (select count(distinct value->>'chapterId') from jsonb_array_elements(p_sources))<>jsonb_array_length(p_sources)
   or (select count(distinct value) from jsonb_array_elements(ids))<>jsonb_array_length(ids) then
  raise exception using errcode='22023',message='invalid customer AI source snapshot'; end if;
 for s in select value from jsonb_array_elements(p_sources) loop
  if jsonb_typeof(s) is distinct from 'object' or not s ?& array['chapterId','documentVersionId','version']
    or (s-array['chapterId','documentVersionId','version'])<>'{}'::jsonb
    or jsonb_typeof(s->'version') is distinct from 'number' or (s->>'version') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(s->'chapterId') is distinct from 'string' or jsonb_typeof(s->'documentVersionId') is distinct from 'string' then
   raise exception using errcode='22023',message='invalid customer AI source snapshot'; end if;
  if not exists(select 1 from public.chapters c join public.document_versions d on d.id=c.current_document_version_id and d.chapter_id=c.id
       where c.book_id=p_book and c.id=(s->>'chapterId')::uuid and d.id=(s->>'documentVersionId')::uuid
         and d.version_number=(s->>'version')::integer for share of c,d)
     or not ids @> jsonb_build_array(s->>'chapterId')
     or p_request#>>array['input','chapters',s->>'chapterId','documentVersionId'] is distinct from s->>'documentVersionId'
     or p_request#>>array['input','chapters',s->>'chapterId','version'] is distinct from s->>'version' then
   raise exception using errcode='40001',message='customer AI source changed'; end if;
 end loop;
end $$;

create function public.create_customer_ai_job(p_job_id uuid,p_operation_id uuid,p_owner_id uuid,p_workspace_id uuid,p_book_id uuid,
 p_connection_id uuid,p_revision integer,p_policy_id uuid,p_request_sha256 text,p_request jsonb,p_sources jsonb,
 p_expected_fee integer,p_consent boolean) returns public.ai_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p bookworm_credentials.customer_ai_policies; a bookworm_credentials.customer_ai_jobs; j public.ai_jobs; org uuid; allowance integer;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_job_id is null or p_operation_id is null or p_owner_id is null or p_consent is distinct from true
   or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' or p_expected_fee is null then
  raise exception using errcode='22023',message='explicit customer AI consent and request identity required'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(p_owner_id);
 select * into a from bookworm_credentials.customer_ai_jobs where owner_id=p_owner_id and operation_id=p_operation_id;
 if found then
  if a.job_id is distinct from p_job_id or a.workspace_id is distinct from p_workspace_id or a.book_id is distinct from p_book_id
    or a.connection_id is distinct from p_connection_id or a.credential_revision is distinct from p_revision
    or a.policy_id is distinct from p_policy_id or a.request_sha256 is distinct from p_request_sha256
    or a.request_snapshot is distinct from p_request or a.source_versions is distinct from p_sources or a.fee_credits is distinct from p_expected_fee then
   raise exception using errcode='40001',message='customer AI retry identity changed'; end if;
  if not exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=p_owner_id and status='active') then
   raise exception using errcode='42501',message='customer AI recovery unavailable'; end if;
  select * into j from public.ai_jobs where id=a.job_id; return j;
 end if;
 select * into p from bookworm_credentials.customer_ai_policies where id=p_policy_id and enabled and expires_at>clock_timestamp() for share;
 if not found or p.fee_credits is distinct from p_expected_fee then
  raise exception using errcode='23514',message='approved customer AI fee policy required'; end if;
 org:=bookworm_credentials.customer_ai_access(p_owner_id,p_workspace_id,p_book_id,p_connection_id,p_revision,p.provider);
 allowance:=bookworm_credentials.customer_ai_allowance(org);
 if (select count(*) from bookworm_credentials.customer_ai_jobs where organization_id=org and state<>'released'
     and created_at>=(date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'))>=allowance then
  raise exception using errcode='23514',message='customer AI monthly capacity exhausted'; end if;
 if jsonb_typeof(p_request) is distinct from 'object' or (p_request-array['input','contextPolicy'])<>'{}'::jsonb
   or jsonb_typeof(p_request->'input') is distinct from 'object'
   or ((p_request->'input')-array['chapterIds','chapters','book','styleGuide','bookBible','relatedContext','userInstruction'])<>'{}'::jsonb
   or (p.agent_type<>'metadata' and jsonb_array_length(p_sources)<1) then
  raise exception using errcode='22023',message='invalid customer AI request'; end if;
 perform bookworm_credentials.check_customer_ai_sources(p_book_id,p_sources,p_request);
 if exists(select 1 from public.ai_jobs where book_id=p_book_id and created_by=p_owner_id
    and agent_type in ('writer','proofreader','copyeditor','consistency','metadata','bookbible') and status in ('queued','running')) then
  raise exception using errcode='23505',message='customer AI book request already active'; end if;
 insert into bookworm_credentials.customer_ai_jobs(job_id,grant_id,operation_id,owner_id,workspace_id,book_id,organization_id,
  connection_id,credential_revision,policy_id,provider,agent_type,model_policy,request_sha256,request_snapshot,source_versions,fee_credits,expires_at)
 values(p_job_id,gen_random_uuid(),p_operation_id,p_owner_id,p_workspace_id,p_book_id,org,p_connection_id,p_revision,p.id,p.provider,p.agent_type,
  p.model_policy,p_request_sha256,p_request,p_sources,p.fee_credits,least(p.expires_at,clock_timestamp()+interval '15 minutes')) returning * into a;
 insert into public.ai_jobs(id,workspace_id,book_id,created_by,agent_type,model,billing_mode,status,idempotency_key,input_ref)
 values(p_job_id,p_workspace_id,p_book_id,p_owner_id,p.agent_type,p.model_policy->>'model','customer_key','queued',
  'customer-ai:'||p_owner_id::text||':'||p_operation_id::text,jsonb_build_object('customerGrantId',a.grant_id,'requestSha256',p_request_sha256)) returning * into j;
 if p.fee_credits>0 then
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
   values(p_owner_id,p_workspace_id,'generation_reservation',-p.fee_credits,0,'customer_ai_platform_fee',j.id);
 end if;
 return j;
end $$;

create function public.claim_customer_ai_job(p_job_id uuid,p_lease_seconds integer default 180) returns public.ai_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then raise exception using errcode='22023',message='invalid lease duration'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 if bookworm_credentials.customer_ai_access(a.owner_id,a.workspace_id,a.book_id,a.connection_id,a.credential_revision,a.provider) is distinct from a.organization_id then
  raise exception using errcode='42501',message='customer AI organization changed'; end if;
 perform bookworm_credentials.customer_ai_allowance(a.organization_id);
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if a.state<>'held' or a.expires_at<=clock_timestamp() or a.dispatched_at is not null or j.billing_mode<>'customer_key'
   or j.attempts>=5 or not ((j.status='queued' and j.available_at<=clock_timestamp())
      or (j.status='running' and j.lease_expires_at<=clock_timestamp()))
   or not exists(select 1 from bookworm_credentials.customer_ai_policies where id=a.policy_id and enabled and expires_at>clock_timestamp()) then
  raise exception using errcode='40001',message='customer job is not claimable'; end if;
 perform bookworm_credentials.check_customer_ai_sources(a.book_id,a.source_versions,a.request_snapshot);
 update public.ai_jobs set status='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
  started_at=coalesce(started_at,clock_timestamp()),attempts=attempts+1 where id=j.id returning * into j;
 return j;
end $$;

-- The only encrypted-secret resolver. It is a one-way dispatch claim, not GET.
-- Lost replies require receipt recovery/manual review; NEVER resolve again.
create function public.resolve_customer_ai_dispatch(p_job_id uuid,p_lease_token uuid,p_fingerprint text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs; secret bookworm_credentials.ai_connection_secrets;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='dispatch fingerprint required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 if bookworm_credentials.customer_ai_access(a.owner_id,a.workspace_id,a.book_id,a.connection_id,a.credential_revision,a.provider) is distinct from a.organization_id then
  raise exception using errcode='42501',message='customer AI organization changed'; end if;
 perform bookworm_credentials.customer_ai_allowance(a.organization_id);
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if a.state<>'held' or a.dispatched_at is not null or a.expires_at<=clock_timestamp() or j.status<>'running'
   or j.billing_mode<>'customer_key' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp()
   or not exists(select 1 from bookworm_credentials.customer_ai_policies where id=a.policy_id and enabled and expires_at>clock_timestamp()) then
  raise exception using errcode='40001',message='customer dispatch authorization unavailable'; end if;
 perform bookworm_credentials.check_customer_ai_sources(a.book_id,a.source_versions,a.request_snapshot);
 select * into secret from bookworm_credentials.ai_connection_secrets where connection_id=a.connection_id and revision=a.credential_revision for share;
 if not found then raise exception using errcode='42501',message='customer credential unavailable'; end if;
 update bookworm_credentials.customer_ai_jobs set dispatched_at=clock_timestamp(),dispatch_lease_token=p_lease_token,
  receipt_fingerprint=p_fingerprint where job_id=j.id returning * into a;
 update public.ai_jobs set provider_dispatched_at=a.dispatched_at where id=j.id;
 return jsonb_build_object('scope',jsonb_build_object('grantId',a.grant_id,'jobId',a.job_id,'workspaceId',a.workspace_id,
  'bookId',a.book_id,'ownerId',a.owner_id,'connectionId',a.connection_id,'credentialRevision',a.credential_revision,
  'leaseToken',p_lease_token,'provider',a.provider,'agentType',a.agent_type,'expectedRequestSha256',a.request_sha256,'policy',a.model_policy),
  'request',a.request_snapshot,'credential',jsonb_build_object('keyId',secret.key_id,'nonce',secret.nonce,'ciphertext',secret.ciphertext,'tag',secret.auth_tag));
end $$;

create function public.customer_ai_dispatch_authorized(p_scope jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs; expected jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 if jsonb_typeof(p_scope) is distinct from 'object' then return false; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=(p_scope->>'jobId')::uuid;
 if not found then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-connection:'||a.owner_id::text,0));
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=a.job_id;
 if bookworm_credentials.customer_ai_access(a.owner_id,a.workspace_id,a.book_id,a.connection_id,a.credential_revision,a.provider) is distinct from a.organization_id then return false; end if;
 perform bookworm_credentials.customer_ai_allowance(a.organization_id);
 perform bookworm_credentials.check_customer_ai_sources(a.book_id,a.source_versions,a.request_snapshot);
 select * into j from public.ai_jobs where id=a.job_id;
 expected:=jsonb_build_object('grantId',a.grant_id,'jobId',a.job_id,'workspaceId',a.workspace_id,'bookId',a.book_id,'ownerId',a.owner_id,
   'connectionId',a.connection_id,'credentialRevision',a.credential_revision,'leaseToken',a.dispatch_lease_token,
   'provider',a.provider,'agentType',a.agent_type,'expectedRequestSha256',a.request_sha256,'policy',a.model_policy);
 return p_scope=expected and a.state='held' and a.expires_at>clock_timestamp() and a.dispatched_at is not null
   and j.provider_dispatched_at=a.dispatched_at and j.status='running' and j.billing_mode='customer_key'
   and j.lease_token=a.dispatch_lease_token and j.lease_expires_at>clock_timestamp()
   and exists(select 1 from public.ai_connections where id=a.connection_id and owner_id=a.owner_id and status='saved' and revision=a.credential_revision)
   and exists(select 1 from public.workspace_members where workspace_id=a.workspace_id and user_id=a.owner_id and status='active' and role in ('owner','admin','editor','writer'))
   and exists(select 1 from bookworm_credentials.customer_ai_policies where id=a.policy_id and enabled and expires_at>clock_timestamp());
exception when invalid_text_representation or insufficient_privilege or check_violation or serialization_failure then return false;
end $$;

create function public.cancel_customer_ai_job(p_job_id uuid,p_owner_id uuid) returns public.ai_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id and owner_id=p_owner_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if a.state='released' then return j; end if;
 if a.state<>'held' or a.dispatched_at is not null or j.status not in ('queued','running') then
  raise exception using errcode='40001',message='customer outcome requires review; no automatic release'; end if;
 update bookworm_credentials.customer_ai_jobs set state='released' where job_id=j.id;
 if a.fee_credits>0 then
  insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after,reference_type,reference_id)
   values(a.owner_id,a.workspace_id,'generation_release',a.fee_credits,0,'customer_ai_platform_fee',j.id);
 end if;
 update public.ai_jobs set status='cancelled',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp() where id=j.id returning * into j;
 return j;
end $$;

create function public.hold_customer_ai_job(p_job_id uuid,p_lease_token uuid) returns public.ai_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if a.state='review' and a.dispatch_lease_token=p_lease_token then return j; end if;
 if a.state<>'held' or a.dispatched_at is null or a.dispatch_lease_token is distinct from p_lease_token then
  raise exception using errcode='40001',message='customer dispatch lease changed'; end if;
 update bookworm_credentials.customer_ai_jobs set state='review' where job_id=j.id;
 update public.ai_jobs set status='failed',error_code='customer_provider_outcome_unknown',
  error_message='Customer AI outcome requires reconciliation; do not regenerate.',completed_at=clock_timestamp(),
  lease_token=null,lease_expires_at=null where id=j.id returning * into j;
 return j;
end $$;

-- Pin this RPC surface, not broad schema/table privileges. No browser secret RPC.
revoke all on function bookworm_credentials.valid_customer_ai_policy(text,jsonb),bookworm_credentials.guard_customer_ai_policy(),
 bookworm_credentials.guard_customer_ai_authority(),bookworm_credentials.lock_customer_ai_owner(uuid),
 bookworm_credentials.customer_ai_access(uuid,uuid,uuid,uuid,integer,text),bookworm_credentials.customer_ai_allowance(uuid),
 bookworm_credentials.check_customer_ai_sources(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.create_customer_ai_job(uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer,boolean),
 public.claim_customer_ai_job(uuid,integer),public.resolve_customer_ai_dispatch(uuid,uuid,text),public.customer_ai_dispatch_authorized(jsonb),
 public.cancel_customer_ai_job(uuid,uuid),public.hold_customer_ai_job(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_customer_ai_job(uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer,boolean),
 public.claim_customer_ai_job(uuid,integer),public.resolve_customer_ai_dispatch(uuid,uuid,text),public.customer_ai_dispatch_authorized(jsonb),
 public.cancel_customer_ai_job(uuid,uuid),public.hold_customer_ai_job(uuid,uuid) to service_role;
