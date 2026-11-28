-- Whole-chapter offers are one transaction. They do not reserve credits or jobs.
create function bookworm_private.narration_job_id(user_id uuid,retry_key text) returns uuid
language plpgsql immutable set search_path=public,pg_temp as $$
declare identity bytea:=public.digest(convert_to('narration-quote:'||user_id::text||':'||retry_key,'UTF8'),'sha256');
begin
  identity:=set_byte(identity,6,(get_byte(identity,6)&15)|80);
  identity:=set_byte(identity,8,(get_byte(identity,8)&63)|128);
  return encode(substring(identity from 1 for 16),'hex')::uuid;
end $$;
revoke all on function bookworm_private.narration_job_id(uuid,text) from public,anon,authenticated,service_role;

-- Exactly ECMAScript String.trim's whitespace set, independent of DB locale.
-- POSIX [:space:] differs for NBSP, BOM and several Unicode separators.
create function bookworm_private.narration_has_source_words(value text) returns boolean
language sql immutable set search_path=public,pg_temp as $$
  select translate(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')<>''
$$;
revoke all on function bookworm_private.narration_has_source_words(text) from public,anon,authenticated,service_role;

create table public.narration_chapter_quote_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id),
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check(length(idempotency_key) between 8 and 200),
  catalog_version text not null check(length(trim(catalog_version)) between 1 and 128),
  model_option_id text not null check(model_option_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  voice text not null,
  speed numeric(4,2) not null,
  instructions text,
  segment_count integer not null check(segment_count between 1 and 250),
  reserved_credits integer not null check(reserved_credits>0),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,idempotency_key),
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour')
);
create table public.narration_chapter_quote_segments (
  chapter_quote_id uuid not null references public.narration_chapter_quote_snapshots(id) on delete cascade,
  segment_index integer not null check(segment_index between 0 and 249),
  quote_id uuid not null unique references public.narration_quote_snapshots(id) on delete cascade,
  primary key(chapter_quote_id,segment_index)
);
alter table public.narration_chapter_quote_snapshots enable row level security;
alter table public.narration_chapter_quote_segments enable row level security;
revoke all on public.narration_chapter_quote_snapshots,public.narration_chapter_quote_segments from public,anon,authenticated,service_role;
grant select on public.narration_chapter_quote_snapshots,public.narration_chapter_quote_segments to service_role;
create trigger narration_chapter_quote_immutable before update on public.narration_chapter_quote_snapshots
  for each row execute function public.guard_narration_quote_snapshot();
create trigger narration_chapter_quote_segment_immutable before update on public.narration_chapter_quote_segments
  for each row execute function public.guard_narration_quote_snapshot();

create function public.save_narration_chapter_quote_snapshot(
  p_user_id uuid,p_workspace_id uuid,p_book_id uuid,p_edition_id uuid,p_chapter_id uuid,p_document_version_id uuid,
  p_source_sha256 text,p_idempotency_key text,p_catalog_version text,p_model_option_id text,p_offers jsonb
) returns public.narration_chapter_quote_snapshots
language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.narration_chapter_quote_snapshots; child public.narration_quote_snapshots;
  role_name text; document public.document_versions; envelope jsonb; r jsonb; q jsonb; first_request jsonb; first_quote jsonb;
  child_ids uuid[]:='{}'; child_key text; counter integer:=0; previous_end integer:=0; total numeric:=0;
