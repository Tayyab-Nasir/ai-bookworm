# MVP Release Checklist

## 2026-09-23 durable Google Play audiobook exports

Cover validation now verifies a clean/trusted exact asset version, followed by
full image decoding in the private renderer and checksum-bound receipt checks
in the export worker. Header-only, truncated, animated and MIME-mismatched
covers are rejected before audio assembly/upload. Renderer tests: 168 passed;
focused worker cases: 10 passed; API TypeScript passes. Runtime deployment of
`/images/inspect-cover`, DPI checks and actual retailer acceptance remain open.

Transport follow-up: real loopback HTTP tests cover stored/unstored lost PATCH
replies, redirect refusal, malformed offsets, deadlines and cancellation.
The uploader uses bounded TUS HEAD recovery without resending committed chunks.
All 15 focused export worker/transport tests pass. Production Supabase Storage
limits and server integration remain a separate acceptance gate.

Follow-up source `4153f52` passes native PostgreSQL 16 acceptance:
[run 35828807252](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/35828807252).
All 67 migrations and 45 SQL suites pass, including viewer cancellation denial,
revoked-approver replay denial, reset progress on renewed leases and rejection
of the old worker token. Five added multi-connection tests prove simultaneous
request replay, disjoint worker claims and both orders of cancellation versus
completion, plus failure fencing before a delayed completion. These use real
PostgreSQL lock waits in a disposable CI database with synthetic Auth/Storage
schema; they do not prove native Supabase HTTP or actual storage uploads.

The synchronous archive described below is superseded by a tenant-scoped,
idempotent queue, private bounded ZIP worker, leased progress/cancellation,
and refreshed signed download history in Publishing Studio. Snapshots contain
identity/hash pointers, not manuscript text. Uploaded-file cleanup is performed
only after a successful database failure transition fences delayed completion.

Local evidence: full `npm run verify` passed during implementation, including
67 migrations/45 SQL assertion files, 316 service tests, 12 E2E, 30 security,
load smoke and six deterministic evals; isolated production web build passed.
The final worker cleanup adjustment passes all 275 API tests and seven focused
worker cases. Real local Next UI with synthetic Auth/API responses passes the
Edge browser journey for uncertain-response idempotency, reload recovery,
cancellation, automatic progress, private download refresh and mobile layout.
Browser artifact bytes are fixtures and do not prove retailer acceptance.

Both the QC sign-off and export-job migrations remain unapplied live. Required
native acceptance: RLS/PostgREST isolation, Storage/TUS and size limits, download
expiry, multiple worker processes, restarts/cancellation and orphan/retention
operations. Cover DPI remains manual. No deployment, model spend, retailer
submission, or production-ready claim accompanies these local checks.

## 2026-09-23 audiobook QC history and author sign-off

Commit `b643083` on `codex/paid-story-blueprint-20260923` adds durable QC
metadata for assembled audiobook files, exact audio/source hashes, a
workspace-authorized listening attestation, and stale-manuscript-version
rejection. The same-origin web proxy forwards only validated QC metadata for
the private MP3 response. The signed-in Publishing Studio browser journey
passes with Microsoft Edge and synthetic Auth/API/audio fixtures; it exercises
download, report ID, required listening confirmation, saved history and the
ACX AI-voice warning. This is not provider or retailer acceptance.

`npm run verify` passes on the committed source: workspace TypeScript, 262 API
tests, 80 web tests, 66 migrations plus 45 SQL assertion files in
disposable PostgreSQL, 316 service tests, 12 service-level E2E, 30 Python
security tests, 50-request load smoke with no 5xx, and six deterministic AI
evals (live provider run skipped because no key is configured). No isolated
production build was run for this slice. Migration
`20260923040940_audiobook_qc_review_signoffs.sql` remains a local repository
migration and was not applied live. No live provider, payment, deployment,
retailer submission, or customer audio was used.

First-party audio policy review is recorded in `docs/AUDIOBOOK_TECHNICAL_QC.md`:
ACX remains blocked for this AI voice absent authorization; Google Play is a
possible export-only target with Synthesized voice disclosure and partner /
territory constraints; Apple Books' digital-narration path is partner-based,
and acceptance of externally generated GPT narration remains unverified. The
local worktree adds an export-only Google Play ZIP route. It requires exact
current QC sign-off for every chapter, a private cover and a safe book
identifier. Full `npm run verify` passes after this change: all workspace
TypeScript, 267 API/unit tests, 81 web tests, 66 migrations + 45 SQL suites in
disposable PostgreSQL, 316 service tests, 12 E2E, 30 security tests, 50-request
load smoke and six deterministic AI evals (live provider eval skipped because
no key is configured). Signed-in Microsoft Edge browser acceptance now covers
the synthetic Google Play ZIP download, AI-voice disclosure reminder, exact
QC sign-off prerequisite, 390px containment and no page errors. An isolated
Next production build passes with 30 app routes. The QC migration is unapplied
live. This is not retailer acceptance or submission.
Current implementation is synchronous, ZIP32-size bounded and not a durable
large-title job; cover DPI is author-verified, not automatically measured. ACX
remains unavailable absent express authorization; Apple audiobook export
remains disabled/neutral.

