# Pricing and plan release controls

AI Bookworm does not include complimentary AI, image, translation, or audio
generation. Account creation may be available without charge, but every
provider-backed generation must have prepaid credit or an explicitly funded
plan allowance before the provider call starts.

## Publication gate

`plans.is_active` is the commercial publication switch. New plan rows are
inactive by default. The public plans API and database policy expose only
active rows, and checkout independently refuses inactive and zero-price rows.

Do not activate a paid plan until all of the following are complete:

1. The owner approves the retail price, included usage, target gross margin,
   overage behavior, taxes, refunds, and regional availability.
2. A matching Stripe Price exists and its ID is present in
   `STRIPE_PRICE_IDS_JSON` for the same database plan ID.
3. Worst-case provider costs have been modelled for text input/output, image
   input/output, speech output, retries, moderation, storage, and platform fees.
4. Credit reservation and final usage reconciliation are tested for every
   provider-backed workflow included by the plan.
5. Checkout and webhook acceptance tests pass in Stripe test mode.

The seeded Pro and Team values are planning placeholders and remain inactive.
They are not approved commercial offers.

## Credit accounting direction

Local migration `20260919050000_metadata_credit_reservations.sql` adds a
database-side hold for the existing one-unit metadata operation before provider
execution. It counts pending metadata requests across organization workspaces.
This is not a versioned token-to-customer-credit policy and is not installed live
by the build. Other text-generation paths sharing ai_credits must participate in
the same reservation model before paid launch; do not interpret this component
check as full billing readiness.

The existing `ai_credits`, `image_credits`, `audio_credits`, and
`translation_credits` meters are operational units, not provider tokens. Audio
and translation each reserve one credit per started 1,000 source characters in
their version-pinned job. Before paid launch,
define a versioned conversion table from
provider usage and model price snapshots into customer credits. Reserve a
conservative maximum before dispatch, reconcile against the provider receipt
after success, and release unused credit. Never rely on a front-end balance
check as the spending boundary.

Provider pricing changes over time. Store the model, price version, measured
usage, provider cost estimate, customer debit, job ID, and idempotency key with
each completed billable job so historical margins remain auditable.

The Speech endpoint returns audio bytes without an inline token receipt. The
worker therefore labels its cost as an estimate based on a versioned word-rate
method; reconcile exact speech spend through OpenAI organization usage before
margin reporting or customer invoicing. Do not present the estimate as a
provider invoice.
