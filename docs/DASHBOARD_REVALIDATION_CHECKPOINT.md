# Dashboard revalidation and author-route checkpoint

This checkpoint covers the author dashboard's private-state lifecycle and its
connection to book creation and paid writing. It does not certify the whole
publishing application or authorize hosted activation.

## Author behavior

- Initial loads, workspace changes and explicit Reload use the same read path.
  Previous workspace, library, summary, usage, jobs and activity are cleared
  before fresh reads. Failed access or transport must not leave private data
  visible or substitute demo summary counters.
- Each load has a response fence. Older StrictMode lists cannot start an
  overview, and an unmounted response cannot update the next view or browser
  preference. Late workspace creation cannot initiate a follow-up read after
  unmount; it does not cancel the explicit backend creation already requested.
- Retry retains the requested workspace. An unavailable explicit target does
  not silently switch to the first workspace. The author can choose another
  authorized workspace explicitly. A mismatching response workspace or book
  scope fails closed.
- Browser preference storage is optional. Its failure must not prevent
  authorized API reads or explicit workspace creation. A preference is saved
  only after a current matching overview succeeds.
- Reload is read-only, guarded against repeated activation while waiting and
  keyboard-focusable. Loading is announced; controls retain visible focus and
  44px minimum touch targets. Long names and titles wrap within mobile bounds.
- The existing black editorial publishing desk and Instrument Serif display
  identity remain intact. No global theme, dependency or font rewrite belongs
  to this focused privacy/recovery change.

## Backend and fixture boundaries

The unchanged `/v1/dashboard` endpoint checks active workspace membership
before scoped book, asset, job and activity queries. Organization usage and
the caller's user-global ledger have different scopes; package counts never
represent sales. Its response is private/no-store and omits private activity
payloads. Client response guards are additional fail-closed behavior, not a
replacement for hosted Auth, PostgREST or RLS acceptance.

`tests/e2e/auth-browser-fixture.mjs` now exposes the dashboard aggregate shape
instead of letting a selected HTML option stand in for a confirmed overview.
Its synthetic books/assets/jobs are workspace-filtered; synthetic quote holds
project the fixture ledger and workspace usage. Its 120-credit balance and
24-credit quotes are test data, not a free plan, approved price catalog or proof
of native settlement. Other generation allowances remain zero. Sales remain
explicitly unconnected and generated packages are not counted as sales.

With `FIXTURE_DASHBOARD_RECOVERY=true`, the second populated summary read fails
with 503. The actual author-route journey asserts confirmed initial summary,
workspace-scoped book creation, separate token-count and generation consent,
explicit proposal Apply/reload, original-key lost chapter-reply recovery,
explicit Reject, then returned library/usage and failed Reload/scoped Retry
without another AI job. Its browser is isolated and blocks non-loopback network
destinations; it does not use a personal browser profile.

Dashboard error checks are scoped to the application's main content. Next.js
also exposes a separate 1px `__next-route-announcer__` accessibility alert;
its presence is not an application error and it must not be disabled to make
the journey pass. All dashboard error alerts, not just a message allowlist,
remain asserted within the main content.

## Retained local verification

- `analytics-admin-mounted.mjs`: 26/26 pass, including the seven existing
  analytics/admin/community tests and 19 dashboard tests. It exercises list and
  overview 401/403/503 failures, stale/unmounted replies, blocked storage,
  unavailable/mismatching scopes, explicit creation, read-only reload,
  keyboard focus and styled 375px long-name/failure containment.
- `quote-recovery-mounted.mjs`: 30/30 pass after dashboard changes.
- `editor-numbering-mounted.mjs`: 28/28 pass after dashboard changes.
- Full `npm run verify`: workspace typechecks, launcher/unit tests, 633 API and
  161 web tests, 105 disposable migrations/67 SQL files, narration serial and
  evidence gates, 437 service tests, 12 Python E2E, 44 security tests plus two
  subtests, load smoke without 5xx and deterministic evaluations pass.
  The retained runner deliberately omits the provider key; its live-evaluation
  skip does not establish operator-key availability. No coverage percentage or
  independent lint acceptance is inferred from the repository's wrapper.

Mounted checks use controlled transports, actual project CSS and display font.
Their body-font fixture is not proof of exact Next.js font loading. Production
build and real Next/BFF author-journey evidence must refer to a fresh reviewed
index candidate, not the preceding Book Bible build. Source digest, tree,
commands, terminal logs, actual-route screenshots and result limitations belong
in `Codex Sessions/2026-10/2026-10-06-dashboard-revalidation.md` in the shared vault.

Runnable mounted check: `node --test apps/web/tests/analytics-admin-mounted.mjs`
from the repository root with an installed supported headless browser. The
legacy author journey requires only its isolated synthetic fixture on 4399 and
a separate Next output on 4398, with `FIXTURE_AI_DRAFT=true`; dashboard recovery
requires the additional flag above. Never substitute the user's app on 3001 or
inherit operator provider/database/payment credentials into that fixture.

## Remaining acceptance

The full author pipeline, native Auth/PostgREST/RLS/private Storage/scanner,
approved OpenAI models/rates and funded worker recovery, Google operator OAuth,
audio QC, international print/RTL, mobile/device and retailer-policy acceptance
remain separate release requirements. Local green checks and checkpoint notes
do not establish production readiness, hosted migration status, paid-provider
quality, live sales or successful retailer publication.
