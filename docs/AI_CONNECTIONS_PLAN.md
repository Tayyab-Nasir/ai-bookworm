# Customer-owned AI connections

Status: encrypted credential storage/settings are implemented; acceptance and
activation are tracked in `docs/AI_CONNECTION_VAULT_CHECKPOINT.md`. The explicit
five-provider text adapter layer is documented in
`docs/CUSTOMER_PROVIDER_ADAPTERS.md`; the signed internal dispatch/receipt seam is
documented in `docs/CUSTOMER_DISPATCH_CHECKPOINT.md`. The local database payer,
fee reservation, exact-revision resolver and uncertain-outcome foundation is in
`docs/CUSTOMER_AI_JOBS.md`; receipt-only completion and pending proposal storage
are in `docs/CUSTOMER_AI_COMPLETION.md`. The default-off private worker factory,
non-secret context accessor and receipt-only recovery are in
`docs/CUSTOMER_AI_WORKER.md`. Authenticated canonical source loading and private,
non-billable actual-prompt hashing are in `docs/CUSTOMER_AI_PREPARATION.md`.
**Queue/public routing and subscription connections
are not implemented or enabled.** Reviewed 2026-10-24
UTC. This is a build contract, not evidence that every subscription is usable or
paid provider acceptance passed. Stripe remains deferred; mobile remains parked.

## Three separate billing/identity modes

1. **Bookworm-managed AI:** server-owned provider key, existing quotes, paid
   entitlements, credit reservation/settlement and unconfirmed-outcome holds.
2. **Bring your own API key (BYOK):** a particular user's approved provider key;
   provider usage is billed by that provider. An API key does not convert a paid
   chat subscription into API credit. Bookworm's platform fee/entitlement policy
   is a separate product decision, currently awaiting the user's answer.
3. **Official connected subscription:** only a provider-supported, eligible
   commercial OAuth/partner integration, with the user's consent and revocation
   controls. Ordinary social login is not inference authorization. Never borrow
   an installed agent's tokens or collect chat passwords, cookies or sessions.

Current paid-feature gates remain unchanged until an explicit BYOK pricing and
entitlement contract is selected. No silently free platform AI, duplicated AI
cost charge, automatic funding-source fallback or subscription quota bypass.

## Provider-specific findings

| Provider | API-key target | Consumer-plan connection for this hosted commercial app |
| --- | --- | --- |
| OpenAI | Supported BYOK target | Official Sign in with ChatGPT plan usage exists, but commercial access is a limited trial for selected partners. Bookworm eligibility/client approval is not established. A Pro subscription is not credit for an `sk-` API key. |
| Anthropic / Claude | Supported BYOK target | Do not offer our own Claude.ai login or route Pro/Max tokens through our gateway. Anthropic separately permits running its unmodified Claude Code product under specific conditions; that is not permission to treat its OAuth credentials as a general API key. No such integration is enabled. |
| Google / Gemini | Supported BYOK target | The official guidance found for third-party apps directs them to Gemini API / Vertex AI, not consumer Google AI / Antigravity subscription pass-through. Google social login already used for Bookworm identity does not grant model access. |
| xAI / Grok | Supported BYOK target | API billing is documented as separate from Grok billing. No public subscription authorization contract suitable for Bookworm has been verified. Do not advertise plan reuse based on shared account login. |
| OpenRouter | Supported BYOK target | Its own API credits/key authorization are not another vendor's consumer subscription. Verify its official OAuth/API contract before implementation. |
| Additional providers | Future explicit allowlist/adapters | Verify official commercial authorization, capabilities, models and billing independently. No arbitrary credential forwarding or custom endpoint URL in the first release. |

Primary sources actually opened during this review:

