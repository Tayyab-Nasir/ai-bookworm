# AI Bookworm shared-agent handoff

## Read first

This is the full AI-native publishing application, not only its landing page.
Shared vault: `C:/Users/Asus/Memory-Ai`.

- Current detailed Codex handoff:
  `Codex Sessions/2026-08/2026-08-31-ai-bookworm-codex-handoff.md`.
- Latest supplemental checkpoint:
  `Codex Sessions/2026-09/2026-09-23-bookworm-restore-recovery.md`.
- Latest live/Git checkpoint:
  `Codex Sessions/2026-09/2026-09-12-bookworm-live-rollout.md`.
- Claude handoff:
  `Claude Sessions/2026-08/2026-08-31-ai-bookworm-project-final-handoff.md`.
- Shared board: `Hermes Context/active-tasks.md`.
- Repository navigation and deployment boundaries: `docs/PROJECT_MAP.md` and
  `docs/VERCEL_DEPLOYMENT.md`.
- Read vault `AGENTS.md` and `CLAUDE.md` before writing. Do not edit other
  agents' private memory or the generated startup briefing.
- Read git status before edits. Preserve shared uncommitted work. Saved
  completion claims require current code and behavioral verification.

## Current checkpoint: 2026-09-24

### Paid AI review uncertain-response hold

OpenAI text SDK retries are disabled. The paid review worker writes a durable
dispatch marker before contacting the AI service; expired leases cannot
redispatch marked jobs. Lost/invalid service replies or uncertain completion
hold the running job with `ai_provider_outcome_unconfirmed`, preserve the
operational credit reservation, and create a private incident without charging
the author. The AI panel shows this state. The AI service now also reserves
and saves private, durable review-result receipts, so a lost reply can be
read without another provider call. The worker attempts one read-only
receipt recovery after an uncertain POST, validating job identity and saved
manuscript operations before charging. An admin-only, audited release is now
source-built for aged holds with no result; a saved result blocks release.
All three additive migrations are source-only, not live. Operator receipt
settlement and provider-usage
reconciliation remain open; do not clear holds by age. This is a prerequisite
for exposing the existing Book Bible candidate agent through paid jobs, not
the candidate workflow itself. See `docs/AI_REVIEW_UNCERTAINTY.md`.

### Book Bible manuscript evidence

Book Bible node citations are now checked against an actual saved document
version; unversioned node references are pinned on API save, and full canonical
node-text hashes are stored/checked. Invented nodes and stale text hashes
fail before write. An additive source-only SQL trigger rejects direct
PostgREST bypasses for new/changed references; historical rows are not
retroactively certified. Chapter-only references remain human notes, not
passage proof. Focused API tests cover save, stale/foreign refs, historical
edits and no-write failures. Full local `npm run verify` passes: 72
disposable migrations/50 SQL suites, 355 service tests, 12 E2E, 30 security,
plus workspace typechecks, API/web, load and mock evals. SQL tests cover
direct insert/update bypasses. See `docs/BOOK_BIBLE_EVIDENCE.md`. No
hosted rollout or AI provider action. Next: review/apply the migration in a
separately approved hosted rollout, verify author journeys, and continue the
wider release gates.

### Image provider cost-estimate provenance

The image job usage JSON now records `costEstimateBasis` separately from
`measurementStatus`: itemized input, conservative treatment of incomplete or
contradictory input breakdowns, or unavailable cost. Contradictory modality
counts cannot discount text, and invalid totals are stored as numeric
compatibility placeholders rather than as measured usage. This changes no
customer debit: image generation still consumes one paid entitlement, and
retail pricing/actual provider reconciliation remain unapproved. Full local
`npm run verify` passes; after the final token-normalization guard, API
typecheck and focused image adapter tests pass. No key, live provider request,
hosted migration, payment, or deployment was used. See
`docs/OPENAI_MODEL_PRICING_AUDIT.md`. Next: bounded provider receipt and
organization-usage reconciliation in an approved private environment, then a
funded versioned customer catalog and broader release gates.

### Imported table header fidelity

DOCX explicitly repeating header rows and EPUB `<thead>`/leading `<th>` rows
now retain `tableHeaderRows` through the canonical grid, table editor, EPUB
and print PDF. EPUB gets scoped column headers; PDF repeats styled headers on
later pages. Merged cells, row-header associations and complex table styling
remain unsupported. Full local `npm run verify` passes (71 disposable
migrations/49 SQL files, 355 services, 99 web, 12 E2E, 30 security, plus
API/type/load/evals); isolated production web build and real EPUBCheck 5.4.0
on a header-bearing EPUB pass. See `docs/TABLE_HEADER_FIDELITY.md`. Native
processing-container CI passed for `b8c7e22` (run 35958694353, including
DOCX header import through Google EPUB package). Hosted import acceptance
remains open.

### Google Play Books ebook handoff

An EPUB-only `googleplay` target now spans Publishing Studio, the client/API,
rendering preflight, package service and a source-only additive SQL migration.
The channel checks a readable 640–7200px front cover embedded in the exact
EPUB, requires the `google_play` paid publishing entitlement, and produces a
private deterministic ZIP for manual single-title Partner Center upload.
It does **not** submit, publish, verify Google processing or create a sale.
The exact EPUB now passes a fail-closed W3C EPUBCheck 5.4.0 in rendering
preflight and package assembly. A pinned checker is installed in the private
rendering/publishing container stages; native processing-container CI passed
for `00c91fd` (run 35957543082, including no-network render/preflight/package).
Full local `npm run verify` passes (71 disposable migrations/49 SQL assertions,
304 API, 353 services, 12 E2E, 30 security, load/evals). A cover-bearing
EPUB passed direct local preflight and package assembly with the actual JAR;
the resulting ZIP preserved identical EPUB bytes. No hosted migration or
retailer action. See `docs/GOOGLE_PLAY_EBOOK_EXPORT.md`. Next: separately
approved Partner Center/hosted acceptance and
wider release gates.

### Image usage measurement provenance

The OpenAI image adapter now saves `measurementStatus` (`complete`, `partial`,
or `unavailable`) in the job's usage JSON. Numeric zero placeholders remain
for existing AI-run columns when the provider omits usage, but the saved job
now distinguishes unknown provider spend from measured zero. This does not
change the one-credit image entitlement or establish retail pricing. Full
local `npm run verify` passes (70 disposable migrations/48 SQL assertions,
303 API tests, 348 service tests, 12 E2E, 30 security, load/evals). No live
provider request or hosted migration. Next: bounded private provider usage
acceptance and reconciliation, then an approved funded image catalog and the
remaining release gates.

### Concurrent image request reservation

`20260924160000_image_single_flight_reservation.sql` moves the
one-pending-image-per-author/workspace rule into the database's existing
organization-lock/credit-reservation transaction. Two API connections can no
longer both pass the earlier read and dispatch overlapping paid image jobs for
the same author/workspace. A different author or workspace can still reserve
available credits. The API maps the specific database refusal to 409 without
calling the provider. The new disposable SQL test and adapted older fixtures
pass; a native two-connection commit/rollback race is added to CI but was not
run locally because this machine lacks `psql`/Docker. Full local `npm run
verify` passes: 70 migrations, 48 SQL assertion files, 302 API tests, 348
service tests, 12 Python E2E tests, 30 security tests, load smoke and mock
evals. No hosted migration or provider call was made. The new migration is
source-only until a separate rollout review; image pricing/provider/storage
and native browser acceptance remain release gates.

### Operator resolution for unconfirmed image holds

An additive migration and admin-only API/UI now provide a reviewed release
path for aged, unresolved image jobs without a deliverable. The database
locks the job, checks that it is still running with no receipt, usage debit,
AI run or output reference, and atomically marks it failed with an incident
audit. The operator must attest to private-storage and provider-usage review;
the platform absorbs any uncertain provider cost. A late completion cannot
charge the released job. This is **not live**: the migration was not applied,
and hosted storage/provider/admin acceptance remains open. See
`docs/IMAGE_HOLD_RELEASE.md` and the vault checkpoint
`Codex Sessions/2026-09/2026-09-24-bookworm-image-hold-resolution.md`.

### Ambiguous paid image response guard

The OpenAI image adapter no longer silently retries an uncertain provider
reply. The asset API retains the reserved running job if the provider outcome
cannot be established, blocks another sequential image dispatch by that
author/workspace, and never claims that provider spend or credit outcome is
known. A definitely missing API key fails and releases the hold. The Assets
UI waits for image history before allowing generation and pauses while a
request is pending or history is unavailable. Full local `npm run verify`
passes (68 disposable migrations/46 SQL assertions, 300 API, 98 web, 348
services, 12 Python E2E, 30 security, load smoke and mock evals); isolated
production web build passes. There is no
provider receipt for a lost reply: operator reconciliation/release and native
multi-connection race testing remain open. No live provider call, migration or
deployment. See the shared vault note
`Codex Sessions/2026-09/2026-09-24-bookworm-image-uncertainty.md`.

