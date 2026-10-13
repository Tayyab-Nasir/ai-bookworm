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
- Ordered migration source digests must be unchanged after the run; owned
  containers, networks and local database volumes are removed in `finally`.

## Evidence boundary

This is an acceptance harness, not a claim that its first CI execution passed.
Record the exact source SHA, run/job, terminal outcome and assertions before
promoting it to release evidence. Local syntax/guard checks do not substitute
for Docker execution. It does not prove Google OAuth consent, rendered browser
behavior, funded OpenAI generation, a hosted database upgrade, physical print
proof, retailer acceptance or whole-product readiness. Those remain separate
release gates; Stripe remains deferred.

Design follows the official [local development workflow](https://supabase.com/docs/guides/local-development/cli-workflows).
That stack is development-only, not a production hosting configuration.
