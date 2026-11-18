# Web workflow state inventory

Reviewed against repository source on 2026-11-18. This is a navigation and risk
inventory, not a claim that every transition is safe or that hosted Supabase
matches these files. Multiple state machines can govern one screen. A status
label alone is often insufficient: identity, authorization, revision, request
receipt, expiry, leases and provider dispatch also determine what may happen.
Mobile and Stripe activation are deferred by the product owner.

## Design decision

Keep the database or owning service authoritative for durable operations and
make browser state explicit at each boundary. Do not introduce a single global
state-machine framework or flatten unrelated workflows into one `status` enum.
For each mutation, preserve actor and resource identity, distinguish an unknown
outcome from a confirmed failure, use a durable request identity where retries
can otherwise duplicate or reverse work, and verify that stale responses cannot
change a different account, book, edition or revision. UI should say what is
known and offer a safe next action. Read-only loading state is not evidence of
an empty result. Document transition authority and the tests next to each
workflow so developers and agents can extend it without guessing.

## Browser and API boundary machines

| Workflow | State and transitions to examine | Source anchors |
| --- | --- | --- |
| Sign-in and account changes | Session unverified, verified actor, signed out or changed; in-flight results and actions belong to the actor that started them. | `apps/web/components/AuthCard.tsx`, `apps/web/lib/browser-session.ts`, `apps/web/app/api/backend/[...path]/route.ts` |
| Workspace onboarding and navigation | Workspace selection/loading, access verified, stale or unavailable; changing actor or workspace invalidates dependent screens. | `apps/web/components/AuthorDashboard.tsx`, `apps/web/components/AuthorShell.tsx`, `services/api/src/routes/workspaces.ts` |
| Book setup and manuscript intake | Book setup, upload allocation, quarantine/scan, import, starter content and its quote are separate; a completed upload is not a completed import. | `apps/web/components/BookSetupClient.tsx`, `services/api/src/routes/assets.ts`, `services/api/src/lib/manuscript-import.ts` |
| Manuscript editing and recovery | Saved base, dirty draft, save pending, confirmed/conflict/unknown; opt-in tab recovery is distinct from a server save. Chapter create, title, reorder and restore each have separate operations. | `apps/web/components/BookEditorClient.tsx`, `apps/web/components/ChapterTitleEditor.tsx`, `services/api/src/routes/chapters.ts`, `tests/security/chapter-creation.test.sql`, `tests/security/chapter-title.test.sql` |
| Manual Book Bible and source search | Draft, saved/conflicting/unknown mutation, deleted/closed receipt; selected source and read result are bound to book and source version. | `apps/web/components/BookMemoryClient.tsx`, `apps/web/components/BookSearchPanel.tsx`, `services/api/src/routes/book-memory.ts`, `tests/security/manual-book-bible-recovery.test.sql` |
| Asset upload, versions and review | Selected, allocated, uploaded, scanned/quarantined, versioned, reviewed/approved; removal and restore are separate actor/revision-bound operations with uncertain/closed outcomes. | `apps/web/components/AssetBrowser.tsx`, `apps/web/components/RemovedAssets.tsx`, `services/api/src/routes/assets.ts`, `services/api/src/routes/asset-lifecycle.ts`, `tests/security/asset-lifecycle-additive.test.sql` |
| Saved edition and print proof | Edition draft, dirty/saved/conflict or uncertain create; render status, proof history and private-link expiry are distinct. Dirty settings invalidate an in-flight history read. | `apps/web/components/PublishingStudio.tsx`, `apps/web/components/SavedPrintLibrary.tsx`, `apps/web/components/SavedPdfProof.tsx`, `apps/web/tests/saved-print-mounted.mjs` |
| EPUB, retailer package and downloads | A saved artifact, verified private link, expired link, preflight, export request and manual retailer handoff have different lifetimes; loading or renewing a link must not start another export. | `apps/web/components/SavedEpubReader.tsx`, `apps/web/components/RetailerPackageRequest.tsx`, `apps/web/components/PrivateArtifactDownload.tsx`, `services/api/src/routes/publishing.ts` |
| Retailer submission status | An author can record the status seen in a retailer account for a completed package. The server saves against the last-read revision. A stale or unconfirmed save requires a fresh read before another edit. | `apps/web/components/RetailerSubmission.tsx`, `services/api/src/routes/publishing.ts`, `tests/security/retailer-submissions.test.sql` |
| AI writer, images, metadata and story plans | Inputs, count/quote, explicit acceptance, dispatched job, outcome recovery, review and apply; opening a panel or plan must not imply paid generation. | `apps/web/components/AiAssistantPanel.tsx`, `apps/web/components/ImageQuoteStudio.tsx`, `apps/web/components/StoryBlueprintClient.tsx`, `services/api/src/routes/ai-review-quotes.ts`, `services/api/src/routes/image-quotes.ts` |
| Translation and narration | Quote, explicit acceptance, generation, saved output, review and export are separate; audio segments, QC and link expiry add more states. | `apps/web/components/TranslationStudio.tsx`, `apps/web/components/NarrationQuoteStudio.tsx`, `apps/web/components/ChapterAudioDownload.tsx`, `services/api/src/routes/translations.ts`, `services/api/src/routes/audiobooks.ts` |
| BYO AI connection | Credential saved/revoked, option selected, prepared/confirmed/closed and job/receipt states; customer execution remains disabled pending its separate readiness gates. | `apps/web/components/AiConnections.tsx`, `apps/web/components/CustomerAiStudio.tsx`, `services/api/src/routes/ai-connections.ts`, `services/api/src/routes/customer-ai.ts` |
| Invitations, community and referrals | Invitation token/session/acceptance; membership join; referral load/claim and ledger each need actor-bound visibility and action state. Account-switch cases are being audited. | `apps/web/components/InvitationAcceptance.tsx`, `apps/web/components/CommunityDirectory.tsx`, `apps/web/components/ReferralCenter.tsx`, `services/api/src/routes/team.ts`, `services/api/src/routes/community.ts`, `services/api/src/routes/referrals.ts` |
| Comments, tasks and moderation | Open/resolved comments, task and approval transitions, reports and moderation decisions; access and revision guards differ. The legacy comment resolve route is a toggle, so a repeated request can reverse a prior result. | `apps/web/components/CommentThread.tsx`, `apps/web/components/CollaborationCenter.tsx`, `services/api/src/routes/collab.ts`, `services/api/src/routes/admin.ts`, `services/api/src/step9.test.ts` |
| Account requests and operations | Data-rights request submission, processing, completion/rejection/cancellation and support ticket states; unavailable hosted functions must not be presented as completed actions. | `apps/web/components/AccountMenu.tsx`, `apps/web/components/AdminConsole.tsx`, `services/api/src/routes/account.ts`, `services/api/src/routes/admin.ts` |
| Analytics and billing views | Workspace/actor selection, loading/error, imported report state and credit ledger/plan access; manual report data is not live retailer connectivity. Stripe activation remains deferred. | `apps/web/app/analytics/page.tsx`, `apps/web/components/BillingCenter.tsx`, `services/api/src/routes/sales.ts`, `services/api/src/routes/billing.ts` |

