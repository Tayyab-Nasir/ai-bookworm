-- Atomic image offer acceptance. Not exposed by the HTTP API until the worker
-- and recovery/settlement lifecycle are complete.
alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check (
 (billing_mode='quoted' and agent_type in ('translator','story_blueprint','metadata','writer','proofreader','copyeditor','consistency','bookbible','illustrator','cover_designer'))
 or (billing_mode='operational' and agent_type<>'story_blueprint')
);

create table public.image_quote_acceptances (
 quote_id uuid primary key references public.image_quote_snapshots(id) on delete restrict,
 job_id uuid not null unique references public.ai_jobs(id) on delete restrict,
 accepted_at timestamptz not null default clock_timestamp()
);
alter table public.image_quote_acceptances enable row level security;
revoke all on public.image_quote_acceptances from public,anon,authenticated,service_role;
grant select on public.image_quote_acceptances to service_role;

create or replace function public.reserve_image_job_credit() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text; v_org uuid; v_quota_text text; v_quota numeric:=0; v_used numeric; v_pending bigint;
begin
 if new.agent_type not in ('illustrator','cover_designer') or new.status not in ('queued','running') then return new; end if;
 if tg_op='UPDATE' then
  if old.agent_type in ('illustrator','cover_designer') and old.status in ('queued','running')
   and old.workspace_id=new.workspace_id and old.created_by=new.created_by then return new; end if;
 end if;
 select role into v_role from public.workspace_members where workspace_id=new.workspace_id
  and user_id=new.created_by and status='active' for share;
 if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
  raise exception 'image reservation requires editing access' using errcode='42501'; end if;
 select organization_id into v_org from public.workspaces where id=new.workspace_id;
 perform id from public.organizations where id=v_org for update;
 if not found then raise exception 'image organization missing' using errcode='22023'; end if;
 if exists(select 1 from public.ai_jobs j where j.workspace_id=new.workspace_id and j.created_by=new.created_by
   and j.agent_type in ('illustrator','cover_designer') and j.status in ('queued','running') and j.id<>new.id) then
  raise exception 'image request already pending' using errcode='23514'; end if;
 -- Same single-flight lock, different payment source. Quoted dispatch is fenced
 -- by guard_job_billing_mode and its funded hold, never a monthly image unit.
 if new.billing_mode='quoted' then return new; end if;
 select case when p.entitlements_json ? 'image_credits_monthly' then coalesce(p.entitlements_json->>'image_credits_monthly','0') else null end
  into v_quota_text from public.subscriptions s left join public.plans p on p.id=s.plan_id
  where s.organization_id=v_org and s.status in ('active','trialing') order by s.created_at desc limit 1;
 if v_quota_text is not null then
  if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'invalid image credit entitlement' using errcode='22023'; end if;
  v_quota:=v_quota_text::numeric;
 end if;
 select coalesce(sum(quantity),0) into v_used from public.usage_events where organization_id=v_org and meter='image_credits'
  and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
 select count(*) into v_pending from public.ai_jobs j join public.workspaces w on w.id=j.workspace_id
  where w.organization_id=v_org and j.agent_type in ('illustrator','cover_designer') and j.billing_mode='operational'
  and j.status in ('queued','running') and j.id<>new.id;
 if v_used+v_pending+1>v_quota then raise exception 'image credit capacity exhausted' using errcode='23514'; end if;
 return new;
end $$;

create function public.prevent_quoted_image_operational_charge() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if new.meter='image_credits' and exists(select 1 from public.ai_jobs where id=new.ai_job_id and billing_mode='quoted'
   and agent_type in ('illustrator','cover_designer')) then
  raise exception 'quoted image cannot use operational settlement' using errcode='23514'; end if;
 return new;
end $$;
create trigger a_quoted_image_no_operational_charge before insert on public.usage_events
 for each row execute function public.prevent_quoted_image_operational_charge();
revoke all on function public.prevent_quoted_image_operational_charge() from public,anon,authenticated,service_role;

