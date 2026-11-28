# Customer-key worker and non-secret preparation

Status: implemented as an explicit internal factory, **not activated**. No queue,
CLI, public route, environment flag or subscription button starts this worker.
No policy, entitlement or pricing choice is seeded. Stripe remains deferred and
mobile remains parked. This is not evidence of real-provider or hosted acceptance.

## Dispatch contract

`prepare_customer_ai_dispatch(job, lease)` is a service-only, repeatable read of
the authorized scope and private request snapshot. It returns no credential,
nonce, ciphertext or key identifier and does not change job/ledger/dispatch state.
It takes the same owner/organization/grant/job locks as the existing resolver and
checks active membership, exact connection revision, paid plan, enabled policy,
current source, grant expiry and current unexpired lease. It grants neither
service-role schema access nor direct private-table SELECT.

`prepareCustomerDispatch` detaches and freezes source/scope, rejects unsafe JSON,
checks size including worst-case envelope escaping, and computes the Python
verifier's exact digest. Scope keys use the fixed canonical ordering; source
hashing uses the actual UTF-8 requestJson bytes, not language-dependent numeric
reserialization. The signer uses this same preparation function.

`customerAiWorker` then:

1. Claims the specified customer job for 300 seconds. It cannot claim managed
   or operational work and checks every canonical job/scope identity field.
2. Obtains non-secret context and computes the fingerprint before requesting
   the one-way encrypted credential resolution. Resolution reauthorizes again.
3. Compares returned identity/source with the prepared immutable snapshot,
   authenticates decryption against owner/provider/connection/revision, and
   signs the private envelope with the separately configured dispatch key.
4. Sends at most one POST to the explicit operator-configured internal service.
   HTTPS is required; local HTTP requires explicit opt-in and a loopback host.
   Credentials, paths, query strings, fragments and redirects are rejected.
   RPC attempts are bounded at 60 seconds; the dispatch attempt at 90 seconds.
5. Ignores the HTTP result body for settlement. The completion RPC validates
   only the immutable database receipt, never a caller-supplied result.
6. Replays only idempotent completion after an ambiguous database reply. Missing
   evidence is held for review; a competing completed result can win a late hold.

Plaintext and wire Buffers owned here are cleared in finally blocks. JavaScript
strings, crypto/runtime and network copies cannot be guaranteed wiped; no body,
source or raw error is logged. Base64 transport is not encryption; TLS and
operator-managed secrets remain essential. The factory snapshots its explicit
dependencies and never modifies process-wide provider credentials.

## Failure and recovery

- Before resolution: `preparation_failed`; no request from this worker was sent.
  The reservation is retained for explicit safe cancellation or another valid
  pre-dispatch lease. This worker never cancels another worker's new lease.
- Once resolution is attempted, even a lost resolver reply is ambiguous. There
  is no second resolution, provider retry, automatic refund or payer fallback.
- `requires_review` is reported only after a matching database hold is confirmed.
  If neither completion nor hold can be confirmed, report `completion_unknown`.
- `recoverCustomerAiJob` needs no vault, signing key or provider service. It
  reads/completes the original saved receipt, including after key revocation.
  A future public recovery route must authenticate the actor and current book
  access; this internal helper is not a browser authorization mechanism.
- Results remain pending proposals. Provider cost remains unknown/NULL, not
  zero. Existing paid-plan and explicit platform-fee rules remain intact.

## Tests and integration boundary

The focused TypeScript tests verify ordered single dispatch, all identity
bindings, encrypted credential tampering, lost resolver/HTTP/completion replies,
missing receipts, hold/completion races, shutdown, static errors and owned-buffer
clearing. They use synthetic credentials and fake HTTP/RPCs, not paid requests.
The signature fixture additionally crosses the real Python verifier/agent and
durable synthetic receipt replay; Unicode and numeric JSON spellings are tested.

`customer-ai-worker-context.test.sql` executes real SQL in the migration suite:
actual restricted service-role read, no secret fields/mutations/second debit,
wrong lease/role/job rejection, changed plan/key/member/source/expiry rejection,
revocation between read and resolver, exact read/resolver parity and no reopening
after dispatch. Populated upgrade now pins 45-to-115, preserving historical rows.
Serial PGlite assertions do not substitute for native multi-connection acceptance.

Remaining: authenticated canonical source/provider-request preparation; private
AI-service database authorizer and explicit registration; controlled queue and
public recovery routing; payer/fee/unknown-cost UI; capacity/cross-worker races;
retention/tombstones; operator pricing/key configuration; authorized live DDL
and separately capped real-provider acceptance. Neither this factory nor the
existing API-key vault establishes consumer-subscription eligibility.

Official subscription contracts are recorded in `AI_CONNECTIONS_PLAN.md`.
OpenAI's commercial client interest form is linked from its official
[client request page](https://developers.openai.com/siwc/request-client-id).
No application, agreement or credential-sharing workaround has been submitted.