- [OpenAI Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart): commercial eligibility and separate inference scopes.
- [OpenAI client request](https://developers.openai.com/siwc/request-client-id): commercial interest-form route; no Bookworm application submitted.
- [OpenAI pricing](https://learn.chatgpt.com/docs/pricing): API-key charges are separate from subscription usage.
- [Anthropic authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance): own-app credential restrictions and the distinct unmodified-Claude-Code conditions.
- [Google Gemini CLI terms](https://geminicli.com/docs/resources/tos-privacy/): direct third-party use of its backing service is restricted.
- [Google's response about consumer-plan access in third-party apps](https://discuss.ai.google.dev/t/supported-gemini-subscription-access-for-a-third-party-vs-code-extension/189889): directs applications to API/Cloud access instead.
- [xAI API account FAQ](https://docs.x.ai/console/faq/accounts): separate API billing.

These are time-sensitive findings. Recheck before implementation or public
availability claims. No legal agreement was accepted or new provider access
requested on the user's behalf during the review.

## Verified source seams

- `services/ai/gateway.py`: `Provider` protocol, `OpenAIProvider(api_key=...)`,
  deterministic mock and request receipts. Registry currently only OpenAI/mock.
- `services/ai/customer_provider.py` and `customer_protocol.py`: explicit,
  single-use customer-key text adapters for all five allowlisted providers.
  Fixed HTTPS destinations, exact model/route policy and request digest, bounded
  output and provider-specific tool/usage parsing. They are deliberately absent
  from the default registry and HTTP service selector. No vault secret resolver
  or payer/job authorization is implied by constructing an adapter.
- `services/api/src/lib/image-generation.ts` and `speech-generation.ts`: current
  server-owned OpenAI clients. Do not mutate process-wide environment variables
  or shared clients to choose a customer's credential.
- `services/api/src/lib/customer-ai-dispatch.ts` and Python `customer_dispatch.py`:
  exact-byte signed short-lived handoff, explicit credential binding, actual-agent
  request verification and durable single-dispatch receipts. The private HTTP
  factory is deliberately unregistered and requires a future database authorizer.
  Its authorizer/registration remain activation dependencies. The new explicit
  customer worker composes the payer-bound database RPCs but is not mounted.
- `services/api/src/lib/quoted-*-worker.ts`, quote routes and SQL job functions:
  reservation, immutable request identity, leased execution and unknown-outcome
  recovery must be retained when adding a payer/credential selector.
- `customer-ai-source.ts`, `customer-ai-prepare.ts` and `customer_prepare_http.py`:
  exact current saved-node source, authenticated RLS reads, full canonical hashes,
  opt-in context and shared deterministic prompt/wire preparation. These helpers
  remain unregistered; they do not authorize a job or perform a paid call.
  Related-reference provenance and whole-book batching are still required.
- `supabase/migrations/20261024040000_customer_ai_jobs.sql`: separate customer-key
  billing mode, private immutable authorization, explicit paid-plan/fee policy,
  single-use encrypted-secret dispatch resolution and pre-dispatch-only release.
  No policy or entitlement seeded. Receipt-only completion and an unmounted
  worker factory are implemented separately; retention/activation remain open.
- `services/api/src/lib/ai-connection-vault.ts`, account AI connection routes,
  the dedicated non-public `bookworm_credentials` schema and `/settings/ai`
  implement credential management. The private decryption helper is not a
  job authorization check and has no HTTP reveal/resolver route. Provider
  routing still requires the payer-bound worker contract below.

## Required implementation sequence

1. **Credential vault and account settings.** Per-user metadata with owner RLS;
   separate non-public encrypted secret storage. Server-side authenticated
   encryption with owner/provider/connection/version in associated data, fresh
   nonce per write and an independently managed, versioned encryption key/KMS.
   Never store provider secrets in metadata, job JSON, logs, prompts, Graphify,
   exports, Obsidian, browser storage, public environment variables or Git.
   Management responses are masked metadata only; no read-back/reveal endpoint.
   Missing encryption configuration/schema fails closed, not plaintext fallback.
2. **Account-bound lifecycle.** Verify the current actor before save/replace/
   revoke, validate a fixed provider allowlist and payload limits, use revision
   checks to prevent overwriting a newer key, and revalidate identity before
   displaying confirmation. Form secrets stay transient and clear after submit,
   account change and unmount. Store does not mean valid or funded. Validation
   is explicit, bounded and non-billable where officially supported; a model
   list/auth response never proves usable quota.
3. **Payer and quote contract.** Fix provider, model, capability, billing mode,
   connection ID/revision, authorizing user and maximum usage in quote/job
   identity. Do not put the key or its reusable fingerprint in that snapshot.
   Distinguish provider cost from Bookworm service fees; unknown cost is not zero.
   Preserve confirmation, reservations, idempotency, leases and hold/review
   behavior. Never retry an ambiguous paid outcome or switch to Bookworm's key.
4. **Worker authorization and adapters.** Resolve only the job creator's exact
   credential immediately before dispatch through a narrowly authenticated
   server path. Workspace collaborators/owners must not inherit another user's
   key. Revocation/replacement must not redirect queued work to a different key.
   Implement text adapters with validated structured output/tool calls, bounded
   requests, model allowlists and real usage receipts. Images and speech stay
   explicit per-provider capabilities, not presumed compatibility. Each adapter
   needs its own official API review and deterministic/native tests.
5. **Official subscription connectors.** First establish commercial eligibility
   and a provider-issued client/contract. Use provider-hosted consent, PKCE,
   one-time state bound to the current Bookworm account, exact redirects,
   encrypted refresh tokens, least-privilege scopes and user revocation. A
   disconnected/expired plan cannot silently fall back to paid API/platform use.
   Unsupported providers show an honest explanation, not a working Connect CTA.
6. **Acceptance before activation.** Tenant isolation, encrypted-at-rest proof,
   tamper/wrong-owner/wrong-key rejection, redacted errors/logging, rotated/
   revoked-key jobs, lost confirmations, token counting consent, cancellation,
   concurrency and exact cost-source settlement. Then separately authorize and
   cap real synthetic provider tests. Do not run paid tests just by saving a key.

Live DDL, a managed encryption key and commercial OAuth approval are activation
dependencies, not satisfied by a local passing test or a handoff assertion.

## Current OpenAI test constraint

Read-only browser review saw the signed-in Personal organization on Free trial
with **$0.00 API credit**, all-projects usage for the last seven days showing no
recorded usage, and one organization in its selector. This is evidence for that
visible organization, not proof of a match to the saved key or reconciliation of
every historical request. No new generation call was made. The original US$5
total cap is not reset; prior conservative holds sum to US$2.50 and are not a
claim of actual spend. Earlier text/image/speech receipts remain unconfirmed.

The user reports available ChatGPT Pro usage. That does not fund API-key tests.
An officially approved plan connector is a separate possible future route, not
permission to reuse this Codex session's credentials or to publish Bookworm as
open source merely to qualify for a different integration category.
