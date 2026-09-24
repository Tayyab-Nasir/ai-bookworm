-- Paid extraction stores review-only candidates and usage atomically.
-- Canonical book_bible_items are written only by an explicit author save.
create unique index book_bible_ai_one_active_author_book
  on public.ai_jobs(book_id, created_by)
  where agent_type = 'bookbible' and status in ('queued','running');

create function public.complete_book_bible_ai_job(
  p_job_id uuid,
  p_provider text,
  p_model text,
  p_usage jsonb,
  p_diagnostics jsonb,
  p_candidates jsonb,
  p_credit_quantity numeric
) returns public.ai_jobs
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_job public.ai_jobs;
  v_organization_id uuid;
  v_candidate jsonb;
  v_source jsonb;
  v_item jsonb;
  v_attrs jsonb;
  v_node jsonb;
  v_content jsonb;
  v_hash text;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  if p_job_id is null or coalesce(length(trim(p_provider)),0) not between 1 and 200
     or coalesce(length(trim(p_model)),0) not between 1 and 200
     or jsonb_typeof(p_usage) is distinct from 'object'
     or jsonb_typeof(p_diagnostics) is distinct from 'array'
     or jsonb_array_length(p_diagnostics)>500 or octet_length(p_diagnostics::text)>2000000
     or jsonb_typeof(p_candidates) is distinct from 'array'
     or jsonb_array_length(p_candidates)>10 or octet_length(p_candidates::text)>1000000
     or p_credit_quantity is null or p_credit_quantity::text='NaN'
     or not ((p_provider='mock' and p_credit_quantity=0)
          or (p_provider<>'mock' and p_credit_quantity=1)) then
    raise exception 'invalid Book Bible completion' using errcode='22023';
  end if;
  if jsonb_typeof(p_usage->'inputTokens') is distinct from 'number'
     or jsonb_typeof(p_usage->'outputTokens') is distinct from 'number'
     or jsonb_typeof(p_usage->'estimatedCostUsd') is distinct from 'number'
     or p_usage->>'inputTokens' !~ '^[0-9]+$'
     or p_usage->>'outputTokens' !~ '^[0-9]+$'
     or (p_usage->>'inputTokens')::numeric>2147483647
     or (p_usage->>'outputTokens')::numeric>2147483647
     or (p_usage->>'estimatedCostUsd')::numeric<0
     or (p_usage ? 'latencyMs' and (
       jsonb_typeof(p_usage->'latencyMs') is distinct from 'number'
       or p_usage->>'latencyMs' !~ '^[0-9]+$'
       or (p_usage->>'latencyMs')::numeric>2147483647)) then
    raise exception 'invalid Book Bible usage' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_diagnostics) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or coalesce(length(trim(v_item->>'severity')),0)=0
       or coalesce(length(trim(v_item->>'code')),0)=0
       or coalesce(length(trim(v_item->>'message')),0)=0
       or jsonb_typeof(v_item->'location') is distinct from 'object' then
      raise exception 'invalid Book Bible diagnostic' using errcode='22023';
    end if;
  end loop;
  select * into v_job from public.ai_jobs where id=p_job_id for update;
  if not found then raise exception 'AI job not found' using errcode='P0002'; end if;
  if v_job.status='succeeded' then return v_job; end if;
  if v_job.status not in ('queued','running') or v_job.agent_type is distinct from 'bookbible'
     or v_job.book_id is null
     or jsonb_typeof(v_job.input_ref->'contextSources') is distinct from 'array' then
    raise exception 'job cannot accept Book Bible candidates' using errcode='55000';
  end if;
  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    v_attrs := v_candidate->'attributes';
    if jsonb_typeof(v_candidate) is distinct from 'object'
       or not (v_candidate ?& array['suggestionKind','status','type','name','description','attributes','sourceRefs','confidence'])
       or v_candidate - array['suggestionKind','status','type','name','description','attributes','sourceRefs','confidence'] <> '{}'::jsonb
       or v_candidate->>'suggestionKind' is distinct from 'book_bible_candidate'
       or v_candidate->>'status' is distinct from 'pending'
       or v_candidate->>'type' not in ('character','place','organization','object','event','term')
       or jsonb_typeof(v_candidate->'name') is distinct from 'string'
       or coalesce(length(v_candidate->>'name'),0) not between 1 and 160
       or v_candidate->>'name' <> trim(v_candidate->>'name')
       or jsonb_typeof(v_candidate->'description') is distinct from 'string'
       or length(v_candidate->>'description')>12000
       or v_candidate->>'description' <> trim(v_candidate->>'description')
       or jsonb_typeof(v_attrs) is distinct from 'object'
       or octet_length(v_attrs::text)>24000
       or jsonb_typeof(v_candidate->'confidence') is distinct from 'number'
       or (v_candidate->>'confidence')::numeric not between 0 and 1
       or jsonb_typeof(v_candidate->'sourceRefs') is distinct from 'array'
       or jsonb_array_length(v_candidate->'sourceRefs') not between 1 and 30 then
      raise exception 'invalid Book Bible candidate' using errcode='22023';
    end if;
    if (select count(*) from jsonb_object_keys(v_attrs))>40
       or exists (select 1 from jsonb_object_keys(v_attrs) key
                  where length(key) not between 1 and 80)
       or v_attrs ?| array['imageAssetIds','__proto__','constructor','prototype'] then
      raise exception 'invalid Book Bible attributes' using errcode='22023';
    end if;
    for v_source in select value from jsonb_array_elements(v_candidate->'sourceRefs') loop
      if jsonb_typeof(v_source) is distinct from 'object'
         or not (v_source ?& array['chapterId','documentVersionId','nodeId','textHash'])
         or v_source - array['chapterId','documentVersionId','nodeId','textHash'] <> '{}'::jsonb
         or v_source->>'chapterId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or v_source->>'documentVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or coalesce(length(v_source->>'nodeId'),0) not between 1 and 200
         or v_source->>'textHash' !~ '^[a-f0-9]{64}$'
         or not exists (select 1 from jsonb_array_elements(v_job.input_ref->'contextSources') trusted
                        where trusted.value=v_source) then
        raise exception 'Book Bible citation outside trusted job sources' using errcode='42501';
      end if;
      select d.content_json into v_content from public.chapters c
        join public.document_versions d on d.id=(v_source->>'documentVersionId')::uuid
        where c.id=(v_source->>'chapterId')::uuid and c.book_id=v_job.book_id and d.chapter_id=c.id;
      if not found or jsonb_typeof(v_content->'nodes') is distinct from 'array' then
        raise exception 'Book Bible source version is unavailable' using errcode='42501';
      end if;
      select node.value into v_node from jsonb_array_elements(v_content->'nodes') node(value)
        where node.value->>'id'=v_source->>'nodeId' limit 1;
      if not found or jsonb_typeof(v_node->'text') is distinct from 'string' then
        raise exception 'Book Bible source node is unavailable' using errcode='42501';
      end if;
      v_hash := encode(public.digest(v_node->>'text','sha256'),'hex');
      if v_hash is distinct from v_source->>'textHash' then
        raise exception 'Book Bible citation does not match saved manuscript' using errcode='42501';
      end if;
    end loop;
  end loop;
  select organization_id into v_organization_id from public.workspaces where id=v_job.workspace_id;
  if v_organization_id is null then raise exception 'AI job workspace missing' using errcode='P0002'; end if;
  insert into public.ai_runs(ai_job_id,workspace_id,provider,model,tokens_in,tokens_out,estimated_cost,latency_ms,status)
  values (v_job.id,v_job.workspace_id,trim(p_provider),trim(p_model),
          (p_usage->>'inputTokens')::integer,(p_usage->>'outputTokens')::integer,
          (p_usage->>'estimatedCostUsd')::numeric,
          case when p_usage ? 'latencyMs' then (p_usage->>'latencyMs')::integer end,'succeeded');
  insert into public.usage_events(ai_job_id,organization_id,user_id,workspace_id,meter,quantity,metadata_json)
  values (v_job.id,v_organization_id,v_job.created_by,v_job.workspace_id,'ai_credits',p_credit_quantity,
          jsonb_build_object('aiJobId',v_job.id,'provider',trim(p_provider),'model',trim(p_model),'kind','book_bible_candidate'));
  update public.ai_jobs set status='succeeded',
      output_ref=jsonb_build_object('candidates',p_candidates,'diagnostics',p_diagnostics,'reviewRequired',true,'savedBibleUpdated',false),
      model=trim(p_model),usage_json=p_usage,error_code=null,error_message=null,
      started_at=coalesce(started_at,clock_timestamp()),completed_at=clock_timestamp()
    where id=v_job.id returning * into v_job;
  return v_job;
end $$;

revoke all on function public.complete_book_bible_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)
  from public,anon,authenticated;
grant execute on function public.complete_book_bible_ai_job(uuid,text,text,jsonb,jsonb,jsonb,numeric)
  to service_role;
