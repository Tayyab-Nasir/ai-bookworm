-- New restore operations only: no historical operation is inferred. Existing
-- generic append/direct version writes are unchanged and do not all take this
-- lock. A closure fences only this new restore RPC, not a pending legacy
-- append or direct table insert; legacy in-flight work needs separate cutover
-- handling. Asset eligibility is checked at restore time but not serialized
-- with every possible asset or approval revocation.
create table public.chapter_restore_operations (
 chapter_id uuid not null references public.chapters(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 operation_id uuid not null,
 target_version_id uuid not null,
 expected_version integer not null check(expected_version between 0 and 2147483646),
 status text not null check(status in ('saved','closed','conflict')),
 saved_version_id uuid,
 saved_version_number integer,
 created_at timestamptz not null default clock_timestamp(),
 primary key(chapter_id,actor_id,operation_id),
 check((status='saved' and saved_version_id is not null and saved_version_number is not null and saved_version_number=expected_version+1)
    or (status in ('closed','conflict') and saved_version_id is null and saved_version_number is null))
);
alter table public.chapter_restore_operations enable row level security;
revoke all on public.chapter_restore_operations from public,anon,authenticated,service_role;

create function public.guard_chapter_restore_operation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 raise exception using errcode='23514',message='restore receipt is immutable';
end $$;
create trigger chapter_restore_operation_immutable before update on public.chapter_restore_operations
 for each row execute function public.guard_chapter_restore_operation();
revoke all on function public.guard_chapter_restore_operation() from public,anon,authenticated,service_role;

-- Does not inspect target contents or current assets. This permits exact saved
-- receipt recovery even if a referenced illustration has since been revoked.
create function public.get_chapter_restore_operation(p_chapter_id uuid,p_operation_id uuid,
 p_target_version_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.chapters; w uuid; r public.chapter_restore_operations;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='authentication required'; end if;
 if p_chapter_id is null or p_operation_id is null or p_target_version_id is null
  or p_expected_version is null or p_expected_version not between 0 and 2147483646 then
  raise exception using errcode='22023',message='invalid restore identity'; end if;
 select * into c from public.chapters where id=p_chapter_id;
 select workspace_id into w from public.books where id=c.book_id;
 if c.id is null or not exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid()
   and status='active' and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
  raise exception using errcode='42501',message='restore is unavailable'; end if;
 select * into r from public.chapter_restore_operations
  where chapter_id=c.id and actor_id=auth.uid() and operation_id=p_operation_id;
 if r.operation_id is not null and (r.target_version_id is distinct from p_target_version_id
    or r.expected_version is distinct from p_expected_version) then
  raise exception using errcode='40001',message='restore operation identity reused'; end if;
 return jsonb_build_object('chapterId',c.id,'operationId',p_operation_id,'targetVersionId',p_target_version_id,
  'expectedVersion',p_expected_version,'status',coalesce(r.status,'not_found'),
  'receipt',case when r.status='saved' then jsonb_build_object('versionId',r.saved_version_id,'version',r.saved_version_number) else null end);
end $$;

create function public.restore_chapter_version(p_chapter_id uuid,p_operation_id uuid,
 p_target_version_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.chapters; w uuid; target public.document_versions; saved public.document_versions;
 existing jsonb; current_number integer; pointer_number integer; node jsonb; cells jsonb; cell jsonb; asset public.assets;
 projected_text text; projected_count integer;
 asset_version public.asset_versions; matching integer; v_asset_id uuid; operation_key text;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='authentication required'; end if;
 if p_chapter_id is null or p_operation_id is null or p_target_version_id is null
  or p_expected_version is null or p_expected_version not between 0 and 2147483646 then
  raise exception using errcode='22023',message='invalid restore identity'; end if;
 select * into c from public.chapters where id=p_chapter_id for update;
 select workspace_id into w from public.books where id=c.book_id;
 if c.id is null or not exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid()
   and status='active' and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
  raise exception using errcode='42501',message='restore is unavailable'; end if;
 existing:=public.get_chapter_restore_operation(c.id,p_operation_id,p_target_version_id,p_expected_version);
 if existing->>'status'<>'not_found' then return existing; end if;
 -- A direct write may occupy this namespace; never treat it as our receipt.
 operation_key:='chapter-restore-v1:'||auth.uid()::text||':'||p_operation_id::text;
 if exists(select 1 from public.document_versions where chapter_id=c.id and operation_id=operation_key) then
  raise exception using errcode='40001',message='restore operation namespace unavailable'; end if;
 select coalesce(max(version_number),0) into current_number from public.document_versions where chapter_id=c.id;
 if current_number<>p_expected_version then
  insert into public.chapter_restore_operations(chapter_id,actor_id,operation_id,target_version_id,expected_version,status)
   values(c.id,auth.uid(),p_operation_id,p_target_version_id,p_expected_version,'conflict');
  return public.get_chapter_restore_operation(c.id,p_operation_id,p_target_version_id,p_expected_version);
 end if;
 select version_number into pointer_number from public.document_versions
  where id=c.current_document_version_id and chapter_id=c.id;
 if (current_number=0 and c.current_document_version_id is not null)
  or (current_number>0 and pointer_number is distinct from current_number) then
  raise exception using errcode='40001',message='chapter version pointer requires review'; end if;
 select * into target from public.document_versions where id=p_target_version_id and chapter_id=c.id;
 if target.id is null then raise exception using errcode='P0002',message='restore target unavailable'; end if;
 if jsonb_typeof(target.content_json) is distinct from 'object'
  or jsonb_typeof(target.content_json->'schemaVersion') is distinct from 'string'
  or target.content_json->>'schemaVersion' is distinct from '1.0'
  or jsonb_typeof(target.content_json->'nodes') is distinct from 'array'
  or jsonb_array_length(target.content_json->'nodes')>20000
  or octet_length(target.content_json::text)>4000000 then
  raise exception using errcode='22023',message='restore target is not supported'; end if;
 -- Direct INSERT bypasses JavaScript serialization. Conservatively accept
 -- only safe integral numbers, reject __proto__ at every depth and bound
 -- nesting. Fractional numbers are not supported by this restore path.
 if exists (
  with recursive items(value,depth) as (
   select target.content_json,0
   union all
   select child.value,items.depth+1 from items
   cross join lateral (
    select value from jsonb_each(case when jsonb_typeof(items.value)='object' then items.value else '{}'::jsonb end)
    union all
    select value from jsonb_array_elements(case when jsonb_typeof(items.value)='array' then items.value else '[]'::jsonb end)
   ) child where items.depth<31
  )
  select 1 from items where depth=31
   or (jsonb_typeof(value)='object' and value ? '__proto__')
   or case when jsonb_typeof(value)='number' then
    (value#>>'{}')::numeric <> trunc((value#>>'{}')::numeric)
    or abs((value#>>'{}')::numeric)>9007199254740991::numeric
   else false end
 ) then raise exception using errcode='22023',message='restore target is not supported'; end if;
 for node in select value from jsonb_array_elements(target.content_json->'nodes') loop
  if jsonb_typeof(node) is distinct from 'object' then raise exception using errcode='22023',message='restore target is not supported'; end if;
  -- Match the API's canonical BookNode schema conservatively. These checks
  -- deliberately run only for a new operation, never for receipt recovery.
  if jsonb_typeof(node->'id') is distinct from 'string' or node->>'id'=''
   or jsonb_typeof(node->'type') is distinct from 'string'
   or node->>'type' not in ('paragraph','heading','quote','list','listItem','image','caption','pageBreak','table','footnote','separator')
   or (node ? 'text' and jsonb_typeof(node->'text') is distinct from 'string')
   or (node ? 'attributes' and jsonb_typeof(node->'attributes') is distinct from 'object')
   or (node ? 'level' and (jsonb_typeof(node->'level') is distinct from 'number' or node->>'level' !~ '^[1-6]$'))
   or (node ? 'assetVersionNumber' and (jsonb_typeof(node->'assetVersionNumber') is distinct from 'number'
     or node->>'assetVersionNumber' !~ '^[1-9][0-9]{0,9}$'
     or (case when node->>'assetVersionNumber' ~ '^[1-9][0-9]{0,9}$' then (node->>'assetVersionNumber')::numeric else 0 end)>2147483647))
   or (node ? 'altText' and (jsonb_typeof(node->'altText') is distinct from 'string'
     or bookworm_private.bible_utf16_length(node->>'altText')>1000))
   or (node ? 'caption' and (jsonb_typeof(node->'caption') is distinct from 'string'
     or bookworm_private.bible_utf16_length(node->>'caption')>2000)) then
   raise exception using errcode='22023',message='restore target is not supported'; end if;
  if node ? 'rows' then
   if jsonb_typeof(node->'rows') is distinct from 'array' then raise exception using errcode='22023',message='restore target is not supported'; end if;
   if jsonb_array_length(node->'rows')>2000 then raise exception using errcode='22023',message='restore target is not supported'; end if;
   for cells in select value from jsonb_array_elements(node->'rows') loop
    if jsonb_typeof(cells) is distinct from 'array' then raise exception using errcode='22023',message='restore target is not supported'; end if;
    if jsonb_array_length(cells)>100 then raise exception using errcode='22023',message='restore target is not supported'; end if;
    for cell in select value from jsonb_array_elements(cells) loop
     if jsonb_typeof(cell) is distinct from 'string' or bookworm_private.bible_utf16_length(cell#>>'{}')>100000 then
      raise exception using errcode='22023',message='restore target is not supported'; end if;
    end loop;
   end loop;
  end if;
  if not node ? 'assetId' or node->'assetId'='null'::jsonb then continue; end if;
  if jsonb_typeof(node->'assetId') is distinct from 'string' or (node->>'assetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception using errcode='22023',message='restore asset is unavailable'; end if;
  v_asset_id:=(node->>'assetId')::uuid;
  select * into asset from public.assets where id=v_asset_id and workspace_id=w and deleted_at is null
   and checksum<>'pending' and status::text not in ('archived','rejected');
  if asset.id is null then raise exception using errcode='22023',message='restore asset is unavailable'; end if;
  select count(*) into matching from public.asset_versions where asset_id=asset.id and storage_path=asset.storage_path
   and checksum=asset.checksum and scan_status in ('clean','trusted_generated');
  if matching<>1 then raise exception using errcode='22023',message='restore asset is unavailable'; end if;
  select * into asset_version from public.asset_versions where asset_id=asset.id and storage_path=asset.storage_path
   and checksum=asset.checksum and scan_status in ('clean','trusted_generated');
  if asset_version.id is null then raise exception using errcode='22023',message='restore asset is unavailable'; end if;
  if asset.requires_approval and (asset.status::text<>'approved'
   or jsonb_typeof(node->'assetVersionNumber') is distinct from 'number'
   or (node->>'assetVersionNumber') is distinct from asset_version.version_number::text
   or not exists(select 1 from public.approvals where workspace_id=w and entity_type='asset' and entity_id=asset.id
    and status::text='approved' and superseded_at is null and entity_version_number=asset_version.version_number)) then
   raise exception using errcode='22023',message='restore asset approval is unavailable'; end if;
 end loop;
 if jsonb_array_length(target.content_json->'nodes')<>(select count(distinct value->>'id') from jsonb_array_elements(target.content_json->'nodes')) then
  raise exception using errcode='22023',message='restore target is not supported'; end if;
 -- Historical projections can be forged via direct table INSERT. Recompute
 -- from validated canonical nodes using the existing API-parity helpers.
 projected_text:=private.canonical_book_nodes_plain_text(target.content_json->'nodes');
 projected_count:=private.canonical_book_plain_text_word_count(projected_text);
 select * into saved from public.append_chapter_version(c.id,p_expected_version,target.content_json,projected_text,
  projected_count,'Restored version '||target.version_number::text,operation_key);
 insert into public.chapter_restore_operations(chapter_id,actor_id,operation_id,target_version_id,expected_version,status,saved_version_id,saved_version_number)
  values(c.id,auth.uid(),p_operation_id,p_target_version_id,p_expected_version,'saved',saved.id,saved.version_number);
 return public.get_chapter_restore_operation(c.id,p_operation_id,p_target_version_id,p_expected_version);
end $$;

create function public.close_chapter_restore_operation(p_chapter_id uuid,p_operation_id uuid,
 p_target_version_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.chapters; w uuid; existing jsonb;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='authentication required'; end if;
 if p_chapter_id is null or p_operation_id is null or p_target_version_id is null
  or p_expected_version is null or p_expected_version not between 0 and 2147483646 then
  raise exception using errcode='22023',message='invalid restore identity'; end if;
 select * into c from public.chapters where id=p_chapter_id for update;
 select workspace_id into w from public.books where id=c.book_id;
 if c.id is null or not exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid()
   and status='active' and role::text in ('owner','admin','editor','writer','illustrator','designer')) then
  raise exception using errcode='42501',message='restore is unavailable'; end if;
 existing:=public.get_chapter_restore_operation(c.id,p_operation_id,p_target_version_id,p_expected_version);
 if existing->>'status'<>'not_found' then return existing; end if;
 insert into public.chapter_restore_operations(chapter_id,actor_id,operation_id,target_version_id,expected_version,status)
  values(c.id,auth.uid(),p_operation_id,p_target_version_id,p_expected_version,'closed');
 return public.get_chapter_restore_operation(c.id,p_operation_id,p_target_version_id,p_expected_version);
end $$;

revoke all on function public.get_chapter_restore_operation(uuid,uuid,uuid,integer),
 public.restore_chapter_version(uuid,uuid,uuid,integer),public.close_chapter_restore_operation(uuid,uuid,uuid,integer)
 from public,anon,authenticated,service_role;
grant execute on function public.get_chapter_restore_operation(uuid,uuid,uuid,integer),
 public.restore_chapter_version(uuid,uuid,uuid,integer),public.close_chapter_restore_operation(uuid,uuid,uuid,integer) to authenticated;
