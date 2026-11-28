# Metadata token quotes

## Source implementation checkpoint

### 2026-10-03 recovery and fenced completion follow-up

Metadata offers can now be recovered by the caller's original key through
read-only `POST /v1/books/:bookId/metadata/quotes/recover`. It returns the same
private no-store offer/job/candidate projection as the saved-request GET. It
requires active book membership and ownership, but never reads the current
catalog or manuscript, calls the provider, accepts an offer, or writes a job or
ledger entry. Creation retries with unchanged saved settings also replay before
current context/catalog preparation. A missing recovery key returns 404; it
must not silently create a new counted request.

Public ready offers must exactly match canonical price arithmetic, saved
job/user/workspace/request hash, model, output limit, input bounds, policy and
original catalog lifetime. Verification rebuilds the immutable saved snapshot
at its original quote time, so expiry or current catalog removal does not erase
read-only recovery. Private source, commercial rates and approval references
are not returned. Typed client methods now separate creation, key recovery,
status and exact acceptance; the retired direct generation method is removed.
OpenAPI describes these routes and safe projections.

Additive source migration `20261003043000_text_quote_recovery_completion.sql`
reclaims expired undispatched text leases, cancels invalid pre-dispatch holds,
locks saved source before one-way dispatch, preserves immutable durable receipts,
and atomically completes metadata with measured settlement under a current lease
and membership lock. Worker hash checks match the actual four-field AI-service
reply. Ambiguous completion requires an authoritative status read; it must not
regenerate or separately release a dispatched hold. This migration is not
applied hosted. Current local verification and native/browser limits belong in
the latest dated Codex checkpoint, not the historical counts below.

`services/api/src/lib/metadata-quote.ts` builds a server-only quote from a
bounded, validated metadata context, a server-configured approved text catalog,
the authenticated AI-service counter and saved credit policy. It pins the
generation request hash returned by that service, computes both cached-input
and uncached-input maximums plus the output cap, rechecks catalog and expiry,
and returns an expiring `UsageQuote`. Book/version IDs and exact excerpt hashes
are part of the bounded snapshot; provider calls only receive selected text.
The shared text preparation endpoint requires explicit token-counting consent.

The read-only model helper returns labels and price/policy version IDs, never
commercial rates or approval references. Missing, expired or malformed catalog
configuration disables quote preparation. Tests use a synthetic catalog,
counter and internal credential only.

The durable local source flow is now connected:

- Source-only migrations `20260925100000_metadata_token_quote_acceptance.sql`
  and `20260925103000_quoted_metadata_worker.sql` define private count-request
  persistence, explicit-consent recording, caller-scoped acceptance with an
  exact expected-credit total, one funded hold/job, dispatch fencing, source
  version checks, renewals, pre-dispatch cancellation and review holds. They
  are not applied to hosted Supabase.
- Authenticated API routes expose approved model choices, quote request/status,
  exact-total acceptance, and safe read-only job status. Source is collected
  under the caller's book access, bounded and version-pinned. Quote/history
  reads are private no-store.
- `runOneQuotedMetadataJob` verifies the accepted quote, source snapshot and
  request hash before one-way dispatch; it checks the private AI receipt,
  validates citations and measured usage, settles through the funded ledger,
  and preserves uncertain provider outcomes for review rather than redispatch.
- `npm run worker:metadata-quotes` and the allowlisted `metadata-quotes`
  launcher/systemd role now run this queue. This is code wiring only; no worker
  was started or deployed by this implementation.
- `BookMemoryClient` now requests an exact quote after explicit consent to
  OpenAI input-token counting, shows the reserved-credit ceiling and expiry,
  requires separate explicit purchase confirmation, supports same-key/status
  recovery in session storage (IDs/options only, no manuscript text), and
  exposes the returned candidate only as an unsaved review draft. A read-only
  status endpoint replaces automatic legacy recovery for pending jobs.
- The quote card uses a restrained publisher-proof visual: an instrument-serif
  receipt on warm paper against the existing dark Book Memory workspace. Its
  hierarchy separates evidence consent, quote and purchase confirmation.

## Boundaries and remaining gates

The approved pricing catalog remains owner-controlled environment
configuration (`METADATA_PRICING_CATALOG_JSON`). No rates were invented or
activated. When this variable is missing/unapproved/expired, the API advertises
no purchasable model and the author cannot start generation. No live OpenAI
key/call or commercial usage occurred here.

The older `POST /metadata/generate` endpoint now returns `410 Gone` before
reading manuscript data, reserving credits or calling a provider. The
compatibility implementation is disabled in the production `buildApp` path;
only explicitly opted-in legacy regression tests can exercise it. OpenAPI and
operations docs describe the retired contract. Keep this gate in place until
the exact-quote flow has passed hosted acceptance and the legacy implementation
can be safely removed. The remaining migration, provider-receipt, ledger and
worker checks are local synthetic/disposable tests; hosted Supabase, live
OpenAI, pricing activation and production worker supervision have not been
accepted.

Current local evidence (2026-09-25): 82 migrations and 58 SQL assertion files
pass in disposable PostgreSQL; 348 API tests, 104 web tests, 3 worker-launcher
tests and all workspace TypeScript checks pass. Native headless Edge metadata
acceptance verifies explicit counting consent, exact 37-credit fixture quote,
explicit purchase acceptance, read-only result recovery, author review and
separate Save at 390px. An isolated Next production build also passes. Browser
AI, quote, ledger and storage outcomes are fixtures, not live integration
proof. The isolated Next runs auto-adjusted the already-dirty `next-env.d.ts`
and `tsconfig.json`; only the test-output references they added were removed,
and the other shared config changes were preserved.

Next: remove the now-gated legacy implementation after verifying that no old
client depends on it; rerun the focused and full local checks,
then complete native hosted Auth/Storage/ledger and owner-approved
pricing/provider acceptance. Keep both migrations source-only until a separate
explicit hosted rollout approval.
