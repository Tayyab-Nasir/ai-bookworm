# Hosted database upgrade review

Recorded on 2026-10-23 for Supabase **AI-BookWorm** (`cyhqtwndadlyzpeatxws`).
This is a read-only inventory, not an applied upgrade or release approval.

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
