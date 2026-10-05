-- Recoverable encoding and atomic receipt-derived billing. No purchase activation.
create table public.quoted_narration_encodings (
  job_id uuid primary key references public.quoted_narration_receipts(job_id) on delete restrict,
  pcm_receipt_sha256 text not null check(pcm_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_sha256 text not null check(receipt_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_json jsonb not null check(jsonb_typeof(receipt_json)='object' and octet_length(receipt_json::text)<=4096),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.quoted_narration_encodings enable row level security;
revoke all on public.quoted_narration_encodings from public,anon,authenticated,service_role;
grant select on public.quoted_narration_encodings to service_role;
create trigger narration_encoding_immutable before update on public.quoted_narration_encodings
  for each row execute function public.guard_narration_quote_snapshot();

create function bookworm_private.normalized_narration_text(value text) returns text
language sql immutable set search_path=public,pg_temp as $$
  -- Exact ECMAScript whitespace, including NBSP, narrow NBSP and BOM; NFC
  -- matches the production reconciler. Never normalize the source identity hash.
  select btrim(regexp_replace(normalize(value,NFC),
    U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'),' ')
$$;
revoke all on function bookworm_private.normalized_narration_text(text) from public,anon,authenticated,service_role;

create function bookworm_private.narration_receipt_settlement(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; s public.narration_quote_snapshots;
  r public.quoted_narration_receipts; u jsonb; input jsonb; output jsonb; cached jsonb;
  field text; tokens jsonb; part jsonb; rate jsonb; source text; numerator numeric:=0; credits numeric;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service narration measurement required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id;
  select * into f from public.funded_usage_quotes where job_id=p_job_id;
  select * into s from public.narration_quote_snapshots where generation_job_id=p_job_id;
  select * into r from public.quoted_narration_receipts where job_id=p_job_id;
  if j.id is null or j.billing_mode is distinct from 'quoted' or j.agent_type is distinct from 'narrator'
    or f.dispatched_at is null or s.id is null or r.job_id is null
    or s.quote_json is distinct from f.quote_json or s.request_json is distinct from j.input_ref->'generationRequest'
    or s.request_sha256 is distinct from r.request_sha256 or s.request_sha256 is distinct from j.input_ref->>'requestSha256'
    or f.user_id is distinct from j.created_by or f.workspace_id is distinct from j.workspace_id
    or s.user_id is distinct from j.created_by or s.workspace_id is distinct from j.workspace_id
    or r.receipt_json->>'model' is distinct from j.model
    or r.receipt_json->>'sourceSha256' is distinct from s.request_json->>'textSha256'
    or r.receipt_sha256 is distinct from encode(public.digest(convert_to(r.receipt_json::text,'UTF8'),'sha256'),'hex') then
    raise exception 'narration original receipt identity mismatch' using errcode='23514'; end if;
  perform public.validate_narration_quote(s.request_json,f.quote_json);
  select substring(d.plain_text from (s.request_json->>'textStart')::integer+1
    for (s.request_json->>'textEnd')::integer-(s.request_json->>'textStart')::integer)
    into source from public.document_versions d where d.id=s.document_version_id and d.chapter_id=s.chapter_id;
  if source is null or s.request_json->>'textSha256' is distinct from encode(public.digest(convert_to(source,'UTF8'),'sha256'),'hex')
    or bookworm_private.normalized_narration_text(source) is distinct from
      bookworm_private.normalized_narration_text(r.receipt_json->>'transcript') then
    raise exception 'narration transcript mismatch' using errcode='23514'; end if;
  u:=r.receipt_json->'rawUsage';
  if jsonb_typeof(u) is distinct from 'object' or octet_length(u::text)>16384
    or not(u ?& array['input_tokens','output_tokens','total_tokens','input_token_details','output_token_details'])
    or u-array['input_tokens','output_tokens','total_tokens','input_token_details','output_token_details']<>'{}'::jsonb
    or jsonb_typeof(u->'input_token_details') is distinct from 'object'
    or jsonb_typeof(u->'output_token_details') is distinct from 'object' then
    raise exception 'narration requires itemized usage' using errcode='23514'; end if;
  input:=u->'input_token_details'; output:=u->'output_token_details'; cached:=input->'cached_tokens_details';
  if not(input ?& array['text_tokens','audio_tokens','cached_tokens'])
    or input-array['text_tokens','audio_tokens','image_tokens','cached_tokens','cached_tokens_details']<>'{}'::jsonb
    or not(output ?& array['text_tokens','audio_tokens']) or output-array['text_tokens','audio_tokens']<>'{}'::jsonb then
    raise exception 'narration requires itemized usage' using errcode='23514'; end if;
  foreach field in array array['input_tokens','output_tokens','total_tokens'] loop
    if jsonb_typeof(u->field) is distinct from 'number' or coalesce(u->>field,'') !~ '^(0|[1-9][0-9]{0,5})$' then
      raise exception 'invalid narration measurement' using errcode='23514'; end if;
  end loop;
  foreach field in array array['text_tokens','audio_tokens','cached_tokens'] loop
    if jsonb_typeof(input->field) is distinct from 'number' or coalesce(input->>field,'') !~ '^(0|[1-9][0-9]{0,5})$' then
      raise exception 'invalid narration measurement' using errcode='23514'; end if;
  end loop;
  foreach field in array array['text_tokens','audio_tokens'] loop
    if jsonb_typeof(output->field) is distinct from 'number' or coalesce(output->>field,'') !~ '^(0|[1-9][0-9]{0,5})$' then
      raise exception 'invalid narration measurement' using errcode='23514'; end if;
  end loop;
  if input ? 'image_tokens' and (jsonb_typeof(input->'image_tokens') is distinct from 'number' or input->'image_tokens'<>'0'::jsonb) then
    raise exception 'invalid narration input modality' using errcode='23514'; end if;
  if cached is not null then
    if jsonb_typeof(cached) is distinct from 'object' or not(cached ?& array['text_tokens','audio_tokens'])
      or cached-array['text_tokens','audio_tokens','image_tokens']<>'{}'::jsonb
      or jsonb_typeof(cached->'text_tokens') is distinct from 'number' or cached->'text_tokens' is distinct from input->'cached_tokens'
      or cached->'audio_tokens' is distinct from '0'::jsonb
      or (cached ? 'image_tokens' and cached->'image_tokens' is distinct from '0'::jsonb) then
      raise exception 'invalid narration cached modality' using errcode='23514'; end if;
  elsif (input->>'cached_tokens')::numeric>0 then
    raise exception 'narration cached detail missing' using errcode='23514'; end if;
  if (u->>'input_tokens')::numeric>128000 or (u->>'output_tokens')::numeric>(s.request_json->>'maxOutputTokens')::integer
    or (u->>'total_tokens')::numeric>132096 or input->'audio_tokens'<>'0'::jsonb
    or (input->>'text_tokens')::numeric<1 or (output->>'audio_tokens')::numeric<1
    or (input->>'cached_tokens')::numeric>(input->>'text_tokens')::numeric
    or (u->>'input_tokens')::numeric<>(input->>'text_tokens')::numeric
    or (u->>'output_tokens')::numeric<>(output->>'text_tokens')::numeric+(output->>'audio_tokens')::numeric
    or (u->>'total_tokens')::numeric<>(u->>'input_tokens')::numeric+(u->>'output_tokens')::numeric then
    raise exception 'narration measurement totals or bound mismatch' using errcode='23514'; end if;
  tokens:=jsonb_build_array(
    jsonb_build_object('dimension','audio_output','tokens',output->>'audio_tokens'),
    jsonb_build_object('dimension','text_cached_input','tokens',input->>'cached_tokens'),
    jsonb_build_object('dimension','text_input','tokens',((input->>'text_tokens')::integer-(input->>'cached_tokens')::integer)::text),
    jsonb_build_object('dimension','text_output','tokens',output->>'text_tokens'));
  for part in select value from jsonb_array_elements(tokens) loop
    select value into strict rate from jsonb_array_elements(f.quote_json#>'{price,rates}') where value->>'dimension'=part->>'dimension';
    numerator:=numerator+(rate->>'microUsdPerMillionTokens')::numeric*(part->>'tokens')::numeric;
  end loop;
  -- Round only the final credit amount, not the fractional provider microdollars.
  credits:=greatest((f.quote_json#>>'{policy,minimumCredits}')::numeric,
    ceil((numerator+(f.quote_json#>>'{policy,platformMicroUsd}')::numeric*1000000)
      *(f.quote_json#>>'{policy,markupBasisPoints}')::numeric
      /(1000000::numeric*10000*(f.quote_json#>>'{policy,microUsdPerCredit}')::numeric)));
  if credits>f.reserved_credits then raise exception 'narration measured usage exceeds quote' using errcode='23514'; end if;
  return jsonb_build_object('status','settle','requestId',r.receipt_json->>'requestId','fingerprint',f.quote_json->>'fingerprint',
    'priceVersion',f.quote_json#>>'{price,version}','policyVersion',f.quote_json#>>'{policy,version}',
    'providerMicroUsd',ceil(numerator/1000000)::text,'debitCredits',credits::text,
    'releaseCredits',(f.reserved_credits-credits)::text,'tokens',tokens);
end $$;
revoke all on function bookworm_private.narration_receipt_settlement(uuid) from public,anon,authenticated;
grant execute on function bookworm_private.narration_receipt_settlement(uuid) to service_role;

create function public.save_quoted_narration_encoding(p_job_id uuid,p_lease_token uuid,p_pcm_receipt_sha256 text,p_receipt jsonb)
returns public.quoted_narration_encodings language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.ai_jobs; pcm public.quoted_narration_receipts; saved public.quoted_narration_encodings;
  segment public.audiobook_segments; field text;
begin
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.agent_type<>'narrator' or j.billing_mode<>'quoted' or j.status<>'running'
    or p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null
    or j.lease_expires_at<=clock_timestamp() then raise exception 'narration encoding lease lost' using errcode='40001'; end if;
  perform bookworm_private.validate_funded_narration_job(j.id,false);
  select * into pcm from public.quoted_narration_receipts where job_id=j.id;
  if not found or pcm.receipt_sha256 is distinct from p_pcm_receipt_sha256
    or pcm.request_sha256 is distinct from j.input_ref->>'requestSha256' then
    raise exception 'narration encoding original receipt mismatch' using errcode='23514'; end if;
  select * into strict segment from public.audiobook_segments where ai_job_id=j.id;
  if jsonb_typeof(p_receipt) is distinct from 'object' or octet_length(p_receipt::text)>4096
    or not(p_receipt ?& array['version','pcmReceiptSha256','assetId','storagePath','mimeType','sizeBytes','checksum',
      'durationSeconds','encodingVersion','sampleRateHz','channels','bitRateKbps','bitRateMode'])
    or p_receipt-array['version','pcmReceiptSha256','assetId','storagePath','mimeType','sizeBytes','checksum',
      'durationSeconds','encodingVersion','sampleRateHz','channels','bitRateKbps','bitRateMode']<>'{}'::jsonb then
    raise exception 'invalid narration encoding shape' using errcode='22023'; end if;
  foreach field in array array['version','pcmReceiptSha256','assetId','storagePath','mimeType','checksum','encodingVersion','bitRateMode'] loop
    if jsonb_typeof(p_receipt->field) is distinct from 'string' then raise exception 'invalid narration encoding scalar' using errcode='22023'; end if;
  end loop;
  foreach field in array array['sizeBytes','durationSeconds','sampleRateHz','channels','bitRateKbps'] loop
    if jsonb_typeof(p_receipt->field) is distinct from 'number' then raise exception 'invalid narration encoding scalar' using errcode='22023'; end if;
  end loop;
  if p_receipt->>'version' is distinct from 'bookworm-narration-mp3-v1'
    or p_receipt->>'pcmReceiptSha256' is distinct from pcm.receipt_sha256 or p_receipt->>'assetId' is distinct from j.id::text
    or p_receipt->>'storagePath' is distinct from format('workspaces/%s/audiobooks/%s/%s.mp3',j.workspace_id,segment.project_id,segment.segment_index)
    or p_receipt->>'mimeType' is distinct from 'audio/mpeg' or p_receipt->>'encodingVersion' is distinct from 'narration-mp3-1.0.0'
    or p_receipt->>'checksum' !~ '^[a-f0-9]{64}$' or p_receipt->>'sizeBytes' !~ '^[1-9][0-9]{0,7}$'
    or (p_receipt->>'sizeBytes')::numeric>8388608 or (p_receipt->>'durationSeconds')::numeric<=0
    or abs((p_receipt->>'durationSeconds')::numeric-(pcm.receipt_json->>'durationSeconds')::numeric)>0.25
    or p_receipt->'sampleRateHz' is distinct from '44100'::jsonb or p_receipt->'channels' is distinct from '1'::jsonb
    or p_receipt->'bitRateKbps' is distinct from '192'::jsonb or p_receipt->>'bitRateMode' is distinct from 'cbr' then
    raise exception 'invalid bound narration encoding' using errcode='22023'; end if;
  select * into saved from public.quoted_narration_encodings where job_id=j.id;
  if found then
    if saved.pcm_receipt_sha256 is distinct from p_pcm_receipt_sha256 or saved.receipt_json is distinct from p_receipt then
      raise exception 'narration encoding receipt conflict' using errcode='23505'; end if;
    return saved;
  end if;
  insert into public.quoted_narration_encodings(job_id,pcm_receipt_sha256,receipt_sha256,receipt_json)
    values(j.id,pcm.receipt_sha256,encode(public.digest(convert_to(p_receipt::text,'UTF8'),'sha256'),'hex'),p_receipt) returning * into saved;
  return saved;
end $$;
revoke all on function public.save_quoted_narration_encoding(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_quoted_narration_encoding(uuid,uuid,text,jsonb) to service_role;

-- Prevent stale workers from settling through the generic RPC or direct table
-- updates before the same transaction records the validated output and usage.
create function bookworm_private.guard_narration_measured_settlement() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.ai_jobs; segment public.audiobook_segments; r public.quoted_narration_encodings; expected jsonb;
begin
  if new.status<>'settled' then return new; end if;
  select * into j from public.ai_jobs where id=new.job_id;
  if j.billing_mode<>'quoted' or j.agent_type<>'narrator' then return new; end if;
  select * into segment from public.audiobook_segments where ai_job_id=j.id;
  select * into r from public.quoted_narration_encodings where job_id=j.id;
  if j.status<>'succeeded' or r.job_id is null or segment.asset_id is distinct from j.id
    or j.output_ref is distinct from jsonb_build_object('assetId',j.id,'audiobookProjectId',segment.project_id,'provider','openai') then
    raise exception 'narration settlement requires atomic completed output' using errcode='23514'; end if;
  expected:=bookworm_private.narration_receipt_settlement(j.id);
  if new.settlement_json is distinct from expected
    or not exists(select 1 from public.assets a join public.asset_versions v on v.asset_id=a.id and v.version_number=1
      where a.id=j.id and a.workspace_id=j.workspace_id and a.type='audiobook_segment' and a.created_by=j.created_by
      and a.mime_type='audio/mpeg' and a.storage_path=r.receipt_json->>'storagePath' and a.checksum=r.receipt_json->>'checksum'
      and a.size_bytes=(r.receipt_json->>'sizeBytes')::bigint and v.storage_path=a.storage_path and v.checksum=a.checksum
      and v.size_bytes=a.size_bytes and v.mime_type=a.mime_type and v.scan_status='trusted_generated')
    or (select count(*) from public.ai_runs where ai_job_id=j.id)<>1
    or not exists(select 1 from public.ai_runs where ai_job_id=j.id and workspace_id=j.workspace_id and provider='openai' and model=j.model
      and tokens_in=(j.usage_json->>'inputTokens')::integer and tokens_out=(j.usage_json->>'outputTokens')::integer
      and estimated_cost=(expected->>'providerMicroUsd')::numeric/1000000 and status='succeeded')
    or (select count(*) from public.usage_events where ai_job_id=j.id)<>1
    or not exists(select 1 from public.usage_events where ai_job_id=j.id and user_id=j.created_by and workspace_id=j.workspace_id
      and meter='token_credits' and quantity=(expected->>'debitCredits')::numeric) then
    raise exception 'narration measured settlement or output mismatch' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function bookworm_private.guard_narration_measured_settlement() from public,anon,authenticated,service_role;
create trigger zz_narration_measured_settlement before update on public.funded_usage_quotes
  for each row execute function bookworm_private.guard_narration_measured_settlement();

create function public.complete_quoted_narration_job(p_job_id uuid,p_lease_token uuid) returns public.ai_jobs
language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; f public.funded_usage_quotes; p public.audiobook_projects; segment public.audiobook_segments;
  pcm public.quoted_narration_receipts; encoded public.quoted_narration_encodings; settlement jsonb; usage jsonb; org uuid; name text;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if not found or j.agent_type<>'narrator' or j.billing_mode<>'quoted' then raise exception 'quoted narration job missing' using errcode='22023'; end if;
  select * into f from public.funded_usage_quotes where job_id=j.id for update;
  if j.status='succeeded' then
    if f.status is distinct from 'settled' or f.settlement_json is distinct from bookworm_private.narration_receipt_settlement(j.id) then
      raise exception 'narration completion replay conflict' using errcode='23505'; end if;
    return j;
  end if;
  if j.status<>'running' or p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null
    or j.lease_expires_at<=clock_timestamp() then raise exception 'narration completion lease lost' using errcode='40001'; end if;
  select * into strict segment from public.audiobook_segments where ai_job_id=j.id;
  select * into strict p from public.audiobook_projects where id=segment.project_id for update;
  perform bookworm_private.validate_funded_narration_job(j.id,false);
  select * into pcm from public.quoted_narration_receipts where job_id=j.id;
  select * into encoded from public.quoted_narration_encodings where job_id=j.id;
  if pcm.job_id is null or encoded.job_id is null or encoded.pcm_receipt_sha256 is distinct from pcm.receipt_sha256
    or encoded.receipt_json->>'pcmReceiptSha256' is distinct from pcm.receipt_sha256
    or encoded.receipt_sha256 is distinct from encode(public.digest(convert_to(encoded.receipt_json::text,'UTF8'),'sha256'),'hex') then
    raise exception 'narration completion encoded receipt missing or mismatched' using errcode='23514'; end if;
  settlement:=bookworm_private.narration_receipt_settlement(j.id);
  usage:=jsonb_build_object('inputTokens',pcm.receipt_json#>'{rawUsage,input_tokens}','outputTokens',pcm.receipt_json#>'{rawUsage,output_tokens}',
    'estimatedCostUsd',(settlement->>'providerMicroUsd')::numeric/1000000,'latencyMs',pcm.receipt_json->'latencyMs','measurement','measured');
  select organization_id into strict org from public.workspaces where id=j.workspace_id;
  select format('%s - narration part %s',title,segment.segment_index+1) into name from public.chapters where id=p.chapter_id;
  insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
    values(j.id,j.workspace_id,'audiobook_segment',name,encoded.receipt_json->>'storagePath','audio/mpeg',
      (encoded.receipt_json->>'sizeBytes')::bigint,encoded.receipt_json->>'checksum','draft',j.created_by);
  insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
    values(j.id,1,encoded.receipt_json->>'storagePath',encoded.receipt_json->>'checksum','audio/mpeg',(encoded.receipt_json->>'sizeBytes')::bigint,j.created_by);
  insert into public.asset_links(asset_id,entity_type,entity_id,usage_role) values(j.id,'audiobook_project',p.id,'narration_segment');
  insert into public.ai_runs(ai_job_id,workspace_id,provider,model,tokens_in,tokens_out,estimated_cost,latency_ms,status)
    values(j.id,j.workspace_id,'openai',j.model,(usage->>'inputTokens')::integer,(usage->>'outputTokens')::integer,
      (usage->>'estimatedCostUsd')::numeric,(usage->>'latencyMs')::integer,'succeeded');
  insert into public.usage_events(ai_job_id,organization_id,user_id,workspace_id,meter,quantity,metadata_json)
    values(j.id,org,j.created_by,j.workspace_id,'token_credits',(settlement->>'debitCredits')::numeric,
      jsonb_build_object('audiobookProjectId',p.id,'segmentIndex',segment.segment_index,'assetId',j.id,'provider','openai','model',j.model,
        'requestId',pcm.receipt_json->>'requestId'));
  update public.audiobook_segments set asset_id=j.id,completed_at=clock_timestamp() where id=segment.id;
  update public.ai_jobs set status='succeeded',output_ref=jsonb_build_object('assetId',j.id,'audiobookProjectId',p.id,'provider','openai'),
    usage_json=usage,error_code=null,error_message=null,lease_token=null,lease_expires_at=null,completed_at=clock_timestamp()
    where id=j.id returning * into j;
  perform public.settle_funded_usage_quote(j.id,settlement);
  -- Previously failed chapters remain failed even when already dispatched
  -- siblings finish recovering their paid original output.
  if p.status in ('queued','running') and not exists(select 1 from public.audiobook_segments s join public.ai_jobs x on x.id=s.ai_job_id
    where s.project_id=p.id and x.status<>'succeeded') then
    update public.audiobook_projects set status='succeeded',completed_at=clock_timestamp() where id=p.id;
  end if;
  insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id,payload_json)
    values(j.workspace_id,j.created_by,'audiobook_segment_generated','audiobook_project',p.id,jsonb_build_object('aiJobId',j.id,'segmentIndex',segment.segment_index));
  return j;
end $$;
revoke all on function public.complete_quoted_narration_job(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_quoted_narration_job(uuid,uuid) to service_role;

-- Keep generic narration settlement on job -> hold order as well. Checked
-- replacement preserves other media and aborts on an unexpected definition.
do $$ declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('public.settle_funded_usage_quote(uuid,jsonb)'::regprocedure);
  anchor:='select * into v_quote from public.funded_usage_quotes where job_id=p_job_id for update;';
  if position(anchor in definition)=0 then raise exception 'funded settlement definition changed'; end if;
  execute replace(definition,anchor,
    'if exists(select 1 from public.ai_jobs where id=p_job_id and billing_mode=''quoted'' and agent_type=''narrator'') then'
    ||E'\n    perform id from public.ai_jobs where id=p_job_id for update;\n  end if;\n  '||anchor);
end $$;

comment on table public.quoted_narration_encodings is
  'Private recoverable encoding metadata; real PCM/MP3 bytes, hashes and native conversion must be verified by the current fenced worker before completion.';
