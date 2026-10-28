# Customer-owned AI: durable preparation and confirmation

Status: implementation and local synthetic acceptance; not a production
activation. Local migration 116, `20261024070000_customer_ai_preparations.sql`,
adds private immutable preparations and service-only lifecycle RPCs. No price,
plan entitlement, credentials, worker launcher or subscription access is seeded.

## Author workflow contract

1. Select the author's own saved connection revision, approved model policy,
   agent and current saved chapters/whole nodes. `options` requires current
   writer-level access and an eligible paid platform plan.
2. `prepare` uses the authenticated source loader and private deterministic
   prompt preparation. The browser supplies source identifiers, not manuscript
   text or provider credentials. Persist the exact snapshot/digest and policy
   before returning the review receipt. This step creates no job or fee.
3. The author reviews provider/model/upstream, output ceiling, exact chapter
   revision UUIDs and version numbers, omitted
   context and the exact platform fee. Provider charges remain separately
   billed and unknown, not zero. `confirm` requires `consent: true` and the
   exact fee. New job creation rechecks source, key revision, access and policy.
4. Confirmation atomically creates the existing payer-bound customer job once.
   The approved public mode is paid-plan inclusion with zero Bookworm credits;
   no credit reservation is made. A replay returns the same job, including an already
   completed/cancelled result; it cannot resurrect or double-charge it.
5. Persist only the owner-bound opaque operation ID in browser recovery state
   before starting a mutation. On a lost response, ask `status`; do not issue
   a new operation or fall back to platform funding. `cancel` closes a prepared
   request or invokes pre-dispatch cancellation. A missing record is not proof
   an in-flight write was cancelled. Migration117 adds `close` with the book ID:
   it either uses existing safe cancellation or records a durable private
   tombstone that rejects an arriving preparation under the same owner lock.
6. `recover` consumes an already-saved exact provider receipt. No source
   re-preparation, key resolution, provider call, automatic retry or refund.
   An absent/incomplete receipt returns conflict and remains unresolved.
   Valid completion creates pending proposals, never automatic manuscript edits.

## HTTP boundary

All seven POST routes are under `/v1/account/customer-ai/`:

| Route | Body |
| --- | --- |
| `options` | `workspaceId`, `bookId`, `connectionId`, `credentialRevision`, `provider`, `agentType` |
| `prepare` | `operationId`, the above `selection`, `policyId`, strict canonical `source` selector |
| `confirm` | `operationId`, literal `expectedPlatformFeeCredits: 0`, literal `consent: true` |
| `status`, `cancel`, `recover` | `operationId` only |
| `close` | `operationId`, `bookId` |

Every route requires a verified Supabase bearer and matching
`x-bookworm-actor`. Unknown body properties and query strings are rejected;
body limit is 128 KiB. RPC ownership derives only from the verified actor.
The database owns durable idempotency, not the process-local request Map.
Request URLs, parsing failures and error IDs use the sensitive-request log
shield; replies use private/no-store/no-cache headers. Raw provider/database
errors, manuscript snapshots, hashes, grants and credentials are not returned.

`buildApp` takes an explicit `customerAiPreparation` dependency. Without it,
`options`/`prepare`/`confirm` return 503. Status/cancel/close/receipt-only recovery are
still registered, so removing configuration or revoking a key does not strand
saved outcomes. Current book membership remains required. These routes do not
schedule or launch the customer worker; queued jobs require explicit wiring.

## Database guarantees and limits

- Private table, RLS enabled, no direct service-role/browser table grants.
  Only the four pinned public service-role functions expose metadata/actions.
- Owner advisory lock serializes preparation, job, vault and fee lifecycle.
  Exact retry identity is immutable. No unreviewed deletion/retention path.
- Preparation expires in at most 15 minutes or at policy expiry, whichever is
  earlier. Closed/expired operations cannot become fresh requests on replay.
- Per-owner preparation cap: ten per minute and fifty per hour, including
  closed records. Retention/purge policy is still a required operational task.
- Unknown-operation closure has its own ten/minute and fifty/hour owner cap.
  Existing replay/cancellation bypass that cap so it cannot strand recovery.
  `closed_before_prepare` carries only operation/book IDs; it never invents a
  policy, source or job. Status still requires current book membership.
- Canonical manuscript contents come from the existing authenticated loader.
  SQL rechecks version identity; it does not independently hash arbitrary
  service-supplied model prompts. Receipt completion verifies saved provenance.
- On 2026-10-24 the owner selected paid-plan inclusion, with no additional
  Bookworm service credits per customer-funded request. Only zero-credit
  `platform_plan` policies are offered or preparable through the public API.
  Old credit-fee receipts remain readable/cancellable/recoverable; they cannot
  be newly confirmed through this API. Current paid access and request
  allowance remain mandatory; no coworker's key or consumer session is borrowed.

## Evidence and remaining integration

`services/api/src/customer-ai.test.ts` covers the real Fastify registration,
canonical loader/private preparation composition, all five provider/six-agent
selections, lost replies/restart, durable retry headers, actor/field validation,
source/catalog changes, neutral errors, no-cache handling and metadata binding.
Its in-memory database fake proves transport behavior, not SQL authorization.

`tests/security/customer-ai-preparations.test.sql` executes real PostgreSQL
functions against rolled-back synthetic fixtures: exact replay/consent,
single job/reservation/release, stale sources/keys/access, expiry, immutability,
private ACLs, no generation on preparation, rate gates and receipt-only recovery
after revocation without applying a manuscript change. The populated 45-to-117
rehearsal reruns these probes and compares existing historical projections.

Local WASM PostgreSQL is not native concurrent/PostgREST/GoTrue acceptance.
Production activation still needs published plan prices/allowances and paid access,
reviewed live DDL, managed encryption/service configuration, worker/queue
composition, native race acceptance and
separately authorized bounded provider tests. Related-source provenance,
whole-book batching, customer-key media and account-data retention are not
implemented by this change. Stripe/mobile remain deferred.

The author interface and typed client are now implemented in
[customer AI author workflow](CUSTOMER_AI_AUTHOR_WORKFLOW.md), with strict
source/policy binding, explicit consent and opaque tab recovery. Dedicated
two-session native preparation/closure/confirmation races are registered in
`tests/security/native-customer-ai-preparations.mjs`; consult the shared session
note for actual terminal evidence instead of assuming that registration passed.

Related: [connection plan](AI_CONNECTIONS_PLAN.md),
[source preparation](CUSTOMER_AI_PREPARATION.md),
[worker](CUSTOMER_AI_WORKER.md), [database transport](CUSTOMER_AI_DATABASE.md).
