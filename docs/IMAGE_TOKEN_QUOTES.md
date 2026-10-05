# Image token quote implementation

## Current image creation experience — source reviewed 2026-10-03

The Assets page now uses `ImageQuoteStudio` for new artwork. It reads public
approved options, explicitly consents to storing the quote prompt, persists the
request key before network submission, recovers the same key after interruption,
shows the maximum hold, requires separate generation consent and displays
read-only accepted job status. Recovery does not require re-entering the private
brief or loading a current model catalog. Interrupted acceptance disables another
Accept until an authoritative status read succeeds, and requires fresh generation
consent afterward. Request controls, permission checks and consent are scoped to
the current workspace; late responses from a previous workspace are ignored.
Browser-storage failures prevent new requests, and invalid pointers are retained
until explicitly discarded. Completed drafts return to the asset library.
The typed API client, OpenAPI accept/status paths and route are connected.
Recent image history includes billing mode, so quoted jobs are not mistakenly
sent to the legacy operational-credit finalize endpoint.
`IMAGE_QUOTE_PURCHASE_ENABLED` defaults off; model discovery mirrors the gate,
and the Accept control stays disabled until the operator enables it and the
catalog is valid. Never enable paid use until worker supervision, margin/catalog
approval and native Supabase Storage/provider acceptance are complete.
The quote creation/recovery/detail responses retain the conservative informational
`purchaseAvailable: false`; current UI eligibility uses model discovery's gated
flag. Neither projection overrides the server's acceptance catalog, permission,
expiry, source or exact-credit checks.
The prior flat image-credit POST `/v1/assets/generate` is now retired with 410
outside test mode unless an explicit legacy operator flag is set. Its method
was removed from the typed client and OpenAPI documents only the retirement.

Recovered offers show the server model, format, maximum credits and expiry. The
browser checkpoint contains only quote ID and/or retry key, so the UI explains
that the original private brief remains in the server quote instead of displaying
blank controls as if they described that saved offer. An author still explicitly
consents before accepting. Generated artwork enters the private asset library;
it is not automatically inserted into a manuscript or selected as a cover.

Historical 2026-09-28 local verification included API/web TypeScript, seven image
quote route tests, six quoted image worker tests and OpenAPI YAML parsing. Those
fixtures made no provider requests and do not prove native Storage or worker
races. Current verification must be recorded separately from those results.

## Current runtime boundary

The routes in `services/api/src/routes/image-quotes.ts` are exposed by the local
application source:

| Route below `/v1/workspaces/:workspaceId` | Behavior |
| --- | --- |
| `GET /image-models` | Approved public option discovery and purchase gate |
| `POST /image-quotes` | Consented private snapshot preparation; no funding or generation |
| `POST /image-quotes/recover` | Caller/workspace lookup of the original retry key; no write |
| `GET /image-quotes/:quoteId` | Verify/redact the immutable offer and report expiry |
| `POST /image-quotes/:quoteId/accept` | Explicit generation consent and exact credits; atomic funded acceptance |
| `GET /image-quotes/:quoteId/job` | Read-only accepted-job and completed-asset recovery |

The acceptance route checks current editor access. A new acceptance also requires
`IMAGE_QUOTE_PURCHASE_ENABLED=true` and a valid approved catalog. Replaying an
existing acceptance recovers the original job/hold, even when the catalog or gate
later becomes unavailable. This replay is a server safeguard; the UI resolves
uncertain outcomes through status reads before offering another financial action.

The source migrations implement immutable snapshots (`20260928090000`), independent
four-dimensional price validation (`20260928100000`), atomic acceptance
(`20260928110000`), lease/release/review fencing (`20260928120000`), write-once
receipts (`20260928130000`) and atomic measured completion (`20260928140000`).
Quoted and operational billing are separated. A quoted job cannot consume the
legacy operational image-credit completion route.

