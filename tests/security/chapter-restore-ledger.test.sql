-- Synthetic only. All fixture data and grant mutations roll back.
begin;
insert into auth.users(id,email) values
 ('a4900000-0000-4000-8000-000000000001','restore-owner@local.test'),
 ('a4900000-0000-4000-8000-000000000002','restore-editor@local.test'),
 ('a4900000-0000-4000-8000-000000000003','restore-viewer@local.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('b4900000-0000-4000-8000-000000000001','Restore test','restore-test','a4900000-0000-4000-8000-000000000001');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('c4900000-0000-4000-8000-000000000001','b4900000-0000-4000-8000-000000000001','Restore test','restore-test','a4900000-0000-4000-8000-000000000001');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('c4900000-0000-4000-8000-000000000001','a4900000-0000-4000-8000-000000000001','owner'),
 ('c4900000-0000-4000-8000-000000000001','a4900000-0000-4000-8000-000000000002','editor'),
 ('c4900000-0000-4000-8000-000000000001','a4900000-0000-4000-8000-000000000003','viewer');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('d4900000-0000-4000-8000-000000000001','c4900000-0000-4000-8000-000000000001','Synthetic','Author','a4900000-0000-4000-8000-000000000001');
insert into public.chapters(id,book_id,order_index,title) values
 ('e4900000-0000-4000-8000-000000000001','d4900000-0000-4000-8000-000000000001',1,'Save'),
 ('e4900000-0000-4000-8000-000000000002','d4900000-0000-4000-8000-000000000001',2,'Close'),
 ('e4900000-0000-4000-8000-000000000003','d4900000-0000-4000-8000-000000000001',3,'Direct'),
 ('e4900000-0000-4000-8000-000000000004','d4900000-0000-4000-8000-000000000001',4,'Bad asset');
set local request.jwt.claims='{"role":"service_role"}';
insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,created_by)
 values('f4900000-0000-4000-8000-000000000001','c4900000-0000-4000-8000-000000000001','source','Synthetic asset',
 'synthetic/source.pdf','application/pdf',10,repeat('a',64),'a4900000-0000-4000-8000-000000000001');
insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
 values('f4900000-0000-4000-8000-000000000001',1,'synthetic/source.pdf',repeat('a',64),'application/pdf',10,'a4900000-0000-4000-8000-000000000001');
insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by) values
 ('04900000-0000-4000-8000-000000000001','e4900000-0000-4000-8000-000000000001',1,
  '{"schemaVersion":"1.0","nodes":[{"id":"p","type":"paragraph","text":"Saved","assetId":"f4900000-0000-4000-8000-000000000001"}]}','Saved',1,'a4900000-0000-4000-8000-000000000001'),
 ('04900000-0000-4000-8000-000000000002','e4900000-0000-4000-8000-000000000002',1,
  '{"schemaVersion":"1.0","nodes":[{"id":"p","type":"paragraph","text":"Close"}]}','Close',1,'a4900000-0000-4000-8000-000000000001'),
 ('04900000-0000-4000-8000-000000000003','e4900000-0000-4000-8000-000000000003',1,
  '{"schemaVersion":"1.0","nodes":[{"id":"p","type":"paragraph","text":"Direct"}]}','Direct',1,'a4900000-0000-4000-8000-000000000001'),
 ('04900000-0000-4000-8000-000000000004','e4900000-0000-4000-8000-000000000004',1,
  '{"schemaVersion":"1.0","nodes":[{"id":"p","type":"paragraph","text":"Bad","assetId":"f4900000-0000-4000-8000-000000000099"}]}','Bad',1,'a4900000-0000-4000-8000-000000000001');
update public.chapters set current_document_version_id=case id
 when 'e4900000-0000-4000-8000-000000000001' then '04900000-0000-4000-8000-000000000001'::uuid
 when 'e4900000-0000-4000-8000-000000000002' then '04900000-0000-4000-8000-000000000002'::uuid
 when 'e4900000-0000-4000-8000-000000000003' then '04900000-0000-4000-8000-000000000003'::uuid
 else '04900000-0000-4000-8000-000000000004'::uuid end where book_id='d4900000-0000-4000-8000-000000000001';
do $$ declare principal text; action text; begin
 foreach principal in array array['anon','authenticated','service_role'] loop
  foreach action in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
   assert not has_table_privilege(principal,'public.chapter_restore_operations',action), 'unexpected ledger privilege';
  end loop;
 end loop;
 assert not has_function_privilege('anon','public.restore_chapter_version(uuid,uuid,uuid,integer)','execute');
