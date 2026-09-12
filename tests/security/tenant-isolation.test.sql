-- tests/security/tenant-isolation.test.sql
-- Tenant isolation test (T04 acceptance): two unrelated users in separate
-- workspaces must not be able to read or write each other's
-- books / chapters / assets / documents.
--
-- Run against a local Supabase database (all migrations, including the
-- additive 0014 RLS hardening migration, applied):
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/tenant-isolation.test.sql
--
-- auth.uid() is simulated per-block with:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<user uuid>"}';
-- so each statement executes under real RLS as that user. Any unexpected
-- cross-tenant row or successful cross-tenant write aborts the script
-- via assert (ON_ERROR_STOP=1 makes that a non-zero exit).

begin;

-- ---------------------------------------------------------------- setup
-- Runs as postgres (table owner, bypasses RLS) to seed two tenants.
create temp table tenant_ids (
  user_a uuid, user_b uuid,
  org_a uuid, org_b uuid,
  ws_a uuid, ws_b uuid,
  book_a uuid, book_version_a uuid, chapter_a uuid, doc_a uuid,
  asset_a uuid, asset_version_a uuid, edition_a uuid
) on commit drop;
-- SET ROLE below changes the effective database role, so grant the test-only
-- fixture identifiers explicitly. The table is temporary and rolled back.
grant select on table tenant_ids to authenticated;

insert into auth.users (id, email)
values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'user-a@isolation.test'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'user-b@isolation.test')
on conflict (id) do nothing;

do $$
declare
  v_user_a uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  v_user_b uuid := 'bbbbbbbb-0000-0000-0000-00000000000b';
  v_org_a uuid; v_org_b uuid;
  v_ws_a uuid; v_ws_b uuid;
  v_book_a uuid; v_book_version_a uuid; v_chapter_a uuid; v_doc_a uuid;
  v_asset_a uuid; v_asset_version_a uuid; v_edition_a uuid;
begin
  insert into public.organizations (name, slug, owner_user_id)
    values ('Org A', 'iso-org-a', v_user_a) returning id into v_org_a;
  insert into public.organizations (name, slug, owner_user_id)
    values ('Org B', 'iso-org-b', v_user_b) returning id into v_org_b;

  insert into public.organization_members (organization_id, user_id, role)
    values (v_org_a, v_user_a, 'owner'), (v_org_b, v_user_b, 'owner')
    on conflict (organization_id, user_id) do nothing;

  insert into public.workspaces (organization_id, name, slug, created_by)
    values (v_org_a, 'WS A', 'iso-ws-a', v_user_a) returning id into v_ws_a;
  insert into public.workspaces (organization_id, name, slug, created_by)
    values (v_org_b, 'WS B', 'iso-ws-b', v_user_b) returning id into v_ws_b;

  insert into public.workspace_members (workspace_id, user_id, role)
    values (v_ws_a, v_user_a, 'owner'), (v_ws_b, v_user_b, 'owner')
    on conflict (workspace_id, user_id) do nothing;

  insert into public.books (workspace_id, title, author_name, created_by)
    values (v_ws_a, 'Book A', 'Author A', v_user_a) returning id into v_book_a;

  insert into public.book_versions (book_id, version_number, source_type, created_by)
    values (v_book_a, 1, 'upload', v_user_a) returning id into v_book_version_a;

  insert into public.book_metadata (book_id, description)
    values (v_book_a, 'tenant A private metadata');

  insert into public.chapters (book_id, order_index, title)
    values (v_book_a, 1, 'Chapter 1') returning id into v_chapter_a;

  insert into public.document_versions (chapter_id, version_number, content_json, plain_text, created_by)
    values (v_chapter_a, 1, '{}', 'secret manuscript A', v_user_a) returning id into v_doc_a;

  update public.chapters
    set current_document_version_id = v_doc_a
    where id = v_chapter_a;

  insert into public.assets (workspace_id, type, name, storage_path, mime_type, checksum, created_by)
    values (v_ws_a, 'image', 'cover.png', 'workspaces/' || v_ws_a || '/assets/x/v1/cover.png', 'image/png', 'sha256-a', v_user_a)
    returning id into v_asset_a;

  insert into public.asset_versions (asset_id, version_number, storage_path, checksum, created_by)
    values (v_asset_a, 1, 'workspaces/' || v_ws_a || '/assets/x/v1/cover.png', 'sha256-a', v_user_a)
    returning id into v_asset_version_a;

  insert into public.editions (book_id, type)
    values (v_book_a, 'ebook') returning id into v_edition_a;

  insert into tenant_ids values (
    v_user_a, v_user_b, v_org_a, v_org_b, v_ws_a, v_ws_b, v_book_a,
    v_book_version_a, v_chapter_a, v_doc_a, v_asset_a, v_asset_version_a,
    v_edition_a
  );
end $$;

-- ------------------------------------------------- user B isolation block
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b"}';

do $$
declare
  v record;
  n int;