### OpenAI model/pricing audit

Current official OpenAI documentation still lists the configured defaults:
GPT-6 Astra text, GPT Image 2.5 Sunburst image and GPT-4o Mini TTS audio.
`estimatedImageCost` now distinguishes the older Image 2 rates from Image 2.5
and conservatively accounts for partial input-token breakdowns. This is
diagnostic provider telemetry, not an image customer-credit quote; account
model access and actual paid usage remain unverified. API TypeScript and 297
API tests pass; no provider or live action. See
`docs/OPENAI_MODEL_PRICING_AUDIT.md`. Next: version and fund real customer
offers, validate worst-case model/size/quality/reference costs and usage
reconciliation in an approved private environment before selling credits.

### Saved-text AI suggestion proof sheet

`7c8bf70` replaces the opaque replacement snippet in the author AI sidebar
with a bounded-context Current/Proposed proof sheet derived from the saved
chapter and canonical replacement offsets. It marks insertion, deletion and
replacement text; stale chapter versions, missing nodes, invalid ranges,
wrong-chapter and no-op proposals cannot be applied from the UI. Apply remains
human-controlled and the API still validates the operation authoritatively.
An accepted apply is recorded before chapter refresh, so a refresh failure
does not tell the author that the save failed or enable another stale apply.
The synthetic AI fixture now carries a complete canonical operation. Web
TypeScript, 98 web tests, isolated production build and browser-script syntax
pass; the native browser journey was amended but could not be run under the
temporary-server policy. No provider/live action. Next: native Edge visual
and keyboard/mobile acceptance on an allowed host, then hosted private
author journeys and full release gates. See vault note
`Codex Sessions/2026-09/2026-09-24-bookworm-ai-proof-sheet.md`.

### Paid AI review request recovery

`ea32cd5` closes the accepted-but-lost reply gap for proofreading, copyediting,
consistency and regular drafting reviews. The server exposes an actor/book-
scoped, read-only request-key lookup and permits replay only for the exact
book, ordered chapter IDs, agent, brief and context policy. The browser saves
only a user/book/chapter-scoped request pointer, settings and SHA-256 brief
fingerprint before POST; uncertain replies retain the key and recover or retry
the original request. Invalid/unavailable recovery storage fails closed. The
UI also restores the correct agent mode when reopening a saved review, and
authenticated BFF responses explicitly forbid caching. No migration or
provider call. Full local `npm run verify` passes (68 migrations/46 SQL files,
95 web tests, 348 service tests, 12 E2E and 30 security cases); isolated
production web build and OpenAPI YAML parsing pass. A synthetic lost-reply
Edge journey was added but is unrun because starting temporary Next on 4398
was policy-rejected in the prior session. This is not hosted provider/billing
acceptance. Next: run that browser journey on an allowed host, then verify
paid ledger and provider behavior in an approved private environment; continue
the full author/publishing release gates. See vault note
`Codex Sessions/2026-09/2026-09-24-bookworm-ai-review-recovery.md`.

### Search-result source navigation

`6045e7e` links current saved manuscript hits to their chapter and Book Bible
hits to the loaded entry form. Changing the phrase clears old hits and
invalidates in-flight responses, so an earlier query cannot be presented as
the new one. Book Bible selection respects unsaved-entry confirmation; a
deleted/not-yet-loaded hit asks for reload. A synthetic Edge journey was added
but could not run in this session because the temporary Next test-server
launch was rejected by execution policy. Web TypeScript, 92 web tests,
isolated production build and browser-script syntax checks pass. No live
service or provider was touched. Next: run the native Edge journey on an
allowed test host, then validate source navigation against hosted current-
version retrieval and continue the wider author/publishing release gates.
See the shared vault `Codex Sessions/2026-09/2026-09-24-bookworm-search-navigation.md`.

### Rich manuscript retrieval baseline

`f9556c2` adds a migration indexing visible table cells, captions
and image alt text with canonical chapter/node/version citations. Superseded
rich content is removed on version change; backfill targets current rich-node
chapters. Disposable PostgreSQL asserts content, hashes, filters, stale-version
removal and cross-tenant denial. Full `npm run verify` passes with 68 local
migrations/46 SQL assertion files, 348 services, 12 E2E, 30 security, load
smoke and mock AI evals. This work did not apply a hosted migration, call a
live provider or deploy; live migration listing timed out twice, so current
hosted installation status was not verified.
The existing decision remains: PostgreSQL source search is the author-facing
baseline; LightRAG needs a private per-book citation/deletion/cost benchmark
before adoption. SnapOtter remains optional behind a licensing/isolation
decision, not installed. See `docs/BOOK_RETRIEVAL_DECISION.md`,
`docs/SNAPOTTER_EVALUATION.md` and the vault note
`Codex Sessions/2026-09/2026-09-24-bookworm-rich-retrieval.md`. Next:
review/install pending live migrations only with explicit release approval,
benchmark long-book retrieval and continue author/publishing release gates.

### Manuscript source upload recovery

`e5e0c75` makes the setup asset ID durable before allocation. The API accepts
that ID for `/assets/upload-url`, verifies exact actor/workspace/metadata and
pending version on replay, repairs a missing first version after partial
allocation, and issues a fresh signed URL without another asset row. The
browser checks whether uncertain PUT bytes arrived before attempting another
upload; a clean original is reused, and changed files or newer/unsafe asset
versions fail closed. No manuscript bytes, filename or signed URL enter the
session checkpoint. If recovery storage cannot persist the ID, allocation
does not start. Native Edge synthetic Auth/API/Storage journeys for lost
allocation and lost PUT replies both reach a queued import with one book,
asset and stored upload. Full local `npm run verify` passes (including 67
migrations/45 SQL suites, 348 services, 12 E2E, 30 security, load smoke and
mock AI evals); isolated web production build passes. This is not hosted
Supabase Storage, scanner or multi-connection race acceptance. No live
migration, provider call or deployment. Next: hosted upload/quarantine and
worker acceptance, then wider author/publishing and release gates. See
`Codex Sessions/2026-09/2026-09-24-bookworm-upload-recovery.md` in the vault.
Preserve generated Next/Graphify dirt.

### Book creation recovery

`b9bdca8` gives new-book setup a client-generated UUID stored before the first
POST. The API accepts it as the book ID and returns the original row on a
matching unique-key replay; changed details, actor or workspace do not become
a second book. On reload, the UI resolves an uncertain ID against the server
before offering the editor, and requires re-entry when no book exists. If
browser recovery storage cannot save the ID, no create request is sent. The
checkpoint keeps identifiers only, not manuscript or story text. Local 88 web
and 292 API tests, both TypeScript checks, isolated production build and native
Edge synthetic-auth/API lost-reply/reload acceptance pass. `4974312` also
passes the pre-accept outage/reload-404/re-entry/same-ID retry path; both modes
end with one book. This is not hosted Supabase acceptance. No migration,
provider call or deployment. Next: resolve the upload allocation/PUT lost
reply orphan risk, then continue cross-service author journeys and release
gates. See `Codex Sessions/2026-09/2026-09-24-bookworm-create-recovery.md` in
the shared vault. Preserve generated Next/Graphify dirt.

### Chapter restore recovery

`80043c8` retains the original restore operation ID and expected version after
an uncertain reply. Editing pauses with explicit retry/download/reload controls;
the current draft stays visible. A confirmed receipt updates the editor before
history refresh; history failure cannot misrepresent the old draft as restored.
409 conflicts retain the draft and expose download/reload recovery. Native Edge
synthetic transport tests pass lost response, exact retry identity, one accepted
revision, history outage and conflict preservation. 86 web tests and web TS pass.
This verifies browser recovery, not live Supabase restore integration; backend
append/restore semantics are unchanged. No build rerun or live action this slice.

### Local login origin recovery

`d155dc4` resolves the IP login issue recorded below: installed NextURL replaces
loopback IPs with localhost even when normalization is disabled. In development,
appOrigin recovers only localhost/127.0.0.1/[::1] Host on the same port; it never
uses Origin or forwarded headers as authority. Production remains pinned to
APP_URL. Native Edge with synthetic Auth/API passes redirects, login, session,
cross-origin/port/site rejection and logout separately on localhost and
127.0.0.1. IPv6 has unit coverage only. 86 web tests, web TypeScript and 30
security tests pass. No production build rerun for this slice and no live
Google/Supabase changes. Google OAuth setup remains a separate operator gate.
Graphify refreshed; generated dirt and existing Gradle parse warnings preserved.

