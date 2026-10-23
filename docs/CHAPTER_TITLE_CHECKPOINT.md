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
- Full clean-source verification after that test-only extension and local runtime
  refresh remain separate acceptance steps; use the final continuation receipt.

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
