# Native author-file acceptance

This test runs the actual Bookworm API and document worker against disposable
Supabase Auth, PostgREST, Storage, ClamAV and document-parser containers. It does
not use the SQL-only suite's Auth/Storage stubs or injected API service fakes.

## Running and safety

The `Native author files acceptance` GitHub workflow builds the existing private
service images and runs `node tests/e2e/run-native-author-files.mjs`. Supabase CLI
is fixed at 2.120.0; its setup action is pinned to the reviewed v3 commit. The
runner refuses execution outside explicitly enabled GitHub-hosted Linux CI.
Run the safe, Docker-free guard tests locally with `npm run test:native-author-guard`.

The runner copies only the ordered repository migrations into a new temporary,
unlinked Supabase project. It never copies `.temp`, `.env`, customer data or
commercial seeds. There is no `db push`, `link`, hosted project ID, external Auth
provider, payment or deployment step. Startup and cleanup target the generated
project only. Private processing containers use a separate internal network.
Published ports must bind to loopback. Operator credentials, proxy/Docker
overrides and dotenv hooks are not inherited by child processes.

The processing network stays Docker-internal, with no published ports or
external route. Two byte-transparent Node TCP relays bind only to host loopback
and reach inspected, running containers on that exact network. They do not
replace HTTP responses or service implementations. The project ID is a full
random UUID under a short prefix, below the pinned CLI's 40-character cap;
inspected container labels must match the cleanup identity exactly.

Native service credentials exist only in process memory/environment and are
never printed. The journey's fetch guard allows only the exact owned loopback
origins, refuses redirects, and bounds requests. OpenAI and Stripe credentials
are empty; no AI job or provider usage may be created. This does not bypass the
application's entitlement, quote or consent controls.

## Assertions

- Two actual email/password signups, native profile triggers, API token
  verification, and workspace isolation through both API and PostgREST.
- Book create/replay, mismatched replay refusal and foreign-book denial.
- Real signed upload, quarantine visibility at both API and Storage, checksum
  mismatch and scanner-unavailable recovery, real malware scan, byte-exact
  original download, and refusal of foreign upload authority.
- The test-only ClamAV database recognizes one exact harmless text fixture;
  the API must persist the infected verdict and keep its bytes quarantined.
- A synthetic DOCX with a table and PNG follows upload, scan, durable job,
  actual document parser, actual embedded-image scan, transaction and receipt.
  Canonical saved text/word counts, tenant-private image bytes, original source
  preservation and idempotent replay are checked.
- A rows-only manual chapter and a real edit/reload verify initial projections,
  stale-write refusal and foreign-write denial. AI jobs/usage remain empty.
- Book Bible create/update/reload links a real scanned image and a pinned saved
  passage. Durable replay/recovery, changed-intent refusal, actor/tenant scope,
  stale edits and evidence retrieval use the actual API and database.
- Ordered migration source digests must be unchanged after the run; owned
  containers, networks and local database volumes are removed in `finally`.

## Evidence boundary

Native run `38386967571` on `6dc20cd` successfully started Supabase with all
109 migrations, resolving the earlier pgcrypto error. It then exposed two
harness defects: internal-only Docker containers have no published host port,
and the 48-character project ID was truncated by `start` but not the explicit
`stop --project-id` filter. Owned-network removal correctly failed rather than
claiming cleanup success. The relay and short-ID repairs above have local
guard coverage; the complete author/Book Bible journey still needs terminal
native acceptance. Separate native database run `38386967711` passed on that
same source SHA; SQL-only acceptance does not certify Auth/Storage HTTP.

The pinned [CLI project-ID implementation](https://github.com/supabase/cli/blob/v2.120.0/apps/cli/src/command-internal/docker-ids.ts)
and [stop handler](https://github.com/supabase/cli/blob/v2.120.0/apps/cli/src/commands/stop/stop.handler.ts)
explain the cleanup mismatch. Docker documents host access to an internal
bridge separately from [port publishing](https://docs.docker.com/engine/network/port-publishing/).

### pgcrypto portability repair

Native run `38384612896` reached the narration snapshot migration and exposed
an actual schema dependency: Supabase keeps pgcrypto in `extensions`, while
the SQL-only fixtures had installed it in `public`. Functions with a fixed
`public, pg_temp` search path could not resolve their existing digest calls.

`20260912175000_pgcrypto_digest_compatibility.sql` is additive and deliberately
ordered immediately after the deployed 45-migration baseline, before any
pending SQL-language function resolves `public.digest` during creation. The CLI
generated its empty file on October 13; only the new, undeployed filename was
ordered at this prerequisite boundary. None of the 45 historical files changed.
There are now 109 migrations locally (64 beyond that baseline).

On a public pgcrypto install the migration makes no changes. On an alternate
schema install it adds two immutable, strict, invoker-only digest overloads,
calling the verified extension-owned functions by qualified name. It never
moves the extension, replaces a collision, rewrites hashes or grants table
access. Existing extension-schema/function access is required; unexpected
permissions or overloads abort atomically for operator review. Anonymous
execution of the new bridges is revoked.

`npm run test:db:crypto` checks public, extensions and quoted-schema layouts,
Unicode/bytea/text hash parity, grants, extension preservation, collision/access
guards and rollback. Full fresh/populated/native tests remain necessary.

Rollback: before deployment, remove only this unapplied migration if the design
is withdrawn. After deployment, use a reviewed forward repair; do not drop the
bridges while existing routines depend on them or relocate pgcrypto. Failed
transactional application rolls back both bridge creation and grants, with no
data changes. A live upgrade still requires explicit approval, drift review
and usable backup; earlier approval questions about 63 pending files do not
silently authorize the expanded 64-file sequence.

This is an acceptance harness, not a claim that its first CI execution passed.
Record the exact source SHA, run/job, terminal outcome and assertions before
promoting it to release evidence. Local syntax/guard checks do not substitute
for Docker execution. It does not prove Google OAuth consent, rendered browser
behavior, funded OpenAI generation, a hosted database upgrade, physical print
proof, retailer acceptance or whole-product readiness. Those remain separate
release gates; Stripe remains deferred.

Design follows the official [local development workflow](https://supabase.com/docs/guides/local-development/cli-workflows).
That stack is development-only, not a production hosting configuration.
