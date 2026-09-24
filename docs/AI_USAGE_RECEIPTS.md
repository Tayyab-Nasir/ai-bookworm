# AI service usage receipt contract

The Python OpenAI gateway emits aggregate `inputTokens`, `outputTokens` and
`estimatedCostUsd`, plus optional `measuredTokens` containing non-overlapping
`text_input`, `text_cached_input` and `text_output` decimal-string counts.
The input aggregate includes cached input. Optional latency is milliseconds.

The metadata, Book Bible and leased manuscript-review consumers now share
`services/api/src/lib/ai-usage.ts`. Previously their strict schemas rejected
the measured field, so a valid OpenAI completion could remain held even while
mock-only tests passed. The new schema preserves that field for durable usage
audit and verifies unique dimensions and exact agreement with the aggregates.
Invalid counts, unknown fields, duplicate dimensions, excessive integer
values, nonfinite costs and missing aggregate usage fail validation.

The gateway no longer manufactures a measured zero receipt when usage is
absent. Missing/invalid aggregate counts and inconsistent cached counts raise
an unknown-outcome error after the provider call; durable requests remain
unresolved rather than being automatically generated again. Absent cached
detail leaves measured dimensions unavailable, not assumed zero. Valid legacy
aggregate-only receipts remain readable for operational-unit workflows.

This is a receipt compatibility/control fix, not an approved token-to-retail
credit policy. Existing operational meters remain operational units. Exact
quoted billing still requires measured dimensions, a provider request ID,
server-owned approved price snapshots and funded settlement. Estimated USD
is not a provider invoice. No rates/models were changed in this checkpoint.

Regression evidence uses a synthetic Responses-shaped gateway result and
production-shaped receipts at metadata, Book Bible and manuscript-review
boundaries. Invalid review receipts remain held, and the original request is
not regenerated. No OpenAI call or live customer charge is made by these tests.

Full local `npm run verify` passes: workspace typechecks, API/unit and 103 web
tests, 80 migrations/57 SQL suites, 381 services, 12 E2E, 30 security, load
without 5xx and six deterministic AI evals. Live provider eval was skipped
because no key was set. Hosted/provider acceptance remains unverified.
