-- Manual canon writes commit once with metadata-only recovery evidence.
-- No item/book FK: deleting or recreating canon must never erase a request.
-- A UUID alone is not a row incarnation: direct CRUD may delete then reinsert
-- the exact prior fields/timestamps. The server always owns this generation.
-- Preserve historical timestamps; an invalid legacy revision requires a
-- reviewed repair before rollout, never a silent history rewrite.
do $$ begin
  lock table public.book_bible_items in share row exclusive mode;
  if exists(select 1 from public.book_bible_items where not pg_catalog.isfinite(updated_at)) then
    raise exception 'Manual Book Bible requires finite legacy revisions';
  end if;
end $$;
alter table public.book_bible_items add column mutation_incarnation_id uuid not null default pg_catalog.gen_random_uuid();
create function bookworm_private.guard_book_bible_incarnation() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.mutation_incarnation_id:=pg_catalog.gen_random_uuid();
    new.updated_at:=pg_catalog.clock_timestamp();
  else
    if new.mutation_incarnation_id is distinct from old.mutation_incarnation_id then
      raise exception 'Book Bible incarnation is server-owned' using errcode='42501';
    end if;
    new.updated_at:=greatest(pg_catalog.clock_timestamp(),old.updated_at+interval '1 millisecond');
  end if;
  return new;
end $$;
revoke all on function bookworm_private.guard_book_bible_incarnation() from public,anon,authenticated,service_role;
create trigger book_bible_incarnation before insert or update on public.book_bible_items
  for each row execute function bookworm_private.guard_book_bible_incarnation();

create table bookworm_private.book_bible_mutation_receipts (
  actor_id uuid not null,
  request_id uuid not null,
  book_id uuid not null,
  workspace_id uuid not null,
  action text not null check (action in ('create','update','delete')),
  item_id uuid not null,
  result_incarnation_id uuid not null,
  intent_hash text not null check (intent_hash ~ '^[a-f0-9]{64}$'),
  result_hash text not null check (result_hash ~ '^[a-f0-9]{64}$'),
  result_updated_at timestamptz not null,
  committed_at timestamptz not null default clock_timestamp(),
  primary key (actor_id,request_id)
);
alter table bookworm_private.book_bible_mutation_receipts enable row level security;
revoke all on bookworm_private.book_bible_mutation_receipts from public,anon,authenticated,service_role;

create function bookworm_private.guard_book_bible_mutation_receipt() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'Book Bible mutation receipt is immutable' using errcode='42501';
end $$;
revoke all on function bookworm_private.guard_book_bible_mutation_receipt() from public,anon,authenticated,service_role;
create trigger book_bible_mutation_receipt_immutable before update or delete
  on bookworm_private.book_bible_mutation_receipts for each row
  execute function bookworm_private.guard_book_bible_mutation_receipt();

-- Missing evidence alone cannot prove that an earlier network request will
-- never arrive. Only an explicit, locked closure can authorize a new UUID.
create table bookworm_private.book_bible_request_closures (
  actor_id uuid not null,
  request_id uuid not null,
  book_id uuid not null,
  workspace_id uuid not null,
  closed_at timestamptz not null default clock_timestamp(),
  primary key (actor_id,request_id)
);
alter table bookworm_private.book_bible_request_closures enable row level security;
revoke all on bookworm_private.book_bible_request_closures from public,anon,authenticated,service_role;
create trigger book_bible_request_closure_immutable before update or delete
  on bookworm_private.book_bible_request_closures for each row
  execute function bookworm_private.guard_book_bible_mutation_receipt();
create function bookworm_private.bible_closure_result(p_closure bookworm_private.book_bible_request_closures)
returns jsonb language sql stable set search_path='' set timezone='UTC' as $$
  select pg_catalog.jsonb_build_object('receipt',null,'disposition',null,'item',null,'replayed',false,'closed',true,
    'closure',pg_catalog.jsonb_build_object('requestId',p_closure.request_id,'bookId',p_closure.book_id,'closedAt',p_closure.closed_at));
$$;
revoke all on function bookworm_private.bible_closure_result(bookworm_private.book_bible_request_closures) from public,anon,authenticated,service_role;