## 2026-09-23 local verification refresh

On branch `codex/paid-story-blueprint-20260923` at `968f7cce`, the full
`npm run verify` command passes: workspace TypeScript, unit/API and 76 web
tests, 65 migrations + 45 SQL assertion files in disposable PostgreSQL, 315
Python service tests, 12 E2E, 30 security tests, load smoke (50 concurrent,
no 5xx), and six deterministic AI evaluations (provider run skipped because no
API key is configured). An isolated `.next-release` production build passes
with 30 app routes. This does not change any PARTIAL/PENDING-INFRA status below:
live Supabase/Auth/Storage, worker orchestration, paid provider quality/cost,
retailer acceptance, observability/backups, legal/support operations and
beta-author acceptance are not proven by this local gate. No live migration,
provider request, payment, retailer submission, or deployment was done.

## 2026-09-18 refreshed cross-service evidence

The broad journey rerun initially found three failing print fixtures: they
contained only three pages and lacked the full covers now required by local
retailer rules. Fixtures now import 32 chapters, render 34-page interiors with
title/copyright pages and embedded Vera fonts, compose real full-cover PDFs,
and pass channel-specific bleed/preflight. All six format/channel combinations
verify exact interior/cover bytes in deterministic ZIPs. This proves local
service integration, not live retailer acceptance or database orchestration.

Current rerun: 8/8 service-level E2E, 276/276 services, 30/30 Python security.
Stale core-version assertions were updated to 1.0.7. Current renderers are
PDF 1.10.0 and EPUB 1.5.0. The earlier front-matter service result preceded the
core version increment; this full rerun now covers the final version too.
No deployment, native Supabase check, paid generation or retailer submission.
Front-matter browser acceptance remains pending after fixture startup denial.

This checklist is a release-readiness audit, not a deployment authorization.
`DONE` means the current local working tree has repeatable fixture/code evidence;
`PARTIAL` means useful local evidence exists but a material control is missing;
`PENDING-INFRA` requires an authorized native/staging/production environment or
an operational process. Saved agent claims are not evidence by themselves.

