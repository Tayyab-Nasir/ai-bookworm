# Hosted database upgrade review

Recorded on 2026-10-23 for Supabase **AI-BookWorm** (`cyhqtwndadlyzpeatxws`).
The upgrade is applied and verified. Earlier preflight notes below are historical.

## Applied and verified — 2026-10-23

All 64 reviewed pending migrations succeeded, preserving the original 45 hosted
history entries. A post-upgrade advisor identified default client EXECUTE grants
on a recreated internal metadata trigger helper. A regression test reproduced
the issue; the additional `metadata_trigger_execution_hardening` migration
revoked anonymous/authenticated access while retaining service access. The
project now has **110 of 110 source migrations**, with no pending files.

The hosted schema matches the reconstructed target: 91 application tables plus
the unchanged unrelated `AI-BookWorm` table, 247 functions, 112 policies,
230 indexes including the unrelated table's index, 84 triggers and six enums.
All application tables have RLS enabled. Final catalog comparison confirms
the follow-up changed only the intended permissions. The profile's hosted
fingerprint is unchanged; one Auth user and zero Storage objects remain.

A live transaction verified anonymous onboarding rejection, authenticated
workspace/book creation, owner memberships and cross-tenant read denial.
It was rolled back; no test workspace or book remains. Local checks passed:
110 migrations, 72 SQL assertion files, the populated 45-to-110 upgrade with
five guarded aborts, crypto namespace checks and three inventory tests.

Recovery used the verified **application-only** snapshot and archived SQL after
the user delegated finding a workable recovery method. A private local restore
rehearsal preserved the typed profile and matched the schema. This is not a
full Supabase/Auth/Storage/project-settings backup. No credentials or customer
rows are in Git or Obsidian. Full disaster recovery remains a release gate.

Metadata-only evidence, source hashes, hosted versions and advisor follow-ups:
[`evidence/supabase-upgrade-applied-2026-10-23.json`](evidence/supabase-upgrade-applied-2026-10-23.json).
Do not replay the old 45 or the completed 64-file plan; refresh hosted history.

The anonymous privileged-function advisory is resolved. Remaining advisors
cover existing public `citext`, authenticated privileged application RPCs,
disabled leaked-password protection, server-only tables without client policies,
and performance index suggestions. No blanket grants or index deletion.
This is not full web/worker/provider acceptance. Mobile remains parked,
Stripe deferred, and no deployment, paid generation or retailer submission occurred.

## Historical operator approval and preflight — 2026-10-23

The user explicitly approved proceeding with the Supabase migrations. That
approval covers the reviewed 64-file upgrade below; it does not need to be
requested again. **No live migration has run yet.**

Fresh checks still identify the intended healthy project with 45 applied and
109 local migrations. The 109 source files match commit
`3019489301d1d76e5e1b4308e5ae3aa54d13228b`. The populated 45-to-109 rehearsal
passed again, including five guarded failures with atomic rollback; ordered
source manifest SHA-256:
`e9f7c1fc6b2ff81c100bb674b6e773db64a840dd57b3b9b5b332872b7d37b54c`.

A catalog comparison against a reconstructed 45-migration baseline verified
75 application function bodies and effective role grants, 55 table definitions,
102 policies, 117 indexes, 33 triggers, six enums and the private storage bucket.
The comparison accounts for PostgreSQL's differing NOT NULL catalog
representation and the observed hosted default function grants. The unrelated
empty `public."AI-BookWorm"` table and its index are preserved. This comparison
does not claim that all managed Supabase schemas have been audited.

Exact aggregate reads found one profile and no workspaces, books, assets,
AI/publishing/import jobs, audiobook projects, Book Bible items or stored
objects. No active application jobs, other active client transactions, idle
transactions, duplicate active metadata requests or nonfinite canon revisions
were observed. Repeat activity checks immediately before applying the upgrade.

The signed-in dashboard confirms that the Free plan has **no project backups**.
The connected migration tools work, but the CLI has no management login and
the local environment has no direct database connection for an export. The
user is saving `BOOKWORM_BACKUP_DATABASE_URL` in the ignored root `.env.local`.
Never put that value in chat, Git, logs or the shared vault.

