# AI Bookworm — Implementation Plan

## Product boundary

Build the existing AI Bookworm monorepo into a reliable, multi-tenant author-publishing OS. The supplied documents are product and architecture reference; they do not override this plan or authorize external publishing, payments, or data migrations against a live environment.

## Working assumptions

- Keep the established architecture: Next.js web client, TypeScript/Fastify API, Supabase/Postgres, Python worker services, and a Flutter companion.
- Treat Supabase/Postgres as canonical; AI produces reviewable suggestions and never silently replaces manuscript content.
- Keep retailer publishing export-first and semi-manual unless an official integration and credentials are explicitly configured.
- Work against local/mock-safe dependencies unless the repository's configured environment explicitly supports an integration.

## Delivery sequence

1. Audit the current repository, supplied specifications, environment contract, and automated checks.
2. Repair the highest-impact broken paths in the web app, API, and services; preserve existing user changes.
3. Complete a coherent author journey: create or import a book, edit it, request AI assistance, manage assets, prepare an edition, validate it, and create a publishing request.
4. Close implementation gaps in authorization, idempotency, tenant isolation, and error handling that block safe use of that journey.
5. Run type checks, unit/service/security/E2E tests, fix regressions, and report remaining configuration-dependent integrations.

## Full-product acceptance map

Completion is unproven until each user-facing requirement works through the
actual UI, authenticated API, and durable storage. Mocked tests and rendered
screens alone are insufficient. The full goal remains active across sessions.

| Requirement | Current evidence / remaining acceptance |
| --- | --- |
| Signup, login, reset, sessions, tenant dashboard | Forms are currently no-ops; implement Supabase sessions and protected API access, verify two-user isolation. |
| Create/upload manuscripts, editing canvas, versions | UI and partial API exist; load/save canonical chapter documents, ingest uploads, test reload/conflicts/version history. |
| AI generation, proofreading, editing, credit usage | Standalone service code exists; connect durable authorized jobs and user-approved suggestions; verify provider failures and accounting. |
| Book Bible and consistent character/image memory | Schema exists; implement persistent management, references, and scoped AI retrieval. |
| Image uploads, illustrations, covers | Asset code exists; complete upload/preview/generation/selection and persistent book linkage. |
| Layout and formatting options | Rendering code exists; wire edition settings, preview/export, typography, trim/margins/spacing and verify artifacts. |
| Cover QR codes | Implement URL validation, QR creation, placement and exported-cover verification. |
| Book metadata/descriptions/tags | Persist metadata; generate suggestions from book context with review before acceptance. |
| KDP/Barnes & Noble/other channels | Verify official current requirements; deterministic preflight, files and submission guidance; use supported integrations only, never fake publication. |
| User dashboard/credits/jobs/book analytics | Tenant-scoped dashboard now shows real books, asset/job/package counts, paid generation meters and recent activity. Local source now supports role-gated, source-backed retailer CSV reports with immutable reconciliation and currency-safe totals; the additive sales migration is not installed live, so the live dashboard still reports sales as not connected rather than inventing revenue. Official retailer connectors and live acceptance remain. |
| Production safety and deployment readiness | Tenant/role tests, migration execution, secrets, job durability, configured live integration checks and user-journey browser tests. |

## Current parallel work ownership (2026-08-31)

- Root Codex: web auth/BFF/session protection, shared API-client request transport,
  Next dev/build isolation, integration and acceptance verification.
- Authoring agent: chapter persistence/import APIs and editor/setup wiring;
  coordinate additions to API-client methods with root's transport edits.
- Memory agent: Book Bible/metadata persistence and management UI/API, independent
  of authoring and auth files; root registers new routes/navigation.
- Data agent: validate tenant-hardening SQL in a disposable local environment,
  fix only its new migration/test files, and audit onboarding membership gaps.

## Required evidence, not a narrower completion definition

- The web and API applications build and their local core journey is operable without exposing provider secrets.
- Existing documented APIs and workflows are represented by real routes/UI states rather than dead-end controls.
- Automated checks pass where runtime dependencies are available; any unavailable external integration is explicitly identified.
- No claims are made that a retailer submission, payment, AI generation, or production deployment happened without configured credentials and an explicit request.
