# Paid author generation checkpoint — 2026-10-05

This checkpoint connects the paid author workflow for manuscript drafting and
review, Book Bible extraction, metadata and illustration/cover generation.
It is not a market-ready release or authorization to activate purchases.

## Author workflow

Authors can upload a manuscript or create an empty saved chapter, optionally
prefill a drafting brief from a saved Story Blueprint, and explicitly consent
to provider token counting. They review an expiring server-owned quote and
confirm its exact maximum credits separately from generation. Acceptance saves
one funded job and hold. The worker validates the saved request, source,
membership, model and lease before the one-way provider dispatch marker.

Measured provider usage settles the saved price/policy and releases surplus
credit. Missing or inconsistent measurements and ambiguous provider outcomes
remain held for operator review, never automatically regenerated or refunded.
Image completion verifies private stored PNG bytes against the immutable
receipt before creating the asset and accounting result atomically.

Lost offer/acceptance/completion replies recover the original request or saved
job. Browser pointers retain IDs/settings/digests, not manuscript text or
private prompts. Storage failures block paid actions. Late callbacks cannot
attach one book's plan, candidate or consent state to another book. A quoted
drafting instruction remains locked while that immutable offer is unresolved.

Review edits remain suggestions until explicit Apply creates a new document
version. Bible candidates remain outside canonical memory until explicit
author review/save. Metadata requires explicit Use and Save; generated text
never silently replaces unsaved fields. Generated artwork returns to the
asset library and the separate exact-version artwork approval/placement flow.

## Boundaries

Legacy unquoted generation endpoints are retired by default. Approved dated
catalogs, configured providers and purchase gates remain separate operator
requirements; no live offers or complimentary generation are configured.
Audio's operational allowance and estimated speech cost are not equivalent to
an approved retail token quote. Its provider/usage/pronunciation/mastering and
retailer acceptance remain separate release work.

The additive quote migrations are source-only until a separately reviewed
hosted rollout. Raw Python HTTP request hashes and prepared provider-input
hashes represent different objects and must not be equated. Private raw
receipts are immutable; Bible completion additionally binds exact raw result,
candidate/citation data and current lease to independently checked settlement.

## Verification scope

The current shared-tree `npm run verify` completed with exit 0: workspace
types, launcher/unit checks, 475 API tests, 148 web tests, 99 disposable
migrations/67 SQL suites, eight paid serial fixture gates, 419 Python service
tests, 12 Python E2E tests, 30 security tests, no-5xx 50-request load smoke and
six deterministic eval cases. Live provider evals were skipped without a key.
The client status-type alignment and documentation updates were made after
that run; isolated staged checks must verify the final adopted source.

The separate mounted React harness passes 19/19 against intercepted local
responses, without a Next server or external requests. Scoped text-worker
checks pass 37/37 and image-worker checks 12/12. They cover recovery and lease
boundaries, not full production Next rendering or actual provider delivery.
The native runner defines 56 paid quote schedules requiring observed
PostgreSQL Lock waits: 28 billing primitives, eight image, four metadata,
eight AI-review and eight Bible receipt/lease/completion orderings. At this
document's initial creation those schedules are not yet natively executed.

### Completed isolated and native acceptance

The final adopted source at `bdd52c40911ded90e38a9522fa7bcf74c5336ef5`
passed an isolated production build (22 static pages), full verification
(463 API, 144 web, 97 migrations/65 SQL suites, eight serial paid fixture
gates, 417 services, 12 E2E, 30 security, types/unit/launcher/load/mock evals)
and all 19 mounted component checks. All 113 staged file blobs matched that
isolated snapshot; unrelated shared analytics/admin/audio/config/graph work
was not adopted. No configured lint script exists.

Native PostgreSQL 16.15 run
[37255633569](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/37255633569),
job `111591974399`, completed successfully on that exact commit. Decoded logs
confirm 97 migrations, 65 SQL suites, all 56 unique expected paid schedules
and all 108 unique expected artwork schedules, with no missing or extra
schedule names. Worker-runtime run
[37255633541](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/37255633541)
also passed launcher tests and systemd template validation without starting
services. This supersedes only the initial unexecuted-native status above.

These are actual database lock/commit/rollback checks, but the provider
receipts and claims are synthetic. Hosted Auth/PostgREST/Storage, real OpenAI
delivery/cost/quality, supervised worker-loop recovery, production catalogs
and complete author/retailer acceptance remain separate release gates.

Before release, verify the coherent isolated source/build and inspect actual
native CI logs. Then accept hosted Auth/Storage/scanning, provider cost/quality,
supervised worker recovery, approved commercial rates, complete author/export
journeys, audio and retailer release gates. Serial fixtures, generated graphs
and prior green artwork CI cannot replace those checks.

Navigation: [Worker runtime](WORKER_RUNTIME.md), [Pricing controls](PRICING_AND_PLAN_RELEASE.md),
[Metadata quotes](METADATA_TOKEN_QUOTES.md), [Image quotes](IMAGE_TOKEN_QUOTES.md),
[Text preparation](TEXT_QUOTE_PREPARATION.md), [Bible evidence](BOOK_BIBLE_EVIDENCE.md).
Shared continuation: `C:/Users/Asus/Memory-Ai/Codex Sessions/2026-08/2026-08-31-ai-bookworm-codex-handoff.md`.
