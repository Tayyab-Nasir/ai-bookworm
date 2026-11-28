create function public.complete_quoted_image_job(p_job_id uuid,p_lease_token uuid,p_settlement jsonb)
returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.ai_jobs; q public.funded_usage_quotes; r public.quoted_image_receipts;
 u jsonb; measured jsonb; tokens jsonb; expected jsonb; part text; item jsonb; asset_id uuid; org uuid; kind text;
begin
 if current_user<>'service_role' and auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
 select * into j from public.ai_jobs where id=p_job_id for update;
 if not found or j.billing_mode<>'quoted' or j.agent_type not in ('illustrator','cover_designer') then
  raise exception 'quoted image job missing' using errcode='22023'; end if;
 select * into q from public.funded_usage_quotes where job_id=j.id for update;
 if j.status='succeeded' then
  if q.status is distinct from 'settled' or q.settlement_json is distinct from p_settlement then
   raise exception 'image completion replay conflict' using errcode='23505'; end if;
  return j;
 end if;
 if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null
  or j.lease_expires_at<=clock_timestamp() then raise exception 'image completion lease lost' using errcode='40001'; end if;
 if q.status is distinct from 'held' or q.dispatched_at is null then raise exception 'image completion requires dispatched hold' using errcode='23514'; end if;
 select * into r from public.quoted_image_receipts where job_id=j.id;
 if not found or r.request_sha256 is distinct from j.input_ref->>'requestSha256'
  or r.request_sha256 is distinct from q.quote_json#>>'{scope,inputSha256}'
  or r.receipt_json->>'model' is distinct from j.model then
  raise exception 'image completion receipt mismatch' using errcode='23514'; end if;
 u:=r.receipt_json->'usage'; measured:=u->'providerTokenUsage';
 if u->>'reconciliationStatus' is distinct from 'supported'
  or jsonb_typeof(measured) is distinct from 'object'
  or jsonb_typeof(measured->'input_tokens_details') is distinct from 'object'
  or jsonb_typeof(measured->'output_tokens_details') is distinct from 'object'
  or exists(select 1 from jsonb_object_keys(measured) k where k not in ('input_tokens','output_tokens','total_tokens','input_tokens_details','output_tokens_details')) then
  raise exception 'image completion requires itemized measurements' using errcode='23514'; end if;
 foreach part in array array['input_tokens','output_tokens','total_tokens'] loop
  if jsonb_typeof(measured->part) is distinct from 'number' or coalesce(measured->>part,'') !~ '^(0|[1-9][0-9]{0,9})$'
   or (measured->>part)::numeric>2147483647 then raise exception 'invalid image aggregate measurement' using errcode='22023'; end if;
 end loop;
 foreach part in array array['input_tokens_details','output_tokens_details'] loop
  if exists(select 1 from jsonb_object_keys(measured->part) k where k not in ('text_tokens','image_tokens'))
   or jsonb_typeof(measured#>array[part,'text_tokens']) is distinct from 'number'
   or jsonb_typeof(measured#>array[part,'image_tokens']) is distinct from 'number'
   or coalesce(measured#>>array[part,'text_tokens'],'') !~ '^(0|[1-9][0-9]{0,9})$'
   or coalesce(measured#>>array[part,'image_tokens'],'') !~ '^(0|[1-9][0-9]{0,9})$' then
   raise exception 'invalid image modality measurement' using errcode='22023'; end if;
 end loop;
 if (measured#>>'{input_tokens_details,text_tokens}')::numeric+(measured#>>'{input_tokens_details,image_tokens}')::numeric<>(measured->>'input_tokens')::numeric
  or (measured#>>'{output_tokens_details,text_tokens}')::numeric+(measured#>>'{output_tokens_details,image_tokens}')::numeric<>(measured->>'output_tokens')::numeric
  or (measured->>'input_tokens')::numeric+(measured->>'output_tokens')::numeric<>(measured->>'total_tokens')::numeric
  or u->>'inputTokens' is distinct from measured->>'input_tokens' or u->>'outputTokens' is distinct from measured->>'output_tokens'
  or coalesce(u->>'latencyMs','') !~ '^(0|[1-9][0-9]{0,9})$' or (u->>'latencyMs')::numeric>2147483647 then
  raise exception 'image measurement totals mismatch' using errcode='23514'; end if;
 tokens:=jsonb_build_array(
  jsonb_build_object('dimension','text_input','tokens',measured#>>'{input_tokens_details,text_tokens}'),
  jsonb_build_object('dimension','image_input','tokens',measured#>>'{input_tokens_details,image_tokens}'),
  jsonb_build_object('dimension','text_output','tokens',measured#>>'{output_tokens_details,text_tokens}'),
  jsonb_build_object('dimension','image_output','tokens',measured#>>'{output_tokens_details,image_tokens}'));
 if jsonb_typeof(p_settlement->'tokens') is distinct from 'array' then raise exception 'image settlement tokens missing' using errcode='22023'; end if;
 if (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(tokens)) is distinct from
    (select jsonb_agg(value order by value->>'dimension') from jsonb_array_elements(p_settlement->'tokens'))
  or p_settlement->>'requestId' is distinct from r.receipt_json->>'requestId' then
  raise exception 'image settlement does not match receipt' using errcode='23514'; end if;
 for item in select value from jsonb_array_elements(tokens) loop
  if not exists(select 1 from jsonb_array_elements(q.quote_json->'maximumTokens') t
   where t->>'dimension'=item->>'dimension' and (t->>'tokens')::numeric>=(item->>'tokens')::numeric) then
   raise exception 'image measured usage exceeds accepted bound' using errcode='23514'; end if;
 end loop;
 expected:=q.quote_json||jsonb_build_object('maximumTokens',tokens,'maximumProviderMicroUsd',p_settlement->>'providerMicroUsd','reservedCredits',p_settlement->>'debitCredits');
 perform public.validate_image_quote_price(expected);
 if not exists(select 1 from public.workspace_members where workspace_id=j.workspace_id and user_id=j.created_by and status='active'
  and role in ('owner','admin','editor','writer','illustrator','designer')) then raise exception 'image completion access changed' using errcode='42501'; end if;
 asset_id:=(r.receipt_json->>'assetId')::uuid;
 kind:=case when j.agent_type='cover_designer' then 'cover' else 'illustration' end;
 select organization_id into org from public.workspaces where id=j.workspace_id;
 perform public.settle_funded_usage_quote(j.id,p_settlement);
 insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
  values(asset_id,j.workspace_id,kind,r.receipt_json->>'name',r.receipt_json->>'storagePath','image/png',
   (r.receipt_json->>'sizeBytes')::bigint,r.receipt_json->>'checksum','draft',j.created_by);
 insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
  values(asset_id,1,r.receipt_json->>'storagePath',r.receipt_json->>'checksum','image/png',(r.receipt_json->>'sizeBytes')::bigint,j.created_by);
 if j.book_id is not null then
  insert into public.asset_links(asset_id,entity_type,entity_id,usage_role)
   values(asset_id,'book',j.book_id,case when kind='cover' then 'front_cover' else 'illustration' end);
 end if;
 insert into public.ai_runs(ai_job_id,workspace_id,provider,model,tokens_in,tokens_out,estimated_cost,latency_ms,status)
  values(j.id,j.workspace_id,'openai',j.model,(measured->>'input_tokens')::integer,(measured->>'output_tokens')::integer,
   (p_settlement->>'providerMicroUsd')::numeric/1000000,(u->>'latencyMs')::integer,'succeeded');
 insert into public.usage_events(ai_job_id,organization_id,user_id,workspace_id,meter,quantity,metadata_json)
  values(j.id,org,j.created_by,j.workspace_id,'token_credits',(p_settlement->>'debitCredits')::numeric,
   jsonb_build_object('assetId',asset_id,'provider','openai','model',j.model,'requestId',r.receipt_json->>'requestId'));
 insert into public.activity_events(workspace_id,actor_id,event_type,entity_type,entity_id,payload_json)
  values(j.workspace_id,j.created_by,'asset_generated','asset',asset_id,jsonb_build_object('aiJobId',j.id,'assetType',kind));
 update public.ai_jobs set status='succeeded',output_ref=jsonb_build_object('assetId',asset_id,'provider','openai'),usage_json=u,
  completed_at=clock_timestamp(),lease_token=null,lease_expires_at=null,error_code=null,error_message=null where id=j.id returning * into j;
 return j;
end $$;
revoke all on function public.complete_quoted_image_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_quoted_image_job(uuid,uuid,jsonb) to service_role;
