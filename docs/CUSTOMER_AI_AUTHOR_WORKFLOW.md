# Customer-owned AI: author review and recovery

Implemented, not activated. The chapter workspace at `/books/[bookId]/ai`
supports drafting, proofreading, copy editing and consistency review using
the author's saved OpenAI, Anthropic, Google, OpenRouter or xAI API connection.
The editor links to it through the existing unsaved-draft navigation guard.
Consumer subscriptions remain a separate, unavailable integration until the
provider grants commercial access. No pricing or provider availability is invented.

The owner selected paid-plan inclusion on 2026-10-24: customer-owned keys and
officially approved subscription connections incur **no additional Bookworm
service credits per request**. Provider usage charges remain separate. This
selects the funding mode, not a public plan price, monthly request allowance,
subscription partner agreement or activation authority.

## Review contract

- Account and book access are verified before reading data and before/after
  every action. Cookie-proxy and API actor fences reject cross-account requests;
  customer-AI requests require HTTPS upstream except local loopback. Focus,
  visibility and unmount fences discard private UI data and late responses.
- The browser asks for an approved model/policy tied to an exact connection
  revision and task. No arbitrary model, upstream URL or price can be entered.
- Preparation loads the selected chapter's authoritative current document UUID
  and version number. Only those identifiers and the direction/context selectors
  are submitted; manuscript contents come from the authenticated server loader.
- A review receipt displays source revision IDs, provider/model/upstream, output
  cap, omitted optional context, expiry and the exact platform charge policy.
  Provider cost is separately billed and unknown, never described as zero.
- A fresh preparation shows the exact direction held in memory. Confirmation
  requires a separate consent checkbox. Eligible paid-plan access queues once
  with zero Bookworm credit reservation; it never applies edits automatically. Successful chapter
  jobs link back to the existing suggestion-review screen.
- The existing connection capability is still false until the server/worker
  activation boundary is approved. Options/prepare/confirm are disabled in
  that state; saved status/closure/receipt recovery remain available.
- Public options and preparation accept only `platform_plan` with zero credits;
  confirmation requires literal `expectedPlatformFeeCredits: 0`. Historical
  credit-fee receipts remain readable, closable and recoverable, not newly
  confirmable. The database still enforces a current paid plan and allowance.

## Recovery and late arrival

Before submitting a preparation, session storage must successfully write and
read back exactly one operation UUID under its owner/book-scoped key. It stores
no manuscript, direction, credentials, model or charge data. It never silently
overwrites another unresolved request. Storage corruption or failure blocks
new submission; closing the browser tab may still lose tab-scoped recovery.

Lost replies never cause automatic re-preparation or confirmation. A status
read cannot generate content. Recovered preparations show the exact saved
source metadata, but cannot be confirmed without the original full instruction
review in this page: close and prepare afresh. This deliberately avoids saving
private instructions in browser storage or guessing them after a reload.

Migration117 `20261024080000_customer_ai_author_recovery.sql` adds private
immutable closure tombstones. Closing an absent operation and inserting its
late preparation contend on the same owner lock. A committed closure rejects
the late insert. An existing preparation uses the established pre-dispatch
cancellation path. Dispatched or unknown outcomes cannot be marked cancelled
or refunded just to clear the UI. A missing status is never safe-to-forget.

Explicit “Start another request” first rechecks server status and only clears
a matching closed/cancelled/succeeded checkpoint. Receipt-only result recovery
uses the saved provider output; it never resends to the provider. Source,
instruction or model changes require a new reviewed operation, not mutation
of an accepted preparation.

## Evidence boundaries

- `apps/web/tests/customer-ai.test.ts`: exact client contracts, actor/source/fee
  binding, strict private-field rejection and fail-closed opaque recovery.
- `apps/web/tests/customer-ai-mounted.mjs`: real component/client in Chromium;
  consent, lost replies, remount, late preparation after closure, account races,
  storage failure, disabled generation, unknown outcomes, mobile/tablet/desktop
  layout, keyboard focus and synthetic screenshot artifacts. No live API.
- `services/api/src/customer-ai.test.ts`: actual route/private preparation
  composition, redaction, strict receipts and loss/recovery transport behavior.
- SQL fixtures run117 migrations and81 assertion files locally. The populated
  historical45-to117 rehearsal compares historical projections after probes.
- Native helper tests real two-session lock waits, commit/rollback closure races,
  duplicate confirmation, confirmation-vs-close, and no post-dispatch refund.
  Its paid-plan fixtures start without credits and assert no debit or release.
  The CI runner invokes it; terminal results belong in the shared session note.

The frontend-design skill shaped an editorial proof sheet using the app's
existing Instrument Serif/Inter, quiet dark paper, clear focus and no animation.
Full-stack/security guidance separates UI metadata from private prompts and
credentials and preserves explicit, durable decisions.

Still pending: published plan price/request allowances, live migration acceptance,
queue/runtime composition and separately authorized bounded paid-provider tests.
Whole-book batching, related-context retrieval, customer-key media, account-data
retention and consumer subscription agreements are separate work. Stripe and
mobile remain deferred. This component is not full production acceptance.
