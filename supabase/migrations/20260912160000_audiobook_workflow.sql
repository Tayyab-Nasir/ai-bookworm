-- Durable, paid-only audiobook narration. Manuscript text remains in the
-- canonical document version; queued jobs retain only ranges and hashes.
create table public.audiobook_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id),
  voice text not null check (voice in ('alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar')),
  instructions text check (instructions is null or length(instructions) between 1 and 2000),
  speed numeric(4,2) not null default 1 check (speed between 0.25 and 4),
  status public.job_status not null default 'queued',
  segment_count integer not null check (segment_count between 1 and 250),
  credit_units integer not null check (credit_units between 1 and 100000),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table public.audiobook_segments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.audiobook_projects(id) on delete cascade,
  ai_job_id uuid not null unique references public.ai_jobs(id) on delete cascade,
  segment_index integer not null check (segment_index between 0 and 249),
  text_start integer not null check (text_start >= 0),
  text_end integer not null check (text_end > text_start),
  text_sha256 text not null check (text_sha256 ~ '^[a-f0-9]{64}$'),
  credit_units integer not null check (credit_units between 1 and 5),
  asset_id uuid references public.assets(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(project_id,segment_index)
);

create table public.audiobook_completion_receipts (
  ai_job_id uuid primary key references public.ai_jobs(id) on delete cascade,
  completion_json jsonb not null check (
    jsonb_typeof(completion_json)='object' and octet_length(completion_json::text)<=100000
  ),
  created_at timestamptz not null default now()
);

alter table public.audiobook_projects enable row level security;
alter table public.audiobook_segments enable row level security;
alter table public.audiobook_completion_receipts enable row level security;

create policy audiobook_projects_select on public.audiobook_projects
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy audiobook_segments_select on public.audiobook_segments
  for select to authenticated using (exists (
    select 1 from public.audiobook_projects p
    where p.id=project_id and private.is_workspace_member(p.workspace_id)
  ));

revoke all on public.audiobook_projects,public.audiobook_segments,
  public.audiobook_completion_receipts from public,anon,authenticated,service_role;
grant select on public.audiobook_projects,public.audiobook_segments to authenticated;
grant select,insert,update on public.audiobook_projects,public.audiobook_segments to service_role;
grant select,insert on public.audiobook_completion_receipts to service_role;

create index audiobook_projects_edition_created on public.audiobook_projects(edition_id,created_at desc);
create index audiobook_segments_project_index on public.audiobook_segments(project_id,segment_index);
create index ai_jobs_pending_narration on public.ai_jobs(available_at,created_at)
  where agent_type='narrator' and status in ('queued','running');
create unique index usage_events_audio_credits_job_key on public.usage_events(ai_job_id)
  where ai_job_id is not null and meter='audio_credits';

create function public.reserve_audio_job_credit() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text; v_org uuid; v_quota_text text; v_quota numeric:=0;
  v_used numeric; v_pending numeric; v_units integer;
