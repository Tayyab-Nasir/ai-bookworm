-- Fund every ordered chapter segment in one transaction. This service-only
-- foundation does not expose purchases or start a narration worker.
alter table public.ai_jobs drop constraint quoted_agent_supported;
alter table public.ai_jobs add constraint quoted_agent_supported check (
  (billing_mode='quoted' and agent_type in ('translator','story_blueprint','metadata','writer','proofreader','copyeditor','consistency','bookbible','illustrator','cover_designer','narrator'))
  or (billing_mode='operational' and agent_type<>'story_blueprint')
);
alter table public.ai_jobs add constraint narration_job_billing_identity unique(id,billing_mode);
alter table public.audiobook_projects
  add column billing_mode text not null default 'operational' check(billing_mode in ('operational','quoted')),
  add column narration_quote_id uuid unique references public.narration_chapter_quote_snapshots(id) on delete restrict,
  add constraint narration_project_billing_identity unique(id,billing_mode),
  add constraint narration_project_quote_mode check((billing_mode='quoted')=(narration_quote_id is not null)),
  add constraint narration_project_quoted_delivery check(billing_mode='operational' or
    (voice in ('alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar') and speed between 0.25 and 1.5));
alter table public.audiobook_projects drop constraint audiobook_projects_credit_units_check;
alter table public.audiobook_projects add constraint audiobook_projects_credit_units_check check(
  credit_units>0 and (billing_mode='quoted' or credit_units<=100000));
alter table public.audiobook_segments
  add column billing_mode text not null default 'operational' check(billing_mode in ('operational','quoted')),
  add constraint narration_segment_project_mode foreign key(project_id,billing_mode)
    references public.audiobook_projects(id,billing_mode) on delete cascade,
  add constraint narration_segment_job_mode foreign key(ai_job_id,billing_mode)
    references public.ai_jobs(id,billing_mode) on delete cascade;
alter table public.audiobook_segments drop constraint audiobook_segments_credit_units_check;
alter table public.audiobook_segments add constraint audiobook_segments_credit_units_check check(
  credit_units>0 and (billing_mode='quoted' or credit_units<=5));

create function public.guard_narration_billing_identity() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_table_name='audiobook_projects' then
    if to_jsonb(new)-array['status','started_at','completed_at'] is distinct from
      to_jsonb(old)-array['status','started_at','completed_at'] then
      raise exception 'narration project identity and maximum budget are immutable' using errcode='23514'; end if;
  elsif to_jsonb(new)-array['asset_id','completed_at'] is distinct from to_jsonb(old)-array['asset_id','completed_at'] then
    raise exception 'narration segment identity and billing mode are immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_narration_billing_identity() from public,anon,authenticated,service_role;
create trigger narration_project_billing_immutable before update on public.audiobook_projects
  for each row execute function public.guard_narration_billing_identity();
create trigger narration_segment_billing_immutable before update on public.audiobook_segments
  for each row execute function public.guard_narration_billing_identity();

create table public.narration_chapter_quote_acceptances (
  quote_id uuid primary key references public.narration_chapter_quote_snapshots(id) on delete restrict,
  project_id uuid not null unique references public.audiobook_projects(id) on delete restrict,
  expected_credits integer not null check(expected_credits>0),
  ai_disclosure_accepted boolean not null check(ai_disclosure_accepted),
  accepted_at timestamptz not null default clock_timestamp()
);
alter table public.narration_chapter_quote_acceptances enable row level security;
revoke all on public.narration_chapter_quote_acceptances from public,anon,authenticated,service_role;
grant select on public.narration_chapter_quote_acceptances to service_role;
create trigger narration_acceptance_immutable before update on public.narration_chapter_quote_acceptances
  for each row execute function public.guard_narration_quote_snapshot();

-- Quoted narrator jobs use funded monetary holds, not historical character
-- units. Keep organization/member locking and zero-default legacy quotas.
create or replace function public.reserve_audio_job_credit() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text; v_org uuid; v_quota_text text; v_quota numeric:=0;
  v_used numeric; v_pending numeric; v_units integer;