-- Match the whitespace removed by JavaScript String.trim(), including Unicode.
create function bookworm_private.bible_trim(p_text text) returns text
language sql immutable set search_path='' as $$
  select pg_catalog.btrim(p_text,E' \t\n\r\f'||pg_catalog.chr(11)||pg_catalog.chr(160)||pg_catalog.chr(5760)
    ||pg_catalog.chr(8192)||pg_catalog.chr(8193)||pg_catalog.chr(8194)||pg_catalog.chr(8195)
    ||pg_catalog.chr(8196)||pg_catalog.chr(8197)||pg_catalog.chr(8198)||pg_catalog.chr(8199)
    ||pg_catalog.chr(8200)||pg_catalog.chr(8201)||pg_catalog.chr(8202)||pg_catalog.chr(8232)
    ||pg_catalog.chr(8233)||pg_catalog.chr(8239)||pg_catalog.chr(8287)||pg_catalog.chr(12288)||pg_catalog.chr(65279));
$$;
create function bookworm_private.bible_utf16_length(p_text text) returns integer
language sql immutable set search_path='' as $$
  select coalesce(pg_catalog.sum(case when pg_catalog.ascii(c)>65535 then 2 else 1 end),0)::integer
    from pg_catalog.regexp_split_to_table(p_text,'') c where c<>'';
$$;
-- Compact JSON keeps the attribute size bound independent of JSONB whitespace.
create function bookworm_private.bible_compact_json(p_value jsonb,p_depth integer default 0) returns text
language plpgsql immutable set search_path='' as $$
declare v_result text;
begin
  if p_depth>64 then raise exception 'Book Bible attributes are nested too deeply' using errcode='22023'; end if;
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      select '{'||coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(k)::text||':'||bookworm_private.bible_compact_json(v,p_depth+1),',' order by k collate "C"),'')||'}'
        into v_result from pg_catalog.jsonb_each(p_value) e(k,v);
    when 'array' then
      select '['||coalesce(pg_catalog.string_agg(bookworm_private.bible_compact_json(v,p_depth+1),',' order by n),'')||']'
        into v_result from pg_catalog.jsonb_array_elements(p_value) with ordinality e(v,n);
    else v_result:=p_value::text;
  end case;
  return v_result;
end $$;

create function bookworm_private.normalize_bible_mutation_body(p_body jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_name text; v_description text; v_attributes jsonb; v_images jsonb; v_sources jsonb;
  v_ref jsonb; v_normalized jsonb; v_result_sources jsonb:='[]'; v_key text; v_value jsonb;
begin
  if p_body is null or pg_catalog.jsonb_typeof(p_body)<>'object'
    or pg_catalog.octet_length(p_body::text)>262144
    or p_body-array['type','name','description','attributes','imageAssetIds','sourceRefs']<>'{}'
    or pg_catalog.jsonb_typeof(p_body->'type') is distinct from 'string'
    or p_body->>'type' not in ('character','location','place','organization','fact','object','event','term','timeline','style')
    or pg_catalog.jsonb_typeof(p_body->'name') is distinct from 'string'
    or (p_body?'description' and pg_catalog.jsonb_typeof(p_body->'description') is distinct from 'string') then
    raise exception 'Check the Book Bible fields' using errcode='22023';
  end if;
  v_name:=bookworm_private.bible_trim(p_body->>'name');
  v_description:=bookworm_private.bible_trim(coalesce(p_body->>'description',''));
  v_attributes:=coalesce(p_body->'attributes','{}');
  v_images:=coalesce(p_body->'imageAssetIds','[]'); v_sources:=coalesce(p_body->'sourceRefs','[]');
  if bookworm_private.bible_utf16_length(v_name) not between 1 and 160
    or bookworm_private.bible_utf16_length(v_description)>12000
    or pg_catalog.jsonb_typeof(v_attributes)<>'object'
    or pg_catalog.jsonb_typeof(v_images)<>'array' or pg_catalog.jsonb_array_length(v_images)>20
    or pg_catalog.jsonb_typeof(v_sources)<>'array' or pg_catalog.jsonb_array_length(v_sources)>30 then
    raise exception 'Check the Book Bible field limits' using errcode='22023';
  end if;
  if (select count(*) from pg_catalog.jsonb_object_keys(v_attributes))>40
    or bookworm_private.bible_utf16_length(bookworm_private.bible_compact_json(v_attributes))>24000 then
    raise exception 'Book Bible attributes exceed their limit' using errcode='22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(v_attributes) loop
    if bookworm_private.bible_utf16_length(v_key) not between 1 and 80
      or v_key in ('imageAssetIds','__proto__','constructor','prototype') then
      raise exception 'Invalid Book Bible attribute name' using errcode='22023';
    end if;
  end loop;
  for v_value in select value from pg_catalog.jsonb_array_elements(v_images) loop
    if pg_catalog.jsonb_typeof(v_value)<>'string' or v_value#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid Book Bible image ID' using errcode='22023';
    end if;
  end loop;
  for v_ref in select value from pg_catalog.jsonb_array_elements(v_sources) loop
    if pg_catalog.jsonb_typeof(v_ref)<>'object'
      or v_ref-array['chapterId','documentVersionId','nodeId','textHash','note']<>'{}'
      or pg_catalog.jsonb_typeof(v_ref->'chapterId') is distinct from 'string'
      or v_ref->>'chapterId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (v_ref?'documentVersionId' and (pg_catalog.jsonb_typeof(v_ref->'documentVersionId') is distinct from 'string'
        or v_ref->>'documentVersionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      or (v_ref?'nodeId' and (pg_catalog.jsonb_typeof(v_ref->'nodeId') is distinct from 'string'
        or bookworm_private.bible_utf16_length(v_ref->>'nodeId') not between 1 and 200))
      or (v_ref?'textHash' and (not v_ref?'nodeId' or pg_catalog.jsonb_typeof(v_ref->'textHash') is distinct from 'string'
        or v_ref->>'textHash' !~ '^[a-f0-9]{64}$'))
      or (v_ref?'note' and (pg_catalog.jsonb_typeof(v_ref->'note') is distinct from 'string'
        or bookworm_private.bible_utf16_length(bookworm_private.bible_trim(v_ref->>'note'))>500)) then
      raise exception 'Invalid Book Bible source reference' using errcode='22023';
    end if;
    v_normalized:=v_ref;
    if v_ref?'note' then v_normalized:=pg_catalog.jsonb_set(v_ref,'{note}',pg_catalog.to_jsonb(bookworm_private.bible_trim(v_ref->>'note'))); end if;
    v_result_sources:=v_result_sources||pg_catalog.jsonb_build_array(v_normalized);
  end loop;
  return pg_catalog.jsonb_build_object('type',p_body->>'type','name',v_name,'description',v_description,
    'attributes',v_attributes,'imageAssetIds',v_images,'sourceRefs',v_result_sources);
