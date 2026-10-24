# Customer-key text adapters

2026-10-24. Implements the transport/structured-output portion of the BYOK plan,
not a released customer generation path. Encrypted key settings were accepted
at `3b63ca69ed887c32382abdff45c657609f9d6565`; their activation dependencies remain
in `AI_CONNECTION_VAULT_CHECKPOINT.md`. Stripe deferred; mobile untouched.

## Implemented boundary

`gateway.get_customer_provider` constructs an explicit `CustomerProvider` with
one API key, a server-owned `ModelPolicy` and an expected request SHA-256. No
credential or model is discovered from the environment. `get_provider` and the
HTTP service still select only the existing OpenAI/mock implementations. No
default changed and no new public endpoint exposes the customer adapter.

The policy specifies the exact requested model, an explicit tuple of permitted
response model IDs, maximum output tokens, and, for OpenRouter, one approved
upstream request slug plus exact allowed response provider names. No prefix
matching, guessed latest model, alias expansion, price fallback or free cost.
The operator must review model capability/limits before adding a catalog entry.

`prepare_customer_request` snapshots text-only system/user/assistant messages
and inline function schemas into immutable UTF-8 JSON. Inputs/outputs are capped
at 1 MiB, 32 levels, 64 messages, 16 declared functions and 64 returned calls.
Only a leading system message and alternating user/assistant conversation ending
in a user message are accepted. No image/file URLs, remote schema references,
built-in tools, hosted tools or arbitrary provider URLs are forwarded. SHA-256
binds the provider, fixed destination, exact body, and response model/upstream
allowlists. It contains no credential or reusable key fingerprint.

After local validation and hash comparison, one instance can dispatch once,
including under concurrent use. Its stored key reference is cleared before the
request. HTTP uses verified TLS, no environment proxies, no redirects and zero
transport retries. No platform-key or cross-provider fallback. A separate
instance is **not** durable replay protection: the worker must still fence the
one-way dispatch in its database before invoking this transport.

Connect/write/read/pool timeouts are bounded. The body checks a 180-second
elapsed-time budget at each network chunk, without buffering to a minimum chunk
size. A currently blocked read may additionally take its 120-second read timeout;
this is not a guaranteed 180-second wall-clock deadline. Non-JSON, compressed,
oversized, malformed, duplicate-key, non-finite, refused or incomplete replies
cannot become successful completions. HTTP/network/post-dispatch validation
errors yield a generic `ProviderOutcomeUnknown`, never raw response/error data
or a retry. JSON-escaped credential echoes are rejected. Python does not promise
secure memory zeroing; no such claim is made.

## Provider contracts

| ID | Fixed transport | Structured output / usage |
| --- | --- | --- |
| `openai` | POST `https://api.openai.com/v1/responses` | Responses functions, `store:false`, no streaming; input/output/total arithmetic, optional cache/reasoning subsets. |
| `anthropic` | POST `https://api.anthropic.com/v1/messages` | Bearer API key and reviewed `anthropic-version:2026-10-21`; top-level system, Messages client tools. Input includes separately reported cache reads and writes. |
| `google` | POST `https://generativelanguage.googleapis.com/v1beta/models/{approved-model}:generateContent` | Key header, not URL query; `parametersJsonSchema`, bounded single candidate and explicit function mode. Output includes reported thought tokens exactly once. |
| `openrouter` | POST `https://openrouter.ai/api/v1/chat/completions` | Function tools; pinned upstream, `allow_fallbacks:false`, required parameters, data-collection deny. Exact returned model/provider checked; no route fallback list. |
| `xai` | POST `https://api.x.ai/v1/responses` | Responses client functions and `store:false`. Current input/output counters required; legacy/inconsistent counter shapes fail closed. |

Current Claude models may reject forced `any`/`tool` choices. For an exact
Bookworm function, the adapter advertises only that function with `auto`, then
requires exactly one schema-valid call of that name. This validates the result,
not a promise that Claude will call it. Absence/refusal stays review-required;
there is no paid retry to obtain a different result. Multiple calls remain
supported for ordinary multi-suggestion agents, within the bounds above.

All functions are checked against their supplied JSON schemas (including UUID
formats) before any completion is returned. Existing agent-specific rules still
apply afterward. `BaseAgent` now preserves an unknown outcome when a dispatched
customer completion fails domain validation, such as duplicate chapter IDs or
inconsistent edit targets. It never converts that into a refundable pre-dispatch
failure. Writer and Story Blueprint remain proposal-only; nothing is applied or
materialized by these adapters.

`Usage.providerTokenUsage` contains only allowlisted observed integer counters.
Missing cache evidence is not invented as zero. Anthropic cache-write durations
are retained when supplied and checked against the write total; Gemini totals
must explain all output/thought tokens. Reasoning already included in OpenAI,
xAI and OpenRouter output is not counted twice. Unexpected server-tool/media
usage is refused where reported by these contracts. These projections are not
an exhaustive vendor invoice or a substitute for future rate reconciliation.

Customer completions explicitly carry `estimatedCostUsd:null`, not zero, and do
not produce managed-AI `measuredTokens` pricing dimensions. A body response ID
is kept separately as `responseId`. An official OpenAI/Anthropic HTTP request ID,
when supplied, remains `requestId`; there is no substitution with an internal
job ID or fabricated receipt. Existing managed-AI workers/quotes are unchanged.

## Official sources reviewed

These API contracts are time-sensitive. Recheck each approved model before live
acceptance. Synthetic tests are not evidence of funded provider compatibility.

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI production practices](https://developers.openai.com/api/docs/guides/production-best-practices)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic tool-choice restrictions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini GenerateContent and usage schema](https://ai.google.dev/api/generate-content)
- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [xAI Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses)

## Verification and remaining integration

New deterministic tests exercise the actual HTTP serialization/parsing layer
with `httpx.MockTransport`, then real Writer/Story Blueprint agents. They cover
all five providers, exact request hashes/models, explicit keys, cross-instance
and same-instance concurrency, unavailable default selection, no retries or
redirects, malformed/oversized responses, tool/usage/refusal errors, unknown
costs and review-required post-dispatch domain failures. No paid calls are made.
The immutable candidate/full-suite evidence is in the linked shared session
note after verification; focused passing tests alone are not product completion.

Next required steps, before any customer-key generation activation:

1. Resolve the user's BYOK platform-fee/credit policy. Do not charge a guessed
   Bookworm AI fee or bypass current paid entitlements while it is unanswered.
2. Bind provider/model, billing mode, credential owner/connection/revision,
   maximum usage and exact prepared request to the accepted quote and job.
   Resolve only that revision immediately before dispatch. Replacing/revoking a
   key must not redirect queued work to a new key or another workspace member.
3. Extend leased workers and durable receipts/reconciliation to those payer
   contracts. Persist provider-specific usage evidence safely. No automatic
   redispatch, refund or Bookworm-key fallback on an unknown outcome.
4. Review/apply the separately pending vault migration and independently managed
   encryption key configuration only with live backup/activation authority.
5. Funded, bounded synthetic acceptance for each selected provider/model, then
   customer UI and fee disclosure. Images/audio require separate capability
   adapters and acceptance; these text adapters do not add those capabilities.

Consumer subscription reuse remains a separate, provider-approved OAuth/partner
project. Nothing here uses ChatGPT/Claude/Grok/Gemini login tokens, agent sessions,
passwords or cookies. See `AI_CONNECTIONS_PLAN.md` for current eligibility.
