# Narration transport and publishing-package checkpoint

Date: 2026-10-05. This is one dependency bundle for the full AI Bookworm product,
not product completion, paid narration activation or a hosted release.

## Included behavior

- Speech chunks preserve Unicode code-point ranges and exact hashes, while
  reserving the combined 1,800-byte UTF-8 budget for text and saved delivery
  instructions. Every chunk uses the unchanged SQL operational tariff
  `ceil((end-start)/1000)`. A 4,000-character ASCII chapter produces lengths
  1,800/1,800/400 and units 2/2/1; global rounding previously failed SQL admission.
- A reusable fixture imports the production TypeScript segmenter and exercises
  actual queue SQL with four synthetic source profiles. It verifies exact paid
  operational allowance, replay without duplicate jobs, forged-unit rejection,
  no queue-time generation charges and non-member isolation. Both disposable
  database runners include it; only the embedded serial execution is verified
  locally at this checkpoint.
- A server-only OpenAI Realtime adapter supports explicit `gpt-realtime-2.1-mini`
  and `gpt-realtime-2.1` profiles, ten supported voices and speed 0.25–1.5. Each
  call has an explicit 1–4,096 output-token cap, one fresh out-of-band response,
  disabled tools/tracing/automatic turns, bound model/source/response/event
  identities and bounded 24-kHz mono 16-bit PCM, transcript and original usage.
- Measured text input, cached text input, text output and audio output remain
  separate. Missing, new, unbalanced or out-of-budget billing evidence requires
  review, never an estimated customer bill. A completed but altered transcript
  also requires review. Ambiguous failures do not retry, fall back or refund.
  No raw provider errors, manuscript text or server key is logged by the adapter.
- The default connector requires `AUDIOBOOK_QUOTE_PURCHASE_ENABLED=true` and a
  server-side `OPENAI_API_KEY`. This switch is not funding authorization. The
  adapter is deliberately not wired into the legacy unquoted/retryable worker.
  `ws` and its TypeScript definitions are pinned SDK runtime dependencies.
- Retailer export packages include deterministic `preflight.json` with located
  findings and a manifest checksum. That filename is reserved. The README tells
  authors to review warnings before manual retailer upload; this is not retailer
  submission, account integration or publishing approval.

## Local evidence and boundaries

Saved logs in `.git/bookworm-tracking/` are local evidence, not committed secrets
or customer data:

- `audio-segmentation-red-20261005.log` and
  `audio-segmentation-db-red-20261005.log`: original allocation fails regressions
  and real queue SQL. GREEN counterparts: 19/19 focused API/helper tests and all
  four actual-SQL segmentation cases pass; SQL validation was not weakened.
- `realtime-narration-final-20261005.log`: 50/50 synthetic transport/receipt tests;
  adapter-only coverage 96.44% lines, 92.00% branches and 100.00% functions.
- `narration-package-adapters-20261005.log`: 25/25 publishing-adapter tests.
- `narration-full-verify-20261005.log`: shared-tree full verification passes:
  workspace types, launcher/unit suites, 540 API, 150 web, 99 disposable
  migrations/67 SQL assertion files/eight serial paid gates plus four segmentation
  cases, 419 Python services, 12 E2E, 35 security, 50-request no-5xx load smoke and
  six deterministic evals. Provider evals are skipped without a key.

These checks do not prove a live OpenAI response, native concurrent execution of
the new fixtures, hosted GoTrue/PostgREST/Storage/scanning, complete Next/mobile
journeys, supervised workers or retailer acceptance. There is no configured
workspace lint gate. Exact-index isolated build/verification and source adoption
must be recorded in the shared continuation note before calling the bundle
accepted. Earlier native CI covers only its exact earlier committed source.

## Required funded integration

Reuse the existing exact integer pricing and funded-usage primitives. Complete
immutable model/rate/source quotes, approved dated catalogs, explicit author
maximum-credit consent, funded holds, current membership/lease checks, one-way
dispatch, measured settlement and durable receipt/recovery before connecting the
adapter to a queue or author UI. No post-dispatch refund or regeneration may be
inferred from timeouts, expired leases or lost replies. Unsupported usage needs
retained evidence and operator review, not manufactured estimates.

Then finish deterministic bounded PCM-to-MP3 processing, source fidelity,
pronunciation/mastering/QC, historical voice compatibility and retailer audio
packaging. Continue the full authoring, illustration/cover, layout/preflight,
translation, dashboard, hosted/operator and retailer release requirements. No
catalog/purchase activation, deployment, migration or provider/payment spending
is authorized by this document. Do not work around the denied test-server launch.

Official sources checked for the workload-specific migration:
[OpenAI TTS deprecations](https://developers.openai.com/api/docs/deprecations),
[Realtime Mini model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
and [out-of-band/custom-input responses](https://developers.openai.com/api/docs/guides/realtime-conversations).

Continuation: `docs/AGENT_HANDOFF.md` and the shared vault's
`Codex Sessions/2026-10/2026-10-05-narration-transport-checkpoint.md`.