end $$;

create function bookworm_private.bible_mutation_result(p_receipt bookworm_private.book_bible_mutation_receipts,p_replayed boolean)
returns jsonb language plpgsql volatile set search_path='' set timezone='UTC' as $$
declare v_item public.book_bible_items; v_hash text; v_disposition text;
begin
  select * into v_item from public.book_bible_items where id=p_receipt.item_id and book_id=p_receipt.book_id;
  if not found then v_disposition:='deleted';
  else
    v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_item)::text,'UTF8')),'hex');
    v_disposition:=case when p_receipt.action<>'delete' and v_item.mutation_incarnation_id=p_receipt.result_incarnation_id
      and v_hash=p_receipt.result_hash then 'unchanged' else 'changed' end;
  end if;
  return pg_catalog.jsonb_build_object('receipt',pg_catalog.jsonb_build_object(
    'requestId',p_receipt.request_id,'bookId',p_receipt.book_id,'action',p_receipt.action,'itemId',p_receipt.item_id,
    'intentHash',p_receipt.intent_hash,'resultHash',p_receipt.result_hash,'resultUpdatedAt',p_receipt.result_updated_at,
    'committedAt',p_receipt.committed_at),'disposition',v_disposition,
    'item',case when v_disposition='deleted' then null else pg_catalog.to_jsonb(v_item) end,'replayed',p_replayed,'closed',false,'closure',null);
end $$;

revoke all on function bookworm_private.bible_trim(text),bookworm_private.bible_utf16_length(text),
  bookworm_private.bible_compact_json(jsonb,integer),bookworm_private.normalize_bible_mutation_body(jsonb),
  bookworm_private.bible_mutation_result(bookworm_private.book_bible_mutation_receipts,boolean)
  from public,anon,authenticated,service_role;

