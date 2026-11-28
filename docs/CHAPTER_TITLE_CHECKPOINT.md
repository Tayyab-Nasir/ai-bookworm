# Chapter titles — 2026-10-23

## Scope

The professional-editor audit found that authors could create/reorder chapters
but could not rename them. The web editor now exposes **Edit chapter title**.
It changes chapter identity metadata, not a heading within the manuscript.
Future contents pages use the renamed chapter; older immutable exports remain
unchanged. Existing consented paid-AI snapshots are not rewritten or redispatched.

## Implementation

- `ChapterTitleEditor.tsx`: explicit edit/save/cancel, permission-aware read-only
  state, multilingual titles, mobile containment, recovery and conflict review.
- Title changes have a separate monotonic `chapters.title_revision`. A database
  trigger advances it even for direct authorized title edits and rejects attempts
  to tamper with the counter. Body saves and chapter ordering do not increment it.
- Actor-scoped UUID receipts make replay safe. Stale revisions record a conflict.
  A read-only receipt check never resubmits a rename. Explicit closure records a
  tombstone under the same chapter lock, so a delayed original cannot overwrite
  a later edit. Closure does not undo an already committed original.
- Browser recovery stores identity, revision and SHA-256 only, not the proposed
  title. A reload can recover a committed title, but not text never received by
  the server. Retry is offered only while the exact original text remains in
  memory. Unknown outcomes remain blocked until read/close confirms them.
- API and BFF check the original actor against the current authenticated account.
  RLS denies direct client access to receipts; SQL RPCs check current membership
  and editing roles. Returned receipts and current state are validated separately.
- Manuscript drafts and immutable document history are untouched. Title recovery
  temporarily gates editor mutations, avoiding overlapping UI actions.

API routes: `GET /v1/chapters/{chapterId}/title`,
`GET|PUT /v1/chapters/{chapterId}/title-changes/{operationId}`, and explicit
`POST .../{operationId}/close`. OpenAPI and the typed client describe all routes.

## Evidence at implementation checkpoint

- RED: nine new API tests failed with 404 before the routes existed.
- GREEN: nine API tests, six title-library tests and the 33-test Auth/BFF suite.
- All 111 local migrations and 74 SQL assertion files pass in disposable
  PostgreSQL/WASM, including rename replay, both save/close orders, stale edits,
  cross-tenant refusal, reader restrictions, direct-write CAS and body preservation.
- 49 mounted browser cases pass: 39 full editor cases plus 10 title-specific
  cases. They cover retained unsaved manuscript text, metadata-only reload
  recovery, original-identity retry, explicit closure, conflict, account changes,
  storage failure, malformed receipts and read-only access.
- Desktop and 320px screenshots visually inspected. This is synthetic browser
  acceptance, not a fresh hosted Google user-session test.
- Web/API typechecks and 18 OpenAPI contract tests pass.

These serial SQL cases are not a new multi-connection race claim.

## Follow-up acceptance

- `5c326301f46fcb3fbc6c2dd2716a31d9289d04ae` passes the isolated production web
  build and native author/files CI `39976538049`. The earlier native run caught
  a title-lock rendering race; the follow-up publishes the dirty/busy lock in the
  input event and waits for the rendered state in its browser assertion.
- Native database CI `39974749745` passed on `86be9c6`; its migration is unchanged
  in the UI-only follow-up. The live project now has 111 migrations. The title SQL
  acceptance also passed in a rolled-back live transaction: profile/Auth identity
  unchanged; no test books, chapters, versions or Storage objects left behind.
- The full clean-source suite first reached the populated-upgrade rehearsal and
  stopped at its deliberate 110-migration pin. The reviewed target is now 111,
  retaining all five negative drift/atomicity guards. Additional populated-row
  probes verify revision-zero backfill without invented receipts, explicit
  rename/replay, stale conflicts, delayed-write closure, unchanged chapter
  identity/order/document pointer and both immutable versions. Rollback restores
  every historical projection. The extended rehearsal passes locally.
- Full `npm run verify` passed at 15:33:09 UTC on clean Git source
  `a22a4aae85c712b565a8b1e81a3fc44e4eadec9e`: 931 committed API tests, 412 web,
  737 service, 18 E2E, 50 security plus two subtests, 111 migrations/74 SQL files,
  populated-upgrade/crypto, synthetic handler-load and deterministic eval gates.
  Live provider eval was skipped without a key. Source integrity was verified.
  This excludes the 15 pre-existing shared, uncommitted billing tests.
- Native database CI `39978430063` passed on `a22a4aa`. Its application code is
  identical to the production-build/native-author source at `5c32630`; only the
  populated-upgrade runner and this checkpoint changed. Native author/files CI
  `39976538049` remains the relevant passing application acceptance.
- The loopback web/API now run the frozen `a22a4aa` snapshot: login and API health
  return 200. Supabase readiness passed; Redis remains unavailable, so aggregate
  readiness correctly returns 503. No private workers or provider keys started.
- At 15:36:19 UTC the actual private application-data snapshot also passed an
  offline archived-source restore from migration 45 through all 66 updates to
  111. All original application row counts and the typed profile are preserved.
  The two additional migration sources and a verified manifest/receipt were
  appended in a private `schema-through-111` supplement. Original backup artifacts
  are byte-identical; this still does not restore Auth credentials or project settings.

Exact private artifact paths, runtime process identities and remaining operator
inputs are recorded in the shared Obsidian continuation note
`Codex Sessions/2026-10/2026-10-23-chapter-title-editing.md`. Do not commit private
backup contents or treat local/native fixture evidence as hosted user acceptance.

## Migration boundary

`20261023153000_chapter_title_changes.sql` is additive: one metadata column,
one private receipt table, a revision trigger and three actor-bound RPCs. No
manuscript or historical version is rewritten. The initial live preflight found
110 installed migrations, zero books/chapters/document versions/Storage objects
and one unchanged profile. Existing application-only recovery is separate from
full Supabase/Auth/Storage/settings disaster recovery.

## Remaining product gates

See `WEB_APP_ACCEPTANCE_2026-10-23.md`. Mobile stays parked, Stripe deferred;
funded AI, retailer entitlements and credit gates remain enforced. No provider
spend, payments, retailer submission or deployment is part of this checkpoint.
