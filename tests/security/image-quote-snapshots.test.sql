begin;
insert into auth.users(id,email) values
 ('e4800000-0000-4000-8000-000000000001','image-quotes@local.test'),
 ('e4800000-0000-4000-8000-000000000002','image-viewer@local.test');
create temp table image_snapshot_fixture(workspace_id uuid) on commit drop;
grant all on image_snapshot_fixture to authenticated,service_role;
set local role authenticated;
set local request.jwt.claims='{"sub":"e4800000-0000-4000-8000-000000000001"}';
insert into image_snapshot_fixture select id from public.create_workspace_with_owner('Image quote snapshots');
reset role;
insert into public.workspace_members(workspace_id,user_id,role)
 select workspace_id,'e4800000-0000-4000-8000-000000000002','viewer' from image_snapshot_fixture;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare
 u uuid:='e4800000-0000-4000-8000-000000000001';
 j uuid:='e4800000-0000-4000-8000-000000000003';
 w uuid; body jsonb; q jsonb; catalog jsonb; accepted public.ai_jobs; saved public.image_quote_snapshots; replay public.image_quote_snapshots;
 ref_job uuid:='e4800000-0000-4000-8000-000000000009'; ref_body jsonb; ref_q jsonb; ref_saved public.image_quote_snapshots;
 claimed public.ai_jobs; reclaimed public.ai_jobs;
 receipt jsonb; stored_receipt public.quoted_image_receipts; settlement jsonb;