Portable PostgreSQL 17.11 tools from PostgreSQL's official EDB download and a
checksum-verified Mozilla CA bundle are prepared locally. The operator helper
`.git/bookworm-tracking/backup-hosted-project-20261023.mjs` requires the exact
project host/user, verifies TLS, uses read-only transactions, excludes credentials
from process arguments/logs, and stores archives outside the repository/vault
with restricted Windows permissions. It will export database and password-free
role definitions, read every archive entry, and write a metadata-only receipt.
**An export and a restore drill have not yet occurred.**

Next: after the connection is configured, complete the backup and restore
readiness check, refresh hosted history/activity, apply the 64 pinned files in
order through the migration tool, then compare the hosted target catalog and
run permission/feature checks. Do not replay the first 45 migrations or bypass
a failed migration guard. Current preflight receipts and source/target catalogs
are local under `.git/bookworm-tracking/hosted-*-20261023.*`.

## Verified metadata

The hosted project was `ACTIVE_HEALTHY`. Its migration history contained **45**
entries; the repository contains **109** SQL migrations. All 45 recorded names
map uniquely, in order, to the first 45 local files. **64 migrations remain
unrecorded in that hosted history.** This establishes recorded identity only:
it does not prove that hosted definitions match the source bytes or that no
manual schema changes occurred.

The last hosted entry is application timestamp `20260912044427`, named
`audiobook_idempotency_hardening`. Its local source is
`20260912170000_audiobook_idempotency_hardening.sql`. These timestamps differ
because the hosted version records when the migration was applied. Comparing
timestamps directly would produce a false plan and risks replaying the baseline.
Do not run an unreviewed `supabase db push` or repair migration history to make
the numbers look equal.

The metadata-only snapshot is
[`evidence/supabase-migration-history-2026-10-23.json`](evidence/supabase-migration-history-2026-10-23.json).
It contains migration names and versions, not credentials or customer records.
Regenerate the source-hashed review offline from the repository root:

```powershell
node scripts/migration-inventory.mjs --applied docs/evidence/supabase-migration-history-2026-10-23.json
npm run test:migrations:inventory
```

The command reads local files and prints JSON. It neither loads operator
environment files nor connects to a database, alters history, writes a plan,
or executes SQL. Unknown names, holes, reordering, duplicate identities and
ambiguous mappings fail closed. Output includes a SHA-256 for every local SQL
file, the 45 mapped applications and the ordered pending files. A fresh metadata
snapshot is required if either the hosted project or local source changes.

## Required before a hosted upgrade

1. Re-read live migration history and inspect the affected tables, functions,
   policies and storage configuration for drift. Verify the intended project.
   Keep all credentials out of notes and logs.
2. Confirm a usable backup/PITR checkpoint and an operator-owned restore plan.
   Freeze application writes and relevant workers for the maintenance window;
   never delete customer records to make a guard pass.
3. Re-run the populated baseline-to-target rehearsal and native isolated
   acceptance on the exact reviewed source. The local rehearsal is
   `npm run test:db:upgrade`; native CI uses disposable Supabase/Docker, not
   this hosted project. Passing either is not proof of hosted schema parity.
4. Review the guarded migrations in particular:
   `20260919030000_metadata_single_active_request.sql` (duplicate active
   metadata requests), `20260919120000_quoted_translation_queue.sql` (expected
   worker function definition), and `20261013100000_manual_book_bible_recovery.sql`
   (finite historical revisions). A guard failure requires investigation and
   an explicit remediation decision, not bypassing the guard.
5. Obtain explicit approval for the mapped **64-file** hosted upgrade. Apply
   only the reviewed pending SQL, in source order, with transactional failure
   boundaries. Keep new application timestamps and source hashes in the
   operator receipt. Do not replay or silently rename the original 45 entries.
6. Verify RLS/tenant isolation, account onboarding, immutable saves, paid quote
   reservations and recovery, private storage and worker readiness before
   re-enabling writes. Run hosted advisors and inspect failures without exposing
   customer data. Confirm native file processors and long-lived workers are
   reachable from the web/API environment; a web-only Vercel build is not the
   full processing stack.

No hosted migrations, deployment, provider charges or retailer actions were
performed for this review. Mobile remains parked and Stripe remains deferred.
Credit enforcement must remain active even while checkout is deferred.
