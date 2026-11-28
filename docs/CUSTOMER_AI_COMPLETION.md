# Customer-key result completion

Status: internal, default-off database implementation. Migration
`20261024050000_customer_ai_completion.sql` follows customer-key authorization.
No live migration, worker activation, model/fee policy publication, provider call,
payment or deployment is part of this change. Stripe is deferred; mobile is parked.

## Receipt-only recovery

`complete_customer_ai_job(jobId, ownerId, receiptFingerprint)` is service-only,
security-definer and has a fixed search path. It takes no caller-supplied output,
usage estimate, credential, lease replacement or billable quantity. It reads the
immutable saved result from `ai_review_service_receipts` and the private authority.
Owner, job, workspace, book, agent, provider, approved response model, dispatch
fingerprint, response identity and measured token counters must match. A missing,
reserved-only, malformed or mismatched receipt cannot complete the job.

Completion and replay serialize with the original owner and organization locks.
The single transaction saves proposals, usage evidence and a succeeded job while
settling its private hold. An exact repeated request returns the same job without
additional proposals, fee debits, usage events or provider work. A failed write
rolls the whole completion back; the original saved receipt remains recoverable.
Late outcome-hold messages cannot turn a completed job back into an uncertain one.

A result can finish from the original dispatched running state or its explicit
outcome-review state. Recovery of already-produced evidence does not need another
provider call, unexpired generation lease, active key, current plan or enabled
policy. It does require the original immutable dispatch and receipt. The future
HTTP entry point must separately authenticate the current actor and enforce book
access; possession of a job ID is not public recovery permission.

## Reviewable output, never automatic application

- Writer, proofreader, copyeditor and consistency results become pending
  `ai_suggestions`. Only `replace_text` operations survive normalization; IDs,
  source flags and expected versions are generated from trusted state. Ranges
  obey the agent's span limit, the saved node length and UTF-16 boundaries.
- Metadata saves one pending candidate in the existing `output_ref.candidate`
  shape. Book Bible saves at most ten pending candidates under `candidates`.
  Candidate limits, reserved attribute names and full chapter/version/node/hash
  provenance are checked before saving. Neither metadata nor canon is overwritten.
- Provenance is checked against the immutable historical document version and
  the dispatched snapshot text, not the latest manuscript pointer. Forged text
  with plausible version IDs is rejected. This first implementation requires
  complete node text and full provenance for candidate citations; sliced-node
  contexts need an explicitly reviewed range contract before support.
- If the manuscript has advanced, pending edit proposals retain the old expected
  version. The existing apply workflow must reject stale proposals; recovery
  itself never changes manuscript content, current version, metadata or Book Bible.

## Honest payer and usage evidence

`ai_runs.cost_payer` defaults to `platform`, preserving every historical cost and
counter. Customer runs explicitly use `customer`, require a customer job, and
store `estimated_cost = NULL`. Platform rows still require a non-null cost. The
shared `AiRun` type makes that distinction explicit. Unknown is not free, and
customer usage must not be priced using managed OpenAI rates.

Observed provider counters are validated separately for OpenAI, Anthropic,
Google, OpenRouter and xAI, including caching/reasoning splits and total bounds.
The response's actual allowed model is recorded on the run; the canonical job's
requested model stays immutable. A `customer_ai_request` usage event records
the customer payer, unknown cost, observed usage and already-reserved platform
fee. Completion creates no `ai_credits` event and changes no credit ledger entry.
The user's fee decision is still pending; no policy or entitlement is seeded.

Completed customer jobs and their run evidence cannot be rewritten. The receipt
table explicitly revokes service DELETE/TRUNCATE privileges; customer receipt
deletion also has a trigger fence. This is not a finished retention system:
reviewed archive/purge/tombstone behavior is still required before activation.

## Verification and remaining work

`tests/security/customer-ai-completion.test.sql` exercises all five providers
across all six text agents, receipt and scope mismatch, null/zero/invalid usage,
unsupported edits, astral Unicode boundaries, forged source text, full citations,
proposal-only persistence, exact replay, actual service-role access, failure
rollback, immutable outcomes and recovery after revocation/expiry/new revisions.
The populated 45-to-114 upgrade reuses those probes and proves historical
nonzero costs are preserved rather than recast as customer usage.

`tests/security/native-customer-ai-completion.mjs` is wired into the dedicated
disposable native runner. It requires actual PostgreSQL lock waits for competing
completion commit/rollback, hold-before-completion, key-revocation-before-recovery
and a late hold losing to completion. Check the exact commit's CI result before
claiming those schedules passed. Local serial PGlite is not native concurrency.

Next: authenticated preparation and sender, exact TS/Python digest parity,
default-off worker/recovery routing and frontend payer/state display; broader
queue/capacity/cross-worker race acceptance; reviewed data-rights retention;
operator fee/key-ring configuration; separately authorized live migrations and
bounded real-provider acceptance. Existing subscription reuse needs its own
official provider eligibility and consent, not this API-key path.
