-- Synthetic copy of the reviewed managed Auth function bodies. Preserve the
-- space after SELECT when constructing each body: the cutover pins its hash.
create role supabase_auth_admin nologin;
grant usage on schema auth to anon, authenticated, service_role;
do $fixture$
begin
  execute format('create or replace function auth.uid() returns uuid language sql stable as %L',
    replace($body$
  select<space>
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$body$, '<space>', chr(32)));
  execute format('create or replace function auth.role() returns text language sql stable as %L',
    replace($body$
  select<space>
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$body$, '<space>', chr(32)));
end $fixture$;
alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
