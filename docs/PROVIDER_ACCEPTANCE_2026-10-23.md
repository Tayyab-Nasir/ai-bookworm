# Bounded provider acceptance — 2026-10-23

The human approved up to **USD5 total** for synthetic text/image/speech tests,
not customer use, deployment, embeddings, recurring spend or funding purchases.
The local server credential is stored in a Git-ignored root environment file.
It must be rotated because it was shared in chat; never copy it into Git,
screenshots, logs, generated graphs, Obsidian or other agents' memory.

## Verified account and transport results

The non-billable model inventory authenticated successfully and listed
`gpt-6-astra`, `gpt-6.1-sol`, `gpt-image-2.5-sunburst`,
`gpt-realtime-2.1-mini` and `gpt-realtime-2.1`.

One bounded attempt per modality was made through the existing provider
adapters. The operator then explicitly supplied a replacement credential and
asked for another test; only one additional bounded text probe was attempted.
The non-billable inventory also authenticated with that replacement credential.
SDK retries were disabled. No customer manuscript was sent.

| Probe | Time UTC | Result |
| --- | --- | --- |
| Astra text, maximum 768 output tokens | 16:55:01–16:55:08 | No verified completion; original diagnostic was not retained by the probe harness. Outcome remains unconfirmed. |
| Sunburst, one low-quality 1024-square illustration, no references | 16:55:44–16:55:46 | SDK RateLimitError, HTTP 429; no verified image or usage receipt. |
| Realtime 2.1, one short synthetic sentence, maximum 512 output tokens | 16:56:27–16:56:29 | Provider error classified as quota/billing before a session-created event; no verified audio or usage receipt. |
| Replacement-key Astra text, maximum 768 output tokens | 17:09:15–17:09:21 | ProviderOutcomeUnknown with underlying HTTP 429 classified as quota/billing. No verified completion or usage receipt. Replacement-key image and speech were not attempted. |

No further paid requests are permitted automatically. The operator needs to
resolve billing/quota and rotate the exposed credential. Local conservative
holds remain **USD2.50** (original text .25, image 1, speech 1, replacement text .25). This is not a measured
charge or refund. Actual spend is unknown and requires provider reconciliation;
at most USD2.50 of the original ceiling remains until then. Changing credentials
does not reset the ceiling. Redacted receipts are local-only in
`.git/bookworm-tracking/provider-acceptance-20261023/` and its `replacement-key/`
subdirectory. The root `.env` holds the latest credential, remains Git-ignored
and untracked, and was not copied into the running app, clean build or tests.
The app's separate `.env.local` has a blank OpenAI assignment; saving the root
file alone does not enable generation or change paid-AI gates.

No runtime purchase flags, customer prices, funded balances, live data,
deployment or retailer publication were changed. A working API key does not
prove generation, durable jobs, quote settlement or paid workflow acceptance.

[OpenAI error guidance](https://developers.openai.com/api/docs/guides/error-codes)
distinguishes exhausted prepaid balance, project/organization spend limits and
organization usage limits. Retrying does not resolve those conditions. The
retained probe classification does not identify which of those specific limits
applies here; the operator must check the account, not generate another key and
assume the budget has changed.

## Current official guidance checked

[OpenAI models](https://developers.openai.com/api/docs/models) and
[standard pricing](https://developers.openai.com/api/docs/pricing) still list
the selected Astra, Sunburst and Realtime 2.1 families. Short-context Astra
input/output rates are USD10/50 per million tokens; Sunburst text-input,
image-input and image-output rates are USD5/8/30. Realtime 2.1 text-input/output
rates are USD4/24 and audio-input/output rates USD32/64 per million tokens.
These are provider rate references, not a published customer price or invoice.

[Speech guidance](https://developers.openai.com/api/docs/guides/text-to-speech)
deprecates the old speech-endpoint models with a January 6, 2027 shutdown and
requires the Realtime API for current models. Bookworm already has a separate
funded Realtime narration path; do not substitute a Realtime model name into
`/audio/speech`. The old speech-endpoint environment default remains legacy,
not the current quoted narration transport.