`services/api/src/lib/quoted-image-worker.ts` claims/renews a lease, verifies the
funded request/model/source pins, checks reference bytes, persists one-way
dispatch, generates once, uploads a PNG, saves its durable receipt, re-reads
Storage bytes/checksum and completes measured settlement. Already-dispatched
jobs only recover a saved receipt. Missing receipts, unsupported or over-budget
measurements, or unverified Storage remain held for review; they do not regenerate
or receive an automatic post-dispatch refund. The `image-quotes` role is wired
through the worker launcher, package scripts and supervisor configuration.

These are implementation facts, not hosted acceptance. The migrations remain
local source until separately authorized. Operator catalog/margin approval,
native Supabase Auth/RLS/Storage/scanner/ledger checks, real provider accounting
acceptance and supervised worker operation remain release gates. This review
does not enable purchases or perform provider, payment, migration or deployment
operations.

## Historical implementation stages — superseded by the runtime above

The following records describe the state when each stage was introduced in
September 2026. Statements about absent routes, workers, funding or settlement
apply only to that stage; they are not the current application contract.

### Durable receipt stage

`20260928130000_quoted_image_receipts.sql` adds private write-once receipts
behind a fenced service RPC. It binds provider/model/request identity and
managed image storage metadata to a dispatched funded job. Identical retries
return the same receipt; mismatched overwrites and stale leases fail. Recording
does not settle usage or publish an asset. Worker must upload and verify bytes
before this RPC and reverify them on recovery; SQL receipt storage alone does
not prove the object exists or its bytes match. Incomplete usage is preserved
for review, not accepted as measured billing.

### Lease and release stage

`20260928120000_quoted_image_leases.sql` adds service-only claim/renew/release/
review operations. A live lease cannot be stolen; expired jobs may be reclaimed
before or after dispatch, but a persisted dispatch marker never resets. Expired
or inaccessible/stale-reference undispatched offers cancel and release once.
Uncertain dispatched work is held for review, never refunded as unstarted.
Provider execution, stored image/raw receipt completion and measured settlement
still need implementation before enabling acceptance through HTTP.

### Atomic acceptance stage, before HTTP/worker wiring

Source-only `20260928110000_image_quote_acceptance.sql` implements service-only
atomic acceptance. It validates exact confirmed credits, active editor access,
unexpired matching approved catalog, price/policy/budget/settings equality,
optional book scope and current clean reference versions. One queued quoted job,
funded reservation and acceptance receipt commit together. Accepted retries
return the same job without a new catalog/hold. The legacy reservation trigger
retains organization-locked single-flight across both modes but applies monthly
allowance only to operational jobs. Quoted images cannot record operational
image-credit usage. This supersedes the legacy-trigger gap described below.
No HTTP acceptance route exists yet; purchaseAvailable stays false pending
worker, expiry/release, durable image/provider receipt and settlement completion.

### Price arithmetic stage, before billing-mode separation

Source-only migration `20260928100000_image_quote_price_validation.sql` adds an
independent SQL validator and insert trigger. Every new offer must have exactly
four unique rate/quantity dimensions, valid integer quantities/policy values,
and matching exact-numeric provider maximum and rounded credit reserve. This
validates arithmetic, not owner approval of the selected rates. Acceptance must
still compare the offer to an approved catalog and verify current source/roles.
Legacy `reserve_image_job_credit` applies to all image jobs today; quoted jobs
must be explicitly separated from that operational allowance before funding is
enabled, while retaining the organization-locked single-flight protection.

### Quote recovery and creation stages

For lost save responses, POST `/v1/workspaces/:workspaceId/image-quotes/recover`
with the original `idempotencyKey`. This read-only caller/workspace lookup
returns the saved quote ID even when the current catalog is unavailable or book
context changed. It does not create a replacement offer. Keys are in the body,
not URL logs. Follow with GET for verified quote details and expiry.

