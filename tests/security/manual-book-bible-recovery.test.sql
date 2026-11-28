-- Real table/RPC boundary assertions. No hosted database or provider is used.
begin;
insert into auth.users(id,email) values
 ('b1300000-0000-4000-8000-000000000001','manual-bible-owner@local.test'),
 ('b1300000-0000-4000-8000-000000000002','manual-bible-editor@local.test'),
 ('b1300000-0000-4000-8000-000000000003','manual-bible-viewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id)
 values('b1300000-0000-4000-8000-000000000004','Manual Bible','manual-bible','b1300000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by)
 values('b1300000-0000-4000-8000-000000000005','b1300000-0000-4000-8000-000000000004','Manual Bible','manual-bible','b1300000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role,status) values
 ('b1300000-0000-4000-8000-000000000005','b1300000-0000-4000-8000-000000000001','owner','active'),
 ('b1300000-0000-4000-8000-000000000005','b1300000-0000-4000-8000-000000000002','editor','active'),
 ('b1300000-0000-4000-8000-000000000005','b1300000-0000-4000-8000-000000000003','viewer','active');
insert into public.books(id,workspace_id,title,author_name,created_by)
 values('b1300000-0000-4000-8000-000000000006','b1300000-0000-4000-8000-000000000005','Manual canon','Author','b1300000-0000-4000-8000-000000000001');
set local request.jwt.claim.role='service_role';
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
 values('b1300000-0000-4000-8000-000000000007','b1300000-0000-4000-8000-000000000005','image','Cleared image','bible/image.png','image/png',128,repeat('a',64),'b1300000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
 values('b1300000-0000-4000-8000-000000000007',1,'bible/image.png',repeat('a',64),'image/png',128,'b1300000-0000-4000-8000-000000000001');
set local request.jwt.claim.role='';
set local role authenticated;
set local request.jwt.claims='{"sub":"b1300000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare b uuid:='b1300000-0000-4000-8000-000000000006'; r jsonb; replay jsonb; changed jsonb;
 item uuid; ts timestamptz; inc uuid; c uuid; v uuid; body jsonb; bad jsonb; before_count integer; old_row public.book_bible_items;
begin
 r:=public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000010');
 assert r='{"receipt":null,"disposition":null,"item":null,"replayed":false,"closed":false,"closure":null}'::jsonb,'missing recovery was not read-only empty evidence';
 r:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000010','create',p_body=>jsonb_build_object('type','character','name',chr(160)||'Elara'||chr(65279)));
 item:=(r#>>'{receipt,itemId}')::uuid; ts:=(r#>>'{item,updated_at}')::timestamptz;
 inc:=(r#>>'{item,mutation_incarnation_id}')::uuid;
 assert r->>'disposition'='unchanged' and r->>'replayed'='false' and r#>>'{item,name}'='Elara','first create did not observe its own saved row';
 assert r#>'{item,attributes_json}'='{"imageAssetIds":[]}'::jsonb and r#>'{item,source_refs_json}'='[]'::jsonb,'defaults differ from API';
 assert r#>>'{receipt,intentHash}' ~ '^[a-f0-9]{64}$' and r#>>'{receipt,resultHash}' ~ '^[a-f0-9]{64}$','receipt hashes missing';
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000010','create',p_body=>' {"sourceRefs":[],"name":"Elara","attributes":{},"description":"","imageAssetIds":[],"type":"character"}');
 assert replay->'receipt'=r->'receipt' and replay->>'replayed'='true' and replay->>'disposition'='unchanged','normalized replay was not stable';
 assert (select count(*) from public.book_bible_items where book_id=b)=1,'same request inserted duplicate canon';
 begin
  perform public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000010','create',p_body=>'{"type":"character","name":"Other"}');
  assert false,'changed intent reused an original request';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'update',item,ts,'{"type":"character","name":"Missing incarnation"}');
  assert false,'update accepted missing incarnation';
 exception when invalid_parameter_value then null; end;
 changed:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000011','update',item,ts,'{"type":"character","name":"Elara revised"}',inc);
 assert changed->>'disposition'='unchanged' and changed->>'replayed'='false' and changed#>>'{item,name}'='Elara revised','first update did not observe its own write';
 assert (changed#>>'{receipt,resultUpdatedAt}')::timestamptz>ts,'update did not advance its revision';
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000011','update',item,ts,'{"type":"character","name":"Elara revised"}',inc);
 assert replay->'receipt'=changed->'receipt' and replay->>'replayed'='true' and replay->>'disposition'='unchanged','same update request was not replayed';
 replay:=public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000010');
 assert replay->'receipt'=r->'receipt' and replay->>'disposition'='changed' and replay#>>'{item,name}'='Elara revised','recovery replaced original evidence or returned stale canon';
 begin
  perform public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000012','update',item,ts,'{"type":"character","name":"Stale"}',inc);
  assert false,'stale update overwrote canon';
 exception when serialization_failure then null; end;
 ts:=(changed#>>'{item,updated_at}')::timestamptz;
 changed:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000013','delete',item,ts,p_expected_incarnation_id=>inc);
 assert changed->>'disposition'='deleted' and changed->'item'='null'::jsonb and changed->>'replayed'='false','first delete did not observe its own deletion';
 assert (changed#>>'{receipt,resultUpdatedAt}')::timestamptz=ts,'delete receipt lost removed-row revision';
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000013','delete',item,ts,'{}',inc);
 assert replay->'receipt'=changed->'receipt' and replay->>'replayed'='true','delete did not replay after target removal';
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000010','create',p_body=>'{"type":"character","name":"Elara"}');
 assert replay->>'disposition'='deleted' and (select count(*) from public.book_bible_items where book_id=b)=0,'create replay recreated a deleted entry';
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000011','update',item,(r#>>'{item,updated_at}')::timestamptz,'{"type":"character","name":"Elara revised"}',inc);
 assert replay->>'disposition'='deleted' and replay->>'replayed'='true' and (select count(*) from public.book_bible_items where book_id=b)=0,'update replay recreated a deleted entry';
 insert into public.book_bible_items(id,book_id,type,name) values(item,b,'character','Recreated directly');
 replay:=public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000013');
 assert replay->>'disposition'='changed' and replay#>>'{item,name}'='Recreated directly','delete recovery called a recreated UUID unchanged';
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000013','delete',item,ts,p_expected_incarnation_id=>inc);
 assert replay->>'disposition'='changed' and exists(select 1 from public.book_bible_items where id=item),'delete replay erased a recreated UUID';

 r:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000018','create',p_body=>'{"type":"fact","name":"Exact clone"}');
 select * into old_row from public.book_bible_items where id=(r#>>'{receipt,itemId}')::uuid;
 delete from public.book_bible_items where id=old_row.id;
 insert into public.book_bible_items select (old_row).*;
 assert (select mutation_incarnation_id from public.book_bible_items where id=old_row.id)<>old_row.mutation_incarnation_id,'client cloned server incarnation on insert';
 replay:=public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000018');
 assert replay->>'disposition'='changed','create receipt called exact field/timestamp recreation unchanged';
 begin
  update public.book_bible_items set mutation_incarnation_id=old_row.mutation_incarnation_id where id=old_row.id;
  assert false,'client could overwrite server incarnation';
 exception when insufficient_privilege then null; end;
 select * into old_row from public.book_bible_items where id=old_row.id;
 r:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000019','update',old_row.id,old_row.updated_at,'{"type":"fact","name":"Exact updated clone"}',old_row.mutation_incarnation_id);
 select * into old_row from public.book_bible_items where id=old_row.id;
 delete from public.book_bible_items where id=old_row.id;
 insert into public.book_bible_items select (old_row).*;
 assert public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000019')->>'disposition'='changed','update receipt called exact recreation unchanged';

 -- A fresh first write cannot overwrite a copied/recreated UUID, even if
 -- supplied its current timestamp. Original incarnation is part of intent.
 select updated_at into ts from public.book_bible_items where id=old_row.id;
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'update',old_row.id,ts,'{"type":"fact","name":"Wrong incarnation"}',old_row.mutation_incarnation_id);
  assert false,'first update overwrote a recreated incarnation';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'delete',old_row.id,ts,p_expected_incarnation_id=>old_row.mutation_incarnation_id);
  assert false,'first delete erased a recreated incarnation';
 exception when serialization_failure then null; end;
 select * into old_row from public.book_bible_items where id=old_row.id;
 update public.book_bible_items set name='Later direct canon',updated_at='infinity' where id=old_row.id;
 assert (select isfinite(updated_at) and updated_at>old_row.updated_at and mutation_incarnation_id=old_row.mutation_incarnation_id from public.book_bible_items where id=old_row.id),
   'direct update retained caller-controlled or non-monotonic revision';
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'update',old_row.id,old_row.updated_at,'{"type":"fact","name":"Stale direct update"}',old_row.mutation_incarnation_id);
  assert false,'first update overwrote later direct canon';
 exception when serialization_failure then null; end;
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'delete',old_row.id,old_row.updated_at,p_expected_incarnation_id=>old_row.mutation_incarnation_id);
  assert false,'first delete erased later direct canon';
 exception when serialization_failure then null; end;
 assert (select name from public.book_bible_items where id=old_row.id)='Later direct canon','rejected CAS changed canon';

 -- Canon defaults, strict keys, reserved names and UTF-16 bounds apply at SQL too.
 select count(*) into before_count from public.book_bible_items where book_id=b;
 for bad in select value from jsonb_array_elements('[{"type":"character","name":"X","unknown":1},{"type":"nope","name":"X"},{"type":"fact","name":" "},{"type":"fact","name":"X","description":null},{"type":"fact","name":"X","attributes":{"constructor":1}},{"type":"fact","name":"X","attributes":{"imageAssetIds":[]}},{"type":"fact","name":"X","imageAssetIds":["invalid"]},{"type":"fact","name":"X","sourceRefs":[{"chapterId":"invalid"}]}]') loop
  begin
   perform public.mutate_book_bible_item(b,gen_random_uuid(),'create',p_body=>bad);
   assert false,'malformed SQL body was accepted';
  exception when invalid_parameter_value then null; end;
 end loop;
 for bad in select jsonb_build_object('type','fact','name',repeat(chr(128640),81)) union all
   select jsonb_build_object('type','fact','name','X','description',repeat(chr(128640),6001)) union all
   select jsonb_build_object('type','fact','name','X','attributes',jsonb_build_object('x',repeat('x',24000))) union all
   select jsonb_build_object('type','fact','name','X','imageAssetIds',(select jsonb_agg('b1300000-0000-4000-8000-000000000007'::text) from generate_series(1,21))) union all
   select jsonb_build_object('type','fact','name','X','sourceRefs',(select jsonb_agg(jsonb_build_object('chapterId',b)) from generate_series(1,31))) loop
  begin
   perform public.mutate_book_bible_item(b,gen_random_uuid(),'create',p_body=>bad);
   assert false,'SQL field limit was not enforced';
  exception when invalid_parameter_value then null; end;
 end loop;
 assert (select count(*) from public.book_bible_items where book_id=b)=before_count,'rejected bodies changed canon';
 r:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000014','create',p_body=>jsonb_build_object('type','fact','name',repeat(chr(128640),80)));
 assert length(r#>>'{item,name}')=80,'SQL UTF-16 boundary rejected a valid name';

 select id into c from public.create_book_chapters(b,'[{"title":"Arrival","nodes":[{"id":"n1","type":"paragraph","text":"Elara carries a silver compass."}]}]');
 select current_document_version_id into v from public.chapters where id=c;
 body:=jsonb_build_object('type','object','name','Compass','imageAssetIds',jsonb_build_array('b1300000-0000-4000-8000-000000000007','b1300000-0000-4000-8000-000000000007'),
  'sourceRefs',jsonb_build_array(jsonb_build_object('chapterId',c,'nodeId','n1','note','  Evidence  ')));
 r:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000015','create',p_body=>body);
 assert r#>>'{item,source_refs_json,0,documentVersionId}'=v::text and r#>>'{item,source_refs_json,0,textHash}'=encode(digest('Elara carries a silver compass.','sha256'),'hex'),'implicit source version/hash was not pinned';
 assert r#>>'{item,source_refs_json,0,note}'='Evidence' and jsonb_array_length(r#>'{item,attributes_json,imageAssetIds}')=1,'source/image normalization differs';
 update public.chapters set current_document_version_id=null where id=c;
 replay:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000015','create',p_body=>body);
 assert replay->'receipt'=r->'receipt' and replay->>'replayed'='true' and replay#>>'{item,source_refs_json,0,documentVersionId}'=v::text,'replay dynamically repinned original intent';
 for bad in select jsonb_build_object('chapterId',c,'nodeId','n1','textHash',repeat('A',64)) union all
   select jsonb_build_object('chapterId',c,'textHash',repeat('a',64)) union all
   select jsonb_build_object('chapterId',c,'nodeId',repeat('n',201)) union all
   select jsonb_build_object('chapterId',c,'note',repeat('n',501)) union all
   select jsonb_build_object('chapterId',c,'unknown',1) union all
   select jsonb_build_object('chapterId',c,'documentVersionId',v,'nodeId','missing') union all
   select jsonb_build_object('chapterId',c,'documentVersionId',v,'nodeId','n1','textHash',repeat('0',64)) loop
  begin
   perform public.mutate_book_bible_item(b,gen_random_uuid(),'create',p_body=>jsonb_build_object('type','fact','name','Bad source','sourceRefs',jsonb_build_array(bad)));
   assert false,'invalid source was accepted';
  exception when invalid_parameter_value then null; end;
 end loop;
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'create',p_body=>body);
  assert false,'fresh request accepted unavailable implicit current version';
 exception when invalid_parameter_value then null; end;
 perform set_config('request.jwt.claims','{"sub":"b1300000-0000-4000-8000-000000000002","role":"authenticated"}',true);
 replay:=public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000015');
 assert replay->'receipt'='null'::jsonb,'same-workspace editor exposed another actor receipt';
 perform set_config('request.jwt.claims','{"sub":"b1300000-0000-4000-8000-000000000003","role":"authenticated"}',true);
 begin
  perform public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000015');
  assert false,'viewer recovered editor evidence';
 exception when insufficient_privilege then null; end;
 begin
  perform public.mutate_book_bible_item(b,gen_random_uuid(),'create',p_body=>'{"type":"fact","name":"Denied"}');
  assert false,'viewer mutated canon';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims','{"sub":"b1300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
 begin
  perform public.recover_book_bible_mutation('b1300000-0000-4000-8000-000000000099',gen_random_uuid());
  assert false,'missing book did not return P0002';
 exception when no_data_found then null; end;
 begin
  perform count(*) from bookworm_private.book_bible_mutation_receipts;
  assert false,'authenticated actor directly read private receipts';
 exception when insufficient_privilege then null; end;
end $$;
reset role;

-- A cleared old version cannot bless current replaced bytes; replay precedes
-- source/image validation and still returns the immutable original receipt.
set local request.jwt.claim.role='';
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
 values('b1300000-0000-4000-8000-000000000007',2,'bible/replaced.png',repeat('b',64),'image/png',128,'b1300000-0000-4000-8000-000000000001');
update public.assets set storage_path='bible/replaced.png',checksum=repeat('b',64) where id='b1300000-0000-4000-8000-000000000007';
set local role authenticated;
set local request.jwt.claims='{"sub":"b1300000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare b uuid:='b1300000-0000-4000-8000-000000000006'; body jsonb;
begin
 body:=jsonb_build_object('type','fact','name','Unsafe image','imageAssetIds',jsonb_build_array('b1300000-0000-4000-8000-000000000007'));
 begin
  perform public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000016','create',p_body=>body);
  assert false,'older cleared version blessed current quarantined bytes';
 exception when invalid_parameter_value then null; end;
 assert public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000016')->'receipt'='null'::jsonb,'failed validation created a receipt';
end $$;
reset role;
do $$ begin
 assert not has_table_privilege('authenticated','bookworm_private.book_bible_mutation_receipts','SELECT'), 'private receipt select grant leaked';
 assert not has_table_privilege('service_role','bookworm_private.book_bible_mutation_receipts','INSERT'), 'private receipt service insert grant leaked';
 assert not has_function_privilege('anon','public.mutate_book_bible_item(uuid,uuid,text,uuid,timestamptz,jsonb,uuid)','EXECUTE'), 'anonymous mutate grant leaked';
 begin
  update bookworm_private.book_bible_mutation_receipts set intent_hash=repeat('0',64);
  assert false,'private receipt could be updated';
 exception when insufficient_privilege then null; end;
 begin
  delete from bookworm_private.book_bible_mutation_receipts;
  assert false,'private receipt could be deleted';
 exception when insufficient_privilege then null; end;
end $$;

-- Force the final receipt insert to fail: even an already-inserted canon row
-- and its retrieval triggers must roll back in the same statement.
create function bookworm_private.test_reject_manual_receipt() returns trigger language plpgsql as $$
begin raise exception 'synthetic receipt failure' using errcode='23514'; end $$;
create trigger test_reject_manual_receipt before insert on bookworm_private.book_bible_mutation_receipts
 for each row when (new.request_id='b1300000-0000-4000-8000-000000000017'::uuid) execute function bookworm_private.test_reject_manual_receipt();
set local role authenticated;
set local request.jwt.claims='{"sub":"b1300000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare b uuid:='b1300000-0000-4000-8000-000000000006'; before_count integer;
begin
 select count(*) into before_count from public.book_bible_items where book_id=b;
 begin
  perform public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000017','create',p_body=>'{"type":"fact","name":"Must roll back"}');
  assert false,'synthetic receipt failure did not fail';
 exception when check_violation then null; end;
 assert (select count(*) from public.book_bible_items where book_id=b)=before_count,'failed receipt left a canon write';
 assert public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000017')->'receipt'='null'::jsonb,'failed receipt left commit evidence';
end $$;
reset role;
drop trigger test_reject_manual_receipt on bookworm_private.book_bible_mutation_receipts;
drop function bookworm_private.test_reject_manual_receipt();

-- Closure is explicit durable evidence, not an inference from missing evidence.
set local role authenticated;
set local request.jwt.claims='{"sub":"b1300000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare b uuid:='b1300000-0000-4000-8000-000000000006'; q uuid:='b1300000-0000-4000-8000-000000000020'; r jsonb;
begin
 begin
  perform public.mutate_book_bible_item(b,q,'create',p_body=>'{"type":"fact","name":" "}');
  assert false,'invalid original request unexpectedly committed';
 exception when invalid_parameter_value then null; end;
 r:=public.recover_book_bible_mutation(b,q);
 assert r->>'closed'='false' and r->'receipt'='null'::jsonb,'a rejected write cannot silently close its key';
 r:=public.close_book_bible_mutation(b,q);
 assert r-'closure'='{"receipt":null,"disposition":null,"item":null,"replayed":false,"closed":true}'::jsonb,'explicit closure invented a canon receipt';
 assert r#>>'{closure,requestId}'=q::text and r#>>'{closure,bookId}'=b::text and (r#>>'{closure,closedAt}')::timestamptz is not null,'closure proof lost its immutable identity';
 assert public.close_book_bible_mutation(b,q)=r and public.recover_book_bible_mutation(b,q)=r,'lost closure reply is not durable or closure is not replayable';
 begin
  perform public.mutate_book_bible_item(b,q,'create',p_body=>'{"type":"fact","name":"Late original request"}');
  assert false,'a closed UUID could write canon';
 exception when object_not_in_prerequisite_state then null; end;
 r:=public.mutate_book_bible_item(b,'b1300000-0000-4000-8000-000000000021','create',p_body=>'{"type":"fact","name":"Corrected explicit new request"}');
 assert r->>'closed'='false' and r->>'disposition'='unchanged','confirmed closure did not permit an explicit corrected request';
 assert public.close_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000021')->'receipt'=r->'receipt','closure undid a committed request instead of recovering it';
 begin
  perform public.close_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000022');
  raise exception 'force rollback closure' using errcode='P0001';
 exception when raise_exception then null; end;
 assert public.recover_book_bible_mutation(b,'b1300000-0000-4000-8000-000000000022')->>'closed'='false','rolled-back closure left false evidence';
 perform set_config('request.jwt.claims','{"sub":"b1300000-0000-4000-8000-000000000002","role":"authenticated"}',true);
 assert public.recover_book_bible_mutation(b,q)->>'closed'='false','another editor exposed private closure evidence';
 perform set_config('request.jwt.claims','{"sub":"b1300000-0000-4000-8000-000000000003","role":"authenticated"}',true);
 begin
  perform public.close_book_bible_mutation(b,q);
  assert false,'viewer could close an editor request';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 assert not has_table_privilege('authenticated','bookworm_private.book_bible_request_closures','SELECT'),'closure evidence leaked';
 assert not has_function_privilege('anon','public.close_book_bible_mutation(uuid,uuid)','EXECUTE'),'anonymous closure grant leaked';
 begin update bookworm_private.book_bible_request_closures set closed_at=clock_timestamp(); assert false,'closure mutable'; exception when insufficient_privilege then null; end;
 begin delete from bookworm_private.book_bible_request_closures; assert false,'closure deletable'; exception when insufficient_privilege then null; end;
end $$;
-- No FKs or retention cleanup erase receipt evidence on book deletion.
delete from public.books where id='b1300000-0000-4000-8000-000000000006';
do $$ begin
 assert (select count(*) from bookworm_private.book_bible_mutation_receipts where book_id='b1300000-0000-4000-8000-000000000006')=8,'book deletion erased durable receipts';
 assert (select count(*) from bookworm_private.book_bible_request_closures where book_id='b1300000-0000-4000-8000-000000000006')=1,'book deletion erased closure evidence';
end $$;
rollback;