| # | Item | Status | Evidence / remaining acceptance work |
|---|---|---|---|
| 1 | Production domain, TLS, CDN and WAF | PENDING-INFRA | No production environment was changed. Verify the trusted certificate chain, HTTPS redirects, security headers and active WAF rules on an authorized deployment. |
| 2 | Native Supabase project and migrations | PARTIAL | The last verified live state had the first 45 repository migrations. All 66 current repository migrations execute in disposable PostgreSQL; the new audiobook QC/sign-off migration remains local-only. Native PostgREST/Storage acceptance and current drift checks remain before production. |
| 3 | Tenant isolation and least privilege | PARTIAL | Forty-five SQL boundary/workflow suites execute locally, and 30 Python security tests pass. The disposable PostgreSQL fixture does not prove Storage HTTP, JWT claims, GoTrue or multi-connection race behavior. |
| 4 | Durable jobs and retrieval services | PARTIAL | Render, preflight, export-package, manuscript-import, editor text-AI-review, audiobook and translation jobs use fenced PostgreSQL leases and durable recovery state. Translation reserves paid credits, pins each saved chapter, keeps source text out of queue rows, stores private recovery receipts, and creates a separate review draft only after explicit author adoption. Author-facing retrieval uses tenant-safe PostgreSQL full-text search with citations. Worker supervision, production credentials, native multi-process races, live provider quality/cost and optional LightRAG/Qdrant experiments remain unverified. |
| 5 | Provider keys and secret management | PENDING-INFRA | No live keys are required for deterministic tests and none were configured by this work. Verify server-only secret storage, rotation and egress policy in the target environment. |
| 6 | Upload/parser safety and malware scanning | PARTIAL | A private authenticated ClamAV/clamd service, bounded streaming protocol, server-side checksum/size/type checks, fail-closed scan persistence, clean-only import/download/render gates, and Storage RLS quarantine are implemented and tested. A service-only, aggregate-only dry-run inventory identifies only old, managed, database-unreferenced private objects; it never deletes. Native Supabase Storage HTTP, deployed clamd signatures/limits, outage recovery, an EICAR staging exercise, and approved per-object cleanup acceptance remain required. |
| 7 | DOCX, EPUB, TXT and limited PDF import fixtures | PARTIAL | Authenticated/root-confined parsers preserve supported DOCX marks/list styles and table text; EPUB nested content is imported once with semantic marks/lists. Body PNG/JPEG/GIF/WebP images pass bounded extraction, independent validation/scanning, private storage and atomic chapter/asset persistence with retry receipts. Real supplied specifications parse. Complex tables, header/footer drawings, vector images, numbering/styles and scanned-PDF OCR remain incomplete. Native Storage/Postgres acceptance and orphan reconciliation are outstanding. |
| 8 | Deterministic EPUB/PDF/cover rendering | PARTIAL | EPUB 1.4.0/PDF 1.8.0 fixtures cover inline marks, nested lists, illustrations, escaped metadata, gutters, paginated tables and RTL EPUB language/direction metadata. Dedicated full-bleed pages have saved crop focus, physical-page placement, no visible page number and 300-DPI preflight. Edition schema 1.1.0 persists direction; render, preflight and package fingerprints use the saved language. Unsafe RTL print/cover text is blocked. Vera-selected editions embed all used fonts. Private artifacts have checksum/size verification. Tagged PDF, RTL shaping/full script coverage, merged-cell/header semantics, fixed-layout completion and physical print/crop proof remain incomplete. |
| 9 | Retailer preflight, export packages and reporting | PARTIAL | Versioned KDP, Apple Books, Barnes & Noble and Lulu rules pass local tests. Actual print PDFs now gate channel-specific page ranges and margins: KDP uses trim plus ink/paper profile and protects even-page cover-spine geometry; B&N uses its supported 18-800 range and four margin settings; Lulu uses the perfect-bound 32-800 range with documented safety/gutter warnings. Zero-error preflight + exact render fingerprints gate deterministic, private ZIP packages with durable history. Local source also has database-derived, replay-safe, currency-safe retailer CSV reporting with active same-source/period overlap protection; its additive migration is not live. Submission is manual, and retailer acceptance/report-format validation is not guaranteed. |
| 10 | Billing, credits and Stripe webhooks | PARTIAL | Local unit tests cover signatures, idempotency, entitlements and ledgers. The author dashboard and Billing Center report text, image, audio and translation meters from one zero-default entitlement contract. An authorized Stripe test-mode round trip, product/price mapping and customer recovery still need verification. |
| 11 | Referral ledger | DONE | Atomic code allocation, qualification/review/reversal state transitions, concurrency-safe balances, bounded history and lifetime summaries have database and API tests plus browser acceptance. |
| 12 | Community moderation | DONE | Local tests cover membership/privacy, posting limits, reports, moderation and reactions. Current web community flows still contain legacy/demo assumptions and need product-browser acceptance. |
| 13 | Flutter companion beta | PENDING-INFRA | Flutter is unavailable on this machine. Hermes added incomplete Android/iOS skeletons but no complete Gradle wrapper/Xcode project or mobile test suite, so the unverified CI workflow was removed. Generate complete platform projects, add tests, analyze, build release artifacts and complete a device journey. |
| 14 | Monitoring, alerting, queues and backups | PARTIAL | Publishing, manuscript import, text-AI review, audiobook and translation have leased workers with bounded retry/recovery behavior; author import retains an authorized retry path. The dashboard returns allowlisted job summaries only, and admin diagnostics omit prompts, provider payloads, checksums and lease tokens. A read-only Storage inventory provides conservative orphan candidates. No worker supervision or alerts are configured, Sentry/OTel are placeholders, and no PITR/backup evidence exists. |
| 15 | Disaster recovery | PENDING-INFRA | No restore drill or measured RPO/RTO has been recorded. Restore a real backup into isolated staging and run the acceptance suite. |
| 16 | Privacy, terms, support and data-rights processes | PARTIAL | Authenticated support and export/delete intake, explicit deletion confirmation, cancellation, tenant RLS, API tests and browser acceptance are implemented. Fulfilment tooling, retention rules, legal pages, notification delivery, an accountable owner and a staging exercise remain required. |
| 17 | Beta-author acceptance | PENDING-INFRA | Requires real authors to complete signup → import/generate → edit → illustrate → render → preflight → package, with P0/P1 defects triaged. |

## Current local verification snapshot