end $$;
set local role authenticated;
set local request.jwt.claims='{"sub":"a4900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ declare saved jsonb; replay jsonb; begin
 assert public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',1)->>'status'='not_found';
 saved:=public.restore_chapter_version('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',1);
 assert saved->>'status'='saved' and (saved#>>'{receipt,version}')::integer=2;
 replay:=public.restore_chapter_version('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',1);
 assert replay=saved and (select count(*) from public.document_versions where chapter_id='e4900000-0000-4000-8000-000000000001')=2;
 begin perform public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000002',1); assert false;
 exception when serialization_failure then null; end;
 begin perform public.close_chapter_restore_operation('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',2); assert false;
 exception when serialization_failure then null; end;
 assert public.close_chapter_restore_operation('e4900000-0000-4000-8000-000000000002','14900000-0000-4000-8000-000000000002','04900000-0000-4000-8000-000000000002',1)->>'status'='closed';
 assert public.restore_chapter_version('e4900000-0000-4000-8000-000000000002','14900000-0000-4000-8000-000000000002','04900000-0000-4000-8000-000000000002',1)->>'status'='closed';
 assert public.restore_chapter_version('e4900000-0000-4000-8000-000000000002','14900000-0000-4000-8000-000000000003','04900000-0000-4000-8000-000000000002',0)->>'status'='conflict';
 begin perform public.restore_chapter_version('e4900000-0000-4000-8000-000000000002','14900000-0000-4000-8000-000000000015','04900000-0000-4000-8000-000000000003',1); assert false,'foreign chapter target restored';
 exception when no_data_found then null; end;
 begin perform public.restore_chapter_version('e4900000-0000-4000-8000-000000000004','14900000-0000-4000-8000-000000000004','04900000-0000-4000-8000-000000000004',1); assert false,'non-image asset reference bypassed';
 exception when invalid_parameter_value then null; end;
 assert public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000004','14900000-0000-4000-8000-000000000004','04900000-0000-4000-8000-000000000004',1)->>'status'='not_found';
 assert public.close_chapter_restore_operation('e4900000-0000-4000-8000-000000000004','14900000-0000-4000-8000-000000000004','04900000-0000-4000-8000-000000000004',1)->>'status'='closed';
 -- Direct legacy writes remain possible; a forged version occupying this
 -- operation namespace is not evidence of an authorized restore receipt.
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by,operation_id)
 values('04900000-0000-4000-8000-000000000013','e4900000-0000-4000-8000-000000000003',2,
  '{"schemaVersion":"1.0","nodes":[{"id":"p","type":"paragraph","text":"Direct"}]}','Direct',1,auth.uid(),
  'chapter-restore-v1:a4900000-0000-4000-8000-000000000001:14900000-0000-4000-8000-000000000013');
 update public.chapters set current_document_version_id='04900000-0000-4000-8000-000000000013' where id='e4900000-0000-4000-8000-000000000003';
 begin perform public.restore_chapter_version('e4900000-0000-4000-8000-000000000003','14900000-0000-4000-8000-000000000013','04900000-0000-4000-8000-000000000003',2); assert false,'direct write forged a restore';
 exception when serialization_failure then null; end;
 assert public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000003','14900000-0000-4000-8000-000000000013','04900000-0000-4000-8000-000000000003',2)->>'status'='not_found';
 begin insert into public.chapter_restore_operations(chapter_id,actor_id,operation_id,target_version_id,expected_version,status)
  values('e4900000-0000-4000-8000-000000000001',auth.uid(),gen_random_uuid(),'04900000-0000-4000-8000-000000000001',1,'closed'); assert false;
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- A malicious editor can insert history directly; restoring unsupported
-- historical shapes must never make the current manuscript unreadable.
set local role authenticated;
set local request.jwt.claims='{"sub":"a4900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ declare c uuid; v uuid; op uuid; n integer:=100; value jsonb; cases jsonb[]:=array[
 '{"schemaVersion":1.0,"nodes":[{"id":"x","type":"paragraph"}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"unsupported"}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"","type":"paragraph"}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph"},{"id":"x","type":"heading"}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","text":null}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","attributes":[]}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"heading","level":7}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","assetVersionNumber":1.5}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","rows":[["ok",9]]}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","attributes":{"magnitude":1e400}}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","extra":[{"n":9007199254740993}]}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","attributes":{"width":0.5}}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","__proto__":{"polluted":true}}]}'::jsonb,
 '{"schemaVersion":"1.0","nodes":[{"id":"x","type":"paragraph","attributes":{"__proto__":{"polluted":true}}}]}'::jsonb,
 jsonb_build_object('schemaVersion','1.0','nodes',jsonb_build_array(jsonb_build_object('id','x','type','paragraph','extra',(repeat('[',32)||'0'||repeat(']',32))::jsonb))),
 jsonb_build_object('schemaVersion','1.0','nodes',jsonb_build_array(jsonb_build_object('id','x','type','image','altText',repeat('😀',501)))),
 jsonb_build_object('schemaVersion','1.0','nodes',jsonb_build_array(jsonb_build_object('id','x','type','caption','caption',repeat('a',2001))))
]; begin
 foreach value in array cases loop
  c:=gen_random_uuid(); v:=gen_random_uuid(); op:=gen_random_uuid(); n:=n+1;
  insert into public.chapters(id,book_id,order_index,title) values(c,'d4900000-0000-4000-8000-000000000001',n,'Malformed');
  insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
   values(v,c,1,value,'synthetic',1,auth.uid());
  update public.chapters set current_document_version_id=v where id=c;
  begin perform public.restore_chapter_version(c,op,v,1); assert false,'unsupported direct historical shape restored';
  exception when invalid_parameter_value then null; end;
  assert (select count(*) from public.document_versions where chapter_id=c)=1;
  assert (select current_document_version_id from public.chapters where id=c)=v;
  assert public.get_chapter_restore_operation(c,op,v,1)->>'status'='not_found';
 end loop;
 -- Direct history may have forged plain_text/word_count even with valid nodes.
 c:=gen_random_uuid(); v:=gen_random_uuid(); op:=gen_random_uuid();
 insert into public.chapters(id,book_id,order_index,title) values(c,'d4900000-0000-4000-8000-000000000001',n+1,'Forged projection');
 value:=jsonb_build_object('schemaVersion','1.0','nodes',jsonb_build_array(
  jsonb_build_object('id','p','type','paragraph','text','A'||chr(160)||'B',
   'attributes',jsonb_build_object('limit',9007199254740991::numeric,'negative',-9007199254740991::numeric)),
  jsonb_build_object('id','t','type','table','rows',jsonb_build_array(jsonb_build_array('C','D')))));
 insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
  values(v,c,1,value,'forged projection',900,auth.uid());
 update public.chapters set current_document_version_id=v where id=c;
 assert public.restore_chapter_version(c,op,v,1)->>'status'='saved';
 assert (select plain_text from public.document_versions where chapter_id=c and version_number=2)=('A'||chr(160)||'B'||E'\n\nC\tD');
 assert (select word_count from public.document_versions where chapter_id=c and version_number=2)=4;
 assert (select content_json from public.document_versions where chapter_id=c and version_number=2)=value; -- safe integer boundary retained
