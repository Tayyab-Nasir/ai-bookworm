-- Metadata is owner-readable. Encrypted envelopes and mutation receipts are
-- outside public and have no browser/table grants. No provider dispatch here.
create schema bookworm_credentials;
revoke all on schema bookworm_credentials from public, anon, authenticated, service_role;

create table public.ai_connections (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 provider text not null check (provider in ('openai','anthropic','google','openrouter','xai')),
 revision integer not null check (revision between 1 and 2147483647),
 status text not null check (status in ('saved','revoked')),
 key_suffix text check (key_suffix ~ '^[A-Za-z0-9_./+=-]{4}$'),
 last_operation_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(owner_id,provider),
 check ((status='saved' and key_suffix is not null) or (status='revoked' and key_suffix is null))
);
alter table public.ai_connections enable row level security;
revoke all on public.ai_connections from public, anon, authenticated, service_role;
grant select on public.ai_connections to authenticated, service_role;
create policy ai_connection_owner_read on public.ai_connections for select to authenticated
 using(owner_id=(select auth.uid()));

create table bookworm_credentials.ai_connection_secrets (
 connection_id uuid primary key references public.ai_connections(id) on delete cascade,
 revision integer not null check(revision>0),
 key_id text not null check(key_id ~ '^[A-Za-z0-9_-]{1,40}$'),
 nonce text not null check(length(nonce)=16 and octet_length(decode(nonce,'base64'))=12),
 ciphertext text not null check(length(ciphertext)<=5464 and octet_length(decode(ciphertext,'base64')) between 16 and 4096),
 auth_tag text not null check(length(auth_tag)=24 and octet_length(decode(auth_tag,'base64'))=16)
);
create table bookworm_credentials.ai_connection_operations (
 owner_id uuid not null references auth.users(id) on delete cascade,
 operation_id uuid not null,
 connection_id uuid not null,
 provider text not null check(provider in ('openai','anthropic','google','openrouter','xai')),
 expected_revision integer,
 revision integer,
 action text not null check(action in ('save','revoke')),
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,operation_id)
);
create index ai_connection_operations_rate on bookworm_credentials.ai_connection_operations(owner_id,created_at);
alter table bookworm_credentials.ai_connection_secrets enable row level security;
alter table bookworm_credentials.ai_connection_operations enable row level security;
revoke all on bookworm_credentials.ai_connection_secrets, bookworm_credentials.ai_connection_operations from public, anon, authenticated, service_role;

-- The API verifies bearer identity and supplies p_owner_id, never a browser
-- owner field. Definer is needed only for private tables; fixed search path.
-- Every write is compare-and-swap. A lost reply is recovered by metadata GET,
-- not by retaining/resubmitting a plaintext key. Operation reuse is refused.
create function public.mutate_ai_connection(
 p_owner_id uuid, p_provider text, p_connection_id uuid, p_expected_revision integer,
 p_operation_id uuid, p_action text, p_key_suffix text default null,
 p_key_id text default null, p_nonce text default null, p_ciphertext text default null,
 p_auth_tag text default null
) returns public.ai_connections language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.ai_connections; n integer;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required';
 end if;
 if p_owner_id is null or p_connection_id is null or p_operation_id is null
   or p_provider is null or p_provider not in ('openai','anthropic','google','openrouter','xai')
   or p_action is null or p_action not in ('save','revoke')
   or (p_expected_revision is not null and (p_expected_revision<1 or p_expected_revision>=2147483647)) then
  raise exception using errcode='22023',message='invalid connection mutation';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-connection:'||p_owner_id::text,0));
 if exists(select 1 from bookworm_credentials.ai_connection_operations where owner_id=p_owner_id and operation_id=p_operation_id) then
  raise exception using errcode='40001',message='reload saved connection';
 end if;
 select * into v from public.ai_connections where owner_id=p_owner_id and provider=p_provider for update;
 if (v.id is null and (p_expected_revision is not null or p_action='revoke'))
   or (v.id is not null and (p_expected_revision is distinct from v.revision or p_connection_id<>v.id)) then
  raise exception using errcode='40001',message='reload saved connection';
 end if;
 -- No replacement can rename a connection or cross owners, including create.
 if v.id is null and exists(select 1 from public.ai_connections where id=p_connection_id) then
  raise exception using errcode='40001',message='reload saved connection';
 end if;
 if (select count(*) from bookworm_credentials.ai_connection_operations where owner_id=p_owner_id and created_at>clock_timestamp()-interval '1 minute')>=10 then
  raise exception using errcode='P0429',message='connection update limit reached';
 end if;
 n:=coalesce(v.revision,0)+1;
 if p_action='save' then
  if p_key_suffix is null or p_key_id is null or p_nonce is null or p_ciphertext is null or p_auth_tag is null then
   raise exception using errcode='22023',message='encrypted envelope required';
  end if;
  insert into public.ai_connections(id,owner_id,provider,revision,status,key_suffix,last_operation_id)
   values(p_connection_id,p_owner_id,p_provider,n,'saved',p_key_suffix,p_operation_id)
   on conflict(owner_id,provider) do update set revision=n,status='saved',key_suffix=p_key_suffix,
    last_operation_id=p_operation_id,updated_at=clock_timestamp()
   returning * into v;
  insert into bookworm_credentials.ai_connection_secrets(connection_id,revision,key_id,nonce,ciphertext,auth_tag)
   values(v.id,n,p_key_id,p_nonce,p_ciphertext,p_auth_tag)
   on conflict(connection_id) do update set revision=n,key_id=p_key_id,nonce=p_nonce,ciphertext=p_ciphertext,auth_tag=p_auth_tag;
 else
  if p_key_suffix is not null or p_key_id is not null or p_nonce is not null or p_ciphertext is not null or p_auth_tag is not null then
   raise exception using errcode='22023',message='revoke cannot contain credentials';
  end if;
  delete from bookworm_credentials.ai_connection_secrets where connection_id=v.id;
  update public.ai_connections set revision=n,status='revoked',key_suffix=null,last_operation_id=p_operation_id,updated_at=clock_timestamp()
   where id=v.id returning * into v;
 end if;
 insert into bookworm_credentials.ai_connection_operations(owner_id,operation_id,connection_id,provider,expected_revision,revision,action)
  values(p_owner_id,p_operation_id,v.id,p_provider,p_expected_revision,n,p_action);
 return v;