### Author revision ledger

`4538302` makes text comparisons chronological regardless of click order,
preserves Unicode/whitespace, distinguishes unavailable from empty text and
bounds diff work. Chapter-scoped component state prevents comparisons leaking
between chapters. Version history now uses a dark editorial ledger with clear
selection, accessible controls and explicit saved-text-only scope. No backend
version/restore semantics changed. All 84 web tests, web TypeScript and isolated
production build pass. Edge synthetic-auth/API acceptance passes save/reverse
selection/diff/deselection/chapter reset/viewer controls and 390px containment.
The test uses localhost:4398; the initial 127.0.0.1 login got invalid-origin 403
and needs separate local-origin investigation. No auth guard was weakened.
Graphify refreshed; existing Gradle parse warnings and generated dirt remain.
No deployment, migration, provider or customer operation occurred.

### Persistent private scanner runtime

`a0e2168`/`2ce67ce` add `ops/scanning/compose.yaml`: separate unprivileged
FreshClam updater, network-isolated engine with read-only persistent signatures,
and authenticated scanner with mounted secret-file configuration. No host ports
are published; resources/logs are bounded. See `docs/SCANNER_RUNTIME.md`.
Native Linux run `35847866748` passes both jobs: actual clean/detection and
outage/restart in the fixture stack, plus secret-file auth, updater startup,
engine-outage refusal and container recreation preserving database 28132 in the
deployment-shaped stack. First run caught a YAML tmpfs split, fixed before the
passing run. All 348 service tests (34 scanner) and 30 security tests pass.
No host deployment occurred. Periodic updater/reload acceptance, configured
alert delivery, approved image digests, hosted Storage/quarantine, host reboot,
capacity and remaining full-product release gates remain open. Preserve
generated Next/Graphify dirt; the graph retains existing Gradle parser warnings.

### Scanner signature freshness

`cdd8bf7` enforces database freshness at readiness and before file dispatch:
default 72 hours, configurable 1-168, invalid/future dates rejected. Stale
signatures return 503 `scanner_database_stale`, never a clean verdict.
Daemon TZ=UTC and synchronized clocks are required. Local 347 service tests
and 30 security tests pass (33 scanner cases). Native run `35847110819`
correctly refused bundled database 28129 dated September 20. `64c0b1a` adds
FreshClam to test-image preparation; run `35847248112` passes with database
28132 dated September 23: real clean/detection, outage refusal and recovery.
Runtime remains network-isolated; build-time official signature downloads are
required. This is not a deployed production updater. Persistent databases,
supervised FreshClam/reload/alerts and hosted upload/quarantine acceptance
remain open. Graphify refreshed; generated dirt preserved. No live deployment,
provider spend or migration. See the latest vault checkpoint for exact evidence.

### Native scanner protocol and recovery

Source `047fee6` adds real scanner/ClamAV container acceptance. Linux run
`35845869937` passes with ClamAV 1.5.4/database 28129: actual INSTREAM clean
and harmless fixture detection, auth/hash/size rejection, fail-closed engine
outage and recovery after engine restart. Containers use an internal network,
no host mounts/published ports and bounded resources. The custom signature is
test-only; do not deploy it. Local scanner tests: 23 passed; security: 30 passed.
Scanner non-ASCII authorization no longer throws a comparison error. This does
not prove current signature freshness, FreshClam updates, production capacity
or hosted Supabase upload/quarantine integration. No live services changed.

Full local `npm run verify` also passes on this checkpoint: workspace TypeScript,
three worker-launcher tests, unit/API and 81 web tests, 67 migrations/45 SQL
suites, 337 service tests, 12 E2E, 30 security, load smoke without 5xx and six
deterministic AI evals. Live provider evals are skipped without a key.

### Native processing containers

`f489e70` adds Docker targets for document, rendering and publishing, including
Poppler, bundled FFmpeg and fonts. Linux CI `35845401795` passes all builds and
six credential/processing scenarios in unprivileged, read-only containers with
no external network or host mounts. Actual parse, reflowable/fixed EPUB, audio
assembly and exact-artifact packaging work. See `docs/PROCESSING_CONTAINERS.md`.
This is fixture runtime acceptance, not deployment, capacity or crash recovery.
Release dependency locks/digests, SBOM/license review and host setup remain open.

### Rendering/document authentication

Rendering now rejects missing/blank internal credentials with 503 across render,
preflight, audio assembly and cover inspection. Wrong/missing request tokens
return 401 before processing. Document parsing already rejected missing config;
it now also rejects whitespace-only config. Both compare UTF-8 bytes safely.
Dedicated-token precedence and shared fallback remain supported. Tests use
explicit fixture credentials, not an unauthenticated development bypass.
336 service tests, 30 security tests and 31 focused auth/E2E checks pass.
Configure matching service/caller tokens before rollout. No live service changed;
private network isolation and hosted recovery/acceptance remain open.

### Private publishing boundary

The Python packager now fails closed with 503 if its service credential is
missing/blank and 401 for absent/wrong caller tokens. Its legacy local-file
`POST /v1/publishing/jobs` returns authenticated 410; no old cache is read,
written, created or deleted. The Fastify public durable job route is unchanged.
E2E now packages exact saved render bytes via the current private endpoint.
328 service tests, 30 security tests, 33 publishing/E2E checks and 12 focused
public API/worker tests pass. Configure the shared token on both callers and
packager before deploying. Document/rendering missing-token behavior still
needs review; this checkpoint does not claim all private services are hardened.

### Retailer metadata handoff

New export ZIPs include `metadata.json` (allowlisted saved listing fields)
and `README.txt` (manual transfer/review instructions). Manifest package version
2.0 hashes both files alongside the unchanged render/cover bytes. Unicode and
multiline text are preserved; internal metadata and Book Bible content are not
serialized. Reserved filenames cannot overwrite the manifest or handoff files.
Existing packages remain unchanged. These files are not retailer import schemas
or evidence of submission/approval. All 323 service tests and 28 focused
publishing/E2E tests pass. No retailer/provider call or deployment occurred.

### Book Bible image clearance

Memory image selection and create/update now require an exact current asset
version with clean/trusted-generated scan status, matching path, checksum,
MIME and size. Existing unavailable links remain in the saved entry until the
author explicitly removes them; no assets are deleted. The picker omits unsafe
images and never exposes storage paths. Scan lookup errors fail closed.
All 289 API tests, 81 web tests and workspace TypeScript pass. This is API
validation, not a database constraint or permission to skip consumption-time
checks. No live scanner/Storage acceptance or deployment occurred.

### Worker runtime checkpoint

`workers/run.mjs` provides nine allowlisted roles, inspection-only list/check
modes and optional single-pass execution. Translation and Blueprint roles pin
funded quote modes. Linux systemd templates and a startup-validation workflow
are in `ops/systemd/` and `.github/workflows/worker-runtime.yml`.
All three launcher tests pass locally and in Linux CI run `35843831453`,
including configuration refusal for every role. Native systemd unit syntax
validation and workspace TypeScript pass. Source checkpoints: `e3c1501`,
`97e2e52`. See `docs/WORKER_RUNTIME.md`. No host services have been installed
or started; host restart/recovery, credentials, alerts and release acceptance
remain open.

### Full cover decoding before audiobook export

The worker now requires a clean/trusted asset version matching the selected
cover's exact path, MIME, size and checksum. A private Rendering service
`/images/inspect-cover` endpoint verifies and decodes complete static JPEG/PNG
bytes within size/pixel bounds and single-process admission. The worker verifies
the inspection checksum/dimensions before audio assembly. Invalid/quarantined
covers fail without upload; corrupt inspection receipts are retryable failures.
All 168 rendering tests and the 10 focused export worker tests pass, as does
API TypeScript and all 286 API tests. This endpoint must be deployed before enabling the worker;
DPI and retailer acceptance remain separate gates.

### Upload HTTP recovery

The audiobook uploader now bounds requests to 120 seconds, rejects redirects
for all authenticated upload/cleanup calls, and uses validated TUS HEAD offsets
to recover ambiguous PATCH replies with at most three attempts per chunk.
Fifteen focused tests pass, including a real loopback HTTP server that drops
sockets before/after storing bytes, redirects, stalls and receives cancellation.
Archive bytes match after recovery; no redirect destination receives credentials.
This is HTTP-client acceptance, not live Supabase Storage/TUS acceptance.
API TypeScript and all 283 API tests pass after this transport change.

### Native audiobook export concurrency acceptance

