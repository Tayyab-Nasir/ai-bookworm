# Private AI connection settings

Local candidate, 2026-10-24. Test/source receipts and current activation state
belong in the shared Codex session handoff; this document specifies behavior.
Do not treat this as full-product, live migration or paid-provider acceptance.

## User workflow

Account & support links to `/settings/ai`. Users can save one API key for each
of OpenAI, Anthropic, Google Gemini, OpenRouter and xAI, replace it with an exact
revision check, or remove it. The page displays only its final four characters.
Saved means stored, not validated/funded/usable for generation. The response
explicitly has `generationAvailable: false`; workers still use the existing
platform funding path. Existing entitlements and paid quotes are unchanged.

Passwords, chat-session tokens and subscription credentials are not accepted as
an integration method. The key syntax check is not proof that a pasted value is
a legitimate API key. No provider request is made by saving, listing, removing
or recovering a connection. Subscription/OAuth and OpenRouter PKCE are still
future integrations under `AI_CONNECTIONS_PLAN.md`.

## Storage and authorization

Migration `20261024020000_ai_connection_vault.sql` adds owner-readable, read-only
metadata with RLS in `public.ai_connections`. Envelopes and operation receipts
live in the dedicated **non-exposed** `bookworm_credentials` schema, with no
direct browser or service-role table/schema grants. Existing `bookworm_private`
settlement access is unchanged. Two narrowly scoped service-role-only RPCs
write encrypted envelopes or recover/close operations. The API derives owner
from remotely verified bearer identity, never body fields. Credential proxy
transport requires HTTPS except for local loopback. Mandatory expected-
actor headers are checked by both cookie proxy and API. Workspace membership,
including ownership, grants no access to another person's keys.

AES-256-GCM uses a fresh random 96-bit nonce and 128-bit tag per write. AAD binds
format, encryption-key version, owner, provider, connection ID and revision.
Envelopes cannot be transferred between these identities. The separately
managed API-server secret `AI_CONNECTION_VAULT_KEYRING_JSON` supplies 1–8 named
32-byte keys in canonical base64 and an active ID. Missing configuration
disables saves; invalid configuration fails closed. Metadata and revocation
continue without a key ring. No service-role-derived/default encryption key.
Old versions must be retained until their records are rotated/revoked; removing
one early makes those records unreadable. No background rotation tool is
implemented yet. Protect key-ring backups separately from database backups.

Remove deletes the active encrypted row, advances the metadata revision and
clears its suffix. It does not revoke the provider key or erase historical
database backups. Auth-user deletion cascades connection, envelope and receipt
records; fulfilling a reviewed data-rights request remains the existing workflow.
Data exports must include only metadata, never private envelopes or the key ring.
The private `open` helper is not exposed over HTTP and is not sufficient worker
authorization; later routing must verify the exact creator/job/revision.

## Concurrency and recovery

All mutations serialize per owner, check expected revision/connection ID, and
allow at most ten successful changes/closures per minute. Reusing an operation
ID is rejected. A browser stores only a strict opaque intent in per-account
session storage before dispatch, never key material. If recovery storage is
unavailable the key is not submitted. Clearing browser storage or closing the
tab may lose that local pointer; a new session still reads current saved state.

The password input clears on dispatch, cancel, account revalidation, hidden tab
and unmount. UI updates verify account identity before and after reads; late
replies never populate another account. JavaScript strings cannot be securely
zeroized; no stronger in-memory erasure guarantee is claimed.

After an unknown response, a read-only `check` returns saved/revoked/closed/
not_found. No plaintext retry occurs. A `close` serializes with the original
write and either returns its completed receipt or saves a tombstone. A late
write then fails. The UI unlocks new changes only after terminal evidence and a
metadata read that observes that revision or newer. A closure never undoes an
already completed save. Provider dispatch does not exist on these endpoints.

## Redaction and acceptance

Key values/ciphertext are excluded from public payloads, logs, jobs, exports,
Graphify and notes. Sensitive route logging masks the full URL/query, generated
request IDs cannot echo submitted secrets, and malformed JSON errors are
neutral. Server and client validate response scope and exact operation identity.

Evidence targets: crypto tamper/binding/rotation tests; actual SQL grants/RLS,
CAS, rollback, revocation, closure and rate limits; real component recovery/
account-change tests; native Auth/HTTP/PostgREST save/reload/concurrent CAS/
revocation tests with synthetic keys only; real responsive screenshots. A green
local fixture does not install this schema or encryption key in the live project.

Before live activation: independently provision the encryption key ring, review
the new migration and backup/rollback plan, then apply under explicit authority.
The prior live migration approval must not be inferred from this document.
Customer generation still needs payer policy, immutable quote/job credential
identity, worker adapters and bounded provider acceptance. No automatic platform
fallback, free generation, duplicated provider charge or private agent-token use.

Primary implementation references reviewed:
[Node crypto](https://nodejs.org/api/crypto.html) and
[Supabase API security](https://supabase.com/docs/guides/api/securing-your-api).
