# Analytics and community moderation checkpoint

This is a reviewed feature bundle for the full AI Bookworm application, not
product completion or production acceptance. It builds on the paid-author
workflow documented in `PAID_GENERATION_CHECKPOINT.md`.

## Author sales analytics

The analytics page reads immutable retailer-report imports for the selected
workspace. It shows a trailing twelve-UTC-calendar-month trend, accessible
table, currency picker, top books, source breakdown and import history.

- Only active imported reports contribute. Exports, preflights and generated
  publishing packages are never represented as sales.
- Currencies are not combined. Corrections can be negative. Reported proceeds
  remain unknown when any contributing row omits them; missing months are not
  silently shown as zero sales.
- Aggregate numbers must be safe JavaScript integers. Import receipts must
  match the submitted row count. The API discloses its top-100 book/currency
  limit and the view discloses its selected-currency display limit.
- Workspace request versions fence late successes, failures and import
  callbacks. An import cannot be redirected by switching workspaces; blocked
  optional browser storage does not prevent a scoped view.

This is source-backed analytics, not an automated retailer sales connection.

## Community and platform moderation

Community moderators receive a bounded, caller-authorized queue covering post
and comment reports, including community content and parent context. Reporter
and author identities are excluded. Platform administrators have a separate
filtered queue. Both interfaces require review and separate confirmation,
retain soft-removal audit evidence and recover lost replies through refresh.

The database is the final authorization boundary:

- Normal resolution uses the caller token and checks current moderator
  membership even when recovering a closed report. Platform resolution is
  service-only behind the authenticated API administrator guard.
- The first saved decision is immutable. Replay returns that original
  decision and does not apply an alternative action or duplicate the audit.
- Comment/reaction inserts lock the published parent and current active
  membership in the same transaction, including trusted service-role inserts.
  Reactions use a caller-bound atomic toggle and per-actor/post/kind lock.
- Removed discussion content is hidden from ordinary reads. Public callers
  cannot restore soft-removed posts or forge saved report decisions.
- Report creation uses the caller token, validates UUID targets and bounded
  nonblank reasons, and admits only currently readable published posts or
  visible comments. Success receipts bind the reporter and requested target;
  permission, validation and storage errors do not expose database details.
- Queue, report and decision responses are private/no-store. An uncertain
  write is not automatically replayed by the moderation UI.

`reports_reason_bounded` enforces new writes but is initially `NOT VALID` to
avoid assuming historical hosted data is clean. Before a hosted rollout,
audit old reasons and resolve invalid historical rows deliberately before
validating the constraint. Do not silently truncate reported evidence.

## Contract and verification

The joint client/OpenAPI adoption also repairs earlier misplaced chapter,
Book Bible, metadata/Story Blueprint and artwork-approval blocks. Strict
contract tests reject duplicate mapping keys, missing/duplicate operation
identities and broken local references. Selected sales, queue and report
schemas have behavior tests; this is not every endpoint's runtime acceptance.

Local focused evidence on 2026-10-05: 60 API tests, 99 disposable migrations,
67 SQL assertion files/eight serial paid gates, workspace typechecks and five
strict OpenAPI tests pass. Selected sales helper/community/sales route
coverage is 93.16% lines and 81.38% branches; it is not whole-product coverage.
No workspace lint script is configured; a successful optional root lint
command would not establish a lint gate.

```powershell
node --import tsx --test services/api/src/step12.test.ts services/api/src/step14.test.ts services/api/src/dashboard.test.ts services/api/src/sales.test.ts
npm run typecheck
npm run test:db
node scripts/run-python.mjs -m pytest tests/security/test_openapi_contract.py -q
node --test apps/web/tests/analytics-admin-mounted.mjs
node --test apps/web/tests/quote-recovery-mounted.mjs
```

Mounted tests use actual React components with intercepted local transport,
not a complete Next/mobile/hosted journey. Acceptance still requires an exact
index-isolated production build/full verification and inspection of native
database logs. The native source defines 38 moderation schedules: sixteen
post/comment decision races, four moderator revocations, sixteen
comment/reaction parent or membership changes, and two atomic-toggle cases.
Also require the prior 56 paid and 108 artwork schedules on the same accepted
source. Enumeration alone is not executed concurrency proof.

## Adoption boundary and continuation

Adopt the coherent analytics/moderation sources, tests, two additive SQL
migrations, joint client/OpenAPI and this document together. Add only this
checkpoint's new navigation hunk from `AGENT_HANDOFF.md`; preserve unrelated
audio, publishing-audio, generated Next configuration, historical docs and
generated graph edits. Do not blanket-stage the shared worktree.

Current shared handoff:
`C:/Users/Asus/Memory-Ai/Codex Sessions/2026-08/2026-08-31-ai-bookworm-codex-handoff.md`.
Detailed continuation note:
`C:/Users/Asus/Memory-Ai/Codex Sessions/2026-10/2026-10-05-analytics-moderation-checkpoint.md`.
Only AI Bookworm's section of the shared task board may be updated.

After isolated/native acceptance, continue complete author/editing,
Book Bible/consistent illustration, cover/QR, layout/preflight/export,
metadata, audio/translation and retailer handoff acceptance. Hosted
Auth/Storage/scanning/provider checks, Google OAuth/server credentials,
approved token/credit pricing, worker supervision, monitoring and backups
remain release gates. Keep paid catalogs/purchases closed until approved.
Do not infer authority for deployment, hosted migrations, provider spending,
payments or retailer publication from checkpoint notes.