Source `4153f52` hardens the unapplied export migration: request-key advisory
locking serializes concurrent replay, replay rechecks current approver access,
cancellation requires approver access inside SQL, and every new worker lease
resets chapter progress for a fresh archive. Local 67 migrations/45 SQL suites
pass. Native PostgreSQL 16 CI run `35828807252` passes those suites plus five
export races: simultaneous queue replay, worker claims with SKIP LOCKED,
cancel-first, complete-first and failure-first completion. Actual lock waits
are observed for the conflicting transactions. Storage/TUS, real Supabase
Auth/PostgREST and renderer-worker restart integration remain unverified.
See [[Codex Sessions/2026-09/2026-09-23-bookworm-export-native-races]] in the
shared vault. No production migration or deployment occurred.

### Durable audiobook archive queue (supersedes synchronous export below)

Google Play export now queues an idempotent, approval-gated job with an immutable
source/QC snapshot. A leased worker assembles a bounded private archive and
uploads it in 6 MiB TUS chunks. Publishing Studio retains history, polls progress,
cancels work and supplies refreshed five-minute download links. Completion and
failure are fenced in PostgreSQL before any uploaded-file cleanup, preventing a
delayed completion reply from causing deletion of a successful archive.

Full local verification and an isolated production web build passed during
implementation. Final follow-up passes 275 API tests, seven targeted worker
cases, and the signed-in Microsoft Edge browser journey with synthetic backend
responses: lost queue reply/retry identity, reload recovery, cancellation,
polled progress, download-link refresh, disclosure and 390px containment.
The migration `20260923053015_audiobook_google_play_export_jobs.sql` remains
unapplied live, as does the earlier QC sign-off migration. Native Supabase RLS,
Storage/TUS, restart/recovery and retention acceptance remain open. See the
latest shared note for exact paths and verification boundaries; keep the full
product goal and the remaining release checklist active.

### Google OAuth recovery UX (local code, provider setup still pending)

The Google sign-in button now has an explicit accessible name, visible keyboard
focus, and an adjacent alert region. Google-start failures use a neutral
temporary-unavailable message. Callback errors for the Google flow are mapped
to a fixed `/login?error=oauth` state without reflecting provider error text;
the safe internal `next` path survives recovery. Email confirmation errors keep
their existing path. Verified with 79 web tests, workspace web typecheck, and
the local `/login?error=oauth` UI. No actual OAuth account, provider setting,
or external login was touched. The live Google provider remains disabled until
the app owner configures the client as documented in `docs/GOOGLE_OAUTH_SETUP.md`;
Supabase may show an error before it ever redirects to this callback.

### 2026-09-23 audiobook technical preflight (local source; not deployed)

Chapter assembly now measures RMS and sample peak on the final MP3 and reports
duration plus its 44.1 kHz mono/192 kbps CBR output profile with the private
download. The Publishing Studio presents objective checks separately from
manual listening checks for noise floor, room tone, pronunciation, edits, and
spoken headings. No generation credits or persistent QC rows are added. Full
`npm run verify` passes (260 API, 79 web, 65 migrations/45 SQL suites, 316
services, 12 E2E, 30 security, load smoke, six deterministic evals); an
isolated production web build passes with 30 routes. These are local checks,
not live renderer deployment or retailer acceptance.

ACX's current rules require a human narrator unless AI/TTS is separately
authorized. This AI voice is therefore not marked ACX-eligible; the technical
preflight is not retailer approval. Read `docs/AUDIOBOOK_TECHNICAL_QC.md` and
recheck retailer policy before adding any audio retailer submission/package.
No production service, live provider, customer audio, or retailer endpoint was
used.

The formerly pending signed-in synthetic browser acceptance and durable QC
history/author sign-off are now complete. The current local follow-up adds the
export-only Google Play archive below. Do not enable ACX submission without
separate verified authorization.

### 2026-09-23 export-only Google Play audiobook archive (local source)

Commit `f108b5f831d9d9e4aee920a8bfc2636fee2c1786` is pushed to
`origin/codex/paid-story-blueprint-20260923`. It adds a private, synchronous
ZIP32 archive download for manual author review: current succeeded narration
for every saved chapter, exact-current QC hash/source identity, approver
listening sign-off, same-workspace private checksum-verified JPEG/PNG cover,
safe ISBN/publisher ID, duration and bitrate checks, and an explicit
Synthesized voice reminder. It does not call a provider, spend credits, submit
to a retailer, or guarantee Partner Center eligibility. Google policy research
is in `docs/AUDIOBOOK_TECHNICAL_QC.md`.

Verification on this local source: full `npm run verify` passes (267 API/unit,
81 web, 66 migrations/45 SQL assertions in disposable PostgreSQL, 316 service,
12 E2E, 30 security; load smoke and six deterministic evals). Signed-in Edge
acceptance covers QC sign-off then synthetic ZIP download, AI-voice notice,
390px layout and no runtime errors. An isolated Next production build passes
with 30 app routes. Thirty focused API/BFF tests also pass after a malformed
JPEG guard. Graphify refreshed to 4,290 nodes / 7,991 edges / 366 communities;
it still reports two pre-existing Android Gradle parse errors.

The QC migration `20260923040940_audiobook_qc_review_signoffs.sql` remains
unapplied live, so the archive route is not active on production data. The
export is synchronous and bounded below ZIP32 limits, not a durable large-book
job; cover DPI is a manual author check. No live migration, retailer, provider,
payment, customer data, or deployment action occurred. Preserve separate
generated dirt in `apps/web/next-env.d.ts`, `apps/web/tsconfig.json`, and
`graphify-out/`; do not stage it with application changes.

Next: separately review/approve the QC schema migration and native Supabase
RLS/PostgREST acceptance before activating history/sign-off; design durable
asynchronous large-title export before claiming production-scale delivery;
continue the broader pending infrastructure, provider, OAuth, operations,
legal/support and beta-author gates in `docs/release-checklist.md`.

### 2026-09-23 local release-gate rerun

On branch `codex/paid-story-blueprint-20260923` at
`968f7ccefb2d67438ed375d2e0dffdda03aa10ba`, `npm run verify` passes in the
current local worktree: workspace TypeScript, unit/API tests, 76 web tests, 65
migrations + 45 SQL assertion files in disposable PostgreSQL, 315 Python
service tests, 12 E2E, 30 security tests, load smoke (50 concurrent; no 5xx),
and six deterministic AI eval cases (no provider key/live run). An isolated
`BOOKWORM_DIST_DIR=.next-release` production build also passes and enumerates 30
routes, including dashboards, authoring, book memory, paid blueprint planning,
translation, publishing, analytics, billing and team operations. These are
local checks, not live Supabase/Storage/provider/retailer acceptance, and do
not establish that the product is complete or production-ready. No app source
was changed in this verification pass. The worktree contains the pre-existing
generated Graphify changes. Git reports `apps/web/next-env.d.ts` modified, but
its content matches `HEAD` (CRLF/autocrlf status artifact); leave it untouched.

Remaining launch gates are still substantial: native Supabase/Storage and
multi-process worker acceptance, operator-approved production pricing and
secret configuration, Google OAuth provider setup, provider quality/cost,
renderer/retailer acceptance and proof, monitoring/backups/restore, legal and
support fulfillment, and beta-author journeys. See `docs/release-checklist.md`.
No live migration, deployment, payment, provider request or retailer
publication was performed.

### 2026-09-23 paid Story Blueprint continuation

The paid, review-only AI Blueprint proposal and quoted translation slices are
in this branch and pushed to origin. Browser acceptance documented in the
shared session note proves synthetic consent/queue/recovery/review behavior;
it does not call OpenAI or establish native credit settlement. Preserve that
distinction when continuing.

## Historical checkpoint: 2026-09-19

### 2026-09-19 Story Blueprint authoring (local only)

The authoring flow now has a revisioned, tenant-scoped Story Blueprint: story
direction and a stable chapter plan can be saved by editors and read by all
members. An editor can materialize exactly one empty manuscript chapter from a
plan item, with replay-safe idempotency and an optimistic revision check. This
is intentionally human-authored planning: it does not invoke a model, send
manuscript text to a provider, create an AI job, or spend credits. The new
database migration `20260919190000_story_blueprints.sql` has strict JSON bounds,
RLS, service-owned RPCs and a materialization receipt; it is NOT applied live.
The API/client/OpenAPI and responsive `/books/<bookId>/plan` screen are wired.
Source `5c94d9a` is pushed to
`codex/live-platform-checkpoint-20260912`. The full local `npm run verify` gate
passes: 246 API tests, 73 web tests, 64 migrations/44 SQL assertion files, 303
service tests, 12 E2E tests, 30 security tests, load smoke and deterministic
evals. Native-harness syntax and a production web build pass. Native GitHub
Actions run `35424562823` passed the real PostgreSQL materialization race. No
live migration, provider use, customer-data write or deployment occurred. Shared:
Codex Sessions/2026-09/2026-09-19-bookworm-story-blueprint.md.

