# MVP Release Checklist

This checklist is a release-readiness audit, not a deployment authorization.
`DONE` means the current local working tree has repeatable fixture/code evidence;
`PARTIAL` means useful local evidence exists but a material control is missing;
`PENDING-INFRA` requires an authorized native/staging/production environment or
an operational process. Saved agent claims are not evidence by themselves.

| # | Item | Status | Evidence / remaining acceptance work |
|---|---|---|---|
| 1 | Production domain, TLS, CDN and WAF | PENDING-INFRA | No production environment was changed. Verify the trusted certificate chain, HTTPS redirects, security headers and active WAF rules on an authorized deployment. |
| 2 | Native Supabase project and migrations | PENDING-INFRA | The current 35 migrations execute in disposable PostgreSQL. Native GoTrue, PostgREST, Storage and migration drift still require an authorized local/staging Supabase project before production. |
| 3 | Tenant isolation and least privilege | PARTIAL | Twenty-three SQL boundary suites execute locally, and 30 Python security tests pass. The disposable PostgreSQL fixture is not native Supabase and does not prove Storage HTTP, JWT claims, GoTrue or multi-connection race behavior. |
| 4 | Durable jobs and retrieval services | PARTIAL | Render, preflight, export-package, manuscript-import and editor text-AI-review jobs use fenced PostgreSQL leases, backoff and a database DLQ. The `worker:ai` consumer rehydrates saved chapter versions only after its claim; the editor polls durable state across reloads. Book Setup queues/polls imports across reloads and exposes audited manual retry. Author-facing retrieval uses tenant-safe PostgreSQL full-text search with citations. Text AI history is allowlisted, private/no-store and omits prompts, idempotency keys and retrieval text. Reviewed metadata generation remains a separate synchronous cited-draft flow. Worker supervision, production credentials, native multi-process races and optional LightRAG/Qdrant experiments remain unverified. |
| 5 | Provider keys and secret management | PENDING-INFRA | No live keys are required for deterministic tests and none were configured by this work. Verify server-only secret storage, rotation and egress policy in the target environment. |
| 6 | Upload/parser safety and malware scanning | PARTIAL | A private authenticated ClamAV/clamd service, bounded streaming protocol, server-side checksum/size/type checks, fail-closed scan persistence, clean-only import/download/render gates, and Storage RLS quarantine are implemented and tested. A service-only, aggregate-only dry-run inventory identifies only old, managed, database-unreferenced private objects; it never deletes. Native Supabase Storage HTTP, deployed clamd signatures/limits, outage recovery, an EICAR staging exercise, and approved per-object cleanup acceptance remain required. |
| 7 | DOCX, EPUB, TXT and limited PDF import fixtures | PARTIAL | Authenticated/root-confined parsers preserve supported DOCX marks/list styles and table text; EPUB nested content is imported once with semantic marks/lists. Body PNG/JPEG/GIF/WebP images pass bounded extraction, independent validation/scanning, private storage and atomic chapter/asset persistence with retry receipts. Real supplied specifications parse. Complex tables, header/footer drawings, vector images, numbering/styles and scanned-PDF OCR remain incomplete. Native Storage/Postgres acceptance and orphan reconciliation are outstanding. |
| 8 | Deterministic EPUB/PDF/cover rendering | PARTIAL | EPUB/PDF version 1.4.0 fixtures cover inline marks, nested lists, illustrations, escaped metadata, gutters, paginated tables and RTL EPUB language/direction metadata. Edition schema 1.1.0 persists `auto`/`ltr`/`rtl`; the saved edition language is carried consistently through render, preflight, and package freshness checks. Preflight blocks RTL print and cover text when the deterministic Latin base-font renderers would be unsafe, and the Publishing Studio explains that constraint before disabling only the invalid render. Editor table insertion/edit/save/reload passes browser acceptance. Private artifacts have checksum/size verification. A licensed embedded font plus shaping pipeline, tagged PDF, merged-cell/header semantics and complete fixed-layout behavior remain incomplete. |
| 9 | Retailer preflight and export packages | DONE | Versioned KDP, Apple Books, Barnes & Noble and Lulu rules pass local tests. Zero-error preflight + exact render fingerprints gate deterministic, private ZIP packages with durable history. Submission is manual; retailer acceptance is not guaranteed. |
| 10 | Billing, credits and Stripe webhooks | PARTIAL | Local unit tests cover signatures, idempotency, entitlements and ledgers. An authorized Stripe test-mode round trip, product/price mapping and customer recovery still need verification. |
| 11 | Referral ledger | DONE | Atomic code allocation, qualification/review/reversal state transitions, concurrency-safe balances, bounded history and lifetime summaries have database and API tests plus browser acceptance. |
| 12 | Community moderation | DONE | Local tests cover membership/privacy, posting limits, reports, moderation and reactions. Current web community flows still contain legacy/demo assumptions and need product-browser acceptance. |
| 13 | Flutter companion beta | PENDING-INFRA | Flutter is unavailable on this machine. Hermes added incomplete Android/iOS skeletons but no complete Gradle wrapper/Xcode project or mobile test suite, so the unverified CI workflow was removed. Generate complete platform projects, add tests, analyze, build release artifacts and complete a device journey. |
| 14 | Monitoring, alerting, queues and backups | PARTIAL | Publishing, manuscript import and text-AI review have leased workers with bounded retry/DLQ behavior; author import retains an authorized retry path. The admin console shows allowlisted manuscript and AI job rows, and aggregate document ready/running/expired-lease/dead-letter health. Neither job list exposes stored prompts, provider payloads, checksums or lease tokens. A separate read-only Storage inventory provides conservative orphan candidates. No worker supervision or alerts are configured, Sentry/OTel are placeholders, and no PITR/backup evidence exists. |
| 15 | Disaster recovery | PENDING-INFRA | No restore drill or measured RPO/RTO has been recorded. Restore a real backup into isolated staging and run the acceptance suite. |
| 16 | Privacy, terms, support and data-rights processes | PARTIAL | Authenticated support and export/delete intake, explicit deletion confirmation, cancellation, tenant RLS, API tests and browser acceptance are implemented. Fulfilment tooling, retention rules, legal pages, notification delivery, an accountable owner and a staging exercise remain required. |
| 17 | Beta-author acceptance | PENDING-INFRA | Requires real authors to complete signup → import/generate → edit → illustrate → render → preflight → package, with P0/P1 defects triaged. |