**2026-09-23 audiobook technical preflight:** the exact assembled private MP3
now carries decoded RMS/sample-peak measurements and its rendered 44.1 kHz
mono/192 kbps CBR profile. Noise floor, room tone, edits, spoken headings and
pronunciation remain listening-only checks. ACX currently requires human
narration unless AI/TTS is separately authorized; Bookworm AI voice must not be
represented as ACX eligible or sent through an ACX package. Full `npm run
verify` and an isolated 30-route Next production build pass after this slice.
That does not establish retailer approval or live renderer deployment. See
[`AUDIOBOOK_TECHNICAL_QC.md`](AUDIOBOOK_TECHNICAL_QC.md).

**2026-09-18 pagination layout:** PDF `1.9.0` and core `1.0.6` prevent page
numbers from overlapping the manuscript or extending beyond their margin
boundary. Number font boxes clear trim by 0.5in and body by 6pt. Small margins
produce located preflight errors; disabled numbering preserves compact layouts.
Verification: 268 service tests and workspace TypeScript, including 25 new
pagination tests with actual dense PDF coordinates, HTTP failure/recovery and
long-label bounds. Existing full-bleed suppression and KDP packaging tests pass.
No browser/production build rerun; the UI change is explanatory margin guidance.
This is not a full-page imported glyph/image safety audit or physical proof.

**2026-09-18 KDP rendering consistency:** cover `1.1.0` and KDP rules `1.4.0`
share stock/trim page ranges and manufacturing page-count rounding. Odd books
now complete render, preflight and package with a correctly sized spine;
custom templates retain exact page-count matching. Request-local preflight
caching prevents stale counts on reevaluation. Verification: 243 service tests
and workspace TypeScript. A real 25-page manuscript passes both HTTP stages
and produces an exact-byte ZIP; measured PDF geometry matches 26 manufacturing
pages, while old unrounded covers fail. Production build/browser evidence
below remains historical; this pass changed only explanatory UI copy.

**2026-09-18 incremental retailer-page evidence:** KDP `1.3.0`, B&N `1.2.0`
and Lulu `1.3.0` read the actual generated PDF page count. Current first-party
page ranges, KDP profile/trim maxima and gutter tiers, B&N margins, Lulu
perfect-bound limits, and odd-page KDP cover-spine protection have focused
artifact tests. The complete rendering suite passes 101 tests. Full workspace
evidence is recorded after this checkpoint. These deterministic rules reduce
known rejections but do not certify a live retailer upload or a physical proof.

**2026-09-18 incremental full-bleed evidence:** manuscript artwork saves inline
or dedicated-page print placement plus crop focus. `pdf-1.8.0` renders the
physical page deterministically and core `1.0.5` blocks missing bleed or sources
below the trim/bleed page's 300-DPI dimensions. Current checks pass: 221 service,
192 API and 64 web tests, workspace TypeScript, actual PDF page/content checks,
and isolated save/reload/mobile browser acceptance. Physical printer proof,
binding-safe crop review and native Storage/render-service acceptance remain.

**2026-09-18 incremental media-finishing evidence:** private completed chapters
can be assembled and downloaded without additional AI generation. Native tests
verify ordered decoded audio, 44.1 kHz mono/192 kbps output, deterministic bytes,
limits and cleanup. `cover-1.3.0` checks measured text fit and exact QR grids;
`pdf-1.7.0` embeds all used fonts for Vera body/heading editions, including
licensed DejaVu Mono code. TypeScript checks, an isolated Next production
build, 217 service, 192 API and 64 web tests pass, plus
browser audio failure/retry/download and publishing/mobile acceptance. Browser
and API transport bytes remain fixtures; native media tests are separate.
Legacy fonts, RTL shaping, physical proof, audio
loudness/quality checks and production capacity remain open.

**2026-09-18 incremental interior-geometry evidence:** `pdf-1.6.0` adds explicit
outer/all bleed edges, fixes the actual odd/even frame cycle after page two,
and anchors numbering to trim. KDP/Lulu `1.2.0` reject wrong bleed settings and
actual PDF dimensions/crop/rotation. Verification: 180 service tests, 64 web
tests, six targeted API tests and workspace TypeScript checks. New tests inspect
actual PDF heading/footer coordinates and dimensions. No browser or production
build was rerun in this small geometry slice; the prior cover-slice evidence
below is historical. Full-bleed illustration placement, complete font/page
limits and native printer proof acceptance remain incomplete.

