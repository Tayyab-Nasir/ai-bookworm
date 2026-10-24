# Customer-key database transport and private service composition

Built locally, default-off. No public route, queue registration, deployment,
live migration, seeded fee policy, consumer subscription or paid-provider proof.
This connects the existing authorization/receipt contracts; it does not create a
second source of billing authority. Stripe remains deferred; mobile stays parked.

## Explicit dependencies

`services/ai/customer_database.py` provides `CustomerAiDatabase`, constructed with
an operator-selected Supabase root and service key. It never reads environment
variables or accepts endpoints/keys from HTTP callers. Configuration is immutable
and omitted from its representation. HTTPS is required except explicitly enabled
literal loopback HTTP for local acceptance. Credentials in URLs, paths, query
strings, fragments, ambiguous escaping and non-loopback HTTP are rejected.

The transport uses fixed PostgREST paths, no redirects or retries, `trust_env=False`
(no ambient proxies/.netrc/TLS overrides), identity encoding, five-second I/O
timeouts, a checked 15-second operation deadline and bounded streamed responses.
Each blocked read is bounded by the I/O timeout; this is not a hard thread-killing
wall-clock deadline. Error bodies are discarded, duplicate JSON keys/non-finite
numbers rejected and public exceptions contain no request/response/credential.
Raw HTTP/body tracing must still be disabled by deployment configuration.

`customer_service_router(...)` explicitly composes the non-billable preparation
router and signed dispatch router with this adapter. Neither `main.py` nor an
environment switch mounts it. The standalone dispatch factory now requires an
explicit receipt store in addition to the authorizer, service token and signing
keys; ambient Supabase environment values cannot activate a receipt store.

## Database authorization

The exact scope is strictly parsed/detached before calling service-only
`customer_ai_dispatch_authorized(p_scope)` from migration 113. Only a literal JSON
`true` authorizes; malformed responses, unavailable storage and missing authority
fail closed. No user key, manuscript or signed envelope is sent to this RPC.

Existing SQL checks the exact owner, payer consent, grant, active writing role,
organization entitlement, saved credential revision, source versions, server-owned
model/fee policy, running customer-key job and current dispatch lease. Authorization
is not cached. The HTTP route checks it before receipt I/O and again after a new
reservation immediately before provider setup, with envelope expiry rechecked.
Revocation/source/lease changes during reservation block the provider and preserve
an unresolved fence. A database check and an external HTTP call cannot form one
atomic transaction: revocation after the final check can still race an in-flight
request. Do not promise cancellation/refunds of a request already dispatched.

Saved-result replay also needs current authorization at this endpoint. The separate
worker completion path remains receipt-only and can reconcile previously produced
results without resolving the key or generating again after revocation/expiry.

## Receipt contract

All six text agents share existing `ai_review_service_receipts` (migration 75),
with unique job ID, immutable request fingerprint, and a one-time result update.
Later SQL guards make settled results immutable and prohibit deletion of customer
receipts. Effective deployed ACLs and migrations must be verified before activation.

- Reserve: one INSERT, `return=representation`, require exactly one matching
  job/fingerprint row with a NULL result. No upsert/ignore-duplicates shortcut.
- Conflict: one bounded SELECT; only the exact fingerprint and a saved object may
  replay. NULL, missing, malformed or mismatched receipts require review. Never
  erase a reservation to retry.
- Save: PATCH with job ID, exact fingerprint and `result_json=is.null`; require
  exactly one matching row and the exact canonical saved result. A generic success
  status or single row with different contents is not confirmation.
- A response lost after INSERT or PATCH is unconfirmed. The next authorized call
  reads the existing fence/result; it does not issue another provider call.
- No delete, truncate, refund, release, job completion or subscription billing is
  provided by this adapter. Provider cost remains unknown/NULL for customer keys;
  proposals remain pending human review.

Canonical result JSON is capped at 1 MiB. Database row responses allow up to
6,001,024 bytes for SQL JSONB/Unicode representation overhead; scope replies are
capped at 8 KiB. Job IDs and fingerprints are validated before constructing filters.

## Verification and remaining release gates

Synthetic tests cover strict configuration/scope/response parsing, ambient proxy
suppression, timeouts/redirects/size limits, exact CAS persistence, restarts,
concurrency, revocation and lost responses. The composed private HTTP pipeline
uses actual Bookworm agents for five providers and six text tasks, with synthetic
provider and PostgREST HTTP. These mocks are not live-provider or native PostgREST
acceptance; the existing local SQL suite independently exercises database rules.

Still required: reviewed native/deployed ACLs, explicit receipt retention and
account-deletion workflow (do not delete recovery fences), authenticated public
preparation/job confirmation, queue wiring, operator fee policy/entitlement choice,
key rotation, private-network controls, funded provider acceptance, and separate
image/audio/translation capability contracts. Nothing here enables free platform
AI, reuses ChatGPT/Claude/Gemini/Grok sessions or activates consumer subscriptions.