create function public.mutate_book_bible_item(p_book_id uuid,p_request_id uuid,p_action text,
  p_item_id uuid default null,p_expected_updated_at timestamptz default null,p_body jsonb default null,
  p_expected_incarnation_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare v_actor uuid:=auth.uid(); v_workspace uuid; v_role text; v_status text; v_body jsonb; v_intent_hash text;
  v_receipt bookworm_private.book_bible_mutation_receipts; v_item public.book_bible_items;
  v_ref jsonb; v_sources jsonb:='[]'; v_chapter public.chapters; v_version public.document_versions;
  v_node jsonb; v_hash text; v_image uuid; v_asset public.assets; v_asset_version public.asset_versions;
  v_image_ids jsonb; v_attributes jsonb;
begin
  -- Both receipt and closure visibility depend on fresh post-lock snapshots.
  -- Reject stronger isolation before any write rather than assert a false
  -- closure when another transaction's committed receipt is still invisible.
  if pg_catalog.current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
    raise exception 'Manual Book Bible requires READ COMMITTED transport' using errcode='0A000';
  end if;
  if v_actor is null then raise exception 'Active Book Bible editor required' using errcode='42501'; end if;
  if p_book_id is null or p_request_id is null or p_action is null or p_action not in ('create','update','delete')
    or (p_action='create' and (p_item_id is not null or p_expected_updated_at is not null or p_expected_incarnation_id is not null))
    or (p_action<>'create' and (p_item_id is null or p_expected_updated_at is null or p_expected_incarnation_id is null or not pg_catalog.isfinite(p_expected_updated_at))) then
    raise exception 'Invalid Book Bible mutation request' using errcode='22023';
  end if;
  select workspace_id into v_workspace from public.books where id=p_book_id for update;
  if not found then raise exception 'Book not found' using errcode='P0002'; end if;
  select role::text,status into v_role,v_status from public.workspace_members
    where workspace_id=v_workspace and user_id=v_actor for share;
  if not found or v_status<>'active' or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'Active Book Bible editor required' using errcode='42501';
  end if;
  if p_action='delete' then
    if p_body is not null and p_body<>'{}'::jsonb then raise exception 'Delete does not accept Book Bible fields' using errcode='22023'; end if;
    v_body:=null;
  else v_body:=bookworm_private.normalize_bible_mutation_body(p_body);
  end if;
  v_intent_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'formatVersion',1,'bookId',p_book_id,'workspaceId',v_workspace,'action',p_action,'itemId',p_item_id,
    'expectedUpdatedAt',p_expected_updated_at,'expectedIncarnationId',p_expected_incarnation_id,'body',v_body)::text,'UTF8')),'hex');
  -- Separate statements after waiting are essential at READ COMMITTED. The
  -- unique key is a rollback backstop; never catch it after a partial write.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('manual-bible:'||v_actor::text||':'||p_request_id::text,0));
  select * into v_receipt from bookworm_private.book_bible_mutation_receipts where actor_id=v_actor and request_id=p_request_id;
  if found then
    if v_receipt.book_id<>p_book_id or v_receipt.workspace_id<>v_workspace or v_receipt.intent_hash<>v_intent_hash then
      raise exception 'Book Bible request ID reused with different intent' using errcode='40001';
    end if;
    return bookworm_private.bible_mutation_result(v_receipt,true);
  end if;
  if exists(select 1 from bookworm_private.book_bible_request_closures where actor_id=v_actor and request_id=p_request_id) then
    raise exception 'Book Bible request is permanently closed; its original UUID cannot write canon' using errcode='55000';
  end if;
  if p_action<>'create' then
    select * into v_item from public.book_bible_items where id=p_item_id and book_id=p_book_id for update;
    if not found or v_item.updated_at<>p_expected_updated_at or v_item.mutation_incarnation_id<>p_expected_incarnation_id then
      raise exception 'Book Bible entry changed or was removed' using errcode='40001';
    end if;
  end if;
  if p_action<>'delete' then
    -- Lock selected images and their exact current metadata through commit.
    for v_image in select distinct value::uuid from pg_catalog.jsonb_array_elements_text(v_body->'imageAssetIds') order by 1 loop
      select * into v_asset from public.assets where id=v_image and workspace_id=v_workspace and deleted_at is null for share;
      if not found or v_asset.mime_type not in ('image/png','image/jpeg','image/gif','image/webp')
        or v_asset.checksum !~ '^[a-f0-9]{64}$' or v_asset.size_bytes<1 then
        raise exception 'Linked images must be cleared current workspace images' using errcode='22023';
      end if;
      perform id from public.asset_versions where asset_id=v_asset.id and storage_path=v_asset.storage_path order by id for share;
      select * into v_asset_version from public.asset_versions where asset_id=v_asset.id and storage_path=v_asset.storage_path
        and checksum=v_asset.checksum and mime_type=v_asset.mime_type and size_bytes=v_asset.size_bytes
        and scan_status in ('clean','trusted_generated') order by id limit 1 for share;
      if not found then
        raise exception 'Linked image version is not scan-cleared' using errcode='22023';
      end if;
    end loop;
    -- Acquire reference locks in stable order, then pin each ORIGINAL reference.
    perform c.id from public.chapters c where c.book_id=p_book_id and c.id in
      (select (value->>'chapterId')::uuid from pg_catalog.jsonb_array_elements(v_body->'sourceRefs')) order by c.id for share;
    perform d.id from public.document_versions d join public.chapters c on c.id=d.chapter_id
      where c.book_id=p_book_id and d.id in (select coalesce((r.value->>'documentVersionId')::uuid,source.current_document_version_id)
        from pg_catalog.jsonb_array_elements(v_body->'sourceRefs') r(value)
        join public.chapters source on source.id=(r.value->>'chapterId')::uuid and source.book_id=p_book_id
        where r.value?'documentVersionId' or r.value?'nodeId') order by d.id for share of d;
    for v_ref in select value from pg_catalog.jsonb_array_elements(v_body->'sourceRefs') loop
      select * into v_chapter from public.chapters where id=(v_ref->>'chapterId')::uuid and book_id=p_book_id for share;
      if not found then raise exception 'Source chapter must belong to this book' using errcode='22023'; end if;
      if v_ref?'documentVersionId' or v_ref?'nodeId' then
        select * into v_version from public.document_versions
          where id=coalesce((v_ref->>'documentVersionId')::uuid,v_chapter.current_document_version_id) and chapter_id=v_chapter.id for share;
        if not found then raise exception 'Source requires an available saved chapter version' using errcode='22023'; end if;
      end if;
      if v_ref?'nodeId' then
        select value into v_node from pg_catalog.jsonb_array_elements(v_version.content_json->'nodes') where value->>'id'=v_ref->>'nodeId' limit 1;
        if not found then raise exception 'Source node is unavailable in its saved version' using errcode='22023'; end if;
        v_ref:=v_ref||pg_catalog.jsonb_build_object('documentVersionId',v_version.id);
        if pg_catalog.jsonb_typeof(v_node->'text')='string' then
          v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_node->>'text','UTF8')),'hex');
          if v_ref?'textHash' and v_ref->>'textHash'<>v_hash then raise exception 'Source text hash does not match saved text' using errcode='22023'; end if;
          v_ref:=v_ref||pg_catalog.jsonb_build_object('textHash',v_hash);
        elsif v_ref?'textHash' then raise exception 'A nontext source cannot carry a text hash' using errcode='22023'; end if;
      end if;
      v_sources:=v_sources||pg_catalog.jsonb_build_array(v_ref);
    end loop;
    select coalesce(pg_catalog.jsonb_agg(value order by first),'[]') into v_image_ids from
      (select value,min(n) first from pg_catalog.jsonb_array_elements(v_body->'imageAssetIds') with ordinality e(value,n) group by value) ids;
    v_attributes:=(v_body->'attributes')||pg_catalog.jsonb_build_object('imageAssetIds',v_image_ids);
    if p_action='create' then
      insert into public.book_bible_items(book_id,type,name,description,attributes_json,source_refs_json)
        values(p_book_id,v_body->>'type',v_body->>'name',nullif(v_body->>'description',''),v_attributes,v_sources) returning * into v_item;
    else
      update public.book_bible_items set type=v_body->>'type',name=v_body->>'name',description=nullif(v_body->>'description',''),
        attributes_json=v_attributes,source_refs_json=v_sources,updated_at=greatest(pg_catalog.clock_timestamp(),v_item.updated_at+interval '1 millisecond')
        where id=v_item.id and book_id=p_book_id returning * into v_item;
    end if;
  else delete from public.book_bible_items where id=v_item.id and book_id=p_book_id;
  end if;
  insert into bookworm_private.book_bible_mutation_receipts(actor_id,request_id,book_id,workspace_id,action,item_id,result_incarnation_id,intent_hash,result_hash,result_updated_at)
    values(v_actor,p_request_id,p_book_id,v_workspace,p_action,v_item.id,v_item.mutation_incarnation_id,v_intent_hash,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_item)::text,'UTF8')),'hex'),v_item.updated_at)
    returning * into v_receipt;
  return bookworm_private.bible_mutation_result(v_receipt,false);