### 2026-09-19 quote-only translation retirement

Sources 36d3e99/6bbd98a remove direct legacy translation creation and
service-role claims, default translation worker execution to funded quoted jobs
and add native quote preparation/cancellation races. Local 242 API/70 web,
workspace TypeScript and 63 migrations/43 SQL suites pass. Native GitHub run
35422912543 passed. No live migration, provider call or deployment. Existing
queued legacy jobs freeze; only known in-flight jobs may settle. Shared:
Codex Sessions/2026-09/2026-09-19-bookworm-quote-only-retirement.md.

### 2026-09-19 quote browser acceptance

Source f3d74a6: real browser with synthetic responses verifies quote consent,
retry identity, accepted recovery, expiry, viewer/mobile and history errors.
Fixed expired consent reset and unhandled refresh rejection. 70 web tests and
web TypeScript pass. No live activation. Worker concurrency and legacy consumer
audit remain next. Shared: Codex Sessions/2026-09/2026-09-19-bookworm-quote-browser.md.

### 2026-09-19 native proposal concurrency

Source 1b33168 adds actual-lock-wait races for same-proposal replay, competing
funds and rollback recovery. Native CI 35421681010 passed all 19 races. Worker
runbook now separates --prepare-quotes/--quoted/legacy modes. No live changes.
Browser acceptance remains next. Shared:
Codex Sessions/2026-09/2026-09-19-bookworm-proposal-races.md.

### 2026-09-19 customer quote review/confirmation

Source d40333d: payer-only canonical proposal GET and web model/consent/request/
progress/review/explicit acceptance replace direct queue controls. 241 API/70 web
tests and workspace TypeScript pass. Browser acceptance still pending; no live
activation. Older direct API remains for other consumers and needs launch audit.
Shared: Codex Sessions/2026-09/2026-09-19-bookworm-quote-confirmation-ui.md.

### 2026-09-19 durable quote-counting worker

Source 4712d6d adds --prepare-quotes: bounded leased chapter counting, saved
count recovery, no automatic recount after expired lease, atomic ready proposal.
238 API tests, workspace TypeScript, 62 migrations/43 SQL suites pass locally.
No live calls. Proposal GET and quote-review UI remain next. Shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-quote-counting-worker.md.

### 2026-09-19 durable quote preparation queue

Source 92ec9ae adds private immutable request snapshots, one active/book and
three/hour limits, explicit consent API and payer-only recovery/progress client.
236 API tests, workspace TypeScript, 61 migrations/43 SQL suites pass locally.
No debit/generation at request time. Counting worker/proposal GET/UI remain next;
queue is not yet operational end to end. Shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-quote-preparation-queue.md.

### 2026-09-19 durable proposal acceptance

Sources 3d3254f (DB), 8db8005 (API/client): private immutable saved offers,
atomic all-chapter job+hold acceptance, same-proposal replay, payer/access/expiry/
source checks. Local 60 migrations/42 SQL suites and native CI 35420563579 pass;
234 API tests pass. No live changes. Creation service/proposal GET/UI remain next.
Shared: Codex Sessions/2026-09/2026-09-19-bookworm-proposal-acceptance.md.

### 2026-09-19 token-counted translation proposals

Source aa25927 adds internal proposal preparation using exact provider input-token
count and full generation hash. No fallback estimates/retries; expiry rechecked.
233 API tests and API TypeScript pass; no live provider calls. Proposal persistence,
authenticated quote endpoint/atomic acceptance/UI remain next. Shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-token-counted-quotes.md.

### 2026-09-19 server-owned translation catalog

Source 4ff8f0f validates optional approved/versioned/expiring server catalog and
exposes authenticated model choices. Internal quote helper pins rates/bounds and
clips expiry. No real offers activated; 229 API tests and API TypeScript pass.
Trusted token counting, quote persistence/acceptance and UI remain next. Shared:
Codex Sessions/2026-09/2026-09-19-bookworm-translation-catalog.md.

### 2026-09-19 private translation billing summary

Source a6e5829 adds payer-only credit totals endpoint/client/UI: held, charged,
returned and review counts, without exposing private quotes or receipts. Missing
or inconsistent accounting is unavailable, not zero. 225 API/69 web tests and
workspace TypeScript pass. No live changes or browser acceptance. Catalog and
quoted public enqueue remain next. Latest shared note:
Codex Sessions/2026-09/2026-09-19-bookworm-billing-summary.md.

### 2026-09-19 quoted translation cancellation

Source 1fb778a adds creator-only pre-dispatch cancellation, one-time held-credit
release and UI confirmation. Local 222 API/68 web tests, TypeScript and 59
migrations/41 SQL suites pass. Native CI 35419700447 succeeded (16 race cases).
No live changes. Quoted public enqueue/catalog and browser acceptance remain open.
Latest shared note: Codex Sessions/2026-09/2026-09-19-bookworm-quoted-cancellation.md.

### 2026-09-19 quoted translation worker integration

Source 8ea4597 adds opt-in --quoted worker: exact request hash/model/output limit,
funded dispatch, durable measured receipt, atomic settlement+completion, no second
operational charge. Missing/uncertain usage cannot redispatch; overrun retains hold.
221 API tests, TypeScript, 58 migrations/41 SQL suites and native CI 35419141932
(16 races) pass. No live calls. Approved catalog, quoted enqueue/UI and review/
cancellation still next. Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-quoted-worker.md.

### 2026-09-19 quoted translation queue isolation

Migration 20260919120000 adds immutable billing_mode, translator-only quoted
enqueue, funded-hold running guard and separate quoted claim RPC. Legacy claims
skip quoted jobs. 57 migrations/41 SQL suites and native CI 35418711607 (16 races)
pass, source 6ed37a5 pushed. Quoted worker/provider/receipt integration remains next.
No live changes. Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-quoted-queue.md.

### 2026-09-19 one-time funded dispatch

Migration 20260919110000 and claimPricedDispatch authorize one provider call
against a held quote and live lease; replay denies redispatch. Quote/dispatch
identity is immutable and pre-dispatch settlement is blocked. 216 API tests,
TypeScript, 56 migrations/40 SQL suites and native CI 35418456271 (16 races) pass.
Source 750e3f7 pushed. Worker and quote-required enqueue integration remain next.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-funded-dispatch.md.

### 2026-09-19 funded pricing adapter

funded-usage.ts connects validated saved quotes to reservation and calculated
settlement. 215 API tests and TypeScript pass, source 3af3fad pushed. Worker
dispatch gating and authenticated provider receipt normalization are still next;
a reserve replay is NOT permission to dispatch. No live changes.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-funded-adapter.md.

### 2026-09-19 persistent funded quotes (local only)

Migration 20260919100000 persists service-owned quotes with atomic ledger holds,
one-time settlement/release and review retention. Legacy and quoted debits cannot
both charge a job. Source 81ea1ec; 55 migrations/40 SQL suites and native CI
35418020168 (15 races) pass. Service calculator/receipt adapter and generation UI
integration remain next; SQL does not authenticate provider receipts or price math.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-funded-quotes.md.

### 2026-09-19 versioned usage pricing math

usage-pricing.ts adds exact version-pinned quote/settlement math; 210 API tests
and API TypeScript pass. Synthetic test rates only. Not wired to generation,
funded reservations or charges. Persist server-owned quotes next; checksums and
approval flags are not authentication. No live changes.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-usage-pricing.md.

### 2026-09-19 atomic service credit deduction (local only)

Migration 20260919090000 makes legacy credits/deduct usage+ledger+receipt atomic.
Same request replays; changed request or historical debit without receipt conflicts.
54 migrations/39 SQL suites, 205 API tests, API TypeScript and native CI
35417527844 (14 concurrency cases) pass. Source e603477, type fix 26dfeb4 pushed.
No live migration. Versioned retail pricing and provider provenance remain open.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-atomic-deduction.md.

### 2026-09-19 accepted media request immutability (local only)

Migration 20260919080000 prevents narrator/translator input and billing-identity
mutation across statuses. Regression reproduced before fixing. Native CI run
35417274720 passed for source 755c5f7: 53 migrations, 38 SQL suites and 12 races.
Normal lifecycle updates remain allowed. No live migration or paid generation.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-media-immutability.md.

### 2026-09-19 media completion accounting (local migration only)

Migration 20260919070000 serializes audio/translation/image usage insertion with
organization-locked reservations. Native CI run 35417114024 succeeded for source
3a4ce5c: 52 migrations, 37 SQL suites and 12 concurrency cases across four meters.
No live changes. Next audit: active audio/translation input_ref.creditUnits
mutation, then versioned retail conversion and broad product acceptance.
Shared note: Codex Sessions/2026-09/2026-09-19-bookworm-media-accounting.md.

