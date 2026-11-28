# Supabase Migration Instructions

## Source of truth and safety

The ordered files in `supabase/migrations/` are the source of truth. Apply
every migration in lexical order, including the tenant hardening,
workspace onboarding, and authoring transaction migrations. These are required
by the connected application, not optional policy patches. Do not edit an
already-applied migration in place.

`docs/apply-migrations.sql` is a historical convenience snapshot through the
first 13 migrations. It is not sufficient by itself after the RLS hardening
migration. If the SQL Editor is the only available deployment path, run that
snapshot first, then run **every remaining ordered migration** as a separate
transaction after reviewing it. The snapshot alone will not install the
onboarding or authoring RPCs.

Never run a migration, reset, or push against a production project until a
backup exists and the dry run/review steps below have succeeded.

## Preferred: Supabase CLI

From the repository root, first inspect the migration plan without changing a
database:

```powershell
supabase db push --dry-run
supabase migration list --linked
```

After an authorized review of the output, apply with:

```powershell
supabase db push
```

`supabase db reset` destroys and recreates the target local database. It is
appropriate only for a disposable local environment, never for a shared,
staging, or production project.

## SQL Editor fallback

1. Open the intended Supabase project's SQL Editor (verify the project ref
   before pasting anything).
2. Run the reviewed historical snapshot only when migrations 0001–0013 are
   absent.
3. Run every pending file in `supabase/migrations/` in lexical order after
   the snapshot, including tenant hardening, onboarding and authoring RPCs.
4. Record the migration version in the deployment change log.

## Historical snapshot

The complete pre-hardening script is kept for bootstrap convenience at:

- Local path: `C:\Users\Asus\ai-bookworm\docs\apply-migrations.sql`
- Repository path: `docs/apply-migrations.sql`

```sql
-- ==== 0001_extensions.sql ====
create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.member_role as enum ('owner','admin','editor','writer','illustrator','designer','reviewer','viewer');
create type public.book_status as enum ('draft','in_review','approved','published','archived');
create type public.asset_status as enum ('draft','in_review','approved','rejected','archived');
create type public.job_status as enum ('queued','running','succeeded','failed','cancelled');
create type public.approval_status as enum ('pending','approved','rejected','cancelled');
create type public.task_status as enum ('todo','in_progress','blocked','done','cancelled');

-- ==== 0002_core.sql ====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  locale text not null default 'en-US',
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- ... (all 13 migrations - see apply-migrations.sql for full content)
```

## Verification

Run actual SQL in an automatically discarded local PostgreSQL/WASM database:

```powershell
npm run test:db
```

This executes the complete current migration chain and every
`tests/security/*.test.sql` script. It does not load `.env`, accept a database
URL, start a network listener, or contact Supabase. SQL tests cover real RLS
roles, tenant isolation, storage ownership and forged pointers, immutable
versions/parents, Book Bible permissions, community privacy, atomic onboarding
including a deliberately failed final insert, and the authoring RPCs.

The runner uses PGlite 0.5.8 with pgcrypto/citext. Its minimal `auth`/`storage`
schema fixture is **not** a full Supabase instance. Passing it does not verify
GoTrue login, PostgREST grants/schema exposure, Storage HTTP behavior, existing
production data compatibility, or concurrent multi-connection transactions.
Do not apply `tests/security/local-supabase-fixture.sql` to an existing database.

Run the static security contract locally (this does not contact Supabase):

```powershell
python -m pytest tests/security -q
```

On a disposable local Supabase database or an explicitly authorized staging
database, run the live RLS isolation test. It opens a transaction and rolls
back its fixtures:

```powershell
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/tenant-isolation.test.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/onboarding.test.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/authoring.test.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/rls-boundaries.test.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/security/community-privacy.test.sql
```

Then inspect database diagnostics without modifying state:

```powershell
supabase db lint --linked --fail-on error
```

The live test must print `TENANT ISOLATION: ALL CHECKS PASSED`. It verifies
that unrelated users cannot read or write each other's organizations,
workspaces, manuscripts, versions, assets, metadata, or editions.

## Release status

Local test success does not establish production readiness or permission to
deploy. No live migration or retailer submission was performed by this SQL
validation pass. Inspect the active build plan and shared handoff for current
runtime ports, integration state, pending migrations and verification gaps.
