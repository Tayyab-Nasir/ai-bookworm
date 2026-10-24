-- Receipt-only completion. This installs no policy, entitlement or worker and
-- never sends a provider request. Unknown customer API cost is NOT zero cost.
alter table public.ai_runs alter column estimated_cost drop not null;
alter table public.ai_runs add column cost_payer text not null default 'platform';
alter table public.ai_runs add constraint ai_run_payer_cost check(
 (cost_payer='platform' and estimated_cost is not null)
 or (cost_payer='customer' and estimated_cost is null and ai_job_id is not null));

create function bookworm_credentials.customer_receipt_assert(p_valid boolean) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 if p_valid is distinct from true then
  raise exception using errcode='23514',message='Customer AI receipt does not match its saved request'; end if;
end $$;

create function bookworm_credentials.customer_receipt_count(p_value jsonb) returns integer
language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(p_value)='number'
  and p_value::text ~ '^[0-9]{1,10}$');
 perform bookworm_credentials.customer_receipt_assert(p_value::text::numeric<=2147483647);
 return p_value::text::integer;
end $$;

create function bookworm_credentials.customer_receipt_usage(p_provider text,p_usage jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
declare evidence jsonb; k text; n integer; ti bigint; tout bigint; allowed text[];
begin
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(p_usage)='object'
  and p_usage ?& array['inputTokens','outputTokens','estimatedCostUsd','providerTokenUsage']
  and p_usage-array['inputTokens','outputTokens','estimatedCostUsd','providerTokenUsage']='{}'
  and p_usage->'estimatedCostUsd'='null'::jsonb);
 ti:=bookworm_credentials.customer_receipt_count(p_usage->'inputTokens');
 tout:=bookworm_credentials.customer_receipt_count(p_usage->'outputTokens');
 evidence:=p_usage->'providerTokenUsage';
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(evidence)='object' and evidence<>'{}');
 allowed:=case p_provider
  when 'anthropic' then array['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens',
   'cache_creation.ephemeral_1h_input_tokens','cache_creation.ephemeral_5m_input_tokens','output_tokens_details.thinking_tokens']
  when 'google' then array['promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount','toolUsePromptTokenCount','cachedContentTokenCount']
  when 'openrouter' then array['prompt_tokens','completion_tokens','total_tokens','prompt_tokens_details.cached_tokens','completion_tokens_details.reasoning_tokens']
  else array['input_tokens','output_tokens','total_tokens','input_tokens_details.cached_tokens','output_tokens_details.reasoning_tokens'] end;
 for k in select jsonb_object_keys(evidence) loop
  perform bookworm_credentials.customer_receipt_assert(k=any(allowed));
  n:=bookworm_credentials.customer_receipt_count(evidence->k);
 end loop;
 if p_provider='anthropic' then
  perform bookworm_credentials.customer_receipt_assert(evidence ?& array['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens']
   and ti=(evidence->>'input_tokens')::bigint+(evidence->>'cache_creation_input_tokens')::bigint+(evidence->>'cache_read_input_tokens')::bigint
   and tout=(evidence->>'output_tokens')::bigint);
  if evidence ?| array['cache_creation.ephemeral_1h_input_tokens','cache_creation.ephemeral_5m_input_tokens'] then
   perform bookworm_credentials.customer_receipt_assert(evidence ?& array['cache_creation.ephemeral_1h_input_tokens','cache_creation.ephemeral_5m_input_tokens']
    and (evidence->>'cache_creation.ephemeral_1h_input_tokens')::bigint+(evidence->>'cache_creation.ephemeral_5m_input_tokens')::bigint=(evidence->>'cache_creation_input_tokens')::bigint);
  end if;
  perform bookworm_credentials.customer_receipt_assert(coalesce((evidence->>'output_tokens_details.thinking_tokens')::bigint,0)<=tout);
 elsif p_provider='google' then
  perform bookworm_credentials.customer_receipt_assert(evidence ?& array['promptTokenCount','candidatesTokenCount','totalTokenCount']
   and ti=(evidence->>'promptTokenCount')::bigint
   and tout=(evidence->>'candidatesTokenCount')::bigint+coalesce((evidence->>'thoughtsTokenCount')::bigint,0)
   and ti+tout=(evidence->>'totalTokenCount')::bigint
   and coalesce((evidence->>'toolUsePromptTokenCount')::bigint,0)=0
   and coalesce((evidence->>'cachedContentTokenCount')::bigint,0)<=ti);
 elsif p_provider='openrouter' then
  perform bookworm_credentials.customer_receipt_assert(evidence ?& array['prompt_tokens','completion_tokens','total_tokens']
   and ti=(evidence->>'prompt_tokens')::bigint and tout=(evidence->>'completion_tokens')::bigint
   and ti+tout=(evidence->>'total_tokens')::bigint
   and coalesce((evidence->>'prompt_tokens_details.cached_tokens')::bigint,0)<=ti
   and coalesce((evidence->>'completion_tokens_details.reasoning_tokens')::bigint,0)<=tout);
 else
  perform bookworm_credentials.customer_receipt_assert(p_provider in ('openai','xai')
   and evidence ?& array['input_tokens','output_tokens','total_tokens']
   and ti=(evidence->>'input_tokens')::bigint and tout=(evidence->>'output_tokens')::bigint
   and ti+tout=(evidence->>'total_tokens')::bigint
   and coalesce((evidence->>'input_tokens_details.cached_tokens')::bigint,0)<=ti
   and coalesce((evidence->>'output_tokens_details.reasoning_tokens')::bigint,0)<=tout);
 end if;
