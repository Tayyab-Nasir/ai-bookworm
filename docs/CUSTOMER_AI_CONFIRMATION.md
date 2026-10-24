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
3. The author reviews provider/model, output ceiling, chapter count, omitted
   context and the exact platform fee. Provider charges remain separately
   billed and unknown, not zero. `confirm` requires `consent: true` and the
   exact fee. New job creation rechecks source, key revision, access and policy.
4. Confirmation atomically creates the existing payer-bound customer job and
   fee reservation once. A replay returns the same job, including an already
   completed/cancelled result; it cannot resurrect or double-charge it.
5. Persist only the owner-bound opaque operation ID in browser recovery state
   before starting a mutation. On a lost response, ask `status`; do not issue
   a new operation or fall back to platform funding. `cancel` closes a prepared
   request or invokes pre-dispatch cancellation. A missing record is not proof
   an in-flight write was cancelled.
6. `recover` consumes an already-saved exact provider receipt. No source
   re-preparation, key resolution, provider call, automatic retry or refund.
   An absent/incomplete receipt returns conflict and remains unresolved.
   Valid completion creates pending proposals, never automatic manuscript edits.

## HTTP boundary

All six POST routes are under `/v1/account/customer-ai/`:

| Route | Body |
| --- | --- |
| `options` | `workspaceId`, `bookId`, `connectionId`, `credentialRevision`, `provider`, `agentType` |
| `prepare` | `operationId`, the above `selection`, `policyId`, strict canonical `source` selector |
| `confirm` | `operationId`, `expectedPlatformFeeCredits`, literal `consent: true` |
| `status`, `cancel`, `recover` | `operationId` only |

Every route requires a verified Supabase bearer and matching
`x-bookworm-actor`. Unknown body properties and query strings are rejected;
body limit is 128 KiB. RPC ownership derives only from the verified actor.
The database owns durable idempotency, not the process-local request Map.
Request URLs, parsing failures and error IDs use the sensitive-request log
shield; replies use private/no-store/no-cache headers. Raw provider/database
errors, manuscript snapshots, hashes, grants and credentials are not returned.

`buildApp` takes an explicit `customerAiPreparation` dependency. Without it,
`options`/`prepare`/`confirm` return 503. Status/cancel/receipt-only recovery are
still registered, so removing configuration or revoking a key does not strand
saved outcomes. Current book membership remains required. These routes do not
schedule or launch the customer worker; queued jobs require explicit wiring.

## Database guarantees and limits

- Private table, RLS enabled, no direct service-role/browser table grants.
  Only the three pinned public service-role functions expose metadata/actions.
- Owner advisory lock serializes preparation, job, vault and fee lifecycle.
  Exact retry identity is immutable. No unreviewed deletion/retention path.
- Preparation expires in at most 15 minutes or at policy expiry, whichever is
  earlier. Closed/expired operations cannot become fresh requests on replay.
- Per-owner preparation cap: ten per minute and fifty per hour, including
  closed records. Retention/purge policy is still a required operational task.
- Canonical manuscript contents come from the existing authenticated loader.
  SQL rechecks version identity; it does not independently hash arbitrary
  service-supplied model prompts. Receipt completion verifies saved provenance.
- This does not authorize free platform usage, substitute a coworker's key,
  or enable consumer subscription pass-through. Fee approval remains pending.

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
after revocation without applying a manuscript change. The populated 45-to-116
rehearsal reruns these probes and compares existing historical projections.

Local WASM PostgreSQL is not native concurrent/PostgREST/GoTrue acceptance.
Production activation still needs operator-approved pricing and paid access,
reviewed live DDL, managed encryption/service configuration, worker/queue
composition, an author-facing review/recovery UI, native race checks and
separately authorized bounded provider tests. Related-source provenance,
whole-book batching, customer-key media and account-data retention are not
implemented by this change. Stripe/mobile remain deferred.

Related: [connection plan](AI_CONNECTIONS_PLAN.md),
[source preparation](CUSTOMER_AI_PREPARATION.md),
[worker](CUSTOMER_AI_WORKER.md), [database transport](CUSTOMER_AI_DATABASE.md).
