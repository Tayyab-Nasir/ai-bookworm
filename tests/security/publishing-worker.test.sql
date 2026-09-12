-- Durable queue leasing, retry/backoff, fencing and dead-letter behavior.
begin;
insert into auth.users(id,email) values
 ('ba000000-0000-4000-8000-000000000001','worker-author@local.test'),
 ('ba000000-0000-4000-8000-000000000002','worker-admin@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('ba100000-0000-4000-8000-000000000001','Worker Org','worker-org','ba000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
 ('ba100000-0000-4000-8000-000000000001','ba000000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('ba200000-0000-4000-8000-000000000001','ba100000-0000-4000-8000-000000000001','Worker Workspace','worker-ws','ba000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('ba200000-0000-4000-8000-000000000001','ba000000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('ba300000-0000-4000-8000-000000000001','ba200000-0000-4000-8000-000000000001','Worker Book','Author','ba000000-0000-4000-8000-000000000001');
insert into public.editions(id,book_id,type,language,edition_metadata_json) values
 ('ba400000-0000-4000-8000-000000000001','ba300000-0000-4000-8000-000000000001','ebook','en','{}');
insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,idempotency_key,created_by,max_attempts,attempts)
select 'ba500000-0000-4000-8000-000000000001','ba300000-0000-4000-8000-000000000001',e.id,'kdp','queued',
 jsonb_build_object('action','validate','editionUpdatedAt',e.updated_at,'bookModelSha256',repeat('a',64)),
 'worker-retry-success','ba000000-0000-4000-8000-000000000001',3,0 from public.editions e where e.id='ba400000-0000-4000-8000-000000000001';
insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,idempotency_key,created_by,max_attempts,attempts)
select 'ba500000-0000-4000-8000-000000000002','ba300000-0000-4000-8000-000000000001',e.id,'kdp','queued',
 jsonb_build_object('action','validate','editionUpdatedAt',e.updated_at,'bookModelSha256',repeat('b',64)),
 'worker-terminal','ba000000-0000-4000-8000-000000000001',3,0 from public.editions e where e.id='ba400000-0000-4000-8000-000000000001';

do $$ begin
 assert not has_function_privilege('authenticated','public.claim_publishing_job(text[],integer)','execute'),'client can claim queue';
 assert has_function_privilege('service_role','public.claim_publishing_job(text[],integer)','execute'),'worker cannot claim queue';
end $$;
set local role authenticated;
set local request.jwt.claims='{"sub":"ba000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
 begin perform public.claim_publishing_job(array['validate'],60); assert false,'authenticated claimed job';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;

do $$
declare first_job public.publishing_jobs; retried public.publishing_jobs; completed public.publishing_jobs; first_token uuid;
begin
 select * into strict first_job from public.claim_publishing_job(array['validate'],60);
 assert first_job.id='ba500000-0000-4000-8000-000000000001' and first_job.attempts=1,'first lease incorrect';
 first_token := first_job.lease_token;
 assert public.renew_publishing_job_lease(first_job.id,first_token,90),'live lease did not renew';
 select * into retried from public.fail_leased_publishing_job(first_job.id,first_token,'temporary_service_failure',true);
 assert retried.status='queued' and retried.attempts=1 and retried.available_at>now(),'retry backoff not persisted';
 update public.publishing_jobs set available_at=now()-interval '1 second' where id=retried.id;
 select * into strict retried from public.claim_publishing_job(array['validate'],60);
 assert retried.id=first_job.id and retried.attempts=2 and retried.lease_token<>first_token,'re-lease not fenced';
 begin
  perform public.complete_leased_publishing_job(retried.id,first_token,
   '{"ruleVersion":"core-1+kdp-1","requestedChannel":"kdp","channel":"kdp","errors":0,"warnings":0,"findings":[]}');
  assert false,'stale worker completed new lease';
 exception when serialization_failure then null; end;
 select * into completed from public.complete_leased_publishing_job(retried.id,retried.lease_token,
  '{"ruleVersion":"core-1+kdp-1","requestedChannel":"kdp","channel":"kdp","errors":0,"warnings":0,"findings":[]}');
 assert completed.status='succeeded' and completed.response_json->>'requestedChannel'='kdp','fenced completion failed';
 assert not public.renew_publishing_job_lease(completed.id,retried.lease_token,60),'completed lease renewed';
 assert (select count(*) from public.activity_events where event_type='edition_validated' and entity_id=completed.edition_id)=1,'completion side effect missing';
end $$;

do $$
declare leased public.publishing_jobs; failed public.publishing_jobs; retried public.publishing_jobs;
begin
 select * into strict leased from public.claim_publishing_job(array['validate'],60);
 assert leased.id='ba500000-0000-4000-8000-000000000002','second job not claimed';
 select * into failed from public.fail_leased_publishing_job(leased.id,leased.lease_token,'invalid_source',false);
 assert failed.status='failed' and failed.response_json->>'deadLettered'='true','terminal failure not recorded';
 assert (select count(*) from public.dead_letter_jobs where job_id=failed.id and error='invalid_source')=1,'dead letter missing';
 select * into retried from public.retry_publishing_job(failed.id,'ba000000-0000-4000-8000-000000000002');
 assert retried.status='queued' and retried.attempts=0 and retried.response_json is null,'manual retry not reset';
 assert (select count(*) from public.audit_logs where action='job.retry' and entity_id=failed.id)=1,'retry audit missing';
 begin perform public.retry_publishing_job(retried.id,'ba000000-0000-4000-8000-000000000002'); assert false,'queued job retried';
 exception when invalid_parameter_value then null; end;
end $$;

-- Expired leases are reclaimed; old tokens cannot fail the replacement lease.
do $$
declare current_job public.publishing_jobs; replacement public.publishing_jobs; old_token uuid;
begin
 select * into strict current_job from public.claim_publishing_job(array['validate'],60);
 old_token:=current_job.lease_token;
 update public.publishing_jobs set lease_expires_at=now()-interval '1 second' where id=current_job.id;
 select * into strict replacement from public.claim_publishing_job(array['validate'],60);
 assert replacement.id=current_job.id and replacement.lease_token<>old_token,'expired job not reclaimed';
 begin perform public.fail_leased_publishing_job(replacement.id,old_token,'late_worker',true); assert false,'old lease mutated replacement';
 exception when serialization_failure then null; end;
end $$;
rollback;
