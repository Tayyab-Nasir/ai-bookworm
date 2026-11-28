-- A parser response is not a trusted asset. Only the private API may commit
-- images after byte verification, malware screening and private upload readback.
create table public.book_import_receipts (
  book_id uuid not null references public.books(id) on delete cascade,
  source_asset_id uuid not null references public.assets(id),
  source_checksum text not null check (source_checksum ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(book_id, source_asset_id)
);
alter table public.book_import_receipts enable row level security;
grant select on public.book_import_receipts to authenticated;
grant all on public.book_import_receipts to service_role;
create policy book_import_receipt_read on public.book_import_receipts for select to authenticated
  using (exists (select 1 from public.books b where b.id = book_id));

create or replace function public.complete_manuscript_image_import(
  p_actor_id uuid, p_book_id uuid, p_source_asset_id uuid, p_source_checksum text,
  p_chapters jsonb, p_images jsonb, p_report jsonb
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_book public.books; v_source public.assets; v_receipt public.book_import_receipts;
  v_image jsonb; v_item jsonb; v_node jsonb; v_chapter public.chapters;
  v_asset_id uuid; v_version_id uuid; v_next integer; v_text text;
  v_chapters jsonb := '[]'; v_ids jsonb := '[]'; v_result jsonb;
begin
  if current_user <> 'service_role' and auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v_book from public.books where id = p_book_id for update;
  if not found then raise exception 'book not found' using errcode = 'P0002'; end if;
  perform 1 from public.workspace_members where workspace_id = v_book.workspace_id
    and user_id = p_actor_id and status = 'active'
    and role::text in ('owner','admin','editor','writer','illustrator','designer') for share;
  if not found then raise exception 'actor cannot import into this book' using errcode = '42501'; end if;
  select * into v_source from public.assets where id = p_source_asset_id
    and workspace_id = v_book.workspace_id and deleted_at is null for share;
  if not found or p_source_checksum is null or v_source.checksum is distinct from p_source_checksum
    or not exists(select 1 from public.asset_versions av where av.asset_id = v_source.id
      and av.storage_path = v_source.storage_path and av.checksum = p_source_checksum and av.scan_status = 'clean') then
    raise exception 'source is not verified and clean in this workspace' using errcode = '22023';
  end if;
  select * into v_receipt from public.book_import_receipts
    where book_id = p_book_id and source_asset_id = p_source_asset_id;
  if found then
    if v_receipt.source_checksum is distinct from p_source_checksum then
      raise exception 'source changed since import' using errcode = '40001';
    end if;
    return v_receipt.result;
  end if;
  if exists(select 1 from public.asset_links where asset_id = p_source_asset_id
    and entity_type = 'book' and entity_id = p_book_id and usage_role = 'manuscript_source') then
    raise exception 'source already imported' using errcode = '23505';
  end if;
  if jsonb_typeof(p_chapters) is distinct from 'array' or jsonb_array_length(p_chapters) not between 1 and 500
    or octet_length(p_chapters::text) > 16000000
    or jsonb_typeof(p_images) is distinct from 'array' or jsonb_array_length(p_images) not between 1 and 100
    or octet_length(p_images::text) > 200000
    or jsonb_typeof(p_report) is distinct from 'object' or octet_length(p_report::text) > 65536 then
    raise exception 'invalid import envelope' using errcode = '22023';
  end if;
  if (select sum((value->>'sizeBytes')::bigint) from jsonb_array_elements(p_images)) > 41943040 then
    raise exception 'embedded image budget exceeded' using errcode = '22023';
  end if;
  for v_image in select value from jsonb_array_elements(p_images) loop
    v_asset_id := (v_image->>'id')::uuid;
    if v_asset_id is null or coalesce(length(v_image->>'name'),0) not between 1 and 256
      or coalesce(v_image->>'mimeType','') not in ('image/png','image/jpeg','image/webp','image/gif')
      or coalesce(v_image->>'checksum','') !~ '^[a-f0-9]{64}$'
      or coalesce((v_image->>'sizeBytes')::bigint,0) not between 1 and 10485760
      or v_image->>'storagePath' is distinct from format('workspaces/%s/assets/%s/v1/imported.%s',
        v_book.workspace_id, v_asset_id, case v_image->>'mimeType'
          when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif' else 'webp' end) then
      raise exception 'invalid imported image metadata' using errcode = '22023';
    end if;
    insert into public.assets(id, workspace_id, type, name, storage_path, mime_type, size_bytes, checksum, created_by)
      values(v_asset_id, v_book.workspace_id, 'illustration', v_image->>'name', v_image->>'storagePath',
        v_image->>'mimeType', (v_image->>'sizeBytes')::bigint, 'pending', p_actor_id);
    -- Pending is deliberate: the internal-artifact trigger must not grant trust
    -- merely because this user-originated file is inserted by the service role.
    insert into public.asset_versions(asset_id,version_number,storage_path,checksum,mime_type,size_bytes,created_by)
      values(v_asset_id,1,v_image->>'storagePath','pending',v_image->>'mimeType',(v_image->>'sizeBytes')::bigint,p_actor_id);
    perform public.record_asset_scan_verdict(v_asset_id,1,'clean',v_image->>'checksum',v_image->>'mimeType',
      (v_image->>'sizeBytes')::bigint,v_image->>'scanner',v_image->>'signature',null);
    insert into public.asset_links(asset_id,entity_type,entity_id,usage_role) values(v_asset_id,'book',p_book_id,'illustration');
    v_ids := v_ids || jsonb_build_array(v_asset_id);
  end loop;
  select coalesce(max(order_index)+1,0) into v_next from public.chapters where book_id = p_book_id;
  for v_item in select value from jsonb_array_elements(p_chapters) loop
    if jsonb_typeof(v_item->'nodes') is distinct from 'array' or coalesce(length(trim(v_item->>'title')),0) = 0 then
      raise exception 'invalid chapter' using errcode = '22023';
    end if;
    for v_node in select value from jsonb_array_elements(v_item->'nodes') loop
      if nullif(v_node->>'assetId','') is not null and not exists(
        select 1 from public.assets a join public.asset_versions av on av.asset_id=a.id and av.storage_path=a.storage_path
        where a.id=(v_node->>'assetId')::uuid and a.workspace_id=v_book.workspace_id and a.deleted_at is null
          and av.scan_status in ('clean','trusted_generated') and av.checksum=a.checksum
      ) then raise exception 'unverified or cross-workspace image reference' using errcode = '22023'; end if;
    end loop;
    insert into public.chapters(book_id,order_index,title) values(p_book_id,v_next,left(v_item->>'title',500)) returning * into v_chapter;
    select coalesce(string_agg(value->>'text', E'\n\n' order by ordinality),'') into v_text
      from jsonb_array_elements(v_item->'nodes') with ordinality;
    insert into public.document_versions(chapter_id,version_number,content_json,plain_text,word_count,created_by,change_summary)
      values(v_chapter.id,1,jsonb_build_object('schemaVersion','1.0','nodes',v_item->'nodes'),v_text,
        case when trim(v_text)='' then 0 else cardinality(regexp_split_to_array(trim(v_text),'\s+')) end,
        p_actor_id,'Manuscript and embedded images imported') returning id into v_version_id;
    update public.chapters set current_document_version_id=v_version_id where id=v_chapter.id returning * into v_chapter;
    v_chapters := v_chapters || to_jsonb(v_chapter);
    v_next := v_next + 1;
  end loop;
  insert into public.asset_links(asset_id,entity_type,entity_id,usage_role) values(p_source_asset_id,'book',p_book_id,'manuscript_source');
  v_result := jsonb_build_object('chapters',v_chapters,'assetIds',v_ids,'sourceAssetId',p_source_asset_id,'report',p_report);
  insert into public.book_import_receipts(book_id,source_asset_id,source_checksum,result)
    values(p_book_id,p_source_asset_id,p_source_checksum,v_result);
  return v_result;
end;
$$;
revoke all on function public.complete_manuscript_image_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_manuscript_image_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb) to service_role;