begin
  select * into v from tenant_ids limit 1;

  -- B cannot SELECT A's rows
  select count(*) into n from public.books where id = v.book_a;
  assert n = 0, 'FAIL: user B can select user A books';

  select count(*) into n from public.organizations where id = v.org_a;
  assert n = 0, 'FAIL: user B can select user A organization';

  select count(*) into n from public.organization_members where organization_id = v.org_a;
  assert n = 0, 'FAIL: user B can select user A organization membership';

  select count(*) into n from public.book_versions where id = v.book_version_a;
  assert n = 0, 'FAIL: user B can select user A book versions';

  select count(*) into n from public.book_metadata where book_id = v.book_a;
  assert n = 0, 'FAIL: user B can select user A book metadata';

  select count(*) into n from public.chapters where id = v.chapter_a;
  assert n = 0, 'FAIL: user B can select user A chapters';

  select count(*) into n from public.document_versions where id = v.doc_a;
  assert n = 0, 'FAIL: user B can select user A document_versions';

  select count(*) into n from public.assets where id = v.asset_a;
  assert n = 0, 'FAIL: user B can select user A assets';

  select count(*) into n from public.asset_versions where id = v.asset_version_a;
  assert n = 0, 'FAIL: user B can select user A asset versions';

  select count(*) into n from public.editions where id = v.edition_a;
  assert n = 0, 'FAIL: user B can select user A editions';

  select count(*) into n from public.workspaces where id = v.ws_a;
  assert n = 0, 'FAIL: user B can select user A workspace';

  assert not private.is_workspace_member(v.ws_a),
    'FAIL: user B is treated as a member of user A workspace';

  -- B cannot INSERT into A's workspace (can_edit_workspace(ws_a) is false)
  begin
    insert into public.books (workspace_id, title, author_name, created_by)
      values (v.ws_a, 'evil', 'evil', v.user_b);
    assert false, 'FAIL: user B inserted a book into user A workspace';
  exception when insufficient_privilege then null;
            when check_violation then null;
  end;

  begin
    insert into public.chapters (book_id, order_index, title)
      values (v.book_a, 99, 'evil');
    assert false, 'FAIL: user B inserted a chapter into user A book';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.document_versions (chapter_id, version_number, content_json, created_by)
      values (v.chapter_a, 99, '{}', v.user_b);
    assert false, 'FAIL: user B inserted a document version into user A chapter';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.assets (workspace_id, type, name, storage_path, mime_type, checksum, created_by)
      values (v.ws_a, 'image', 'evil.png', 'evil', 'image/png', 'x', v.user_b);
    assert false, 'FAIL: user B inserted an asset into user A workspace';
  exception when insufficient_privilege then null;
  end;

  -- B cannot UPDATE A's rows (0 rows visible => no-op; assert nothing changed)
  update public.books set title = 'pwned' where id = v.book_a;
  update public.chapters set title = 'pwned' where id = v.chapter_a;
  update public.assets set name = 'pwned' where id = v.asset_a;

  raise notice 'user B isolation checks passed';
end $$;

reset role;

-- ------------------------------------------- verify A's data is untouched
do $$
declare
  v record;
  n int;
begin
  select * into v from tenant_ids limit 1;

  select count(*) into n from public.books where id = v.book_a and title = 'Book A';
  assert n = 1, 'FAIL: user A book was modified or deleted by user B';

  select count(*) into n from public.chapters where id = v.chapter_a and title = 'Chapter 1';
  assert n = 1, 'FAIL: user A chapter was modified or deleted by user B';

  select count(*) into n from public.document_versions where id = v.doc_a and plain_text = 'secret manuscript A';
  assert n = 1, 'FAIL: user A document version was modified by user B';

  select count(*) into n from public.assets where id = v.asset_a and name = 'cover.png';
  assert n = 1, 'FAIL: user A asset was modified or deleted by user B';

end $$;

-- ------------------------------------------- user A sees own data (control)
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a"}';

do $$
declare
  v record;
  n int;
begin
  select * into v from tenant_ids limit 1;

  select count(*) into n from public.books where id = v.book_a;
  assert n = 1, 'FAIL: user A cannot see own book (policy regression)';

  select count(*) into n from public.book_versions where id = v.book_version_a;
  assert n = 1, 'FAIL: user A cannot see own book version';

  select count(*) into n from public.book_metadata where book_id = v.book_a;
  assert n = 1, 'FAIL: user A cannot see own book metadata';

  select count(*) into n from public.chapters where id = v.chapter_a;
  assert n = 1, 'FAIL: user A cannot see own chapter';

  select count(*) into n from public.document_versions where id = v.doc_a;
  assert n = 1, 'FAIL: user A cannot see own document version';

  select count(*) into n from public.assets where id = v.asset_a;
  assert n = 1, 'FAIL: user A cannot see own asset';

  select count(*) into n from public.asset_versions where id = v.asset_version_a;
  assert n = 1, 'FAIL: user A cannot see own asset version';

  select count(*) into n from public.editions where id = v.edition_a;
  assert n = 1, 'FAIL: user A cannot see own edition';

  assert private.is_workspace_member(v.ws_a),
    'FAIL: user A is not treated as a member of their workspace';

  -- A (owner) can insert into own workspace
  insert into public.books (workspace_id, title, author_name, created_by)
    values (v.ws_a, 'Book A2', 'Author A', v.user_a);

  raise notice 'user A control checks passed';
end $$;

reset role;

do $$ begin raise notice 'TENANT ISOLATION: ALL CHECKS PASSED'; end $$;

rollback; -- keep test data out of the database