POST `/v1/workspaces/:workspaceId/image-quotes` now creates private offers with
explicit `consentToQuoteStorage`, an author retry key and active edit access.
The server constructs the full prompt from scoped saved book/Bible context and
relevant retrieval, and downloads/checks clean reference bytes before pinning
their version/checksum. It saves via the immutable RPC and returns only quoteId.
No provider, funding or generation call occurs. Rebuilt source/settings changes
on retry conflict rather than silently replacing the original offer. Recover
the old offer through GET; request a fresh key for intentional new settings.

### Discovery stage, before creation/acceptance wiring

Authenticated GET `/v1/workspaces/:workspaceId/image-models` now exposes only
public option labels/settings/version IDs from the approved catalog. GET
`/v1/workspaces/:workspaceId/image-quotes/:quoteId` recovers only the caller's
saved offer after active workspace membership and stored hash/price verification.
Responses are private/no-store, omit prompts/references/internal prices, and
explicitly say `purchaseAvailable: false`. No quote creation or acceptance route
is exposed yet. Suspended members cannot save/recover through the snapshot RPC;
active illustrator/designer roles are eligible alongside existing editors.

### Immutable snapshot stage, before funding

Source-only migration `20260928090000_image_quote_snapshots.sql` now stores
private immutable offers through a service-only RPC. It checks workspace write
access, optional book scope, request/quote identities and offer expiry, and
serializes retry keys. Matching retries return the original offer; changed
requests conflict. Clients have no direct table access, service_role cannot
directly insert/update, and no job or credit is created. This is snapshot storage,
NOT a financial acceptance validator: future acceptance must recompute price
arithmetic, source pins and current eligibility before creating a funded hold.
The image adapter now accepts a server-owned pinned model; existing legacy calls
retain their environment default. Browser-supplied models must not be forwarded.

### Initial pure pricing contract stage

`services/api/src/lib/image-pricing.ts` implements a pure, then-unexposed pricing
contract. It does not enable purchases, call OpenAI, reserve credits, enqueue
jobs, or replace the current operational-credit image route.

Catalogs must explicitly be approved, effective and unexpired. Entries bind
one model/size/quality combination to versioned prices and credit policy.
They require four explicit dimensions: text/image input and text/image output.
There are no fallback rates. Bounds are approved maximum token budgets, NOT
exact pre-generation counts or a provider-enforced token cap. If actual usage
exceeds them, settlement returns requires_review rather than overdrawing funds.

The request hash binds book/workspace/user/job, kind, full provider prompt,
size, quality, model and ordered reference asset versions/checksums. Callers
must build it only after authorization and verifying private reference bytes.
No browser-supplied reference digest is trusted merely because it hashes.

Reconciliation requires raw validated provider usage with balanced input,
output and total counters and both modality breakdowns. Unsupported fields
(including cache fields) fail closed pending a reviewed accounting contract.
Do not substitute projected `providerTokenUsage` for the raw receipt when that
would discard unsupported fields; do not fabricate output/cache counters.

## Remaining acceptance gates

1. Verify current provider token/caching semantics and safe budgets for each
   offered image size, quality and reference limit. Owner approves prices.
2. Verify native concurrency for acceptance, funded dispatch, lease loss,
   write-once receipt recovery, measured settlement, release and ledger replay
   against the exact source bundle being adopted.
3. Verify actual Auth/RLS/Storage/scanner behavior, immutable reference bytes,
   provider-account configuration and supported raw accounting measurements.
4. Complete permitted browser author journeys covering lost quote/acceptance
   replies, unavailable recovery storage, workspace/permission changes,
   completion/library refresh and explicit manuscript/cover selection.
5. Verify worker supervision and operators' review/recovery procedure before
   opening the purchase gate. Keep already-dispatched legacy recovery available.

Local tests cover approved-catalog gates, UTF-8 prompt limits, request binding,
reference ordering, settlement arithmetic, malformed usage and over-budget
holds. They do not establish provider budget bounds, hosted adoption or a complete
retail release.