begin
  if new.agent_type<>'narrator' or new.status not in ('queued','running') then return new; end if;
  if tg_op='UPDATE' and old.agent_type='narrator' and old.status in ('queued','running')
    and old.workspace_id=new.workspace_id and old.created_by=new.created_by then return new; end if;
  select role::text into v_role from public.workspace_members
    where workspace_id=new.workspace_id and user_id=new.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'audio reservation requires editing access' using errcode='42501'; end if;
  select organization_id into v_org from public.workspaces where id=new.workspace_id;
  perform id from public.organizations where id=v_org for update;
  if not found then raise exception 'audio organization missing' using errcode='22023'; end if;
  if new.billing_mode='quoted' then
    if v_role not in ('owner','admin','editor','writer') then
      raise exception 'quoted narration requires writing access' using errcode='42501'; end if;
    return new;
  end if;
  if jsonb_typeof(new.input_ref->'creditUnits') is distinct from 'number'
    or new.input_ref->>'creditUnits' !~ '^[1-5]$' then
    raise exception 'invalid audio credit reservation' using errcode='22023'; end if;
  v_units:=(new.input_ref->>'creditUnits')::integer;
  select case when p.entitlements_json ? 'audio_credits_monthly' then coalesce(p.entitlements_json->>'audio_credits_monthly','0') else null end
    into v_quota_text from public.subscriptions s left join public.plans p on p.id=s.plan_id
    where s.organization_id=v_org and s.status in ('active','trialing') order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'invalid audio credit entitlement' using errcode='22023'; end if;
    v_quota:=v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity),0) into v_used from public.usage_events where organization_id=v_org and meter='audio_credits'
    and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  select coalesce(sum((j.input_ref->>'creditUnits')::numeric),0) into v_pending
    from public.ai_jobs j join public.workspaces w on w.id=j.workspace_id
    where w.organization_id=v_org and j.agent_type='narrator' and j.billing_mode='operational'
      and j.status in ('queued','running') and j.id<>new.id;
  if v_used+v_pending+v_units>v_quota then raise exception 'audio credit capacity exhausted' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.reserve_audio_job_credit() from public,anon,authenticated,service_role;

create function public.prevent_quoted_narration_operational_charge() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.meter='audio_credits' and exists(select 1 from public.ai_jobs where id=new.ai_job_id
    and agent_type='narrator' and billing_mode='quoted') then
    raise exception 'quoted narration cannot use operational settlement' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.prevent_quoted_narration_operational_charge() from public,anon,authenticated,service_role;
create trigger a_quoted_narration_no_operational_charge before insert on public.usage_events
  for each row execute function public.prevent_quoted_narration_operational_charge();

create function public.accept_narration_chapter_quote(
  p_quote_id uuid,p_user_id uuid,p_expected_credits integer,p_ai_disclosure_accepted boolean,p_catalog jsonb
) returns public.audiobook_projects
language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.narration_chapter_quote_snapshots; project public.audiobook_projects; child public.narration_quote_snapshots;
  member_role text; original uuid; document public.document_versions; option jsonb; r jsonb; q jsonb;
  first_request jsonb; first_quote jsonb; previous_end integer:=0; counter integer:=0; total numeric:=0; source_text text;