## Current local verification snapshot

Snapshot: **2026-09-11 (AI review recovery and RTL edition safety)**, uncommitted shared
working tree on `master` at baseline HEAD `2ae208e`. Hermes's orphan commits
remain recoverable in the reflog, but their broad completion claims are not a
release tag or evidence. These results describe the current files, not authorship.

| Suite | Result |
|---|---|
| All workspace TypeScript checks | pass |
| Production npm dependency audit | pass; 0 known vulnerabilities |
| Book-model tests | 28/28 |
| Config tests | 3/3 |
| API tests | 149/149 |
| Web auth/BFF/client/editor-model/import-recovery/publishing-direction/AI-review tests | 43/43 |
| Disposable database | 34 migrations + 23 SQL assertion files |
| Python AI/document/rendering/publishing/scanning services | 154/154 |
| Fixture E2E journey | 2/2 |
| Python security tests | 30/30 |
| Load smoke | 50 concurrent requests, no 5xx |
| AI deterministic evals | six cases; must-find 5/5, zero false positives |
| Browser acceptance | Sep 11 isolated fixture: lost scan reply, queue, failed worker status, reload, audited retry, background success and completed reload create one book/one upload (2 confirmations, 2 simulated worker attempts, 1 retry). Durable report counts/literal warnings restore without another attempt; heading focus and 390px/375px containment pass with no console errors. Native worker/services remain separate acceptance. |
| Storage reconciliation | Local dry-run classifier accepts only old, managed, unreferenced paths; referenced, young, unknown-age and out-of-scope paths never become candidates. The command has no deletion code. Native Storage inventory is still required. |
| Web production build | pass; 27 manifest entries including admin, memory, publishing and account settings |
| OpenAPI YAML syntax | 75 paths and 23 schemas; durable import queue/list/retry, admin health and receipt contracts documented |

Commands used: `npm run verify`, `npm run build -w @bookworm/web`, a direct
isolated-fixture browser inspection, and an independent YAML parse of
`services/api/openapi.yaml`. `npm audit --omit=dev` also passes after upgrading
Fastify 5.12.3, Tiptap 3.31.3, PostCSS 8.5.28 and vulnerable transitive patches.

## Explicit blockers and exclusions

- The application is **not production ready** and the full PRD is not complete.
- No live migration, deployment, Stripe charge, provider generation or retailer
  submission was performed.
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
