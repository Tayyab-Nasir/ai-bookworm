# Signed customer-key dispatch handoff

2026-10-24. Internal integration component, **not activated BYOK generation or
subscription OAuth**. Complements the vault and five-provider text adapters.
Stripe is deferred; mobile is parked. No new migration, live provider call,
deployment or customer charge is part of this checkpoint.

## Implemented boundary

- `services/api/src/lib/customer-ai-dispatch.ts` signs exact UTF-8 bytes using an
  explicit, dedicated 256-bit HMAC key and key ID. The customer credential binding
  must match owner, provider, connection and revision. The grant also binds job,
  workspace, book, lease, agent, reviewed model/response-model/upstream policy,
  output bound, exact provider-request digest and the source/context snapshot.
- The secret-bearing envelope expires after 60 seconds. It is not a JWT, browser
  token, saved job payload or encrypted object: **base64 is not encryption**.
  The wrapper redacts ordinary inspection/JSON and releases its body once only.
  Callers must use authenticated TLS (explicit loopback for local development),
  never log/persist the wire body, clear their buffers, and never retry after an
  uncertain send. No production sender or default environment key was introduced.
- `services/ai/customer_dispatch.py` verifies HMAC before parsing the inner JSON;
  strict fields/UUIDs/types, duplicate-key rejection, bounded depth/size and
  freshness checks precede receipt/provider work. Errors do not quote input.
  It reconstructs the actual Bookworm agent prompt/tools, verifies the exact
  provider digest, then uses the single-use customer provider. No platform-key
  fallback or document edits; outputs remain pending review proposals.
- The shared customer text namespace uses existing private
  `ai_review_service_receipts` storage, regardless of the text agent. Reservation
  is atomic on job ID, request identity is immutable and saved results cannot be
  overwritten by service-role updates. Before activation, audit effective live
  ACLs (including inherited/default grants); do not assume the migration's
  explicit SELECT/INSERT/UPDATE grant revokes existing DELETE privileges.
  Fingerprints include grant, original
  lease, source and all nonsecret authority fields; they never include a key or
  reusable key hash. Envelope timestamps/signing-key rotation do not change the
  underlying job identity. A changed credential revision cannot replace old work.
- Receipt reservation happens before any provider send. Process/cache loss,
  simultaneous submits and fresh signed replays cannot produce a second call.
  Pending reservations, unknown provider outcomes and uncertain receipt writes
  remain held for review. A saved, scope-checked receipt can be returned without
  generation. Provider cost remains unknown (`null`), not zero or an invented
  managed-OpenAI price. Request IDs and response IDs retain adapter semantics.
- `customer_dispatch_http.py` supplies an **unregistered** private router factory.
  In addition to service auth/signatures, it requires an explicit database
  authorizer dependency. With no authorizer it fails closed. No environment flag
  mounts it in `main.py`. Body reads are bounded to 1 MiB and 15 seconds; inner
  signed payloads to 512 KiB; no framework validation echo of secret inputs.
  Authenticated worker calls alone must not be mistaken for user consent.

## Acceptance scope

Deterministic tests cover all five adapters through real agents, durable SQLite
test-store restarts/concurrent claims, the actual Supabase receipt adapter with
synthetic responses, and TypeScript-issued envelopes consumed by Python through
real agent/provider parsing and receipt replay. HTTP tests use an isolated app
with a test authorizer and synthetic HTTP, **not** the running Bookworm service.
SQLite is test infrastructure, not a production storage fallback. Existing SQL
receipt constraints are verified by the repository's migration/security suites.

Full frozen-source verification/build results, exact tree/commit, and any CI
boundaries are recorded in the shared Obsidian session note. A local test does
not prove live provider compatibility, commercial eligibility or paid acceptance.
Python/JavaScript strings cannot be reliably zeroed; no claim of secure erasure.

## Required before activation

1. Select the BYOK platform fee/entitlement policy with the owner. Provider API
   charges and Bookworm service fees are distinct. Do not bypass current paid
   gates or silently charge managed generation credits again.
2. Implement the database payer-bound customer quote/job lifecycle. Existing
   `operational`/`quoted` contracts and settlement require managed OpenAI; changing
   just the provider field is invalid. Audit reservation, lease, monthly-limit,
   receipt recovery, cancellation and billing-mode triggers together.
3. Implement the narrow, atomic resolver/dispatch authorization against saved
   actor membership, job creator, payer consent, current lease, exact connection
   revision and revocation status. No collaborator inherits another user's key.
   Lock/check/create one-way claims before issuing the transient signed handoff.
   This repository currently has **no such resolver or database authorizer**.
4. Integrate the worker, dedicated signing-key rotation, authenticated transport
   and receipt-only recovery. Fresh replay authorization must preserve the
   original immutable grant/lease while consulting current persisted state; do
   not create a new grant to bypass an unresolved reservation. Exclude managed
   jobs from this path. The signature proves the issuer, not database permissions.
5. Text review/metadata/Book Bible are this component's allowed agents. Story
   Blueprint, translations, images and speech require their own payer/receipt
   integration and capability tests; they are not enabled by this router.
6. Obtain separate authority for live vault migration/configuration and bounded
   real provider tests. Existing US$5 total cap and US$2.50 unconfirmed holds are
   unchanged, not a new allowance or assertion of actual charges. Keep exposed
   keys out of notes/Git and rotate them before production.

Official subscription connectors remain a separate eligibility/OAuth project;
see `AI_CONNECTIONS_PLAN.md`. Never use Codex/Claude CLI sessions, chat cookies,
passwords or consumer-plan keys as an unofficial subscription proxy.
