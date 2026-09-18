# MVP Release Checklist

This checklist is a release-readiness audit, not a deployment authorization.
`DONE` means the current local working tree has repeatable fixture/code evidence;
`PARTIAL` means useful local evidence exists but a material control is missing;
`PENDING-INFRA` requires an authorized native/staging/production environment or
an operational process. Saved agent claims are not evidence by themselves.

| # | Item | Status | Evidence / remaining acceptance work |
|---|---|---|---|
| 1 | Production domain, TLS, CDN and WAF | PENDING-INFRA | No production environment was changed. Verify the trusted certificate chain, HTTPS redirects, security headers and active WAF rules on an authorized deployment. |
| 2 | Native Supabase project and migrations | PARTIAL | The authorized live project has the first 45 migrations. All 47 repository migrations execute in disposable PostgreSQL; the additive translation and retailer-sales migrations are reviewed but not live. Native PostgREST/Storage acceptance and drift checks remain before production. |
| 3 | Tenant isolation and least privilege | PARTIAL | Thirty-three SQL boundary/workflow suites execute locally, and 30 Python security tests pass. The disposable PostgreSQL fixture does not prove Storage HTTP, JWT claims, GoTrue or multi-connection race behavior. |
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