end $$;

-- Historical source versions are immutable. Recovery uses those versions, not
-- today's pointer or a newly fetched chapter, and needs no live credential.
create function bookworm_credentials.customer_receipt_node(a bookworm_credentials.customer_ai_jobs,p_chapter text,p_node text)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare s jsonb; doc jsonb; snapshot jsonb; n jsonb; plain text;
begin
 perform bookworm_credentials.customer_receipt_assert(p_chapter ~ '^[a-f0-9-]{36}$' and length(p_node) between 1 and 200);
 select value into s from jsonb_array_elements(a.source_versions) where value->>'chapterId'=p_chapter;
 perform bookworm_credentials.customer_receipt_assert(s is not null);
 select d.content_json into doc from public.document_versions d join public.chapters c on c.id=d.chapter_id
  join public.books b on b.id=c.book_id where d.id=(s->>'documentVersionId')::uuid and c.id=p_chapter::uuid
   and d.version_number=(s->>'version')::integer and c.book_id=a.book_id and b.workspace_id=a.workspace_id;
 snapshot:=a.request_snapshot#>array['input','chapters',p_chapter,'nodes'];
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(doc->'nodes')='array' and jsonb_typeof(snapshot)='array');
 perform bookworm_credentials.customer_receipt_assert(
  (select count(*) from jsonb_array_elements(doc->'nodes') where value->>'id'=p_node)=1
  and (select count(*) from jsonb_array_elements(snapshot) where value->>'id'=p_node)=1);
 select value into n from jsonb_array_elements(doc->'nodes') where value->>'id'=p_node;
 plain:=private.canonical_book_nodes_plain_text(jsonb_build_array(n));
 select value into snapshot from jsonb_array_elements(snapshot) where value->>'id'=p_node;
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(snapshot->'text')='string' and snapshot->>'text'=plain);
 return jsonb_build_object('source',s,'node',n,'text',plain,'hash',encode(sha256(convert_to(plain,'UTF8')),'hex'));
end $$;