end $$;

create function public.recover_book_bible_mutation(p_book_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' as $$
declare v_actor uuid:=auth.uid(); v_workspace uuid; v_role text; v_status text; v_receipt bookworm_private.book_bible_mutation_receipts;
  v_closure bookworm_private.book_bible_request_closures;
begin
  if pg_catalog.current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
    raise exception 'Manual Book Bible requires READ COMMITTED transport' using errcode='0A000';
  end if;
  if v_actor is null then raise exception 'Active Book Bible editor required' using errcode='42501'; end if;
  if p_book_id is null or p_request_id is null then raise exception 'Invalid Book Bible recovery request' using errcode='22023'; end if;
  select workspace_id into v_workspace from public.books where id=p_book_id for share;
  if not found then raise exception 'Book not found' using errcode='P0002'; end if;
  select role::text,status into v_role,v_status from public.workspace_members
    where workspace_id=v_workspace and user_id=v_actor for share;
  if not found or v_status<>'active' or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'Active Book Bible editor required' using errcode='42501';
  end if;
  select * into v_receipt from bookworm_private.book_bible_mutation_receipts
    where actor_id=v_actor and request_id=p_request_id and book_id=p_book_id and workspace_id=v_workspace;
  if not found then
    select * into v_closure from bookworm_private.book_bible_request_closures
      where actor_id=v_actor and request_id=p_request_id and book_id=p_book_id and workspace_id=v_workspace;
    if found then return bookworm_private.bible_closure_result(v_closure); end if;
    return pg_catalog.jsonb_build_object('receipt',null,'disposition',null,'item',null,'replayed',false,'closed',false,'closure',null);
  end if;
  return bookworm_private.bible_mutation_result(v_receipt,true);
end $$;

create function public.close_book_bible_mutation(p_book_id uuid,p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' as $$
declare v_actor uuid:=auth.uid(); v_workspace uuid; v_role text; v_status text;
  v_receipt bookworm_private.book_bible_mutation_receipts; v_closure bookworm_private.book_bible_request_closures;
begin
  if pg_catalog.current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
    raise exception 'Manual Book Bible requires READ COMMITTED transport' using errcode='0A000';
  end if;
  if v_actor is null then raise exception 'Active Book Bible editor required' using errcode='42501'; end if;
  if p_book_id is null or p_request_id is null then raise exception 'Invalid Book Bible closure request' using errcode='22023'; end if;
  select workspace_id into v_workspace from public.books where id=p_book_id for update;
  if not found then raise exception 'Book not found' using errcode='P0002'; end if;
  select role::text,status into v_role,v_status from public.workspace_members
    where workspace_id=v_workspace and user_id=v_actor for share;
  if not found or v_status<>'active' or v_role not in ('owner','admin','editor','writer','illustrator','designer') then
    raise exception 'Active Book Bible editor required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('manual-bible:'||v_actor::text||':'||p_request_id::text,0));
  select * into v_receipt from bookworm_private.book_bible_mutation_receipts where actor_id=v_actor and request_id=p_request_id;
  if found then
    if v_receipt.book_id<>p_book_id or v_receipt.workspace_id<>v_workspace then
      raise exception 'Book Bible request ID belongs to another scope' using errcode='40001';
    end if;
    -- Never close or undo a committed write: show its current disposition.
    return bookworm_private.bible_mutation_result(v_receipt,true);
  end if;
  select * into v_closure from bookworm_private.book_bible_request_closures where actor_id=v_actor and request_id=p_request_id;
  if found then
    if v_closure.book_id<>p_book_id or v_closure.workspace_id<>v_workspace then
      raise exception 'Book Bible request ID belongs to another scope' using errcode='40001';
    end if;
  else
    insert into bookworm_private.book_bible_request_closures(actor_id,request_id,book_id,workspace_id)
      values(v_actor,p_request_id,p_book_id,v_workspace) returning * into v_closure;
  end if;
  return bookworm_private.bible_closure_result(v_closure);
end $$;
revoke all on function public.mutate_book_bible_item(uuid,uuid,text,uuid,timestamptz,jsonb,uuid),
  public.recover_book_bible_mutation(uuid,uuid),public.close_book_bible_mutation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mutate_book_bible_item(uuid,uuid,text,uuid,timestamptz,jsonb,uuid),
  public.recover_book_bible_mutation(uuid,uuid),public.close_book_bible_mutation(uuid,uuid) to authenticated;