end;
$$;
revoke all on function public.mutate_ai_connection(uuid,text,uuid,integer,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.mutate_ai_connection(uuid,text,uuid,integer,uuid,text,text,text,text,text,text) to service_role;

-- Closing an unobserved request serializes with its original write and leaves
-- a tombstone: a late save cannot resurrect it. Returns metadata only.
create function public.recover_ai_connection_operation(
 p_owner_id uuid,p_provider text,p_connection_id uuid,p_expected_revision integer,
 p_operation_id uuid,p_action text,p_close boolean default false
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v bookworm_credentials.ai_connection_operations;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception using errcode='42501',message='server authorization required';
 end if;
 if p_owner_id is null or p_connection_id is null or p_operation_id is null or p_close is null
   or p_provider is null or p_provider not in ('openai','anthropic','google','openrouter','xai')
   or p_action is null or p_action not in ('save','revoke')
   or (p_expected_revision is not null and (p_expected_revision<1 or p_expected_revision>=2147483647)) then
  raise exception using errcode='22023',message='invalid connection recovery';
 end if;
 if p_close then perform pg_advisory_xact_lock(hashtextextended('ai-connection:'||p_owner_id::text,0)); end if;
 select * into v from bookworm_credentials.ai_connection_operations where owner_id=p_owner_id and operation_id=p_operation_id;
 if v.operation_id is not null and (v.provider<>p_provider or v.connection_id<>p_connection_id or v.action<>p_action
   or v.expected_revision is distinct from p_expected_revision) then
  raise exception using errcode='40001',message='connection recovery does not match';
 end if;
 if v.operation_id is null and p_close then
  if (select count(*) from bookworm_credentials.ai_connection_operations where owner_id=p_owner_id and created_at>clock_timestamp()-interval '1 minute')>=10 then
   raise exception using errcode='P0429',message='connection update limit reached';
  end if;
  insert into bookworm_credentials.ai_connection_operations(owner_id,operation_id,connection_id,provider,expected_revision,action)
   values(p_owner_id,p_operation_id,p_connection_id,p_provider,p_expected_revision,p_action) returning * into v;
 end if;
 return jsonb_build_object('operationId',p_operation_id,'connectionId',p_connection_id,'provider',p_provider,
  'expectedRevision',p_expected_revision,'action',p_action,'revision',v.revision,
  'status',case when v.operation_id is null then 'not_found' when v.revision is null then 'closed'
    when v.action='save' then 'saved' else 'revoked' end);
end;
$$;
revoke all on function public.recover_ai_connection_operation(uuid,text,uuid,integer,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.recover_ai_connection_operation(uuid,text,uuid,integer,uuid,text,boolean) to service_role;
