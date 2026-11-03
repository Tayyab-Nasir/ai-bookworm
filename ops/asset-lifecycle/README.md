# Asset lifecycle cutover: review draft

The additive migration installs revision tracking and inaccessible lifecycle
functions. The feature remains disabled by default, and the current legacy
removal path remains available. The file
`atomic-cutover.source-only.sql` is **not an automatic migration** and must
not be used to turn on the feature until the separate release checks are met.

The artifact contains one explicit transaction. Submit its exact contents on
a **dedicated idle database connection** with error stopping enabled. Never
execute it inside an existing transaction: its final `COMMIT` could commit
that transaction. Do not run the component drafts separately. On any failure,
close or roll back the connection and investigate; do not bypass guards.

The Auth check is specific to the reviewed Supabase project
`cyhqtwndadlyzpeatxws`: it pins the observed `supabase_auth_admin` ownership
and source hashes of managed `auth.uid()` and `auth.role()`. A legitimate
Supabase update can make the check fail. Review the current hosted functions,
their semantics and privileges before revising the pin; do not replace it with
a self-captured baseline.

Before a real cutover, verify a current database and Storage backup and restore
plan, exact hosted migration and security baseline, and the managed Auth pins.
Drain old writers and coordinate every API/web instance; quiesce privileged
schema writers, because the readiness fingerprint cannot prevent a concurrent
non-cooperating privileged function change. Establish statement limits and
hosted JWT/PostgREST and Storage acceptance. Storage hash verification confirms
bytes only at check time and is not a retention guarantee. Keep tombstones
until all delayed requests are provably impossible.

Local proofs are separate from hosted acceptance:

```sh
node tests/security/asset-lifecycle-cutover-pglite.mjs
BOOKWORM_PG_BIN=/path/to/postgresql-17/bin node tests/security/asset-lifecycle-cutover-native.mjs
```

The native test creates a disposable loopback-only PostgreSQL 17 cluster and
requires permission to run `initdb` as a non-root user. On Windows, set
`BOOKWORM_PG_BIN` in PowerShell before running the second command. Neither
test loads the app environment or connects to Supabase. Their synthetic Auth
fixture mirrors the reviewed function definitions solely for testing; it must
never be applied to a hosted project.