begin
 select workspace_id into w from image_snapshot_fixture;
 assert not has_table_privilege('authenticated','public.image_quote_snapshots','select');
 assert not has_table_privilege('service_role','public.image_quote_snapshots','insert');
 assert not has_table_privilege('service_role','public.image_quote_snapshots','update');
 assert not has_function_privilege('authenticated',
   'public.save_image_quote_snapshot(uuid,uuid,uuid,uuid,text,text,jsonb,text,text,jsonb)','execute');
 body:=jsonb_build_object('jobId',j,'workspaceId',w,'userId',u,'bookId',null,'model','fixture-image','prompt','private prompt',
   'kind','cover','size','1024x1024','quality','low','references','[]'::jsonb);
 q:=jsonb_build_object('scope',jsonb_build_object('jobId',j,'workspaceId',w,'userId',u,'inputSha256',repeat('a',64)),
   'price',jsonb_build_object('version','fixture-price','provider','openai','model','fixture-image','rates',
     '[{"dimension":"text_input","microUsdPerMillionTokens":"1000000"},{"dimension":"image_input","microUsdPerMillionTokens":"1000000"},{"dimension":"text_output","microUsdPerMillionTokens":"1000000"},{"dimension":"image_output","microUsdPerMillionTokens":"1000000"}]'::jsonb),
   'policy','{"approved":true,"version":"fixture-policy","microUsdPerCredit":"10","markupBasisPoints":15000,"platformMicroUsd":"0","minimumCredits":"1"}'::jsonb,
   'maximumTokens','[{"dimension":"text_input","tokens":"100"},{"dimension":"image_input","tokens":"100"},{"dimension":"text_output","tokens":"10"},{"dimension":"image_output","tokens":"100"}]'::jsonb,
   'maximumProviderMicroUsd','310','createdAt',clock_timestamp()-interval '1 second','expiresAt',clock_timestamp()+interval '5 minutes','reservedCredits','47','fingerprint',repeat('b',64));
 perform public.validate_image_quote_price(q);
 begin
   perform public.validate_image_quote_price(q||'{"reservedCredits":"46"}'::jsonb);
   raise exception 'underquoted credit offer accepted';
 exception when check_violation then null; end;
 begin
   perform public.validate_image_quote_price(q||'{"maximumProviderMicroUsd":"1"}'::jsonb);
   raise exception 'false provider maximum accepted';
 exception when check_violation then null; end;
 begin
   perform public.validate_image_quote_price(jsonb_set(q,'{policy,microUsdPerCredit}','"0"'));
   raise exception 'zero credit denominator accepted';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.validate_image_quote_price(jsonb_set(q,'{maximumTokens,0,dimension}','"image_input"'));
   raise exception 'duplicate token dimension accepted';
 exception when invalid_parameter_value then null; end;
 select * into saved from public.save_image_quote_snapshot(u,w,null,j,'image-key-01',repeat('a',64),body,'catalog-v1','square-low',q);
 select * into replay from public.save_image_quote_snapshot(u,w,null,j,'image-key-01',repeat('a',64),body,'catalog-v2','square-low',q);
 assert replay.id=saved.id and replay.catalog_version='catalog-v1','retry replaced immutable offer';
 assert not exists(select 1 from public.ai_jobs where id=j),'saving an offer dispatched a job';
 assert not exists(select 1 from public.credit_ledger where reference_id=j),'saving an offer mutated credits';
 begin
   perform public.save_image_quote_snapshot(u,w,null,j,'image-key-01',repeat('a',64),body||'{"prompt":"changed"}'::jsonb,'catalog-v1','square-low',q);
   raise exception 'changed retry accepted';
 exception when unique_violation then null; end;
 begin
   perform public.save_image_quote_snapshot('e4800000-0000-4000-8000-000000000002',w,null,j,'image-key-02',repeat('a',64),body,'catalog-v1','square-low',q);
   raise exception 'viewer accepted';
 exception when insufficient_privilege then null; end;
 begin
   perform public.save_image_quote_snapshot(u,w,null,j,'image-key-03',repeat('a',64),body,'catalog-v1','square-low',q||jsonb_build_object('expiresAt',clock_timestamp()-interval '1 minute'));
   raise exception 'expired quote accepted';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.save_image_quote_snapshot(u,w,null,'e4800000-0000-4000-8000-000000000004','image-key-04',repeat('a',64),body,'catalog-v1','square-low',q);
   raise exception 'foreign job scope accepted';
 exception when check_violation then null; end;
 catalog:=jsonb_build_object('version','catalog-v1','approved',true,'effectiveAt',clock_timestamp()-interval '1 minute',
   'expiresAt',clock_timestamp()+interval '1 hour','entries',jsonb_build_array(jsonb_build_object(
   'id','square-low','price',q->'price','policy',q->'policy','size','1024x1024','quality','low','maxPromptBytes',1000,'maxReferenceImages',0,
   'maximumTokens','{"text_input":100,"image_input":100,"text_output":10,"image_output":100}'::jsonb)));
 begin
   perform public.accept_image_quote(saved.id,u,46,catalog);
   raise exception 'wrong confirmed credit amount accepted';
 exception when check_violation then null; end;
 ref_body:=body||jsonb_build_object('jobId',ref_job,'references',jsonb_build_array(jsonb_build_object(
   'assetId','e4800000-0000-4000-8000-000000000099','version',1,'sha256',repeat('c',64),'mimeType','image/png')));
 ref_q:=jsonb_set(q,'{scope,jobId}',to_jsonb(ref_job::text));
 select * into ref_saved from public.save_image_quote_snapshot(u,w,null,ref_job,'image-reference-01',repeat('a',64),ref_body,'catalog-v1','square-low',ref_q);
 begin
   perform public.accept_image_quote(ref_saved.id,u,47,jsonb_set(catalog,'{entries,0,maxReferenceImages}','1'));
   raise exception 'missing or deleted reference accepted';
 exception when check_violation then
   assert sqlerrm='image reference changed','reference rejection did not occur before funding';
 end;
 assert not exists(select 1 from public.ai_jobs where id=ref_job),'missing reference created job';
 begin
   perform public.accept_image_quote(saved.id,u,47,jsonb_set(catalog,'{entries,0,policy,microUsdPerCredit}','"20"'));
   raise exception 'changed catalog rate accepted';
 exception when check_violation then null; end;
 begin
   perform public.accept_image_quote(saved.id,u,47,catalog);
   raise exception 'unfunded image acceptance succeeded';
 exception when check_violation then
   assert sqlerrm='insufficient credits','unexpected rejection instead of insufficient balance';
 end;
 assert not exists(select 1 from public.ai_jobs where id=j),'failed funding left queued job';
 assert not exists(select 1 from public.image_quote_acceptances where quote_id=saved.id),'failed funding left acceptance receipt';
 assert not exists(select 1 from public.funded_usage_quotes where job_id=j),'failed funding left a hold';
 assert not exists(select 1 from public.credit_ledger where reference_id=j),'failed funding changed credits';
 insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values(u,w,'purchase',100,0);
 select * into accepted from public.accept_image_quote(saved.id,u,47,catalog);
 assert accepted.id=j and accepted.billing_mode='quoted' and accepted.status='queued';
 assert (select reserved_credits=47 and status='held' from public.funded_usage_quotes where job_id=j);
 assert (select count(*)=1 from public.credit_ledger where reference_id=j and source='generation_reservation' and amount=-47);
 select * into accepted from public.accept_image_quote(saved.id,u,47,'{}'::jsonb);
 assert accepted.id=j,'accepted retry required a new catalog or job';
 assert (select count(*)=1 from public.credit_ledger where reference_id=j),'accepted retry created another credit entry';
 assert not exists(select 1 from public.usage_events where ai_job_id=j),'acceptance charged operational image usage';
 begin
   perform public.accept_image_quote(saved.id,u,46,catalog);
   raise exception 'accepted replay ignored changed confirmation';
 exception when check_violation then null; end;
 select * into strict claimed from public.claim_quoted_image_job(180);
 assert claimed.id=j and claimed.lease_token is not null;
 assert not exists(select 1 from public.claim_quoted_image_job(180)),'live image lease was stolen';
 assert public.renew_quoted_image_lease(j,claimed.lease_token,180);
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j;
 select * into strict reclaimed from public.claim_quoted_image_job(180);
 assert reclaimed.id=j and reclaimed.lease_token<>claimed.lease_token and reclaimed.attempts=2;
 assert not public.renew_quoted_image_lease(j,claimed.lease_token,180),'old image lease renewed';
 begin
   perform public.release_quoted_image_before_dispatch(j,claimed.lease_token,'request_mismatch');
   raise exception 'stale worker refunded held credits';
 exception when serialization_failure then null; end;
 assert public.claim_funded_dispatch(j,reclaimed.lease_token,repeat('a',64),'fixture-image');
 assert not public.claim_funded_dispatch(j,reclaimed.lease_token,repeat('a',64),'fixture-image'),'image dispatched twice';
 update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j;
 select * into strict reclaimed from public.claim_quoted_image_job(180);
 assert reclaimed.id=j and reclaimed.attempts=3,'dispatched image could not reclaim for receipt recovery';
 assert not public.claim_funded_dispatch(j,reclaimed.lease_token,repeat('a',64),'fixture-image'),'reclaimed image dispatched again';
 assert not has_table_privilege('authenticated','public.quoted_image_receipts','select');
 assert not has_table_privilege('service_role','public.quoted_image_receipts','update');
 receipt:=jsonb_build_object('assetId','e4800000-0000-4000-8000-000000000050','name','Saved generated artwork',
  'provider','openai','model','fixture-image','requestId','fixture-provider-request','mimeType','image/png',
  'checksum',repeat('d',64),'sizeBytes',8,'storagePath',format('workspaces/%s/assets/e4800000-0000-4000-8000-000000000050/v1/generated.png',w),
  'usage','{"inputTokens":30,"outputTokens":20}'::jsonb);
 select * into stored_receipt from public.save_quoted_image_receipt(j,reclaimed.lease_token,repeat('a',64),receipt);
 assert stored_receipt.receipt_json=receipt;
 perform public.save_quoted_image_receipt(j,reclaimed.lease_token,repeat('a',64),receipt);
 assert (select count(*)=1 from public.quoted_image_receipts where job_id=j),'receipt replay duplicated';
 begin
  perform public.save_quoted_image_receipt(j,reclaimed.lease_token,repeat('a',64),receipt||'{"checksum":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}'::jsonb);
  raise exception 'provider receipt overwritten';
 exception when unique_violation then null; end;
 begin
  perform public.save_quoted_image_receipt(j,claimed.lease_token,repeat('a',64),receipt);
  raise exception 'stale worker wrote receipt';
 exception when serialization_failure then null; end;
 assert (select status='held' from public.funded_usage_quotes where job_id=j),'receipt save prematurely settled usage';
 begin
   perform public.complete_quoted_image_job(j,reclaimed.lease_token,'{}'::jsonb);
   raise exception 'unmeasured receipt completed';
 exception when check_violation then
   assert sqlerrm='image completion requires itemized measurements';
 end;
 begin
   perform public.release_quoted_image_before_dispatch(j,reclaimed.lease_token,'request_mismatch');
   raise exception 'dispatched image was refunded';
 exception when check_violation then null; end;
 begin
   insert into public.usage_events(organization_id,user_id,workspace_id,ai_job_id,meter,quantity)
    select organization_id,u,w,j,'image_credits',1 from public.workspaces where id=w;
   raise exception 'quoted image used legacy settlement';
 exception when check_violation then
   assert sqlerrm='quoted image cannot use operational settlement','wrong guard rejected operational charge';
 end;
 assert not exists(select 1 from public.usage_events where ai_job_id=j),'rejected legacy charge left usage';
 assert public.hold_quoted_image_for_review(j,reclaimed.lease_token,'provider_outcome_unknown','fixture-unknown');
 assert (select status='requires_review' from public.funded_usage_quotes where job_id=j);
 assert not exists(select 1 from public.credit_ledger where reference_id=j and source='generation_release');
 assert not exists(select 1 from public.claim_quoted_image_job(180)),'review hold reclaimed for generation';

 ref_job:='e4800000-0000-4000-8000-000000000010';
 ref_body:=body||jsonb_build_object('jobId',ref_job);
 ref_q:=jsonb_set(q,'{scope,jobId}',to_jsonb(ref_job::text));
 select * into ref_saved from public.save_image_quote_snapshot(u,w,null,ref_job,'image-release-01',repeat('a',64),ref_body,'catalog-v1','square-low',ref_q);
 perform public.accept_image_quote(ref_saved.id,u,47,catalog);
 select * into strict claimed from public.claim_quoted_image_job(180);
 assert public.release_quoted_image_before_dispatch(ref_job,claimed.lease_token,'provider_not_configured');
 assert (select count(*)=1 from public.credit_ledger where reference_id=ref_job and source='generation_release' and amount=47);
 begin
   perform public.release_quoted_image_before_dispatch(ref_job,claimed.lease_token,'provider_not_configured');
   raise exception 'image hold refunded twice';
 exception when check_violation then null; end;

 ref_job:='e4800000-0000-4000-8000-000000000011';
 ref_body:=body||jsonb_build_object('jobId',ref_job);
 ref_q:=jsonb_set(q,'{scope,jobId}',to_jsonb(ref_job::text));
 select * into ref_saved from public.save_image_quote_snapshot(u,w,null,ref_job,'image-complete-01',repeat('a',64),ref_body,'catalog-v1','square-low',ref_q);
 perform public.accept_image_quote(ref_saved.id,u,47,catalog);
 select * into strict claimed from public.claim_quoted_image_job(180);
 assert public.claim_funded_dispatch(ref_job,claimed.lease_token,repeat('a',64),'fixture-image');
 receipt:=receipt||jsonb_build_object('assetId','e4800000-0000-4000-8000-000000000051','requestId','fixture-complete',
   'storagePath',format('workspaces/%s/assets/e4800000-0000-4000-8000-000000000051/v1/generated.png',w),
   'usage','{"inputTokens":30,"outputTokens":20,"latencyMs":12,"providerTokenUsage":{"input_tokens":30,"output_tokens":20,"total_tokens":50,"input_tokens_details":{"text_tokens":10,"image_tokens":20},"output_tokens_details":{"text_tokens":0,"image_tokens":20}}}'::jsonb);
 receipt:=jsonb_set(receipt,'{usage,reconciliationStatus}','"supported"');
 perform public.save_quoted_image_receipt(ref_job,claimed.lease_token,repeat('a',64),receipt);
 settlement:=jsonb_build_object('status','settle','requestId','fixture-complete','fingerprint',repeat('b',64),
   'priceVersion','fixture-price','policyVersion','fixture-policy','providerMicroUsd','50','debitCredits','8','releaseCredits','39',
   'tokens','[{"dimension":"text_input","tokens":"10"},{"dimension":"image_input","tokens":"20"},{"dimension":"text_output","tokens":"0"},{"dimension":"image_output","tokens":"20"}]'::jsonb);
 begin
   perform public.complete_quoted_image_job(ref_job,reclaimed.lease_token,settlement);
   raise exception 'stale lease completed image';
 exception when serialization_failure then null; end;
 begin
   perform public.complete_quoted_image_job(ref_job,claimed.lease_token,settlement||'{"debitCredits":"7","releaseCredits":"40"}'::jsonb);
   raise exception 'incorrect measured price completed';
 exception when check_violation then null; end;
 begin
   perform public.complete_quoted_image_job(ref_job,claimed.lease_token,jsonb_set(settlement,'{tokens,0,tokens}','"9"'));
   raise exception 'incorrect measured tokens completed';
 exception when check_violation then null; end;
 assert (select status='held' from public.funded_usage_quotes where job_id=ref_job);
 assert not exists(select 1 from public.assets where id='e4800000-0000-4000-8000-000000000051');
 assert not exists(select 1 from public.usage_events where ai_job_id=ref_job);
 -- Fail after settlement starts: the asset collision must roll back the release.
 begin
   insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
    values('e4800000-0000-4000-8000-000000000051',w,'cover','Collision fixture',receipt->>'storagePath','image/png',8,repeat('d',64),'draft',u);
   perform public.complete_quoted_image_job(ref_job,claimed.lease_token,settlement);
   raise exception 'asset collision did not abort completion';
 exception when unique_violation then null; end;
 assert (select status='held' from public.funded_usage_quotes where job_id=ref_job),'failed asset write settled hold';
 assert not exists(select 1 from public.credit_ledger where reference_id=ref_job and source='generation_release'),'failed asset write released credits';
 assert (select status='running' from public.ai_jobs where id=ref_job),'failed asset write completed job';
 select * into accepted from public.complete_quoted_image_job(ref_job,claimed.lease_token,settlement);
 assert accepted.status='succeeded';
 assert (select status='settled' from public.funded_usage_quotes where job_id=ref_job);
 assert (select count(*)=1 from public.asset_versions where asset_id='e4800000-0000-4000-8000-000000000051');
 assert (select count(*)=1 from public.ai_runs where ai_job_id=ref_job);
 assert (select count(*)=1 from public.usage_events where ai_job_id=ref_job and meter='token_credits' and quantity=8);
 assert (select count(*)=1 from public.credit_ledger where reference_id=ref_job and source='generation_release' and amount=39);
 perform public.complete_quoted_image_job(ref_job,claimed.lease_token,settlement);
 assert (select count(*)=1 from public.ai_runs where ai_job_id=ref_job),'replayed completion duplicated run';
 assert (select count(*)=2 from public.credit_ledger where reference_id=ref_job),'replayed completion changed ledger';
 begin
   perform public.complete_quoted_image_job(ref_job,claimed.lease_token,settlement||'{"requestId":"changed"}'::jsonb);
   raise exception 'changed completion replay accepted';
 exception when unique_violation then null; end;
end $$;
reset role;
do $$ begin
 begin
   update public.image_quote_snapshots set catalog_version='tampered';
   raise exception 'immutable snapshot changed';
 exception when check_violation then null; end;
end $$;
update public.workspace_members set status='suspended'
 where user_id='e4800000-0000-4000-8000-000000000001';
set local role service_role;
do $$ declare s public.image_quote_snapshots;
begin
 select * into strict s from public.image_quote_snapshots limit 1;
 begin
   perform public.save_image_quote_snapshot(s.user_id,s.workspace_id,s.book_id,s.generation_job_id,
     s.idempotency_key,s.request_sha256,s.request_json,s.catalog_version,s.model_option_id,s.quote_json);
   raise exception 'suspended author recovered private offer through service RPC';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
