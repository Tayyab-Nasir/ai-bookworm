-- Deliberately minimal local fixtures. Do NOT apply this file to Supabase.
-- The runner creates a new in-memory database and cannot connect elsewhere.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;

create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
$$;

create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  metadata jsonb,
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant all on all tables in schema public, auth, storage to service_role;
-- Mimic Supabase's baseline grants so the hardening migration's revocations
-- are exercised; RLS policies remain responsible for row visibility.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
