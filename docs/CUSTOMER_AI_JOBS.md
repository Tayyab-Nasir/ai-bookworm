# Customer-key database authorization

Status: internal database foundation, **not an activated customer-generation
feature**. Local migration `20261024040000_customer_ai_jobs.sql` follows the
credential vault. No live database was changed. No pricing policy, subscription,
entitlement, credential or job is seeded. The user's BYOK fee decision is pending.
Stripe remains deferred; mobile is outside this work.

## Payer boundary

`ai_jobs.billing_mode = customer_key` is distinct from both legacy operational
jobs and managed-provider quoted jobs. Supported agents at this boundary are
writer, proofreader, copyeditor, consistency, metadata and Book Bible. Images,
speech, translation and Story Blueprint are not implicitly enabled by this mode.

The non-public `bookworm_credentials.customer_ai_policies` table holds immutable
operator-reviewed policy versions: provider, exact request/response model names,
output bound, explicit OpenRouter route where applicable, expiration and fee.
Only `enabled` may change in place. Nothing chooses a default model or fee.

Two explicit policy modes are representable, not approved product offerings:

- `platform_plan`: zero per-request Bookworm credit debit. Still requires the
  latest active, unexpired, paid and published platform plan with explicit BYOK
  entitlement and finite monthly request allowance.
- `per_request_credits`: additionally reserves the exact disclosed platform fee
  after consent. This is a **platform fee**, not an invented provider-token cost.

Required plan entitlements are `customer_ai_enabled: true` and a positive finite
`customer_ai_requests_monthly`. A newer canceled/past-due subscription cannot
fall back to an older active one. Pending, uncertain and settled requests consume
capacity; only safe pre-dispatch release frees it. Provider charges remain the
customer's agreement with their provider, never a ChatGPT/Claude subscription
credit inferred from an API key. Unknown provider cost must remain unknown.

## Immutable job authority

Private `customer_ai_jobs` binds job/grant/operation, creator, workspace, book,
organization, saved connection and exact revision, provider, model policy, request
digest, private source snapshot/current document versions, fee and expiry.
The public job contains only grant/digest pointers, not source text or a key.
Operation replay requires identical identity and input; it does not debit again.

Current editable membership, book/workspace relationship, original organization,
paid entitlement, policy and credential revision are checked before dispatch.
Another collaborator, including a workspace owner, cannot borrow the creator's
connection. Replacement does not redirect queued jobs to a newer credential.
Source revisions and request identity are pinned; creation never applies content.

Six service-only RPCs, fixed search paths and explicit private-table revocations:

| RPC | Purpose |
| --- | --- |
| `create_customer_ai_job` | Explicit consent, policy/fee confirmation, capacity and atomic job/fee reservation; exact replay |
| `claim_customer_ai_job` | Lease an undispatched job; expired pre-dispatch leases can be reclaimed within attempt/expiry limits |
| `resolve_customer_ai_dispatch` | One-way exact-revision encrypted-secret resolution and dispatch marker |
| `customer_ai_dispatch_authorized` | Revalidate the exact signed scope, current key/member/plan/policy/source and lease |
| `cancel_customer_ai_job` | Creator-bound pre-dispatch cancellation with one exact platform-fee release |
| `hold_customer_ai_job` | Preserve a dispatched unknown outcome for reconciliation, without refund or redispatch |

The resolver returns an **encrypted envelope**, not plaintext. Only the private
trusted sender may decrypt it transiently and sign the existing short-lived
dispatch contract. The owner/provider/connection/revision binding must be passed
to authenticated decryption. Never expose this RPC through a browser read-back
route or log its result. It is not a repeatable GET: even a lost resolver reply
leaves dispatch recorded and requires reconciliation.

Customer mutations serialize owner/key changes, balance and organization
capacity before job mutation. The ledger independently checks exact fee identity,
amount, permitted state and duplicate reservation/release. Legacy debit rejects
customer jobs before entering its accounting locks. Existing operational workers
do not claim this mode, and legacy retry/completion cannot promote its state.
Two guarded function edits abort the entire migration on unexpected source drift.

## Verification

`tests/security/customer-ai-jobs.test.sql` uses only synthetic data inside a rolled-
back transaction. It exercises private grants, strict five-provider policies,
missing/default-off configuration, paid-plan rules, owner/revision/source binding,
explicit consent, failed-reservation rollback, replay, monthly capacity, separate
fee modes, legacy-debit isolation, leases, cancellation, single-use resolution,
post-dispatch reauthorization and charged/zero-fee unknown-outcome holds.

`tests/security/run-populated-upgrade.mjs` now pins historical migration 45 through
113. It preserves historical rows, proves no inherited customer policy/job/quota,
reuses the new SQL suite, and adds atomic-abort probes for both guarded function
rewrites (seven total drift/legacy-data probes). These targeted local runs passed
2026-10-24. Full frozen-source/build/native evidence belongs in the dated Obsidian
handoff; this document does not claim a hosted or real-provider acceptance result.

## Required before activation

1. Obtain the user's platform-fee choice. Review explicit plan/policy publication
   separately; no test fixture may become a production entitlement.
2. Finish authenticated request preparation, source snapshot construction, exact
   provider-request digest/fingerprint calculation, private sender and worker.
   SQL verifies document identities, not that arbitrary submitted text matches
   canonical content; the authenticated server must build it from authorized data.
3. Implement receipt-bound completion/recovery and proposal insertion. `review`
   is deliberately not automatically released or settled. Never invoke a managed
   OpenAI completion RPC with a customer job or record unknown cost as zero in
   `ai_runs.estimated_cost` (currently non-null). No success RPC exists here yet.
4. Audit live receipt ACLs, durable ambiguous outcomes, multi-connection races and
   cross-worker lock ordering on native PostgreSQL. In-memory serial tests alone
   are not native concurrency acceptance.
5. Finish retention/data-rights reconciliation. Private authority currently
   restricts deleting its canonical job/book/account dependencies, intentionally
   preventing silent loss of unresolved billing records. A reviewed purge/archive
   path and recovery tombstones are required before enabling customer jobs.
6. Separately authorize live migrations/key-ring configuration and bounded real
   provider acceptance. Subscription OAuth requires provider-issued eligibility
   and consent; this database mode does not authorize consumer-plan token reuse.

See [connection plan](AI_CONNECTIONS_PLAN.md), [vault checkpoint](AI_CONNECTION_VAULT_CHECKPOINT.md),
[provider adapters](CUSTOMER_PROVIDER_ADAPTERS.md) and
[signed dispatch](CUSTOMER_DISPATCH_CHECKPOINT.md).