begin
  select * into saved from public.narration_chapter_quote_snapshots where id=p_quote_id and user_id=p_user_id for update;
  if not found then raise exception 'chapter narration quote missing' using errcode='P0002'; end if;
  select role into member_role from public.workspace_members where workspace_id=saved.workspace_id and user_id=p_user_id
    and status='active' for share;
  if not found or member_role not in ('owner','admin','editor','writer') then
    raise exception 'funded chapter narration requires writing access' using errcode='42501'; end if;
  if p_expected_credits is distinct from saved.reserved_credits or p_ai_disclosure_accepted is distinct from true then
    raise exception 'confirm exact chapter maximum and AI voice disclosure' using errcode='23514'; end if;
  select project_id into original from public.narration_chapter_quote_acceptances where quote_id=saved.id;
  if found then
    select * into strict project from public.audiobook_projects where id=original and narration_quote_id=saved.id;
    return project; -- Replays recover the original funded project, not new holds.
  end if;
  if saved.expires_at<=clock_timestamp() or jsonb_typeof(p_catalog) is distinct from 'object'
    or octet_length(p_catalog::text)>65536
    or not(p_catalog ?& array['version','approved','approvalReference','effectiveAt','expiresAt','quoteLifetimeSeconds','entries'])
    or p_catalog-array['version','approved','approvalReference','effectiveAt','expiresAt','quoteLifetimeSeconds','entries']<>'{}'::jsonb
    or p_catalog->'approved' is distinct from 'true'::jsonb or p_catalog->>'version' is distinct from saved.catalog_version
    or jsonb_typeof(p_catalog->'approvalReference') is distinct from 'string'
    or coalesce(length(trim(p_catalog->>'approvalReference')),0) not between 1 and 256
    or jsonb_typeof(p_catalog->'effectiveAt') is distinct from 'string' or coalesce(p_catalog->>'effectiveAt','')=''
    or jsonb_typeof(p_catalog->'expiresAt') is distinct from 'string' or coalesce(p_catalog->>'expiresAt','')=''
    or (p_catalog->>'effectiveAt')::timestamptz>clock_timestamp() or (p_catalog->>'expiresAt')::timestamptz<=clock_timestamp()
    or jsonb_typeof(p_catalog->'quoteLifetimeSeconds') is distinct from 'number'
    or coalesce(p_catalog->>'quoteLifetimeSeconds','') !~ '^[0-9]{2,4}$'
    or (p_catalog->>'quoteLifetimeSeconds')::integer not between 30 and 3600
    or jsonb_typeof(p_catalog->'entries') is distinct from 'array' or jsonb_array_length(p_catalog->'entries') not between 1 and 20 then
    raise exception 'chapter narration quote or approved catalog unavailable' using errcode='23514'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_catalog->'entries'))<>jsonb_array_length(p_catalog->'entries')
    or (select count(*) from jsonb_array_elements(p_catalog->'entries') where value->>'id'=saved.model_option_id)<>1 then
    raise exception 'narration catalog option missing or duplicated' using errcode='22023'; end if;
  select value into option from jsonb_array_elements(p_catalog->'entries') where value->>'id'=saved.model_option_id;
  if jsonb_typeof(option) is distinct from 'object' or not(option ?& array['id','label','price','policy','maxInputTokens','maxOutputTokens'])
    or option-array['id','label','price','policy','maxInputTokens','maxOutputTokens']<>'{}'::jsonb
    or option->'maxInputTokens' is distinct from '128000'::jsonb
    or jsonb_typeof(option->'maxOutputTokens') is distinct from 'number'
    or coalesce(option->>'maxOutputTokens','') !~ '^[1-9][0-9]{0,3}$'
    or (option->>'maxOutputTokens')::integer not between 1 and 4096
    or jsonb_typeof(option#>'{price,rates}') is distinct from 'array' then
    raise exception 'invalid approved narration profile' using errcode='22023'; end if;
  perform id from public.books where id=saved.book_id and workspace_id=saved.workspace_id for share;
  if not found then raise exception 'narration book scope changed' using errcode='42501'; end if;
  perform id from public.editions where id=saved.edition_id and book_id=saved.book_id and type='audiobook' for share;
  if not found then raise exception 'narration edition scope changed' using errcode='23514'; end if;
  perform id from public.chapters where id=saved.chapter_id and book_id=saved.book_id
    and current_document_version_id=saved.document_version_id for share;
  if not found then raise exception 'chapter narration source changed' using errcode='23514'; end if;
  select * into document from public.document_versions where id=saved.document_version_id and chapter_id=saved.chapter_id for share;
  if not found or length(document.plain_text) not between 1 and 1000000
    or saved.source_sha256 is distinct from encode(public.digest(convert_to(document.plain_text,'UTF8'),'sha256'),'hex') then
    raise exception 'chapter narration source identity mismatch' using errcode='23514'; end if;
  for child in select c.* from public.narration_chapter_quote_segments l join public.narration_quote_snapshots c on c.id=l.quote_id
    where l.chapter_quote_id=saved.id order by l.segment_index for share of l,c
  loop
    r:=child.request_json; q:=child.quote_json;
    perform public.validate_narration_quote(r,q);
    if child.user_id is distinct from saved.user_id or child.workspace_id is distinct from saved.workspace_id
      or child.book_id is distinct from saved.book_id or child.edition_id is distinct from saved.edition_id
      or child.chapter_id is distinct from saved.chapter_id or child.document_version_id is distinct from saved.document_version_id
      or child.catalog_version is distinct from saved.catalog_version or child.model_option_id is distinct from saved.model_option_id
      or child.request_sha256 is distinct from bookworm_private.narration_request_hash(r)
      or child.idempotency_key is distinct from 'narration-chapter:'||encode(public.digest(convert_to(saved.idempotency_key,'UTF8'),'sha256'),'hex')||':'||counter::text
      or child.generation_job_id is distinct from bookworm_private.narration_job_id(saved.user_id,child.idempotency_key)
      or r->>'jobId' is distinct from child.generation_job_id::text
      or r->>'userId' is distinct from saved.user_id::text or r->>'workspaceId' is distinct from saved.workspace_id::text
      or r->>'bookId' is distinct from saved.book_id::text or r->>'editionId' is distinct from saved.edition_id::text
      or r->>'chapterId' is distinct from saved.chapter_id::text or r->>'documentVersionId' is distinct from saved.document_version_id::text
      or r->>'segmentIndex' is distinct from counter::text or r->>'voice' is distinct from saved.voice
      or (r->>'speed')::numeric is distinct from saved.speed or r->>'instructions' is distinct from saved.instructions
      or r->'maxOutputTokens' is distinct from option->'maxOutputTokens'
      or q->'policy' is distinct from option->'policy' or (q->'price')-'rates' is distinct from (option->'price')-'rates'
      or (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(q#>'{price,rates}')) is distinct from
         (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(option#>'{price,rates}'))
      or child.expires_at is distinct from saved.expires_at or (q->>'expiresAt')::timestamptz is distinct from saved.expires_at
      or (q->>'createdAt')::timestamptz<(p_catalog->>'effectiveAt')::timestamptz
      or (q->>'expiresAt')::timestamptz>(p_catalog->>'expiresAt')::timestamptz
      or (q->>'expiresAt')::timestamptz>(q->>'createdAt')::timestamptz+make_interval(secs=>(p_catalog->>'quoteLifetimeSeconds')::integer)
      or (r->>'textStart')::integer<previous_end or (r->>'textEnd')::integer>length(document.plain_text)
      or bookworm_private.narration_has_source_words(substring(document.plain_text from previous_end+1 for (r->>'textStart')::integer-previous_end)) then
      raise exception 'chapter narration saved segment or approved profile mismatch' using errcode='23514'; end if;
    source_text:=substring(document.plain_text from (r->>'textStart')::integer+1 for (r->>'textEnd')::integer-(r->>'textStart')::integer);
    if not bookworm_private.narration_has_source_words(source_text)
      or octet_length(source_text)+coalesce(octet_length(saved.instructions),0)>1800
      or r->>'textSha256' is distinct from encode(public.digest(convert_to(source_text,'UTF8'),'sha256'),'hex')
      or saved.instructions is distinct from btrim(saved.instructions,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') then
      raise exception 'chapter narration exact text or delivery changed' using errcode='23514'; end if;
    if counter=0 then first_request:=r; first_quote:=q;
    elsif r-array['jobId','segmentIndex','textStart','textEnd','textSha256'] is distinct from
      first_request-array['jobId','segmentIndex','textStart','textEnd','textSha256']
      or q->'price' is distinct from first_quote->'price' or q->'policy' is distinct from first_quote->'policy'
      or q->'createdAt' is distinct from first_quote->'createdAt' or q->'expiresAt' is distinct from first_quote->'expiresAt' then
      raise exception 'chapter narration children must share one delivery and price snapshot' using errcode='23514'; end if;
    total:=total+(q->>'reservedCredits')::numeric; counter:=counter+1; previous_end:=(r->>'textEnd')::integer;
  end loop;
  if counter<>saved.segment_count or total<>saved.reserved_credits or total>2147483647
    or bookworm_private.narration_has_source_words(substring(document.plain_text from previous_end+1)) then
    raise exception 'chapter narration aggregate or complete coverage changed' using errcode='23514'; end if;
  insert into public.audiobook_projects(workspace_id,book_id,edition_id,chapter_id,document_version_id,voice,instructions,speed,
    segment_count,credit_units,idempotency_key,created_by,billing_mode,narration_quote_id)
    values(saved.workspace_id,saved.book_id,saved.edition_id,saved.chapter_id,saved.document_version_id,saved.voice,saved.instructions,saved.speed,
      saved.segment_count,saved.reserved_credits,'narration-chapter-quote:'||saved.id::text,saved.user_id,'quoted',saved.id) returning * into project;
  for child in select c.* from public.narration_chapter_quote_segments l join public.narration_quote_snapshots c on c.id=l.quote_id
    where l.chapter_quote_id=saved.id order by l.segment_index
  loop
    r:=child.request_json;
    insert into public.ai_jobs(id,workspace_id,book_id,created_by,agent_type,billing_mode,status,model,input_ref,idempotency_key)
      values(child.generation_job_id,saved.workspace_id,saved.book_id,saved.user_id,'narrator','quoted','queued',r->>'model',
        jsonb_build_object('audiobookProjectId',project.id,'narrationQuoteId',child.id,'requestSha256',child.request_sha256,'generationRequest',r),
        'narration-quote:'||child.id::text);
    perform public.reserve_funded_usage_quote(child.quote_json);
    insert into public.audiobook_segments(project_id,ai_job_id,segment_index,text_start,text_end,text_sha256,credit_units,billing_mode)
      values(project.id,child.generation_job_id,(r->>'segmentIndex')::integer,(r->>'textStart')::integer,(r->>'textEnd')::integer,
        r->>'textSha256',(child.quote_json->>'reservedCredits')::integer,'quoted');
  end loop;
  insert into public.narration_chapter_quote_acceptances(quote_id,project_id,expected_credits,ai_disclosure_accepted)
    values(saved.id,project.id,p_expected_credits,true);
  return project;
end $$;
revoke all on function public.accept_narration_chapter_quote(uuid,uuid,integer,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.accept_narration_chapter_quote(uuid,uuid,integer,boolean,jsonb) to service_role;

-- No new unquoted creation or claims. Already-running historical jobs retain
-- fenced renew/complete/fail for legitimate saved receipts; quoted jobs never
-- enter any legacy callback, including its succeeded fast path.
do $$
declare signature regprocedure; definition text; original text; replacement text;
begin
  signature:='public.claim_audiobook_job(integer)'::regprocedure;
  definition:=pg_get_functiondef(signature);
  original:='where j.agent_type=''narrator'' and p.status in (''queued'',''running'')';
  replacement:='where j.agent_type=''narrator'' and j.billing_mode=''operational'' and s.billing_mode=''operational'' and p.billing_mode=''operational'' and p.status in (''queued'',''running'')';
  if position(original in definition)=0 then raise exception 'legacy audiobook claim definition changed'; end if;
  execute replace(definition,original,replacement);
  signature:='public.renew_audiobook_lease(uuid,uuid,integer)'::regprocedure;
  definition:=pg_get_functiondef(signature);
  original:='where id=p_job_id and agent_type=''narrator'' and status=''running''';
  replacement:='where id=p_job_id and agent_type=''narrator'' and billing_mode=''operational'' and status=''running''';
  if position(original in definition)=0 then raise exception 'legacy audiobook renewal definition changed'; end if;
  execute replace(definition,original,replacement);
  foreach signature in array array[
    'public.complete_audiobook_segment(uuid,uuid,uuid,text,text,bigint,text,text,text,text,jsonb)'::regprocedure,
    'public.fail_audiobook_job(uuid,uuid,text,text,boolean)'::regprocedure
  ] loop
    definition:=pg_get_functiondef(signature);
    original:='if not found then raise exception ''narration job not found'' using errcode=''P0002''; end if;';
    replacement:=original||E'\n  if v_job.billing_mode<>''operational'' then raise exception ''quoted narration requires funded completion'' using errcode=''23514''; end if;';
    if position(original in definition)=0 then raise exception 'legacy audiobook callback definition changed'; end if;
    execute replace(definition,original,replacement);
  end loop;
end $$;
revoke all on function public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb),public.claim_audiobook_job(integer)
  from public,anon,authenticated,service_role;
comment on function public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb) is
  'RETIRED: new narration requires atomic funded chapter quote acceptance; no execute grants.';
comment on function public.claim_audiobook_job(integer) is
  'RETIRED: do not begin new unquoted narration; quoted worker has a separate funded lifecycle.';