create function public.accept_image_quote(p_quote_id uuid,p_user_id uuid,p_expected_credits integer,p_catalog jsonb)
returns public.ai_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.image_quote_snapshots; j public.ai_jobs; e jsonb; r jsonb; q jsonb; v_role text; a uuid;
begin
 select * into s from public.image_quote_snapshots where id=p_quote_id and user_id=p_user_id for update;
 if not found then raise exception 'image quote missing' using errcode='P0002'; end if;
 select role into v_role from public.workspace_members where workspace_id=s.workspace_id and user_id=p_user_id and status='active' for share;
 if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
  raise exception 'image quote requires editing access' using errcode='42501'; end if;
 q:=s.quote_json; r:=s.request_json;
 if p_expected_credits is distinct from (q->>'reservedCredits')::integer then
  raise exception 'image quote confirmation mismatch' using errcode='23514'; end if;
 select job_id into a from public.image_quote_acceptances where quote_id=s.id;
 if found then select * into strict j from public.ai_jobs where id=a; return j; end if;
 perform public.validate_image_quote_price(q);
 if s.expires_at<=clock_timestamp() or (q->>'expiresAt')::timestamptz is distinct from s.expires_at
  or p_catalog->'approved' is distinct from 'true'::jsonb or p_catalog->>'version' is distinct from s.catalog_version
  or coalesce(p_catalog->>'effectiveAt','')='' or coalesce(p_catalog->>'expiresAt','')=''
  or (p_catalog->>'effectiveAt')::timestamptz>clock_timestamp() or (p_catalog->>'expiresAt')::timestamptz<=clock_timestamp()
  or jsonb_typeof(p_catalog->'entries') is distinct from 'array' then
  raise exception 'image quote or catalog expired' using errcode='23514'; end if;
 if (select count(*) from jsonb_array_elements(p_catalog->'entries') x where x->>'id'=s.model_option_id)<>1 then
  raise exception 'image catalog option missing or duplicated' using errcode='22023'; end if;
 select value into e from jsonb_array_elements(p_catalog->'entries') where value->>'id'=s.model_option_id;
 if coalesce(e->>'maxPromptBytes','') !~ '^[1-9][0-9]{0,7}$'
  or coalesce(e->>'maxReferenceImages','') !~ '^[0-3]$'
  or jsonb_typeof(e->'maximumTokens') is distinct from 'object'
  or jsonb_typeof(e#>'{price,rates}') is distinct from 'array'
  or coalesce(r->>'kind','') not in ('illustration','cover') then
  raise exception 'invalid approved image option' using errcode='22023'; end if;
 if q->'policy' is distinct from e->'policy' or ((q->'price')-'rates') is distinct from ((e->'price')-'rates')
  or (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(q#>'{price,rates}')) is distinct from
     (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(e#>'{price,rates}'))
  or r->>'model' is distinct from e#>>'{price,model}' or r->>'size' is distinct from e->>'size'
  or r->>'quality' is distinct from e->>'quality' or r->>'kind' not in ('illustration','cover')
  or coalesce(r->>'prompt','')='' or octet_length(r->>'prompt')>(e->>'maxPromptBytes')::integer
  or jsonb_typeof(r->'references') is distinct from 'array'
  or jsonb_array_length(r->'references')>least(3,(e->>'maxReferenceImages')::integer)
  or (select count(distinct x->>'assetId') from jsonb_array_elements(r->'references') x)<>jsonb_array_length(r->'references')
  or exists(select 1 from jsonb_array_elements(q->'maximumTokens') x where x->>'tokens' is distinct from e#>>array['maximumTokens',x->>'dimension']) then
  raise exception 'image quote differs from approved option' using errcode='23514'; end if;
 if s.book_id is not null and not exists(select 1 from public.books where id=s.book_id and workspace_id=s.workspace_id for share) then
  raise exception 'image book scope changed' using errcode='42501'; end if;
 for r in select value from jsonb_array_elements(s.request_json->'references') loop
  perform a.id from public.assets a join public.asset_versions v on v.asset_id=a.id and v.storage_path=a.storage_path
   where a.id=(r->>'assetId')::uuid and a.workspace_id=s.workspace_id and a.deleted_at is null
    and a.mime_type='image/png' and v.version_number=(r->>'version')::integer
    and a.checksum=r->>'sha256' and v.checksum=a.checksum and v.scan_status in ('clean','trusted_generated') for share of a,v;
  if not found then raise exception 'image reference changed' using errcode='23514'; end if;
 end loop;
 insert into public.ai_jobs(id,workspace_id,book_id,created_by,agent_type,billing_mode,status,model,input_ref,idempotency_key)
  values(s.generation_job_id,s.workspace_id,s.book_id,s.user_id,
   case when s.request_json->>'kind'='cover' then 'cover_designer' else 'illustrator' end,'quoted','queued',s.request_json->>'model',
   jsonb_build_object('imageQuoteId',s.id,'requestSha256',s.request_sha256,'generationRequest',s.request_json),
   'image-quote:'||s.id::text) returning * into j;
 perform public.reserve_funded_usage_quote(q);
 insert into public.image_quote_acceptances(quote_id,job_id) values(s.id,j.id);
 return j;
end $$;
revoke all on function public.accept_image_quote(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.accept_image_quote(uuid,uuid,integer,jsonb) to service_role;