begin
  if new.agent_type<>'narrator' or new.status not in ('queued','running') then return new; end if;
  if tg_op='UPDATE' and old.agent_type='narrator' and old.status in ('queued','running')
    and old.workspace_id=new.workspace_id and old.created_by=new.created_by then return new; end if;
  if jsonb_typeof(new.input_ref->'creditUnits') is distinct from 'number'
    or new.input_ref->>'creditUnits' !~ '^[1-5]$' then
    raise exception 'invalid audio credit reservation' using errcode='22023'; end if;
  v_units := (new.input_ref->>'creditUnits')::integer;
  select role::text into v_role from public.workspace_members
    where workspace_id=new.workspace_id and user_id=new.created_by and status='active' for share;
  if not found or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'audio reservation requires editing access' using errcode='42501'; end if;
  select organization_id into v_org from public.workspaces where id=new.workspace_id;
  perform id from public.organizations where id=v_org for update;
  if not found then raise exception 'audio organization missing' using errcode='22023'; end if;
  select case when p.entitlements_json ? 'audio_credits_monthly'
    then coalesce(p.entitlements_json->>'audio_credits_monthly','0') else null end into v_quota_text
    from public.subscriptions s left join public.plans p on p.id=s.plan_id
    where s.organization_id=v_org and s.status in ('active','trialing')
    order by s.created_at desc limit 1;
  if v_quota_text is not null then
    if v_quota_text !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'invalid audio credit entitlement' using errcode='22023'; end if;
    v_quota:=v_quota_text::numeric;
  end if;
  select coalesce(sum(quantity),0) into v_used from public.usage_events
    where organization_id=v_org and meter='audio_credits'
      and created_at >= (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  select coalesce(sum((j.input_ref->>'creditUnits')::numeric),0) into v_pending
    from public.ai_jobs j join public.workspaces w on w.id=j.workspace_id
    where w.organization_id=v_org and j.agent_type='narrator'
      and j.status in ('queued','running') and j.id<>new.id;
  if v_used+v_pending+v_units>v_quota then
    raise exception 'audio credit capacity exhausted' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.reserve_audio_job_credit() from public,anon,authenticated;
create trigger audio_job_credit_reservation before insert or update of status,agent_type,workspace_id,created_by
  on public.ai_jobs for each row execute function public.reserve_audio_job_credit();

create function public.queue_audiobook_project(
  p_edition_id uuid,p_chapter_id uuid,p_voice text,p_instructions text,p_speed numeric,
  p_idempotency_key text,p_segments jsonb
) returns public.audiobook_projects
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_edition public.editions; v_book public.books;
  v_chapter public.chapters; v_document public.document_versions; v_existing public.audiobook_projects;
  v_project public.audiobook_projects; v_segment jsonb; v_job_id uuid; v_start integer;
  v_end integer; v_index integer; v_units integer; v_total_units integer:=0; v_count integer;
begin
  if v_uid is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_voice not in ('alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar')
    or p_speed is null or p_speed<0.25 or p_speed>4
    or p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200
    or (p_instructions is not null and length(trim(p_instructions)) not between 1 and 2000)
    or jsonb_typeof(p_segments) is distinct from 'array' then
    raise exception 'invalid audiobook request' using errcode='22023'; end if;
  v_count:=jsonb_array_length(p_segments);
  if v_count not between 1 and 250 then raise exception 'invalid audiobook segments' using errcode='22023'; end if;

  select * into v_existing from public.audiobook_projects where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.created_by<>v_uid or v_existing.edition_id<>p_edition_id or v_existing.chapter_id<>p_chapter_id then
      raise exception 'audiobook request key conflict' using errcode='23505'; end if;
    return v_existing;
  end if;

  select * into v_edition from public.editions where id=p_edition_id;
  if not found or v_edition.type<>'audiobook' then raise exception 'audiobook edition not found' using errcode='P0002'; end if;
  select * into strict v_book from public.books where id=v_edition.book_id;
  if not private.can_edit_workspace(v_book.workspace_id) then raise exception 'editing access required' using errcode='42501'; end if;
  select * into v_chapter from public.chapters where id=p_chapter_id and book_id=v_book.id;
  if not found or v_chapter.current_document_version_id is null then raise exception 'chapter source not found' using errcode='P0002'; end if;
  select * into strict v_document from public.document_versions where id=v_chapter.current_document_version_id and chapter_id=v_chapter.id;
  if length(v_document.plain_text) not between 1 and 1000000 then raise exception 'chapter text is unavailable or too large' using errcode='22023'; end if;

  for v_segment in select value from jsonb_array_elements(p_segments) loop
    begin
      v_index:=(v_segment->>'index')::integer; v_start:=(v_segment->>'start')::integer;
      v_end:=(v_segment->>'end')::integer; v_units:=(v_segment->>'creditUnits')::integer;
    exception when others then raise exception 'invalid audiobook segment values' using errcode='22023'; end;
    if jsonb_typeof(v_segment) is distinct from 'object' or v_index<0 or v_index>=v_count
      or v_start<0 or v_end<=v_start or v_end>length(v_document.plain_text) or v_end-v_start>4096
      or v_units<>ceil((v_end-v_start)::numeric/1000)::integer
      or v_segment->>'sha256' !~ '^[a-f0-9]{64}$'
      or v_segment->>'sha256'<>encode(digest(convert_to(substring(v_document.plain_text from v_start+1 for v_end-v_start),'UTF8'),'sha256'),'hex') then
      raise exception 'audiobook segment does not match saved text' using errcode='22023'; end if;
    v_total_units:=v_total_units+v_units;
  end loop;
  if (select count(distinct (value->>'index')::integer) from jsonb_array_elements(p_segments))<>v_count then
    raise exception 'duplicate audiobook segment index' using errcode='22023'; end if;

  insert into public.audiobook_projects(workspace_id,book_id,edition_id,chapter_id,document_version_id,
    voice,instructions,speed,segment_count,credit_units,idempotency_key,created_by)
  values(v_book.workspace_id,v_book.id,v_edition.id,v_chapter.id,v_document.id,p_voice,
    nullif(trim(p_instructions),''),p_speed,v_count,v_total_units,p_idempotency_key,v_uid)
  returning * into v_project;

  for v_segment in select value from jsonb_array_elements(p_segments) order by (value->>'index')::integer loop
    v_index:=(v_segment->>'index')::integer; v_start:=(v_segment->>'start')::integer;
    v_end:=(v_segment->>'end')::integer; v_units:=(v_segment->>'creditUnits')::integer;
    v_job_id:=gen_random_uuid();
    insert into public.ai_jobs(id,workspace_id,book_id,agent_type,status,input_ref,idempotency_key,created_by)
    values(v_job_id,v_book.workspace_id,v_book.id,'narrator','queued',jsonb_build_object(
      'audiobookProjectId',v_project.id,'documentVersionId',v_document.id,'segmentIndex',v_index,
      'textStart',v_start,'textEnd',v_end,'textSha256',v_segment->>'sha256','creditUnits',v_units
    ),'audiobook:'||v_project.id::text||':'||v_index::text,v_uid);
    insert into public.audiobook_segments(project_id,ai_job_id,segment_index,text_start,text_end,text_sha256,credit_units)
    values(v_project.id,v_job_id,v_index,v_start,v_end,v_segment->>'sha256',v_units);
  end loop;
  return v_project;
end $$;

create function public.claim_audiobook_job(p_lease_seconds integer default 600)
returns setof public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_project_id uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  for v_job in select j.* from public.ai_jobs j join public.audiobook_segments s on s.ai_job_id=j.id
    join public.audiobook_projects p on p.id=s.project_id
    where j.agent_type='narrator' and p.status in ('queued','running') and (
      (j.status='queued' and j.available_at<=clock_timestamp()) or
      (j.status='running' and j.lease_expires_at<=clock_timestamp())
    ) order by j.available_at,j.created_at,j.id for update of j skip locked limit 100
  loop
    v_project_id:=v_job.input_ref->>'audiobookProjectId';
    if v_job.attempts>=5 then
      update public.ai_jobs set status='failed',error_code='audio_attempts_exhausted',error_message='Narration attempts exhausted',
        lease_token=null,lease_expires_at=null,completed_at=clock_timestamp() where id=v_job.id;
      update public.audiobook_projects set status='failed',completed_at=clock_timestamp() where id=v_project_id;
      update public.ai_jobs j set status='cancelled',error_code='audio_project_failed',
        error_message='Another narration segment failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp()
        from public.audiobook_segments s where s.ai_job_id=j.id and s.project_id=v_project_id
          and j.id<>v_job.id and j.status in ('queued','running');
      continue;
    end if;
    update public.ai_jobs set status='running',attempts=attempts+1,started_at=coalesce(started_at,clock_timestamp()),
      completed_at=null,error_code=null,error_message=null,lease_token=gen_random_uuid(),
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
      where id=v_job.id returning * into v_job;
    update public.audiobook_projects set status='running',started_at=coalesce(started_at,clock_timestamp()) where id=v_project_id;
    return next v_job; return;
  end loop;
end $$;

create function public.renew_audiobook_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 600)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid lease duration' using errcode='22023'; end if;
  update public.ai_jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and agent_type='narrator' and status='running' and lease_token=p_lease_token
      and lease_expires_at>clock_timestamp();
  return found;