## Durable and worker state machines

| Area | Authoritative concepts and source anchors | Test navigation (existence only; not a fresh pass) |
| --- | --- | --- |
| Membership and invitations | Membership invited/active/suspended, invitation pending/accepted/revoked/expired; role and expiry are separate. `supabase/migrations/0002_core.sql`, `supabase/migrations/20260904120000_collaboration_invitations.sql` | `tests/security/collaboration-invitations.test.sql` |
| Import and authoring receipts | Import queued/running/succeeded/failed also binds attempts, lease, checksum and document receipt. Title/create/restore receipts close or conflict independently. `supabase/migrations/20260910100000_manuscript_import_jobs.sql` | `tests/security/chapter-creation.test.sql`, `tests/security/chapter-restore-ledger.test.sql` |
| Asset lifecycle | Scan, version and review plus soft deletion are separate; staged operation receipts bind actor, action and revision. `supabase/migrations/20260907110000_asset_quarantine.sql`, `supabase/migrations/20261103011721_asset_lifecycle_additive.sql` | `tests/security/asset-quarantine.test.sql`, `tests/security/asset-lifecycle-cutover-native.mjs` |
| Quotes, credits and AI jobs | Quote and credit hold/settlement/review/cancellation, provider dispatch, job lease and output review are not interchangeable. Later migrations add transitions; inspect the latest function. `supabase/migrations/20260919100000_funded_usage_quotes.sql`, `supabase/migrations/20260919140000_cancel_undispatched_translation.sql` | `tests/security/narration-funded-lifecycle.mjs`, `tests/security/translation-quote-requests.test.sql` |
| Story planning | Blueprint proposal and quote progress are distinct from materializing chapters and paid draft execution. `supabase/migrations/20260919200000_story_blueprint_quote_proposals.sql` | `services/api/src/routes/story-blueprint-proposals.ts`, `services/api/src/lib/quoted-story-blueprint-worker.ts` |
| Narration and translation | Project/job, leased processing, segment assets, QC/signoff, quote settlement and archive export are separate. `supabase/migrations/20260912160000_audiobook_workflow.sql`, `supabase/migrations/20260912180000_translation_workflow.sql` | `tests/security/native-narration-lifecycle.mjs`, `tests/integration/test_google_play_cover_transport.py` |
| Rendering and publishing | Render, preflight, package, worker lease and request closure each have distinct identities; closure must fence an unaccepted request. `supabase/migrations/20260903120000_render_workflow.sql`, `supabase/migrations/20260905120000_publishing_worker_leases.sql`, `supabase/migrations/20261104110000_render_close_request.sql` | `tests/security/render-workflow.test.sql`, `tests/security/native-render-close.mjs`, `tests/security/publishing-worker.test.sql` |
| Retailer status records | A completed export owns one workspace-visible, author-reported status. Revision checks serialize edits, and removing a package file preserves the report. `supabase/migrations/20261118013037_retailer_submissions.sql` | `tests/security/retailer-submissions.test.sql`, `tests/e2e/native-author-files-packages.mjs`, `apps/web/tests/saved-print-mounted.mjs` |
| Sales imports | An imported report can be current or superseded; digest and replacement identify the report. It is not live retailer sales integration. `supabase/migrations/20260912190000_retailer_sales_imports.sql` | `tests/security/retailer-sales-imports.test.sql` |
| Customer-owned AI | Connection revision/revocation, preparation, authority, dispatch, leased job, receipt and maintenance journal form separate machines. `supabase/migrations/20261024020000_ai_connection_vault.sql`, `supabase/migrations/20261024070000_customer_ai_preparations.sql`, `supabase/migrations/20261028070000_customer_ai_maintenance_journal.sql` | `tests/security/customer-ai-preparations.test.sql`, `tests/security/customer-ai-jobs.test.sql`, `tests/security/customer-ai-maintenance-journal.test.sql` |
| Referrals, credits and operations | Referral attribution/review/reward and immutable ledger entries differ from support, moderation and data-rights request states. `supabase/migrations/20260905070000_referral_transactions.sql`, `supabase/migrations/0012_community_extras.sql`, `supabase/migrations/0013_admin_ops.sql` | `tests/security/referral-transactions.test.sql`, `services/api/src/routes/admin.ts` |

