begin;
insert into auth.users(id,email) values
 ('c8000000-0000-4000-8000-000000000001','job-owner@local.test'),
 ('d8000000-0000-4000-8000-000000000001','job-outsider@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('c8000000-0000-4000-8000-000000000002','Job Org','job-org','c8000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role) values
 ('c8000000-0000-4000-8000-000000000002','c8000000-0000-4000-8000-000000000001','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('c8000000-0000-4000-8000-000000000003','c8000000-0000-4000-8000-000000000002','Job Workspace','job-ws','c8000000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('c8000000-0000-4000-8000-000000000003','c8000000-0000-4000-8000-000000000001','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('c8000000-0000-4000-8000-000000000004','c8000000-0000-4000-8000-000000000003','Queued Story','Author','c8000000-0000-4000-8000-000000000001');
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by) values
 ('c8000000-0000-4000-8000-000000000005','c8000000-0000-4000-8000-000000000003','manuscript','source.txt','workspaces/c8000000-0000-4000-8000-000000000003/assets/c8000000-0000-4000-8000-000000000005/v1/source.txt','text/plain',100,'pending','c8000000-0000-4000-8000-000000000001'),
 ('c8000000-0000-4000-8000-000000000006','c8000000-0000-4000-8000-000000000003','manuscript','source2.docx','workspaces/c8000000-0000-4000-8000-000000000003/assets/c8000000-0000-4000-8000-000000000006/v1/source.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'pending','c8000000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by) values
 ('c8000000-0000-4000-8000-000000000005',1,'workspaces/c8000000-0000-4000-8000-000000000003/assets/c8000000-0000-4000-8000-000000000005/v1/source.txt','pending','text/plain',100,'c8000000-0000-4000-8000-000000000001'),
 ('c8000000-0000-4000-8000-000000000006',1,'workspaces/c8000000-0000-4000-8000-000000000003/assets/c8000000-0000-4000-8000-000000000006/v1/source.docx','pending','application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'c8000000-0000-4000-8000-000000000001');
set local role service_role;
select public.record_asset_scan_verdict('c8000000-0000-4000-8000-000000000005',1,'clean',repeat('a',64),'text/plain',100,'fixture','v1',null);
select public.record_asset_scan_verdict('c8000000-0000-4000-8000-000000000006',1,'clean',repeat('b',64),'application/vnd.openxmlformats-officedocument.wordprocessingml.document',100,'fixture','v1',null);

do $$ declare actor uuid := 'c8000000-0000-4000-8000-000000000001';
 book uuid := 'c8000000-0000-4000-8000-000000000004'; source uuid := 'c8000000-0000-4000-8000-000000000005';
 first_job public.manuscript_import_jobs; replay public.manuscript_import_jobs; claimed public.manuscript_import_jobs; result jsonb;
begin
 assert not has_function_privilege('authenticated','public.enqueue_manuscript_import(uuid,uuid,uuid)','execute'), 'client can enqueue with chosen actor';
 assert has_column_privilege('authenticated','public.manuscript_import_jobs','status','select'), 'member cannot read safe status';
 assert not has_column_privilege('authenticated','public.manuscript_import_jobs','source_checksum','select'), 'client can read checksum';
 select * into first_job from public.enqueue_manuscript_import(actor,book,source);
 select * into replay from public.enqueue_manuscript_import(actor,book,source);
 assert first_job.id=replay.id and first_job.status='queued', 'enqueue is not idempotent';
 begin
   perform public.enqueue_manuscript_import('d8000000-0000-4000-8000-000000000001',book,source);
   assert false, 'outsider actor queued import';
 exception when insufficient_privilege then null; end;
 select * into claimed from public.claim_manuscript_import(30);
 assert claimed.id=first_job.id and claimed.status='running' and claimed.attempts=1 and claimed.lease_token is not null, 'job not claimed';
 assert public.renew_manuscript_import_lease(claimed.id,claimed.lease_token,30), 'lease did not renew';
 result := public.complete_leased_manuscript_import(claimed.id,claimed.lease_token,
   '[{"title":"Opening","nodes":[{"id":"e8000000-0000-4000-8000-000000000001","type":"paragraph","text":"Queued text"}]}]',
   '[]','{"warnings":[],"chapterCount":1,"imageCount":0}');
 assert result->>'sourceAssetId'=source::text and jsonb_array_length(result->'chapters')=1, 'receipt not committed';
 assert (select status from public.manuscript_import_jobs where id=claimed.id)='succeeded', 'job not completed';
 assert (select count(*) from public.chapters where book_id=book)=1, 'chapter missing';
 begin
   perform public.complete_leased_manuscript_import(claimed.id,'f8000000-0000-4000-8000-000000000001','[]','[]','{}');
   assert false, 'wrong lease replayed result';
 exception when serialization_failure then null; end;
 delete from public.manuscript_import_jobs where id=claimed.id;
 select * into replay from public.enqueue_manuscript_import(actor,book,source);
 assert replay.status='succeeded' and replay.completed_at is not null, 'existing receipt did not finish enqueue immediately';
end $$;

do $$ declare actor uuid := 'c8000000-0000-4000-8000-000000000001';
 job public.manuscript_import_jobs; claimed public.manuscript_import_jobs; failed public.manuscript_import_jobs; retried public.manuscript_import_jobs;
begin
 select * into job from public.enqueue_manuscript_import(actor,'c8000000-0000-4000-8000-000000000004','c8000000-0000-4000-8000-000000000006');
 select * into claimed from public.claim_manuscript_import(30);
 select * into failed from public.fail_manuscript_import(claimed.id,claimed.lease_token,'document_source_rejected',false);
 assert failed.status='failed' and failed.completed_at is not null, 'terminal failure not saved';
 assert exists(select 1 from public.dead_letter_jobs where job_id=claimed.id and error='document_source_rejected'), 'DLQ missing';
 select * into retried from public.retry_manuscript_import(claimed.id,actor);
 assert retried.status='queued' and retried.attempts=0 and retried.error_code is null, 'manual retry not reset';
 assert exists(select 1 from public.audit_logs where entity_id=claimed.id and action='job.retry'), 'retry audit missing';
end $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c8000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin assert (select count(*) from public.manuscript_import_jobs)=2, 'member cannot list own jobs'; end $$;
set local request.jwt.claims = '{"sub":"d8000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin assert not exists(select 1 from public.manuscript_import_jobs), 'outsider sees jobs'; end $$;
rollback;