end $$;

create function public.complete_audiobook_segment(
  p_job_id uuid,p_lease_token uuid,p_asset_id uuid,p_storage_path text,p_mime_type text,
  p_size_bytes bigint,p_checksum text,p_provider text,p_model text,p_request_id text,p_usage jsonb
) returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_segment public.audiobook_segments; v_project public.audiobook_projects;
  v_org uuid; v_name text; v_remaining integer;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_asset_id is null or p_mime_type<>'audio/mpeg' or p_size_bytes not between 1 and 52428800
    or p_checksum !~ '^[a-f0-9]{64}$' or length(trim(p_provider)) not between 1 and 100
    or length(trim(p_model)) not between 1 and 200 or jsonb_typeof(p_usage) is distinct from 'object'
    or jsonb_typeof(p_usage->'inputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'outputTokens') is distinct from 'number'
    or jsonb_typeof(p_usage->'estimatedCostUsd') is distinct from 'number'
    or jsonb_typeof(p_usage->'latencyMs') is distinct from 'number'
    or p_usage->>'inputTokens' !~ '^[0-9]+$' or p_usage->>'outputTokens' !~ '^[0-9]+$'
    or p_usage->>'latencyMs' !~ '^[0-9]+$' or (p_usage->>'estimatedCostUsd')::numeric<0 then
    raise exception 'invalid audiobook completion' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'narration job not found' using errcode='P0002'; end if;
  select * into strict v_segment from public.audiobook_segments where ai_job_id=v_job.id;
  select * into strict v_project from public.audiobook_projects where id=v_segment.project_id for update;
  if v_job.status='succeeded' then return v_job; end if;
  if v_job.agent_type<>'narrator' or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'lease lost' using errcode='40001'; end if;
  if p_storage_path<>format('workspaces/%s/audiobooks/%s/%s.mp3',v_job.workspace_id,v_project.id,v_segment.segment_index) then
    raise exception 'invalid audiobook asset path' using errcode='22023'; end if;
  select organization_id into strict v_org from public.workspaces where id=v_job.workspace_id;
  select format('%s - narration part %s',c.title,v_segment.segment_index+1) into v_name
    from public.chapters c where c.id=v_project.chapter_id;

  insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
    values(p_asset_id,v_job.workspace_id,'audiobook_segment',v_name,p_storage_path,p_mime_type,p_size_bytes,p_checksum,'draft',v_job.created_by);
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
    values(p_asset_id,1,p_storage_path,p_checksum,p_mime_type,p_size_bytes,v_job.created_by);
  insert into public.asset_links(asset_id,entity_type,entity_id,usage_role)
    values(p_asset_id,'audiobook_project',v_project.id,'narration_segment');
  insert into public.ai_runs(ai_job_id,workspace_id,provider,model,tokens_in,tokens_out,estimated_cost,latency_ms,status)
    values(v_job.id,v_job.workspace_id,trim(p_provider),trim(p_model),(p_usage->>'inputTokens')::integer,
      (p_usage->>'outputTokens')::integer,(p_usage->>'estimatedCostUsd')::numeric,
      (p_usage->>'latencyMs')::integer,'succeeded');
  insert into public.usage_events(ai_job_id,organization_id,user_id,workspace_id,meter,quantity,metadata_json)
    values(v_job.id,v_org,v_job.created_by,v_job.workspace_id,'audio_credits',v_segment.credit_units,
      jsonb_build_object('audiobookProjectId',v_project.id,'segmentIndex',v_segment.segment_index,
        'assetId',p_asset_id,'provider',trim(p_provider),'model',trim(p_model),'requestId',p_request_id));
  update public.audiobook_segments set asset_id=p_asset_id,completed_at=clock_timestamp() where id=v_segment.id;
  update public.ai_jobs set status='succeeded',output_ref=jsonb_build_object('assetId',p_asset_id,'audiobookProjectId',v_project.id),
    model=trim(p_model),usage_json=p_usage,error_code=null,error_message=null,lease_token=null,lease_expires_at=null,
    completed_at=clock_timestamp() where id=v_job.id returning * into v_job;
  select count(*) into v_remaining from public.audiobook_segments s join public.ai_jobs j on j.id=s.ai_job_id
    where s.project_id=v_project.id and j.status<>'succeeded';
  if v_remaining=0 then update public.audiobook_projects set status='succeeded',completed_at=clock_timestamp() where id=v_project.id; end if;
  insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id,payload_json)
    values(v_job.workspace_id,v_job.created_by,'audiobook_segment_generated','audiobook_project',v_project.id,
      jsonb_build_object('aiJobId',v_job.id,'segmentIndex',v_segment.segment_index));
  return v_job;
