# Native author-file acceptance

This test runs the actual Bookworm API and document worker against disposable
Supabase Auth, PostgREST, Storage, ClamAV, document-parser and rendering containers. It does
not use the SQL-only suite's Auth/Storage stubs or injected API service fakes.

## Running and safety

The `Native author files acceptance` GitHub workflow builds the existing private
service images and runs `node tests/e2e/run-native-author-files.mjs`. Supabase CLI
is fixed at 2.120.0; its setup action is pinned to the reviewed v3 commit. The
runner refuses execution outside explicitly enabled GitHub-hosted Linux CI.
Run the safe, Docker-free guard tests locally with `npm run test:native-author-guard`.
The guard suite boots the actual production API with the same child-environment
builder, synthetic local settings and outbound fetches forbidden. This catches
environment-schema and route-registration failures before building containers;
it does not replace native dependency or authenticated-journey acceptance.

The runner copies only the ordered repository migrations into a new temporary,
unlinked Supabase project. It never copies `.temp`, `.env`, customer data or
commercial seeds. There is no `db push`, `link`, hosted project ID, external Auth
provider, payment or deployment step. Startup and cleanup target the generated
project only. Private processing containers use a separate internal network.
Published ports must bind to loopback. Operator credentials, proxy/Docker
overrides and dotenv hooks are not inherited by child processes.

The processing network stays Docker-internal, with no published ports or
external route. Three byte-transparent Node TCP relays bind only to host loopback
and reach inspected, running containers on that exact network. They do not
replace HTTP responses or service implementations. The project ID is a full
random UUID under a short prefix, below the pinned CLI's 40-character cap;
inspected container labels must match the cleanup identity exactly.

Native service credentials exist only in process memory/environment and are
never printed. The journey's fetch guard allows only the exact owned loopback
origins, refuses redirects, and bounds requests. OpenAI and Stripe credentials
are empty; no AI job or provider usage may be created. This does not bypass the
application's entitlement, quote or consent controls.

Rendering uses the existing private image, including its pinned EPUBCheck
runtime, with a separate owned loopback relay and explicit service token.
No subscription or commercial plan is seeded: saved-book export uses the
application's existing rendering entitlement. Initial authoring creates no
usage; the export extension requires exactly two `rendering` meter records,
one per saved edition, with no AI jobs or other usage even after replay.

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
- The production Next interface runs against those same real services in
  Playwright: signup/profile/private cookies, workspace onboarding, DOCX
  upload/import, chapter save/reload, linked Book Bible, publishing metadata,
  mobile containment, logout and a fresh-context returning-author login.
  It does not replace application responses with browser fixtures. The web
  child receives only the disposable anonymous key, not service-role or paid
  provider credentials. Canonical web, API and Supabase origins must differ.
- Synthetic desktop/mobile screenshots are retained for seven days. Password
  fields are masked; cookies, storage-state dumps and raw server logs are not
  uploaded. The workflow also runs for web-only source changes. Browser and
  web processes are closed before native-service cleanup.
- Ordered migration source digests must be unchanged after the run; owned
  containers, networks and local database volumes are removed in `finally`.

## Evidence boundary

Native production-browser run `38400066961`, job `115305096361`, PASSED at
`2026-10-13T12:52:58Z` on exact `b24ca869b2d5b92fa3f0b250e4304a30b52c29bc`.
Alongside the native API/service assertions, its terminal logs verify signup,
private cookies, workspace creation, real DOCX import, persistent chapter edits,
Book Bible image/chapter links after reload, saved description/keywords, desktop
and mobile containment, logout, fresh-context login and foreign-book refusal.
Zero AI jobs/usage, migration-source integrity and both cleanup levels passed.
This supersedes the failed-browser status below; it does not cover the new
rendering extension or hosted Google OAuth/funded provider/release acceptance.

The added native export extension is not yet accepted. It exercises actual
EPUB/PDF generation, stored bytes/checksums, foreign-tenant refusal, durable
render replay, real saved EPUB text/image reads, refreshed PDF downloads and
export preflight replay. It edits the manuscript afterward: old proofs must
remain readable byte-for-byte, while reuse of old render/preflight keys must
return 409. Preflight findings are recorded, not treated as retailer approval;
the deliberately small imported image is not print-quality acceptance. This
does not yet prove the browser's Publishing Studio against native rendering.

