do $$
declare v_definition text; v_anchor text:='  select organization_id into strict v_org from public.workspaces where id = v_job.workspace_id;';
begin
  select pg_get_functiondef('public.complete_translation_chapter(uuid,uuid,text,text,text,text,jsonb)'::regprocedure) into v_definition;
  if position(v_anchor in v_definition)=0 or position('  update public.translation_chapters set translated_text' in v_definition)=0 then
    raise exception 'unexpected translation completion definition'; end if;
  v_definition:=replace(v_definition,v_anchor,$fragment$
  if v_job.billing_mode='quoted' and not exists(select 1 from public.funded_usage_quotes q
    where q.job_id=v_job.id and q.status='settled' and q.dispatched_at is not null
      and q.quote_json#>>'{price,model}'=p_model and q.quote_json#>>'{price,provider}'=p_provider
      and q.settlement_json->>'requestId'=p_request_id) then
    raise exception 'quoted translation requires matching settlement' using errcode='23514'; end if;
$fragment$||v_anchor);
  v_definition:=replace(v_definition,'  insert into public.usage_events(ai_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json)',
    '  if v_job.billing_mode=''operational'' then insert into public.usage_events(ai_job_id, organization_id, user_id, workspace_id, meter, quantity, metadata_json)');
  v_definition:=replace(v_definition,'  update public.translation_chapters set translated_text',
    '  end if; update public.translation_chapters set translated_text');
  execute v_definition;
end $$;

create function public.complete_quoted_translation(
  p_job_id uuid,p_lease_token uuid,p_translated_text text,p_provider text,p_model text,
  p_request_id text,p_usage jsonb,p_settlement jsonb
) returns public.ai_jobs language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_job public.ai_jobs; v_receipt jsonb;
begin
  if current_user<>'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found or v_job.billing_mode<>'quoted' then raise exception 'quoted translation missing' using errcode='22023'; end if;
  if v_job.status<>'succeeded' and (v_job.status<>'running' or p_lease_token is null
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=clock_timestamp()
    or v_job.lease_expires_at is null) then raise exception 'lease lost' using errcode='40001'; end if;
  select completion_json into v_receipt from public.translation_completion_receipts where ai_job_id=p_job_id;
  if v_receipt is distinct from jsonb_build_object('p_job_id',p_job_id,'p_translated_text',p_translated_text,
    'p_provider',p_provider,'p_model',p_model,'p_request_id',p_request_id,'p_usage',p_usage)
    or p_settlement->>'status' is distinct from 'settle'
    or p_settlement->>'requestId' is distinct from p_request_id then
    raise exception 'quoted completion receipt mismatch' using errcode='22023'; end if;
  perform public.settle_funded_usage_quote(p_job_id,p_settlement);
  return public.complete_translation_chapter(p_job_id,p_lease_token,p_translated_text,p_provider,p_model,p_request_id,p_usage);
end $$;
revoke all on function public.complete_quoted_translation(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_quoted_translation(uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;