### 2026-09-19 native concurrency acceptance harness

Added tests/security/run-native-postgres.mjs and a dedicated PostgreSQL 16 CI
workflow. Uses separate psql connections and pg_stat_activity lock assertions
for competing reservations, completion accounting and rollback release. Only
loopback port 55439/test user, a generated disposable database and synthetic
fixtures are used; no application credentials or live migrations. Syntax and
51 migrations/36 SQL suites pass locally. Native GitHub Actions run 35416935051
completed successfully for source aed4094, including all three concurrency cases.
Latest continuation: Codex Sessions/2026-09/2026-09-19-bookworm-native-ci.md.

### 2026-09-19 shared text funding (local only)

Migration 20260919060000 replaces the metadata-only reservation trigger with one
shared guard for metadata, writer, proofreader, copyeditor, consistency and
bookbible jobs. It counts all their active holds under the organization lock.
ai_credits usage insertion acquires that same lock through commit so completion
cannot race the consumed/pending reads. Text enqueue maps capacity/role errors;
accepted request replay now precedes quota checking and validates book/agent.
205 API tests, API TypeScript, 51 migrations and 36 SQL suites pass locally.
NOT applied live. Native multi-connection proof and token-based retail conversion
are still open; tests are not a claim of full billing or product readiness.

### 2026-09-19 metadata funding reservation (local only)

Migration 20260919050000 reserves one current operational ai_credits unit when
metadata jobs enter queued/running. It locks the organization, requires editing
membership and explicit allowance, and counts monthly usage plus pending metadata
across its workspaces. Queued-to-running retains a hold; reactivation rechecks.
API quota/role conflicts stop before the provider. 204 API tests, API TypeScript,
50 local migrations and 35 SQL assertion files pass. NOT applied live.
This does not approve retail pricing or finish usage-based conversion. Reservation
coordination with other text-generation workflows sharing ai_credits remains a
launch gate, along with token-cost quoting/reconciliation and native race tests.

### 2026-09-19 durable metadata receipts (local only)

New metadata_service_receipts table is service-only/RLS-enabled, linked to the
AI job with cascade deletion and a bounded result object. Production metadata
requires a saved job ID, service token and Supabase service credentials. It
reserves a request fingerprint before provider execution, saves the result before
success, and reads persisted results after process-cache loss. Unknown reserved
outcomes never regenerate; changed fingerprints conflict. Mock-only tests can
opt into durable storage with AI_RESULT_STORE=supabase. No new dependencies.
This migration has NOT been applied live. Worker restarts are covered with an
HTTP storage simulation; actual deployed PostgREST/multi-worker acceptance stays
open. A crash between provider completion and receipt persistence can still leave
an unknown outcome requiring reconciliation, not automatic retry spending.

### 2026-09-19 metadata result recovery

Lost AI-service responses and uncertain completion persistence no longer mark
metadata jobs failed/release their active slot. New author-scoped recovery POST
reads the existing AI-service job with GET only, validates job/book/workspace/
agent identity and pinned source refs, then uses the idempotent completion RPC.
The editor exposes Recover existing result with original-credit settlement copy.
Missing, foreign or unverifiable receipts keep the request pending; no age-based
failure or new provider generation. The AI service currently retains results in
process memory only, so a service restart can still require manual reconciliation.
203 API and 68 web tests pass. Native PostgreSQL CLI/container tooling was absent,
so native two-connection race testing remains unverified. No live actions.

### 2026-09-19 metadata concurrency constraint (local only)

Migration 20260919030000 enforces one queued/running metadata job per author/book
with a partial unique index. API insert conflicts return the existing active ID
before any provider call; UI requires status refresh. Terminal jobs free the slot.
Existing duplicate active rows make migration fail; no cancellation/deletion is
performed. Reconcile real provider state before resolving such duplicates.
Verified 201 API/68 web tests and 48 local migrations/33 SQL assertion files.
Includes concurrent API requests against a stateful constraint fake and real SQL
constraint/slot-release assertions. Native multi-connection race test remains.
NOT applied live. Deployment must include this migration before relying on it.

### 2026-09-19 pending metadata visibility

Metadata history also returns safe id/time/status fields for the current user's
queued/running metadata jobs in this book. The editor checks history on load and
blocks new generation while status is unknown or pending; refresh is read-only.
Failed reads fail closed, and terminal jobs disappear from pending results.
No prompt/key exposure, stale-age cancellation, or automatic retry spending.
This is a UI recovery guard, not a database concurrency lock across tabs.
200 API and 68 web tests pass; API/web TypeScript passed. Browser acceptance
and stuck-job operational reconciliation still require work.

### 2026-09-19 saved metadata draft recovery

GET /books/:bookId/metadata/drafts returns the latest 20 successful metadata
jobs as validated candidates after book membership checks. Private prompts,
request keys and job diagnostics are not returned. No provider or billing calls.
BookMemoryClient can load/open these drafts after a reload without overwriting
the form; explicit Use draft and Save metadata remain required. The UI warns
that drafts may refer to older manuscript versions. Malformed saved candidates
are omitted, not presented as valid. Pending-job recovery remains separate.

### 2026-09-19 metadata retry safety

BookMemoryClient now locks tone/audience while an unresolved metadata generation
key exists. Editing previously discarded the key after a lost response, allowing
another paid generation. Network/5xx/running and incomplete-success responses
retain the key; confirmed failed jobs and pre-generation validation failures
allow correction. This is tab-local recovery, not cross-session persistence.
67 web tests passed; full product/release gates remain open.

### 2026-09-18 fixed EPUB layout controls

EPUB 1.8.0 honors saved fixed_layout trim, margins and typography. Publishing
Studio reuses print controls, preserves settings across flow changes, and hides
print-only bleed/page numbering for EPUB. Legacy fixed defaults remain 6x9/Vera;
legacy print defaults are preserved. New editions default to Vera. RTL fixed
layout is blocked in the UI with a reflowable alternative, matching the worker.
Verified 298 services, 197 API, 66 web, 12 E2E, TypeScript and production build.
Native tests check actual PNG geometry, altered output and save/reload behavior.
No browser/retailer-reader acceptance or live changes claimed.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-fixed-layout-controls.md`.

### 2026-09-18 raster fixed-layout EPUB

EPUB 1.7.0 stops ignoring flow=fixed. It paginates through the embedded-font
6x9 PDF renderer, converts actual pages using local Poppler, and packages
viewport-sized XHTML images with pre-paginated metadata, chapter navigation,
cover/front landmarks and text alternatives. Optional title page is honored.
Reflowable contents navigation uses an explicit spine layout override.
No selectable text: UI and operations docs explain rasterization, fixed default
typography/trim and inherited script limitations. This is a working fixed-page
path, not full fixed-layout/accessibility/retailer certification.
Verified 296 services, 12 E2E, 65 web, all workspace TypeScript and production
build. Native tests used Poppler 26.07.0 with no skips. Converter failure/missing
dependency stops with actionable errors and cleans temporary files. No live work.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-fixed-epub.md`.

### 2026-09-18 contents visual stress fix

PDF 1.12.0 fixes a reproduced LayoutError with 20pt contents text, narrow trim,
long chapter titles and Roman numbering starting at 9999. Wide labels now
stack below titles instead of reserving most of the title width. Contents rows
may split within a page-spanning entry. Standard layout remains unchanged.
New scripts/preview-print-contents.py creates synthetic PDFs and PNG previews
using local pdftoppm, no network or real manuscripts. Standard/stress pages
were visually inspected. Verified 291 services and 8 E2E; nine focused TOC
tests include the stress regression and deterministic output. No live work.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-contents-visual-check.md`.

### 2026-09-18 print contents pages

PDF 1.11.0 adds opt-in include_table_of_contents, saved through Studio/API/client
and Python edition config. Multi-pass layout resolves actual chapter pages;
contents links and PDF bookmarks use chapter destinations. Arabic/Roman labels
follow starting-number settings; hidden numbering omits labels. Title wrapping
reserves space for page labels, and core 1.0.8 validates contents-font glyphs.
Eight new actual-PDF tests cover 65-chapter/multi-page TOCs, exact label-title
pairs, destinations, font repagination, wrapping, opt-out and determinism.
Verified 290 services, 196 API, 65 web, all workspace TypeScript, production
build and 8 E2E. Print retailer journeys now have 36 pages including contents,
and exact cover/interior bytes survive preflight/packaging. Browser assertions
added but not run (previous fixture startup policy denial remains). No live work.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-print-contents.md`.

### 2026-09-18 EPUB navigation settings