Export run `38400938973`, job `115308087178`, failed at `2026-10-13T12:59:38Z`
on `f3096e7` after the complete native author/browser flow passed. EPUB rendering,
private-byte checksum/replay and saved history checks reached the reader; the
test incorrectly expected manuscript text in spine section zero, which is the
real table of contents. A local renderer/reader reproduction confirms this.
The revised test resolves the imported chapter's unique title from the returned
spine, keeps exact-source/text/image/tenant checks and uses that chapter again
for old-proof verification. Both cleanup levels passed in the failed run;
preflight, print and final export accounting are not yet accepted.

Native author run `38389676074`, job `115270072557`, passed at
`2026-10-13T11:24:19Z` on exact source
`9245dfc6bdd860cf09aad90fd4f050d4d33cf19e`. Its terminal logs confirm the
real API/Auth/Storage/scanner/import/Book Bible assertions above, zero AI
jobs/usage, migration-source integrity and owned-resource cleanup. It does
**not** cover the production-browser extension added after that commit.
That extension has 11 passing local guard checks, including a reproduced
then-fixed trailing-slash origin-collision case, but still requires an exact
new-source production build and native browser run with screenshot review.

The first browser runs on `14e1791` and diagnostic follow-up `99ede3a` passed
production build and native API/service assertions, but failed when the test
read the signup response body after AuthCard's full navigation. A local
isolated Chrome reproduction confirms that old response handle is unavailable
while the new page's authenticated session endpoint succeeds. Browser identity
is now verified through that endpoint after navigation, including exact email,
minimal public fields and durable profile. Cookie, tenant and logout assertions
remain strict; production authentication behavior was not changed. Both failed
native runs completed browser/web and service cleanup. The revised browser
journey still needs terminal native acceptance.

Run `38395191172` on `5bbc4aa` subsequently passed the production-browser
signup/profile/private-cookie, workspace, real DOCX import and chapter
save/reload assertions. It stopped before saving linked Book Bible memory;
both cleanup levels passed. The retained screenshot shows its chapter select
still unselected. An isolated Chrome reproduction found zero matches for the
test's exact label lookup, but one exact accessible combobox match, which could
select the chapter. Both selection and reload assertions now use that semantic
role locator without changing the application or weakening saved-link checks.
The same probe reproduced exact-label failure for a populated nested textarea;
memory descriptions and metadata now use exact textbox roles. Metadata reload
also checks the saved keyword lines, not only the book description.
The remainder of this revised native browser journey is still unverified.

Run `38397789460` on `5c9dcec` passed the same earlier browser stages, then
failed at linked Book Bible save/reload; both cleanup levels passed. Its
retained screenshot now shows a confirmed saved entry and selected source
chapter. The UI performs a post-write identity check before clearing its dirty
state, so the test must await the actual save confirmation and cleared unsaved
indicator before reloading, not only the HTTP response. The save button remains
enabled after a confirmed save. The test also checks the returned entry type
independently of its visual badge, uses the entry name for selection, waits for
metadata save confirmation, and reports narrow stages with safe error categories.
These synchronization/diagnostic changes still require a successful native run;
the earlier failure does not by itself prove an application persistence defect.

Run `38387928342` on `fa4ff82` started Supabase, ClamAV and the document parser,
and completed owned cleanup. The author process then failed before requests
because its `LOG_LEVEL=fatal` was outside the application's configuration enum.
The shared child-environment builder now uses `error`; a real production-boot
regression reproduced that failure before the correction, then passed. All ten
guard/relay/boot checks passed locally before the successful retry above.

Native run `38386967571` on `6dc20cd` successfully started Supabase with all
109 migrations, resolving the earlier pgcrypto error. It then exposed two
harness defects: internal-only Docker containers have no published host port,
and the 48-character project ID was truncated by `start` but not the explicit
`stop --project-id` filter. Owned-network removal correctly failed rather than
claiming cleanup success. The relay and short-ID repairs above have local
guard coverage; the later successful author run above supplies terminal
native acceptance for that slice. Separate native database run `38386967711` passed on that
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
