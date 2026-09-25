# Metadata token quotes

## Implemented preparation

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

## Not yet connected to author purchases

This is a preparation module, not a customer purchase workflow. It is not yet
called by `metadata-generation.ts` or `BookMemoryClient.tsx`. There is no saved
quote proposal, author-facing total/acceptance, atomic acceptance RPC, funded
worker lease, pre-dispatch source revalidation, usage settlement or user
recovery flow for metadata. Do not display or accept this prepared quote as a
billable offer until those steps are implemented together.

The existing `/metadata/generate` route still spends one operational AI credit
and directly calls the synchronous AI service. It must remain clearly separate
from this helper until the new durable path is complete; do not send it a
`expectedCredits` value and assume that creates authorization. Retail pricing
approval is an owner decision; the code only accepts dated, approved server
catalog configuration and seeds no price.

## Next steps

1. Add source-only quote-request/proposal SQL with strict immutability,
   caller-scoped reads, rate limits, idempotency and atomic expected-credit
   acceptance that creates the metadata job and funded hold together. Ensure
   existing operational metadata reservation triggers cannot double-reserve.
2. Add API quote, status/recovery and acceptance routes. Load book/chapter,
   current document versions, style and approved Book Bible under caller RLS;
   snapshot precisely the same bounded context that is sent to the token
   counter. Recheck every version at quote acceptance and again before dispatch.
3. Add a leased metadata worker. Verify the stored request hash/model before
   claiming irreversible dispatch, send that hash to `/v1/ai/jobs`, persist a
   private result receipt, validate source citations, and atomically settle
   measured provider usage. Uncertain or incomplete receipts stay held for
   read-only recovery/review, never a second generation.
4. Connect `BookMemoryClient` to model selection, explicit provider-counting
   consent, quoted credit total, acceptance, pending progress and recovery.
   Keep candidate content review-only and require the author's existing
   explicit Save before updating publishing metadata.
5. Verify source-only SQL, API routes, worker idempotency/races, web UI and
   native local-browser recovery before considering an owner-approved hosted
   catalog or production offer.
