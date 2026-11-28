begin;
 insert into auth.users(id,email) values('b6000000-0000-4000-8000-000000000001','owner@local.test'),('b6000000-0000-4000-8000-000000000002','member@local.test'),('b6000000-0000-4000-8000-000000000003','outsider@local.test');
 insert into public.organizations(id,name,slug,owner_user_id) values('b6000000-0000-4000-8000-000000000004','Synthetic','audio-receipt-fixture','b6000000-0000-4000-8000-000000000001');
 insert into public.workspaces(id,organization_id,name,slug,created_by) values('b6000000-0000-4000-8000-000000000005','b6000000-0000-4000-8000-000000000004','Synthetic','audio-receipt-fixture','b6000000-0000-4000-8000-000000000001');
 insert into public.workspace_members(workspace_id,user_id,role,status) values('b6000000-0000-4000-8000-000000000005','b6000000-0000-4000-8000-000000000001','owner','active'),('b6000000-0000-4000-8000-000000000005','b6000000-0000-4000-8000-000000000002','viewer','active');
 insert into public.books(id,workspace_id,title,author_name,created_by) values('b6000000-0000-4000-8000-000000000006','b6000000-0000-4000-8000-000000000005','Synthetic','Author','b6000000-0000-4000-8000-000000000001');
 insert into public.editions(id,book_id,type,language,edition_metadata_json) values('b6000000-0000-4000-8000-000000000007','b6000000-0000-4000-8000-000000000006','audiobook','en','{"kind":"audiobook"}');
 insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
 values('b6000000-0000-4000-8000-000000000008','b6000000-0000-4000-8000-000000000005','cover','Synthetic','workspaces/b6000000-0000-4000-8000-000000000005/synthetic.png','image/png',10,repeat('a',64),'draft','b6000000-0000-4000-8000-000000000001');
 insert into public.audiobook_google_play_export_jobs(id,workspace_id,book_id,edition_id,created_by,idempotency_key,identifier,cover_asset_id,snapshot_json,progress_total,status)
 values('b6000000-0000-4000-8000-000000000009','b6000000-0000-4000-8000-000000000005','b6000000-0000-4000-8000-000000000006','b6000000-0000-4000-8000-000000000007','b6000000-0000-4000-8000-000000000001','old-request','SYNTHETIC','b6000000-0000-4000-8000-000000000008','{"chapters":[{}]}',1,'cancelled');
 insert into public.audiobook_google_play_export_jobs(id,workspace_id,book_id,edition_id,created_by,idempotency_key,identifier,cover_asset_id,snapshot_json,progress_total,status) select 'b6000000-0000-4000-8000-000000000010',workspace_id,book_id,edition_id,created_by,'pre-upgrade-deleted',identifier,cover_asset_id,snapshot_json,progress_total,'cancelled' from public.audiobook_google_play_export_jobs where id='b6000000-0000-4000-8000-000000000009';
 delete from public.audiobook_google_play_export_jobs where id='b6000000-0000-4000-8000-000000000010';

-- Simulate a future nullable secret column. Public RPCs must stay allowlisted.
alter table public.audiobook_google_play_export_jobs add column draft_future_secret text;
update public.audiobook_google_play_export_jobs set draft_future_secret='future-sensitive-data';
do $$
declare c text;
begin
  assert not has_table_privilege('authenticated','public.audiobook_google_play_export_jobs','select');
  assert not has_table_privilege('anon','public.audiobook_google_play_export_jobs','select');
  foreach c in array array['id','workspace_id','book_id','edition_id','status','progress_chapters','progress_total','error_code','output_size_bytes','total_duration_seconds','created_at','completed_at'] loop
    assert has_column_privilege('authenticated','public.audiobook_google_play_export_jobs',c,'select'), 'missing safe grant ' || c;
    assert not has_column_privilege('anon','public.audiobook_google_play_export_jobs',c,'select'), 'anon has grant ' || c;
    assert has_column_privilege('service_role','public.audiobook_google_play_export_jobs',c,'select'), 'worker missing ' || c;
  end loop;
  foreach c in array array['created_by','idempotency_key','identifier','cover_asset_id','snapshot_json','attempts','available_at','lease_token','lease_expires_at','cancellation_requested_at','output_storage_path','output_sha256','started_at'] loop
    assert not has_column_privilege('authenticated','public.audiobook_google_play_export_jobs',c,'select'), 'leaked ' || c;
    assert not has_column_privilege('anon','public.audiobook_google_play_export_jobs',c,'select'), 'anon leaked ' || c;
    assert has_column_privilege('service_role','public.audiobook_google_play_export_jobs',c,'select'), 'worker missing ' || c;
  end loop;
  assert not has_column_privilege('authenticated','public.audiobook_google_play_export_jobs','draft_future_secret','select');
  assert not has_column_privilege('anon','public.audiobook_google_play_export_jobs','draft_future_secret','select');
  assert not has_function_privilege('authenticated','private.audio_export_queue_unredacted_v1(uuid,text,uuid,text)','execute');
  assert not has_function_privilege('authenticated','private.audio_export_cancel_unredacted_v1(uuid)','execute');
  assert not has_function_privilege('authenticated','private.audio_export_public_v1(public.audiobook_google_play_export_jobs)','execute');
  assert not has_function_privilege('anon','public.queue_audiobook_google_play_export(uuid,text,uuid,text)','execute');
  assert not has_function_privilege('anon','public.cancel_audiobook_google_play_export(uuid)','execute');
  assert has_function_privilege('authenticated','public.queue_audiobook_google_play_export(uuid,text,uuid,text)','execute');
  assert has_function_privilege('authenticated','public.cancel_audiobook_google_play_export(uuid)','execute');
  assert has_function_privilege('authenticated','public.get_audiobook_google_play_export(uuid)','execute');
  assert has_function_privilege('service_role','public.claim_audiobook_google_play_export(integer)','execute');