create function bookworm_credentials.customer_receipt_refs(a bookworm_credentials.customer_ai_jobs,p_refs jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare r jsonb; n jsonb;
begin
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(p_refs)='array');
 perform bookworm_credentials.customer_receipt_assert(jsonb_array_length(p_refs) between 1 and 30);
 for r in select value from jsonb_array_elements(p_refs) loop
  perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(r)='object'
   and r ?& array['chapterId','documentVersionId','nodeId','textHash']
   and r-array['chapterId','documentVersionId','nodeId','textHash']='{}'
   and jsonb_typeof(r->'chapterId')='string' and jsonb_typeof(r->'nodeId')='string');
  n:=bookworm_credentials.customer_receipt_node(a,r->>'chapterId',r->>'nodeId');
  perform bookworm_credentials.customer_receipt_assert(r->'documentVersionId'=n#>'{source,documentVersionId}' and r->'textHash'=n->'hash');
 end loop;
end $$;

create function bookworm_credentials.customer_utf16_boundary(p_text text,p_offset integer) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select p_offset=0 or exists(select 1 from (
  select sum(case when ascii(c)>65535 then 2 else 1 end) over(order by pos) as boundary
  from regexp_split_to_table(p_text,'') with ordinality as t(c,pos) where c<>'') b where boundary=p_offset);
$$;

create function bookworm_credentials.customer_receipt_candidate(a bookworm_credentials.customer_ai_jobs,c jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare k text; item jsonb; normalized jsonb;
begin
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(c)='object' and c->>'status'='pending'
  and c ? 'confidence' and (jsonb_typeof(c->'confidence')='number' or c->'confidence'='null'::jsonb));
 if c->'confidence'<>'null'::jsonb then
  perform bookworm_credentials.customer_receipt_assert((c->>'confidence')::numeric between 0 and 1); end if;
 perform bookworm_credentials.customer_receipt_refs(a,c->'sourceRefs');
 if a.agent_type='metadata' then
  perform bookworm_credentials.customer_receipt_assert(c->>'suggestionKind'='metadata_candidate'
   and c ?& array['description','keywords','categories','audience','rationale']
   and c-array['suggestionKind','status','description','keywords','categories','audience','rationale','confidence','sourceRefs']='{}');
  foreach k in array array['description','audience','rationale'] loop
   perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(c->k)='string'
    and c->>k=bookworm_private.bible_trim(c->>k)
    and bookworm_private.bible_utf16_length(c->>k) between case when k='description' then 40 else 1 end
     and case k when 'description' then 4000 when 'audience' then 500 else 2000 end);
  end loop;
  foreach k in array array['keywords','categories'] loop
   perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(c->k)='array');
   perform bookworm_credentials.customer_receipt_assert(jsonb_array_length(c->k) between 1 and case k when 'keywords' then 30 else 20 end
    and (select count(distinct lower(value#>>'{}')) from jsonb_array_elements(c->k))=jsonb_array_length(c->k));
   for item in select value from jsonb_array_elements(c->k) loop
    perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(item)='string' and item#>>'{}'=bookworm_private.bible_trim(item#>>'{}')
     and bookworm_private.bible_utf16_length(item#>>'{}') between 1 and case k when 'keywords' then 100 else 180 end);
   end loop;
  end loop;
 else
  perform bookworm_credentials.customer_receipt_assert(c->>'suggestionKind'='book_bible_candidate'
   and c->>'type' in ('character','place','organization','object','event','term')
   and c ?& array['type','name','description','attributes'] and jsonb_typeof(c->'confidence')='number'
   and c-array['suggestionKind','status','type','name','description','attributes','confidence','sourceRefs']='{}');
  normalized:=bookworm_private.normalize_bible_mutation_body(c-array['suggestionKind','status','confidence']);
  perform bookworm_credentials.customer_receipt_assert(normalized-'imageAssetIds'=c-array['suggestionKind','status','confidence']);
 end if;
end $$;

-- A saved paid result may arrive after the job has entered outcome review.
-- Only the completion RPC below can couple review -> settled to a receipt.
create or replace function bookworm_credentials.guard_customer_ai_authority() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-array['state','dispatched_at','dispatch_lease_token','receipt_fingerprint']) is distinct from
    (to_jsonb(old)-array['state','dispatched_at','dispatch_lease_token','receipt_fingerprint'])
  or (old.dispatched_at is not null and (new.dispatched_at is distinct from old.dispatched_at
   or new.dispatch_lease_token is distinct from old.dispatch_lease_token or new.receipt_fingerprint is distinct from old.receipt_fingerprint))
  or (new.state is distinct from old.state and not ((old.state='held' and new.state in ('review','released','settled'))
    or (old.state='review' and new.state='settled' and old.dispatched_at is not null)))
  or (new.state='released' and new.dispatched_at is not null) then
  raise exception using errcode='23514',message='customer AI authority is immutable'; end if;
 return new;
end $$;

-- The receipt store needs SELECT/INSERT/UPDATE, never DELETE/TRUNCATE. Explicit
-- revocation is necessary even when inherited default grants gave DELETE.
revoke delete,truncate on public.ai_review_service_receipts from public,anon,authenticated,service_role;
create function public.guard_customer_ai_receipt_delete() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from bookworm_credentials.customer_ai_jobs where job_id=old.job_id) then
  raise exception using errcode='23514',message='Customer AI receipt requires an explicit retention workflow'; end if;
 return old;
end $$;
create trigger customer_ai_receipt_no_delete before delete on public.ai_review_service_receipts
 for each row execute function public.guard_customer_ai_receipt_delete();
revoke all on function public.guard_customer_ai_receipt_delete() from public,anon,authenticated,service_role;

create function public.guard_customer_ai_completed_job() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if old.billing_mode='customer_key' and old.status='succeeded' and
  (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
  raise exception using errcode='23514',message='Completed customer AI job is immutable'; end if;
 return new;
end $$;
create trigger customer_ai_completed_immutable before update on public.ai_jobs
 for each row execute function public.guard_customer_ai_completed_job();
revoke all on function public.guard_customer_ai_completed_job() from public,anon,authenticated,service_role;

create function public.guard_customer_ai_run() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; r jsonb;
begin
 if tg_op='UPDATE' and old.cost_payer='customer' and new is distinct from old then
  raise exception using errcode='23514',message='Customer AI usage evidence is immutable'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=new.ai_job_id;
 if not found then
  perform bookworm_credentials.customer_receipt_assert(new.cost_payer='platform'); return new; end if;
 select result_json into r from public.ai_review_service_receipts where job_id=a.job_id and request_sha256=a.receipt_fingerprint;
 perform bookworm_credentials.customer_receipt_assert(a.state='settled' and r is not null and new.cost_payer='customer'
  and new.estimated_cost is null and new.workspace_id=a.workspace_id and new.provider=a.provider and new.model=r->>'model'
  and new.tokens_in=(r#>>'{usage,inputTokens}')::integer and new.tokens_out=(r#>>'{usage,outputTokens}')::integer and new.status='succeeded');
 return new;
end $$;
create trigger customer_ai_run_guard before insert or update on public.ai_runs for each row execute function public.guard_customer_ai_run();
revoke all on function public.guard_customer_ai_run() from public,anon,authenticated,service_role;

create function public.complete_customer_ai_job(p_job_id uuid,p_owner_id uuid,p_receipt_fingerprint text) returns public.ai_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a bookworm_credentials.customer_ai_jobs; j public.ai_jobs; saved public.ai_review_service_receipts;
 r jsonb; item jsonb; op jsonb; n jsonb; suggestion_id uuid; output jsonb; span_from integer; span_to integer;
begin
 if auth.role() is distinct from 'service_role' then raise exception using errcode='42501',message='server authorization required'; end if;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id and owner_id=p_owner_id;
 if not found then raise exception using errcode='P0002',message='customer job not found'; end if;
 -- Same leading lock order as claim/hold/revoke. No credit ledger mutation.
 perform bookworm_credentials.lock_customer_ai_owner(a.owner_id);
 perform id from public.organizations where id=a.organization_id for update;
 select * into a from bookworm_credentials.customer_ai_jobs where job_id=p_job_id for update;
 select * into j from public.ai_jobs where id=p_job_id for update;
 perform bookworm_credentials.customer_receipt_assert(a.dispatched_at is not null
  and a.receipt_fingerprint=p_receipt_fingerprint and j.billing_mode='customer_key'
  and a.state in ('held','review','settled') and j.provider_dispatched_at=a.dispatched_at);
 if a.state='settled' then
  perform bookworm_credentials.customer_receipt_assert(j.status='succeeded'); return j; end if;
 perform bookworm_credentials.customer_receipt_assert((a.state='held' and j.status='running' and j.lease_token=a.dispatch_lease_token)
  or (a.state='review' and j.status='failed' and j.error_code='customer_provider_outcome_unknown'));
 select * into saved from public.ai_review_service_receipts where job_id=j.id for share;
 r:=saved.result_json;
 perform bookworm_credentials.customer_receipt_assert(saved.request_sha256=a.receipt_fingerprint and jsonb_typeof(r)='object'
  and octet_length(r::text)<=6000000 and r->>'jobId'=j.id::text and r->>'workspaceId'=a.workspace_id::text
  and r->>'bookId'=a.book_id::text and r->>'agentType'=a.agent_type and r->>'provider'=a.provider
  and r->>'customerDispatchSha256'=a.receipt_fingerprint and r->>'status'='succeeded'
  and jsonb_typeof(r->'model')='string' and a.model_policy->'responseModels' @> jsonb_build_array(r->>'model')
  and jsonb_typeof(r->'responseId')='string' and r->>'responseId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'
  and (not r ? 'requestId' or (jsonb_typeof(r->'requestId')='string' and r->>'requestId' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'))
  and r-array['jobId','workspaceId','bookId','agentType','customerDispatchSha256','status','provider','model','requestId','responseId','usage','suggestions','diagnostics']='{}');
 perform bookworm_credentials.customer_receipt_usage(a.provider,r->'usage');
 perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(r->'diagnostics')='array' and jsonb_typeof(r->'suggestions')='array');
 perform bookworm_credentials.customer_receipt_assert(jsonb_array_length(r->'diagnostics')<=500
  and octet_length((r->'diagnostics')::text)<=400000 and jsonb_array_length(r->'suggestions')<=200);
 for item in select value from jsonb_array_elements(r->'diagnostics') loop
  perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(item)='object');
 end loop;
 if a.agent_type in ('metadata','bookbible') then
  perform bookworm_credentials.customer_receipt_assert((a.agent_type='metadata' and jsonb_array_length(r->'suggestions')=1)
   or (a.agent_type='bookbible' and jsonb_array_length(r->'suggestions')<=10));
  for item in select value from jsonb_array_elements(r->'suggestions') loop
   perform bookworm_credentials.customer_receipt_candidate(a,item);
  end loop;
  output:=case a.agent_type when 'metadata' then jsonb_build_object('candidate',r#>'{suggestions,0}','savedMetadataUpdated',false)
    else jsonb_build_object('candidates',r->'suggestions','savedBibleUpdated',false) end;
 else
  for item in select value from jsonb_array_elements(r->'suggestions') loop
   perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(item)='object' and jsonb_typeof(item->'chapterId')='string'
    and jsonb_typeof(item->'nodeId')='string' and jsonb_typeof(item->'rationale')='string'
    and length(bookworm_private.bible_trim(item->>'rationale')) between 1 and 2000
    and item ? 'confidence' and (jsonb_typeof(item->'confidence')='number' or item->'confidence'='null'::jsonb));
   if item->'confidence'<>'null'::jsonb then
    perform bookworm_credentials.customer_receipt_assert((item->>'confidence')::numeric between 0 and 1); end if;
   n:=bookworm_credentials.customer_receipt_node(a,item->>'chapterId',item->>'nodeId');
   op:=item->'operation';
   perform bookworm_credentials.customer_receipt_assert(jsonb_typeof(op)='object' and op->>'type'='replace_text'
    and op#>'{target,chapterId}'=item->'chapterId' and op#>'{target,nodeId}'=item->'nodeId'
    and op#>'{payload,nodeId}'=item->'nodeId' and jsonb_typeof(op#>'{payload,text}')='string'
    and octet_length(op#>>'{payload,text}')<=200000 and jsonb_typeof(n#>'{node,text}')='string');
   span_from:=bookworm_credentials.customer_receipt_count(op#>'{payload,from}');
   span_to:=bookworm_credentials.customer_receipt_count(op#>'{payload,to}');
   perform bookworm_credentials.customer_receipt_assert(span_to>=span_from
    and span_to-span_from<=case a.agent_type when 'writer' then 20000 when 'proofreader' then 120 when 'copyeditor' then 400 else 200 end
    and bookworm_credentials.customer_utf16_boundary(n->>'text',span_from) and bookworm_credentials.customer_utf16_boundary(n->>'text',span_to));
   suggestion_id:=gen_random_uuid();
   -- Only the verified replace_text fields survive. Never trust provider IDs,
   -- actor/source flags or an invented expected manuscript revision.
   op:=jsonb_build_object('operationId','ai:'||suggestion_id::text,'type','replace_text',
    'target',jsonb_build_object('chapterId',item->'chapterId','nodeId',item->'nodeId'),
    'payload',jsonb_build_object('nodeId',item->'nodeId','from',span_from,'to',span_to,'text',op#>'{payload,text}'),
    'source','ai','sourceRef',suggestion_id,'expectedVersion',n#>'{source,version}');
   insert into public.ai_suggestions(id,ai_job_id,entity_type,entity_id,operation_json,rationale,confidence,status)
    values(suggestion_id,j.id,'chapter',(item->>'chapterId')::uuid,op,item->>'rationale',(item->>'confidence')::numeric,'pending');
  end loop;
  output:=jsonb_build_object('suggestionCount',jsonb_array_length(r->'suggestions'));
 end if;
 output:=output||jsonb_build_object('diagnostics',r->'diagnostics','reviewRequired',true,'costPayer','customer',
  'providerCostStatus','unknown','customerDispatchSha256',a.receipt_fingerprint);
 update bookworm_credentials.customer_ai_jobs set state='settled' where job_id=j.id;
 insert into public.ai_runs(workspace_id,ai_job_id,provider,model,tokens_in,tokens_out,estimated_cost,cost_payer,status)
  values(a.workspace_id,j.id,a.provider,r->>'model',(r#>>'{usage,inputTokens}')::integer,(r#>>'{usage,outputTokens}')::integer,null,'customer','succeeded');
 insert into public.usage_events(organization_id,workspace_id,user_id,ai_job_id,meter,quantity,metadata_json)
  values(a.organization_id,a.workspace_id,a.owner_id,j.id,'customer_ai_request',1,jsonb_build_object(
   'provider',a.provider,'model',r->>'model','costPayer','customer','providerCostStatus','unknown','platformFeeCredits',a.fee_credits,
   'usage',r->'usage','responseId',r->>'responseId','requestId',r->'requestId'));
 update public.ai_jobs set status='succeeded',output_ref=output,usage_json=r->'usage',error_code=null,error_message=null,
  lease_token=null,lease_expires_at=null,completed_at=clock_timestamp() where id=j.id returning * into j;
 return j;
end $$;

revoke all on function bookworm_credentials.customer_receipt_assert(boolean),bookworm_credentials.customer_receipt_count(jsonb),
 bookworm_credentials.customer_receipt_usage(text,jsonb),bookworm_credentials.customer_receipt_node(bookworm_credentials.customer_ai_jobs,text,text),
 bookworm_credentials.customer_receipt_refs(bookworm_credentials.customer_ai_jobs,jsonb),bookworm_credentials.customer_utf16_boundary(text,integer),
 bookworm_credentials.customer_receipt_candidate(bookworm_credentials.customer_ai_jobs,jsonb),
 public.complete_customer_ai_job(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.complete_customer_ai_job(uuid,uuid,text) to service_role;