## Verified gaps and review limits

- A pending saved-print history request invalidated by unsaved edition settings
  could be mistaken for an empty archive. The fix marks history for
  refresh when settings become clean and explains why checking is paused while
  dirty; see the mounted regression tests. Confirm the exact commit and suite
  result in Git before relying on it.
- The existing `POST /comments/:id/resolve` is a toggle. An isolated invocation
  of the current handler showed two identical requests resolve and then reopen a
  comment. Existing clients depend on the toggle contract; replacing it silently
  would break compatibility. A desired-state prototype alone still permits a
  delayed earlier request to reverse a later action. Durable operation identity,
  revision fencing and old/direct-writer coordination need further design.
- Mounted synthetic tests reproduced referral and invitation account-switch
  races. The invitation fix binds the request to the verified actor,
  rechecks the session and keeps an unconfirmed result separate from success;
  its warning remains tab-memory only and the existing backend does not provide
  a durable accepted-invitation receipt. Referral reads and claims now bind to
  the verified actor; an uncertain claim retains the original code for an
  explicit retry in the same tab. This does not coordinate different tabs, and
  hosted uniqueness has not been verified. Community discovery and join now
  bind to a verified actor and hide prior results during revalidation. Its
  locally remembered Joined state is not refreshed after external membership
  revocation, and uncertain joins are not persisted across remounts or tabs.
  These tests do not establish hosted authentication or data behavior.
- Chapters and editions originally have text status columns; edition API
  validation is not proof that every direct database writer enforces the same
  transitions. Inspect later migrations and live ACLs before adding constraints.
- Asset lifecycle recovery is staged and default-off. Hosted render closure,
  deletion intake and asset revision were absent in the latest read-only check;
  local/native tests do not prove hosted identity, Storage or retailer behavior.
  Editors can check removal history on the legacy schema. This read confirms
  the file's current removed state while restore still requires verified recovery
  readiness and a new, revision-bound operation. A lost removal reply remains
  unconfirmed even when the file appears in history.
- This index is grouped rather than an assertion of exhaustive state coverage.
  For a change, search its routes, workers, SQL functions, frontend consumers,
  recovery identifiers and tests; verify its current state before acting.

## Maintaining a workflow

1. List the durable owner, browser-only state and every authorized transition.
   Include the actor, resource and revision or request identity needed to
   distinguish stale work from the current operation.
2. Trace success, definitive rejection and unknown outcomes separately. A
   timeout or lost reply does not establish that a write failed. Specify what
   survives a reload, which retries are safe and how the user can recover.
3. Test late success and failure, account/workspace changes, duplicate actions,
   access revocation, concurrent writes and unmount or remount when relevant.
   Include a real boundary test when mocks cannot establish the property.
4. Update this index and the shared handoff when ownership, transitions or
   rollout gates change. Point to exact tests and distinguish local fixtures
   from hosted acceptance. Keep credentials and user data out of both.