end $$;

create function public.fail_audiobook_job(p_job_id uuid,p_lease_token uuid,p_error_code text,p_error_message text,p_retryable boolean)
returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_terminal boolean; v_project_id uuid;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,79}$' or p_error_message is null
    or length(p_error_message)>2000 or p_retryable is null then raise exception 'invalid narration failure' using errcode='22023'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'narration job not found' using errcode='P0002'; end if;
  if v_job.agent_type<>'narrator' or v_job.status<>'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() then
    raise exception 'lease lost' using errcode='40001'; end if;
  v_terminal:=not p_retryable or v_job.attempts>=5; v_project_id:=(v_job.input_ref->>'audiobookProjectId')::uuid;
  update public.ai_jobs set status=(case when v_terminal then 'failed' else 'queued' end)::public.job_status,
    error_code=p_error_code,error_message=p_error_message,lease_token=null,lease_expires_at=null,
    available_at=clock_timestamp()+make_interval(secs=>(5*power(2,v_job.attempts-1))::integer),
    completed_at=case when v_terminal then clock_timestamp() else null end where id=v_job.id returning * into v_job;
  if v_terminal then
    update public.audiobook_projects set status='failed',completed_at=clock_timestamp() where id=v_project_id;
    update public.ai_jobs j set status='cancelled',error_code='audio_project_failed',
      error_message='Another narration segment failed',lease_token=null,lease_expires_at=null,completed_at=clock_timestamp()
      from public.audiobook_segments s where s.ai_job_id=j.id and s.project_id=v_project_id
        and j.id<>v_job.id and j.status in ('queued','running');
  end if;
  return v_job;
end $$;

revoke all on function public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb) from public,anon;
grant execute on function public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb) to authenticated;
revoke all on function public.claim_audiobook_job(integer),public.renew_audiobook_lease(uuid,uuid,integer),
  public.complete_audiobook_segment(uuid,uuid,uuid,text,text,bigint,text,text,text,text,jsonb),
  public.fail_audiobook_job(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_audiobook_job(integer),public.renew_audiobook_lease(uuid,uuid,integer),
  public.complete_audiobook_segment(uuid,uuid,uuid,text,text,bigint,text,text,text,text,jsonb),
  public.fail_audiobook_job(uuid,uuid,text,text,boolean) to service_role;
