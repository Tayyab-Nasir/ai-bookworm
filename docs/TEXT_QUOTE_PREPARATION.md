# Exact text request preparation

## Current scope

The private Python AI service can prepare exact input counts and request hashes
for writer, proofreader, copyeditor, consistency, metadata, Book Bible and Story
Blueprint jobs. The two internal endpoints below are preparation primitives,
not purchase authorization: they do not persist customer quotes, hold credits,
or settle usage. Separate author-facing paid quote paths consume the shared
hash/count contract for metadata, Story Blueprint, translation, Book Bible and
writer/proofreader/copyeditor/consistency. Their accepted jobs require funded
holds, fenced dispatch and measured settlement. Catalog configuration remains
owner-controlled; source wiring does not activate or approve a commercial offer.

Both endpoints require the internal `x-service-token`:

- `POST /v1/ai/text/request-hash`: builds the request locally; no provider call.
- `POST /v1/ai/text/quote`: counts the same input through OpenAI, without a
  completion. In production this sends the selected content to OpenAI; expose
  it only behind member scope, consent, request limits and server-owned inputs.

The API also has an `ai-review-pricing.ts` preparation primitive
for the writer/proofreader/copyeditor/consistency catalog shape. It consumes
the exact private AI-service count/hash response and calculates a cached-input,
uncached-input and output maximum using server catalog values. Synthetic unit
tests cover consent, failure, identity and limits. Authenticated
`ai-review-quotes.ts` routes now use it to prepare immutable consented quotes;
separate acceptance creates a funded job. The `ai-review-quotes` worker verifies
the accepted saved request and durable receipt before measured completion.
The preparation primitive alone never authorizes purchase. The legacy direct
review route is disabled by default in the production app. Provider/catalog,
native service and browser acceptance remain distinct release gates.

Request fields: `jobId`, `workspaceId`, `bookId`, `agentType`, explicit `model`,
`maxOutputTokens`, canonical `input`, and optional `contextPolicy`. Responses
include `inputSha256`, `model`, `agentType`, effective `maxOutputTokens`, and
for the count endpoint `inputTokens`. These are not prices or funding evidence.
The existing Story Blueprint endpoint contracts remain compatible.

## Quote/dispatch invariant

One gateway builder defines the actual OpenAI wire payload. The SHA-256 binds
model, system/user messages, tool definitions, optional tool choice and output
cap. Omitted tool choice remains omitted, matching generation. Counting sends
the same input fields but excludes the output cap. The hash still binds that
cap; Book Bible returns its effective maximum of 6,000, even if more was requested.

`/v1/ai/jobs` verifies any supplied `expectedInputSha256` before reserving a
private result receipt or calling the provider. Explicit model/output bounds
are required with a hash; Story Blueprint continues requiring a hash. A mismatch
returns 409 without generation. The same prepared messages/tools and agent
evidence are then used for dispatch, with no second context/prompt build.

A hash is **not** payment authorization. The API must still persist an accepted
server-owned quote, atomically reserve funds and claim a durable dispatch marker.
It must recheck the hash before that marker, then send the expected hash with the
generation call. Source ownership and saved-version checks belong to the API;
the private AI service trusts only its authenticated internal caller.

Counter retries are disabled. Missing, Boolean, noninteger, zero, negative or
out-of-range counts fail closed. Uncertain paid completion outcomes retain
the existing private receipt hold/recovery behavior.

## Book Bible integration defect corrected

Public jobs and receipt tables use `bookbible`; the agent and prompt identifier
is `book_bible`. The registry now recognizes both, preserving prompt lookup and
the external contract. Previously, the HTTP path could reject the public name
as unknown. Earlier mocked-agent receipt tests did not exercise that registry.
New tests run the real Book Bible agent through HTTP, save its private receipt,
clear process caches and recover/replay without a second generation.

## Verification and remaining work

`services/ai/tests/test_text_quotes.py` uses synthetic provider output and a
synthetic counter. It checks exact counted/dispatched payload equality across
six agents, one context build, evidence validation, source/instruction/model/
agent/style/system-prompt drift, authentication, output caps, invalid count
rejection and no provider/receipt side effects on pre-dispatch failures.
`test_result_store.py` covers real-agent durable receipt recovery with a local
HTTP transport fixture. These are not live OpenAI or Supabase acceptance.

Full local `npm run verify` passed on 2026-09-25: workspace TypeScript,
348 API/unit tests, 104 web tests, 82 disposable migrations/58 SQL assertion
files, 411 service tests, 12 E2E, 30 security, load smoke with no 5xx and six
deterministic AI evaluations. Live provider evaluation was skipped because no
provider API key was configured.

Next acceptance: verify the coherent API, migration, worker, client and author
UI bundle independently of unrelated dirty work. Exercise native concurrent
acceptance/dispatch/settlement and lost-response recovery, then hosted service,
provider and supervised-worker behavior. Historical local counts above are not
current release certification. Preserve existing operational jobs for their
explicit recovery paths; do not enable new unquoted generation. Do not publish
retail offers until those gates and approved pricing are verified.