end $$;
reset role;
set local request.jwt.claims='{"role":"service_role"}';
update public.assets set deleted_at=clock_timestamp() where id='f4900000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims='{"sub":"a4900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
 assert public.restore_chapter_version('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',1)->>'status'='saved', 'saved replay revalidated revoked asset';
 begin perform public.restore_chapter_version('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000005','04900000-0000-4000-8000-000000000001',2); assert false,'revoked asset restored';
 exception when invalid_parameter_value then null; end;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"a4900000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$ begin
 assert public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000002','14900000-0000-4000-8000-000000000002','04900000-0000-4000-8000-000000000002',1)->>'status'='not_found', 'actor saw another actor receipt';
end $$;
set local request.jwt.claims='{"sub":"a4900000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$ begin
 begin perform public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',1); assert false;
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.workspace_members set status='suspended' where workspace_id='c4900000-0000-4000-8000-000000000001'
 and user_id='a4900000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims='{"sub":"a4900000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
 begin perform public.get_chapter_restore_operation('e4900000-0000-4000-8000-000000000001','14900000-0000-4000-8000-000000000001','04900000-0000-4000-8000-000000000001',1); assert false,'revoked editor read receipt';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 begin update public.chapter_restore_operations set status='closed' where operation_id='14900000-0000-4000-8000-000000000001'; assert false,'immutable receipt changed';
 exception when check_violation then null; end;
end $$;
rollback;