EPUB 1.6.0 now honors saved navigation: toc inserts a readable contents page
after front matter; toc+landmarks also emits section links to available cover,
title/copyright, contents and first chapter; none keeps mandatory reader TOC
but omits the contents page from the spine. UI labels explain this distinction.
Navigation title honors metadata overrides, escapes text and retains direction.
Verified 282 services, 8 E2E, 65 web tests and web TypeScript. Six new cases
check every nav target/fragment, mode/front-matter combination and determinism;
existing import roundtrips remain green. No live/paid operations.
Print TOC remains a separate unimplemented feature, not covered by this change.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-epub-navigation.md`.

### 2026-09-18 cross-service export acceptance

Broad verification found three stale print E2E fixtures (too short/no full
cover). They now import 32 chapters, render 34-page interiors with copyright
and embedded fonts, compose covers, run actual channel preflight, and preserve
exact PDF/cover bytes in ZIPs. Lulu uses all-edge bleed; KDP/B&N use outer.
Corrected stale core-1.0.6 assertions left after the front-matter version bump.
Verified: all 8 E2E, 276 service and 30 Python security tests. These tests do
not cover live providers, database orchestration, native storage or retailer
submission. Release checklist records the corrected evidence and open gates.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-export-acceptance.md`.

### 2026-09-18 relevant illustration memory

Illustrations now reuse book-scoped PostgreSQL full-text search to prioritize
matching bible entries ahead of the first 100 fallback rows. Matches are
rehydrated from current bible rows with book scope checked again and duplicates
removed. Existing text budget, prompt fingerprints, reference checks and credit
reservation remain intact. Search errors stop before provider/credit work.
Context version is image-book-context-2. This is keyword retrieval, not semantic
search; manuscript hits can share the top-20 search budget.
Verified: 196 API tests, API TypeScript, all 47 migrations and 33 SQL assertion
files in disposable PostgreSQL. New cases cover a character beyond 100 entries,
foreign match exclusion and missing retrieval migration. No live operations.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-image-retrieval.md`.

### 2026-09-18 illustration source fingerprints

Image jobs now record a SHA-256 of the exact effective provider prompt plus
ordered reference asset IDs/checksums and a context format version. No prompt
text, manuscript facts, storage paths or image bytes are added to job metadata.
Existing public history continues to omit input_ref. Book-bible retrieval is
ordered by ID before its 100-row bound, and attribute keys are sorted before
their bound, avoiding context changes caused only by database/key order.
Verified: 194 API tests and API TypeScript, including actual route/provider
prompt hash equality, reference checksums and unchanged safety checks.
This is provenance, not a guarantee of visual consistency or a stored prompt
snapshot. No paid provider call, migration or deployment occurred.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-image-provenance.md`.

### 2026-09-18 edition front matter

Publishing Studio now saves bounded publisher/imprint and exact copyright
notice text for print and EPUB. Print title pages include subtitle and author;
EPUB title pages are opt-in to preserve existing manuscript/import behavior.
A copyright page appears only when notice or publisher is supplied; no legal
claims or ISBNs are invented. Saved ISBN is included when present. EPUB uses
edition metadata overrides and registers pages in manifest/spine, plus rights
and publisher metadata. PDF `1.10.0`, EPUB `1.5.0`, core rules `1.0.7`.
Print font checks cover these new strings with located findings.

Verified: 276 service tests, 193 API tests, 65 web tests, workspace TypeScript,
production build; 34 focused rendering tests rerun after rule version bump.
New browser save/reload assertions are written but not run: the tool policy
rejected startup of the isolated fixture web server. No live operations.
Note: `Codex Sessions/2026-09/2026-09-18-bookworm-front-matter.md`.

### 2026-09-18 print page-number layout

PDF `1.9.0` places the entire numbering font box at least 0.5in inside finished
trim and keeps a 6pt gap from the body frame. Outer numbers align their outer
edge with the mirrored margin, rather than centering on that boundary. Small
top/bottom margins that cannot fit numbering produce a located preflight
finding and a render 422; authors can increase that margin, move the numbers,
or disable numbering. Core rules `1.0.6` also reject margins leaving no body
area. Starting numbers now match the API's 1-10000 range. Publishing Studio
shows the recommended 0.75in margin on the selected numbering edge.

Verified: 268 services and workspace TypeScript. Twenty-five pagination tests
include dense actual PDFs across three positions, two font paths, three bleed
settings, mirrored alignment, HTTP error/recovery, long Roman labels and input
bounds. pypdf's multiline visitor coordinates were unreliable; the geometry
fixtures use short lines with explicit text matrices. This does not certify
all imported text/image boundaries or old artifacts. No live operations.
Current note: `Codex Sessions/2026-09/2026-09-18-bookworm-page-number-layout.md`.

### 2026-09-18 KDP rendering and preflight consistency

Supersedes the odd-page blocking behavior in the checkpoint below. Cover
renderer `paperback-cover-1.1.0` uses KDP's even manufacturing page count
automatically; a 25-page manuscript receives a spine calculated for 26 pages.
KDP `1.4.0` reports this as information, so authors can package the book without
manually adding a blank page. Custom printer templates still require their
exact supplied count. Cover generation and preflight share the same stock/trim
page ranges, including standard-color minimums and letter-size maxima.
Preflight's parsed page-count cache is now confined to one evaluation.

Verified: 243 service tests and all workspace TypeScript checks. An actual
25-page book goes through rendering HTTP, preflight HTTP and deterministic ZIP
packaging, with exact interior/cover bytes preserved and the expected spine
width measured from the PDF. Regression tests reject stale odd-count covers
and check all eight supported KDP profile/regular-or-letter combinations.
Shared note: `Codex Sessions/2026-09/2026-09-18-bookworm-kdp-render-consistency.md`.
No production build or browser test rerun was needed for the single UI copy
change; the previous build is historical. No live operations occurred.

### 2026-09-18 local retailer page and margin update

KDP `1.3.0`, B&N `1.2.0`, and Lulu `1.3.0` now evaluate the actual rendered
PDF. KDP uses trim plus saved ink/paper profile for current min/max pages,
applies its page-count-dependent gutter and outside margins, and blocks an odd
interior when KDP's even-page rounding would invalidate the generated cover
spine. B&N enforces 18-800 pages and its 0.75in inner/0.5in other margins.
Lulu enforces the 32-800 perfect-bound range and reports its documented
safe-area/gutter recommendations as warnings. B&N now receives the same actual
geometry validation already used by KDP/Lulu.

Focused tests use real PDFs; the full rendering suite passes 101 tests. Final
workspace, Git, graph and shared-vault evidence belongs in the current session
note after checkpointing. This is deterministic local preflight, not live
retailer acceptance or physical printer proof. No deployment, migration,
provider call, customer-data operation or retailer submission was performed.

### 2026-09-18 local full-bleed illustration update

Manuscript artwork can now be saved as an inline image or a dedicated
full-bleed print page with horizontal/vertical crop focus. `pdf-1.8.0` paints
that image across the physical PDF page, suppresses the page number, preserves
inline ebook behavior, and fails instead of silently substituting an inline
layout. Core rules `1.0.5` require print bleed and enough source pixels for a
300-DPI page after crop. Print normalization retains the minimum useful raster
instead of reducing every image to the old 2400-pixel width.

Verified: 221 service, 192 API and 64 web tests; workspace TypeScript; a real
PDF has a dedicated full-page image between the surrounding text pages;
isolated browser acceptance saves/reloads focus controls and fits at 390px.
No live service, migration, provider, customer-data or deployment operation.
Production build and the final Git/graph evidence are recorded in the current
vault session note after checkpointing. Physical printer proof and automated
safe-zone/contrast review remain required.

### 2026-09-18 local media finishing update

Completed chapter narration can now be downloaded as one private MP3 from
Publishing Studio. Caller-scoped RLS reads verify segment order, exact private
paths, sizes and checksums before native decoding/assembly. This reuses saved
audio without new OpenAI calls or generation credits. `chapter-audio-1.0.0`
uses a bounded FFmpeg subprocess, not byte concatenation. It is not loudness
mastering, pronunciation QC or retailer-audio certification.

`cover-1.3.0` fits measured title/subtitle/author/QR-label bounds, prevents
footer collisions and preserves integer QR modules/quiet zones. `pdf-1.7.0`
embeds every used font when both body and heading choose Vera, including
vendored licensed DejaVu Sans Mono for code. Legacy font settings remain
unchanged; RTL shaping is still unsupported. Source licenses/checksums are
retained in `services/rendering/fonts/`.

