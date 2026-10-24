# Customer-key canonical source preparation

Implemented locally on 2026-10-24. This is an **unregistered, default-off internal
component**, not an enabled BYOK or subscription feature. It makes no provider
request, resolves no credential, creates no job, reserves no credits and does
not calculate a provider charge. A successful hash is not spending authority.

## Source and identity

`services/api/src/lib/customer-ai-source.ts` loads explicit chapter IDs, current
document-version IDs, version numbers and optional whole-node IDs using only the
authenticated user's RLS client. It verifies the user and active writing role
before loading, then rechecks identity, membership, book metadata and current
chapter pointers before returning. It never substitutes the highest numbered
version or a retrieval excerpt for the selected saved document.

Canonical text comes from `bookNodesPlainText`, the same full-node text contract
checked independently by receipt completion. Each selected node includes its
exact UTF-8 SHA-256 and version provenance. Editing agents receive only nodes
whose original text field equals the canonical text; saved empty text remains a
valid writer target. Metadata and Book Bible extraction can cite canonical table
cells and image captions. Rich attributes, assets, alt text, private book fields
and transient access tokens are not included in manuscript targets.

Style guide and approved Book Bible context are opt-in. Bible image associations
are omitted; citations are retained only when bound to the selected canonical
nodes. This is a captured context snapshot, not an atomic database snapshot of
every ancillary metadata row. Future job creation must recheck source versions
and authority transactionally. The caller receives a detached frozen object.

## Exact private preparation

`customer-ai-prepare.ts` sends the canonical snapshot to an explicitly configured
private service root. HTTPS is required except for explicitly allowed loopback
development. No browser-selected URL, URL credentials, redirect, provider key,
automatic retry or environment-provider fallback is accepted. Source loading
has a 30-second deadline; the entire operation has a 60-second deadline. Response
streaming is capped at 16 KiB, independent of Content-Length.

`services/ai/customer_prepare_http.py` provides an **unmounted** router factory
for `POST /v1/internal/customer-text/prepare`. It requires a dedicated service
token, strict JSON and a bounded envelope. It constructs the actual agent prompt,
tools and provider wire through the same function used by signed dispatch. It
returns only provider/agent/model identity, effective output cap, exact input
digest, provider-request digest and the count of omitted optional references.
Errors do not echo source or upstream validation values.

All nested source objects are key-sorted before becoming prompt strings. Array
order stays unchanged. This matters because PostgreSQL JSONB may reorder object
fields between preparation and execution. The signed envelope still hashes the
exact UTF-8 input bytes it transports; the provider hash binds the deterministic
prompt, tools, provider destination and response allowlists. Synthetic
TypeScript-to-Python and five-provider/six-agent tests check this distinction.

## Explicit limits and unfinished integration

- At most 100 chapters and 200 eligible whole nodes per request; source JSON at
  most 400,000 UTF-8 bytes, with an additional escaped-envelope sizing bound.
- Book Bible context over 100 entries fails explicitly. The agent reports any
  optional reference entries excluded by its context budget. Editable targets
  are never shortened to fit.
- Related retrieval is explicitly rejected for this new path until reference-
  only passages have their own canonical provenance contract. Existing managed
  retrieval is unchanged. Whole-book batching and long-node slicing still need
  implementation and acceptance; this component does not claim full-book review.
- Only the six supported text agents are prepared. Images, audio, translation
  and other capabilities need their own payer/credential integration; this does
  not enable them through every provider.
- Next: authenticated public preparation/job routes and policy selection,
  confirmation/fee UX, the database-backed Python scope authorizer, receipt
  retention and queue registration. Use the existing payer-bound transactional
  job functions and exact-receipt recovery, not a second authorization system.
- No pricing policy seeded or activated. The user's BYOK platform-fee decision
  remains open. Provider cost is unknown until separately established, not $0.
- No migration is added here. Local schema remains 115 migrations; local tests
  do not prove the live project's installation or production permissions.
- No commercial subscription approval, account connection or paid-provider
  acceptance is implied. The reviewed provider distinctions remain in
  [AI_CONNECTIONS_PLAN.md](AI_CONNECTIONS_PLAN.md).

Stripe and mobile remain parked. The full publishing OS is still in progress.
Exact frozen-tree test/build evidence, GitHub status and next steps belong in
the shared Obsidian note `2026-10-24-customer-key-preparation.md`.