end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub":"b6000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare j public.audiobook_google_play_export_jobs; serialized json;
begin
  assert (select count(id)=1 from public.audiobook_google_play_export_jobs where book_id='b6000000-0000-4000-8000-000000000006');
  begin perform lease_token from public.audiobook_google_play_export_jobs; raise exception 'protected lease selected'; exception when insufficient_privilege then null; end;
  begin perform idempotency_key from public.audiobook_google_play_export_jobs; raise exception 'protected key selected'; exception when insufficient_privilege then null; end;
  begin perform identifier from public.audiobook_google_play_export_jobs; raise exception 'protected identifier selected'; exception when insufficient_privilege then null; end;
  begin perform snapshot_json from public.audiobook_google_play_export_jobs; raise exception 'protected snapshot selected'; exception when insufficient_privilege then null; end;
  begin perform output_storage_path from public.audiobook_google_play_export_jobs; raise exception 'protected path selected'; exception when insufficient_privilege then null; end;
  begin perform t.* from public.audiobook_google_play_export_jobs t; raise exception 'table star selected'; exception when insufficient_privilege then null; end;
  select * into j from public.queue_audiobook_google_play_export('b6000000-0000-4000-8000-000000000007','SYNTHETIC','b6000000-0000-4000-8000-000000000008','old-request');
  assert j.id='b6000000-0000-4000-8000-000000000009' and j.status='cancelled';
  assert j.created_by is null and j.idempotency_key is null and j.identifier is null and j.cover_asset_id is null and j.snapshot_json is null
    and j.lease_token is null and j.lease_expires_at is null and j.output_storage_path is null and j.output_sha256 is null;
  serialized := row_to_json(j); assert serialized->>'identifier' is null and serialized->>'snapshot_json' is null and serialized->>'idempotency_key' is null and serialized->>'draft_future_secret' is null;
  select * into j from public.cancel_audiobook_google_play_export(j.id);
  assert j.id='b6000000-0000-4000-8000-000000000009' and j.idempotency_key is null and j.snapshot_json is null and j.output_storage_path is null and to_jsonb(j)->>'draft_future_secret' is null;
  select * into j from public.get_audiobook_google_play_export(j.id);
  assert j.id='b6000000-0000-4000-8000-000000000009' and j.idempotency_key is null and j.snapshot_json is null and j.output_storage_path is null;
  begin perform private.audio_export_queue_unredacted_v1('b6000000-0000-4000-8000-000000000007','SYNTHETIC','b6000000-0000-4000-8000-000000000008','old-request'); raise exception 'called private queue'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims = '{"sub":"b6000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
begin
  assert (select count(id)=1 from public.audiobook_google_play_export_jobs where book_id='b6000000-0000-4000-8000-000000000006');
  assert (select (public.get_audiobook_google_play_export('b6000000-0000-4000-8000-000000000009')).id)='b6000000-0000-4000-8000-000000000009';
  begin perform public.queue_audiobook_google_play_export('b6000000-0000-4000-8000-000000000007','SYNTHETIC','b6000000-0000-4000-8000-000000000008','old-request'); raise exception 'viewer queued'; exception when insufficient_privilege then null; end;
  begin perform public.cancel_audiobook_google_play_export('b6000000-0000-4000-8000-000000000009'); raise exception 'viewer cancelled'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims = '{"sub":"b6000000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$
begin
  assert (select count(id)=0 from public.audiobook_google_play_export_jobs), 'outsider saw row';
  assert (select (public.get_audiobook_google_play_export('b6000000-0000-4000-8000-000000000009')).id) is null;
  begin perform public.cancel_audiobook_google_play_export('b6000000-0000-4000-8000-000000000009'); raise exception 'outsider cancelled'; exception when no_data_found then null; end;
end $$;
reset role;
set local role service_role;
do $$
declare j public.audiobook_google_play_export_jobs;
begin
  select * into strict j from public.audiobook_google_play_export_jobs where id='b6000000-0000-4000-8000-000000000009';
  assert j.idempotency_key='old-request' and j.identifier='SYNTHETIC' and j.snapshot_json is not null and j.created_by is not null;
  update public.audiobook_google_play_export_jobs set status='running',lease_token='b6000000-0000-4000-8000-000000000011',lease_expires_at=clock_timestamp()+interval '5 minutes' where id=j.id;
  assert public.progress_audiobook_google_play_export(j.id,'b6000000-0000-4000-8000-000000000011',1);
end $$;
rollback;