Verified: TypeScript checks, isolated Next production build, 217 service,
192 API and 64 web tests; browser publishing and audio
failure/retry/download/mobile acceptance. Native tests inspect actual audio
duration/order/format and PDF font streams, while browser/API transports use
fixtures. Final build/Git evidence and exact next steps are in
`Codex Sessions/2026-09/2026-09-18-bookworm-media-finishing.md` in the vault.
No live deployment, migration, paid generation or customer data operation.

### 2026-09-18 local interior geometry update

`pdf-1.6.0` adds saved `bleed_edges` (`outer` for KDP, `all` for Lulu),
corrects mirrored frame cycling after page two, and anchors page numbering to
the finished trim area. Existing editions without the field keep their old
all-edge setting; new UI drafts default to outer edges. KDP/Lulu rule versions
are now `1.2.0`: they reject wrong printer bleed and inspect actual PDF page
dimensions/crop/rotation. Margins are measured from the trim edge. This does
not yet place illustrations into the bleed area or certify printer acceptance.
See `Codex Sessions/2026-09/2026-09-18-bookworm-interior-geometry.md` in the
shared vault for final test/Git evidence and remaining work.

### 2026-09-18 local full paperback cover update

Publishing Studio now saves back/spine text, colors, paper profile and custom
template dimensions. `paperback-cover-1.0.0` composes one CMYK back/spine/front
PDF from the actual rendered interior page count. The raster front is composed
at 300 DPI; back/spine fonts embed. Custom templates must match the page count;
text overflow, unsupported glyphs, narrow spine text and stale PDF geometry are
rejected. This reserves barcode space; it does not issue an ISBN or barcode.
API render paths and private package transport preserve `cover.pdf`. Core rules
`core-1.0.4` require full covers for print retailer packages and recheck their
geometry. Existing ebook PNG covers remain supported.

Current evidence: workspace TypeScript checks, an isolated Next production
build, 175 service, 188 API and 63 web tests; Publishing Studio
browser acceptance includes save/reload, paper settings, font choice, package
history and 390px containment. Browser bytes are fixtures; actual PDFs and ZIPs
are checked separately in service tests. No live deployment or migration.
Printer proof/acceptance, full interior bleed/font coverage, RTL and hardcover
remain unfinished. See the shared vault note
`Codex Sessions/2026-09/2026-09-18-bookworm-paperback-cover.md` for final build
and Git evidence and exact next steps.

### 2026-09-18 local print typography update

Publishing Studio, edition API validation and the API client now accept
`BookwormVera` / `BookwormVera-Bold` for print body and headings. The
`pdf-1.5.0` renderer embeds ReportLab's bundled regular/bold/italic/bold-italic
Vera fonts. Core preflight `core-1.0.3` and direct rendering check actual
printed text against the chosen font, including marks, tables and captions;
unsupported characters produce located errors before output. Existing font
settings remain compatible. Coverage is limited Latin; RTL shaping, other
scripts and complete font embedding for code/page numbers remain open.

Verified in this slice: workspace TypeScript checks, 165 service tests, 62 web
tests, and four edition API tests. Generated PDF inspection verifies four font
streams, Unicode text extraction, and deterministic bytes. No production build,
native browser acceptance, live migration, provider call or deployment was run
for this slice. See `Codex Sessions/2026-09/2026-09-18-bookworm-print-fonts.md`
in the shared vault. The older full verification snapshot below is historical.

The authorized live initialization is now complete on Supabase project
`cyhqtwndadlyzpeatxws`: all then-current 45 repository migrations are installed. The newest
migrations create a safe profile row for every Auth identity, enforce zero
text/image/audio generation allowance without an explicit paid entitlement,
default commercial plans to unpublished, and add the durable audiobook queue.
The live definitions were read back and confirm default-deny plan/audio access. No seed
plans, test users, payments, provider calls, publishing submissions or customer
content were created. Remaining advisor notices are the public `citext`
extension plus intentionally private no-policy service tables and nine
authenticated, internally-authorized SECURITY DEFINER RPCs; review before any
change rather than revoking them blindly.

OpenAI is now the only production-default generator. Text uses the Responses
API with `gpt-6-astra`; images default to `gpt-image-2.5-sunburst`; audiobook
configuration targets `gpt-4o-mini-tts`. Current official model-specific text
and image estimates replace the stale generic GPT rate. Mock remains explicit
for tests. No OpenAI key is configured, so no live generation or spend was
performed.

Audiobook chapter narration is now a durable, paid-only workflow. Authors can
create an audiobook edition in Publishing Studio, choose a saved chapter,
acknowledge the AI-voice disclosure, queue version-pinned segments, refresh
progress, preview private MP3s, and download short-lived links. Segments are at
most 4,096 Unicode characters; queue records hold source ranges/hashes rather
than copied manuscript text. The leased worker (`npm run worker:audiobook`)
uses private recovery receipts and atomically creates trusted assets, AI run
telemetry, and `audio_credits` usage. Missing plan allowance is zero. Speech
cost is explicitly a word-rate estimate until reconciled against OpenAI usage.
Mastering/concatenation, loudness and pronunciation QC, retail audio packaging,
and live-provider acceptance remain open; segment MP3s are not retail-ready.

Translation is now implemented and locally verified, but its additive quote
migrations are deliberately **not yet applied** to the live project. The only
supported consumer is `npm run worker:translation -- --quoted` (also its
unflagged default), which requires a server-owned, accepted funded quote. The
old operational queue and direct endpoint are retired/frozen; never use it to
dispatch OpenAI work. Translation jobs retain source pointers/hashes rather
than manuscript text, use server-only OpenAI Responses API (`gpt-6-astra` by
default), fenced leases and private completion receipts. A completed project is
reviewable and can create a separate text-only draft only by explicit author
action; it never overwrites or publishes source. No key, provider call, spend,
or live migration was made by this work. Before live use: review/apply quote
migrations through `20260919180000_retire_legacy_translation_queue.sql`, set an
approved catalog, supervise both quote workers, and perform live quality/cost
acceptance.

The author dashboard now uses one tenant-scoped aggregate endpoint instead of
demo counters or one browser request per book. It shows real books, live asset
and cover/illustration counts, open/failed jobs, ready retailer packages, recent
allowlisted job/activity rows, ledger balance, and all four paid generation
meters. Local source now includes member-readable, role-gated retailer CSV
report imports with database-derived source identity, replay-safe immutable
reconciliation, active source/period overlap protection, source-only activity,
and currency-safe totals; package creation is never reported as a sale. The
additive `20260912190000_retailer_sales_imports.sql` migration is not installed
live, so that environment still truthfully reports sales as `not_connected`.
Billing and dashboard share zero-default text, image, audio, and translation
entitlements.

Google OAuth code and callback regression coverage pass, and the live Auth
profile trigger is installed. Google sign-in remains unavailable because the
Supabase Google provider is disabled until the operator creates one Web OAuth
client and stores its ID/secret in Supabase. Exact setup is in
`docs/GOOGLE_OAUTH_SETUP.md`; customers use their normal Google accounts and do
not create credentials.

The full shared tree is committed and pushed to
`codex/live-platform-checkpoint-20260912`; durable audiobook implementation is
saved at `e14c556`. The local remote no
longer embeds a credential. The current local full `npm run verify` passes: 186
API, 61 web, 47 migrations/33 SQL suites, 156 services, 8 E2E, 30 security,
load smoke and mock evals; the isolated production web build passes with the
translation and analytics routes. This is a
checkpoint, not market-readiness: Google/OpenAI credentials, paid plan pricing,
native Storage/scanner/provider acceptance, observability/backups, audio mastering,
translation, mobile completion and author beta remain open.

Graphify is now available to Codex, Claude, Hermes, and generic project
agents. Its committed code-and-SQL graph is `graphify-out/graph.json`; query
it before broad code searches and refresh it with `graphify update .` after
source edits. The shared vault entry point is
`C:/Users/Asus/Memory-Ai/AI Bookworm Graphify Index.md`. The graph is a local
AST index only, with no customer files, secrets, or provider-backed semantic
analysis.

Next: finish local mastering, loudness and pronunciation QC, then retail-audio
packaging. Native Supabase Storage/scanner/provider acceptance, paid billing
configuration, translation live acceptance, observability/backups, mobile
completion and broader release-checklist gaps remain open.
Deploy and supervise workers only after the requested build and release gates.
Do not declare the full product complete from these local fixtures.

## Safety and recovery

Live migrations for the named AI-BookWorm Supabase project and a secret-free
`codex/*` GitHub branch were explicitly authorized; payments, emails, provider
spend and retailer publishing are not authorized by these notes. Never copy secrets. Change fingerprints are recorded
by `node scripts/track-project-changes.mjs --record`; they are not source backups
or proof of authorship. Commits are allowed only on the authorized checkpoint
branch; do not reset or overwrite another agent's work.