begin
  select role into role_name from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and status='active' for share;
  if not found or role_name not in ('owner','admin','editor','writer') then
    raise exception 'chapter narration quote requires writing access' using errcode='42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200
    or jsonb_typeof(p_offers) is distinct from 'array' or jsonb_array_length(p_offers) not between 1 and 250
    or octet_length(p_offers::text)>4194304 then
    raise exception 'invalid chapter narration offer envelope' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('narration-chapter-quote:'||p_user_id::text||':'||p_idempotency_key,0));
  select * into saved from public.narration_chapter_quote_snapshots where user_id=p_user_id and idempotency_key=p_idempotency_key;
  if found then
    if saved.workspace_id is distinct from p_workspace_id or saved.book_id is distinct from p_book_id
      or saved.edition_id is distinct from p_edition_id or saved.chapter_id is distinct from p_chapter_id
      or saved.document_version_id is distinct from p_document_version_id or saved.source_sha256 is distinct from p_source_sha256
      or saved.model_option_id is distinct from p_model_option_id or saved.segment_count<>jsonb_array_length(p_offers) then
      raise exception 'chapter narration retry key belongs to another request' using errcode='23505'; end if;
    for envelope in select value from jsonb_array_elements(p_offers) loop
      select s.* into child from public.narration_chapter_quote_segments l join public.narration_quote_snapshots s on s.id=l.quote_id
        where l.chapter_quote_id=saved.id and l.segment_index=counter;
      if not found or child.request_json is distinct from envelope->'request'
        or jsonb_typeof(envelope) is distinct from 'object' or not(envelope ?& array['request','quote'])
        or envelope-array['request','quote']<>'{}'::jsonb then
        raise exception 'chapter narration retry differs from the saved segments' using errcode='23505'; end if;
      counter:=counter+1;
    end loop;
    return saved; -- Original prices survive catalog/source changes and lost replies.
  end if;
  perform id from public.books where id=p_book_id and workspace_id=p_workspace_id for share;
  if not found then raise exception 'narration book scope mismatch' using errcode='42501'; end if;
  perform id from public.editions where id=p_edition_id and book_id=p_book_id and type='audiobook' for share;
  if not found then raise exception 'narration edition scope mismatch' using errcode='42501'; end if;
  perform id from public.chapters where id=p_chapter_id and book_id=p_book_id and current_document_version_id=p_document_version_id for share;
  if not found then raise exception 'chapter narration source changed' using errcode='23514'; end if;
  select * into document from public.document_versions where id=p_document_version_id and chapter_id=p_chapter_id for share;
  if not found or length(document.plain_text) not between 1 and 1000000
    or p_source_sha256 is distinct from encode(public.digest(convert_to(document.plain_text,'UTF8'),'sha256'),'hex') then
    raise exception 'chapter narration source identity mismatch' using errcode='22023'; end if;
  for envelope in select value from jsonb_array_elements(p_offers) loop
    if jsonb_typeof(envelope) is distinct from 'object' or not(envelope ?& array['request','quote'])
      or envelope-array['request','quote']<>'{}'::jsonb then
      raise exception 'invalid chapter narration segment envelope' using errcode='22023'; end if;
    r:=envelope->'request'; q:=envelope->'quote';
    perform public.validate_narration_quote(r,q);
    if r->>'segmentIndex' is distinct from counter::text or r->>'userId' is distinct from p_user_id::text
      or r->>'workspaceId' is distinct from p_workspace_id::text or r->>'bookId' is distinct from p_book_id::text
      or r->>'editionId' is distinct from p_edition_id::text or r->>'chapterId' is distinct from p_chapter_id::text
      or r->>'documentVersionId' is distinct from p_document_version_id::text
      or (r->>'textStart')::integer<previous_end
      or bookworm_private.narration_has_source_words(substring(document.plain_text from previous_end+1 for (r->>'textStart')::integer-previous_end)) then
      raise exception 'chapter narration segments must cover every source word in order' using errcode='22023'; end if;
    if counter=0 then first_request:=r; first_quote:=q;
    elsif (r-array['jobId','segmentIndex','textStart','textEnd','textSha256']) is distinct from
      (first_request-array['jobId','segmentIndex','textStart','textEnd','textSha256'])
      or q->'price' is distinct from first_quote->'price' or q->'policy' is distinct from first_quote->'policy'
      or q->'createdAt' is distinct from first_quote->'createdAt' or q->'expiresAt' is distinct from first_quote->'expiresAt' then
      raise exception 'chapter narration delivery, prices and lifetime must match across segments' using errcode='22023'; end if;
    child_key:='narration-chapter:'||encode(public.digest(convert_to(p_idempotency_key,'UTF8'),'sha256'),'hex')||':'||counter::text;
    if (r->>'jobId')::uuid is distinct from bookworm_private.narration_job_id(p_user_id,child_key) then
      raise exception 'chapter narration child identity must belong to its original retry key' using errcode='22023'; end if;
    select * into child from public.save_narration_quote_snapshot(p_user_id,p_workspace_id,p_book_id,p_edition_id,p_chapter_id,
      p_document_version_id,(r->>'jobId')::uuid,child_key,bookworm_private.narration_request_hash(r),r,p_catalog_version,p_model_option_id,q);
    if child.quote_json is distinct from q or child.catalog_version is distinct from p_catalog_version then
      raise exception 'chapter narration child key already has different prices' using errcode='23505'; end if;
    child_ids:=array_append(child_ids,child.id); total:=total+(q->>'reservedCredits')::numeric;
    if total>2147483647 then raise exception 'chapter narration aggregate exceeds ledger capacity' using errcode='22023'; end if;
    previous_end:=(r->>'textEnd')::integer; counter:=counter+1;
  end loop;
  if bookworm_private.narration_has_source_words(substring(document.plain_text from previous_end+1)) then
    raise exception 'chapter narration offer omitted source words' using errcode='22023'; end if;
  insert into public.narration_chapter_quote_snapshots(user_id,workspace_id,book_id,edition_id,chapter_id,document_version_id,
    source_sha256,idempotency_key,catalog_version,model_option_id,voice,speed,instructions,segment_count,reserved_credits,expires_at)
    values(p_user_id,p_workspace_id,p_book_id,p_edition_id,p_chapter_id,p_document_version_id,p_source_sha256,p_idempotency_key,
      p_catalog_version,p_model_option_id,first_request->>'voice',(first_request->>'speed')::numeric,first_request->>'instructions',
      counter,total::integer,(first_quote->>'expiresAt')::timestamptz) returning * into saved;
  insert into public.narration_chapter_quote_segments(chapter_quote_id,segment_index,quote_id)
    select saved.id,index-1,quote_id from unnest(child_ids) with ordinality children(quote_id,index);
  return saved;
end $$;
revoke all on function public.save_narration_chapter_quote_snapshot(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_narration_chapter_quote_snapshot(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,jsonb) to service_role;
