# Manual chapter save recovery — 2026-10-23

## Implemented

The manuscript editor retains the identity of an uncertain manual save across
a remount/reload in the same browser tab. Recovery is scoped to the signed-in
account, book and chapter, and binds the original UUID, expected revision and
canonical content digest. Session storage contains no manuscript text and has
no automatic expiry that could silently turn an uncertain write into a new one.

Editing, chapter mutations, restores and AI application are paused while the
manual save is unresolved. The author explicitly checks saved status. A missing
receipt is not cancellation: retry is available only for the unchanged original
body still held in memory, with the same UUID. A cold reload cannot reconstruct
unsent text; the UI says so and offers a local draft download before leaving.

An explicit **Close unconfirmed save** action uses the existing locked
`append_chapter_version` RPC, with server-loaded saved content and the original
expected revision. If the save never committed, one unchanged revision fences
a late original request. It does not delete history or undo a committed save.
A stable author-scoped closure key makes the closure recoverable after a lost
reply. A concurrent save winning the lock is recovered by checking status again.
No new migration, provider call, credit movement or payment is needed.

The new status/closure routes require `X-Bookworm-Actor` in the API and browser
proxy. Existing document PUT clients remain compatible; when that header is
present it must match the authenticated account. Identity is also checked before
and after browser recovery. Late responses cannot adopt a different chapter.

Saved receipts must match the original content digest and revision. The latest
document must be canonical, no older than the observed receipt, and consistent
with that immutable revision when equal. Later collaborator changes never
silently replace a dirty local draft. Explicit reload/merge remains necessary.
The client supports the same 20,000-node / 4,000,000-character chapter limits as
the API. Malformed metadata or unavailable storage fails closed.

## Verification

- Workspace typechecks and unit suites passed. Shared checkout API: **937 tests**;
  the clean committed snapshot has **922 tests**, excluding 15 preserved,
  uncommitted billing tests from another agent.
- Web suite: **406 tests**; security/contract suite: **49 tests + 2 subtests**.
- Actual mounted editor/compiled CSS in headless Edge: **38 tests**, including
  cold recovery, identical retry, lost closure reply, late response/account
  change, corrupt metadata and conflicting immutable-content checks.
- A 320px screenshot was inspected: recovery actions and the read-only draft
  remain readable without horizontal overflow. This is a fixture, not a live
  hosted acceptance or a mobile-app implementation.
- Disposable database: **110 migrations and 73 SQL assertion files** pass,
  including sequential original-first/closure-first ordering and stable replay.
  These local SQL cases do not themselves prove multi-connection races or
  GoTrue/PostgREST/Storage behavior.
- The existing native author/files CI workflow now includes the full mounted
  editor regression suite before its production web build. Exact commit/run
  outcomes are recorded separately in the shared Obsidian handoff.

Final acceptance of application commit `8861da07425efb097bc6d0a09ef60c1366623564`:
the complete clean-snapshot `npm run verify` passed at 14:12:44 UTC, including
737 service, 18 E2E, database-upgrade/crypto, load and deterministic evaluation
cases. Installed Python and hash-verified EPUBCheck were explicitly configured;
live-provider evaluation was skipped without a key. Production Next build passed.
[Native database CI](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/39963455427)
and [native author/files CI](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/39963455341)
both passed on that exact application commit. These are not hosted/funded proofs.

## Files and continuation

- Editor/persistence: `apps/web/components/BookEditorClient.tsx`,
  `apps/web/lib/manual-chapter-save.ts`.
- Actor-bound transport: `packages/api-client/src/index.ts`,
  `apps/web/app/api/backend/[...path]/route.ts`.
- Status/closure: `services/api/src/lib/manual-chapter-save.ts`,
  `services/api/src/routes/chapters.ts`; documented in `services/api/openapi.yaml`.
- Regressions: corresponding web/API tests, `editor-numbering-mounted.mjs`,
  `tests/security/manual-chapter-save.test.sql` and OpenAPI contract tests.

This does not complete the full product. Hosted migrations were separately
verified at 110/110; do not rerun the old migration plan. The recovery snapshot
is application-only, not a full Auth/Storage/settings disaster-recovery backup.
Private runtime/Redis readiness, fresh user Google-login evidence, configured
OpenAI model/price catalogs and funded provider acceptance remain release gates.
Mobile is parked. Stripe is deferred; paid AI and retailer entitlement gates
remain enforced. No deployment or retailer publication is implied by these tests.