**2026-09-18 incremental paperback-cover evidence:** saved wrap settings now
reach deterministic single-page CMYK PDF generation, private render storage
and retailer ZIP assembly. Actual artifact tests check geometry, embedded
fonts, text, color space, checksums and repeatability; preflight rejects stale
templates, missing/cropped/wrong-size covers and unsupported back/spine text.
Workspace TypeScript checks, an isolated Next production build, 175 service,
188 API and 63 web tests pass. Isolated Publishing Studio browser
acceptance passes with fixture transport, including save/reload and mobile
containment. These are local checks, not retailer acceptance or live Storage
evidence. Hardcover, RTL shaping, complete interior bleed/font conformance and
physical proof review remain open. Core rules are now `core-1.0.4`.

**2026-09-18 incremental print-font evidence:** `pdf-1.5.0` adds bundled
Bitstream Vera body/heading choices with four embedded styles. Core rules
`core-1.0.3` block unsupported printed glyphs with chapter/node locations,
and the render endpoint returns 422 for the same input. Current checks pass:
165 services, 62 web, four edition API tests, and all workspace TypeScript
checks. PDF inspection confirms four embedded font streams, accented text
extraction and repeatable checksums. This is limited Latin coverage; RTL
shaping, other scripts, full embedding of code/page-number fonts and native
retailer acceptance remain open. The full snapshot below was not rerun.

Snapshot: **2026-09-12 (paid translation, author operations dashboard, and local retailer reporting)** on
`codex/live-platform-checkpoint-20260912`. These results describe the current
local files and tests, not production acceptance.

| Suite | Result |
|---|---|
| All workspace TypeScript checks | pass |
| Production npm dependency audit | pass; 0 known vulnerabilities |
| Book-model tests | 28/28 |
| Config tests | 3/3 |
| API tests | 186/186 |
| Web auth/BFF/client/editor/import/publishing/dashboard/sales tests | 61/61 |
| Disposable database | 47 migrations + 33 SQL assertion files |
| Python AI/document/rendering/publishing/scanning services | 156/156 |
| Fixture E2E journey | 8/8 |
| Python security tests | 30/30 |
| Load smoke | 50 concurrent requests, no 5xx |
| AI deterministic evals | six cases; must-find 5/5, zero false positives |
| Browser acceptance | Sep 11 isolated fixture: lost scan reply, queue, failed worker status, reload, audited retry, background success and completed reload create one book/one upload (2 confirmations, 2 simulated worker attempts, 1 retry). Durable report counts/literal warnings restore without another attempt; heading focus and 390px/375px containment pass with no console errors. Native worker/services remain separate acceptance. |
| Storage reconciliation | Local dry-run classifier accepts only old, managed, unreferenced paths; referenced, young, unknown-age and out-of-scope paths never become candidates. The command has no deletion code. Native Storage inventory is still required. |
| Web production build | pass; includes dashboard, analytics, translation, admin, memory, publishing and account settings |
| OpenAPI YAML syntax | pass; dashboard, sales import, durable jobs, import, admin health and receipt contracts documented |

Commands used: `npm run verify`, `npm run build -w @bookworm/web`, a direct
isolated-fixture browser inspection, and an independent YAML parse of
`services/api/openapi.yaml`. `npm audit --omit=dev` also passes after upgrading
Fastify 5.12.3, Tiptap 3.31.3, PostCSS 8.5.28 and vulnerable transitive patches.

## Explicit blockers and exclusions

- The application is **not production ready** and the full PRD is not complete.
- No live migration, deployment, Stripe charge, provider generation, retailer
  CSV import or retailer submission was performed. The retailer-sales migration
  remains local-only pending an explicit live operation and native acceptance.
- Retailer automation is export-first/manual; official retailer submission and
  retailer-side status integrations are unavailable. An invalid Hermes KDP
  scaffold that attempted writes through Amazon's read-only Catalog Items API
  was removed.
- Native Supabase/Storage behavior, a deployed ClamAV signature/outage exercise,
  live AI providers, Stripe test mode, Redis, Qdrant, observability,
  backup/restore and Flutter release builds remain unverified.
- The publishing/render/preflight, document and text-AI consumers are implemented, but
  they have not been exercised against native Supabase, private Storage, or live
  rendering/publishing/document/AI services. Metadata generation remains
  synchronous by design.
- Admin and referrals have authenticated screens. Billing and collaboration
  have author routes, including secure manual invitation links; transactional
  invitation email delivery is not yet connected to an external provider. The
  unregistered Hermes console-email scaffold was removed because it logged
  recipient/template data while reporting success without delivering mail.
- There is no measured TypeScript coverage report; no 100% coverage claim is made.
