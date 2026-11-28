# OpenAI model and pricing checkpoint — 2026-09-24

## Source defaults and Standard diagnostics — checked 2026-11-28

New requests without a model override default to
[GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)
for text and [GPT-Image-2.6 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst)
for image generation and edits. Both use the existing API request shapes.
The text estimate uses $8 input and $40 output per million tokens, rising to
$16 and $60 respectively above 272,000 input tokens. Sunburst's diagnostic
rates remain $5 per million text input, $8 image input and $30 image output.
See [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

Environment overrides and accepted quotes retain their selected model.
Provider diagnostic estimates apply to Standard processing and do not update
the versioned paid offer catalogue or activate purchases. Verify model access
with a current project credential and measure a funded provider run before
activating a new paid offer. Quoted Realtime narration continues on its
published GPT-Realtime 2.1 model family.

## Current speech deprecation — checked 2026-11-03

OpenAI has deprecated `gpt-4o-mini-tts` and scheduled its shutdown for
2027-01-06. Its recommended replacement, `gpt-realtime-2.1-mini`, uses the
Realtime API and is not supported by the `/v1/audio/speech` endpoint. See the
[deprecation schedule](https://developers.openai.com/api/docs/deprecations) and
[text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech).
Do not substitute the Realtime model name into the legacy Speech API setting.

The current source has a separate, quoted Realtime narration adapter and
worker for `gpt-realtime-2.1-mini` and `gpt-realtime-2.1`; direct unquoted
narration is retired. The legacy Speech API implementation and
`OPENAI_TTS_MODEL` setting remain for historical compatibility and must not be
treated as the production narration plan. Before activation, complete the
provider, funding, cost and hosted acceptance described in
[`NARRATION_TRANSPORT_CHECKPOINT.md`](NARRATION_TRANSPORT_CHECKPOINT.md).
No provider request or account availability check was made in this review.

At the November 3 review, official references listed
[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [`gpt-image-2.5-sunburst`](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst).
Model listings do not establish account access or approve commercial prices.
The figures and other statements below are historical, as of 2026-09-24.

This is a source-code and documentation review, **not** a live provider or
billing acceptance test. Official sources consulted:

- Model catalog: https://developers.openai.com/api/docs/models
- Standard token prices: https://developers.openai.com/api/docs/pricing
- Image generation and token-cost guidance: https://developers.openai.com/api/docs/guides/image-generation
- Image create response schema: https://developers.openai.com/api/reference/cli/resources/images/methods/generate
- Text-to-speech model and endpoint: https://developers.openai.com/api/docs/guides/text-to-speech
- TTS model token prices: https://developers.openai.com/api/docs/models/gpt-4o-mini-tts

The September defaults were `gpt-6-astra` for text, `gpt-image-2.5-sunburst`
for images, and `gpt-4o-mini-tts` for speech. Official documentation identifies
all three, with Mini TTS as the current speech endpoint model. Availability
for this OpenAI account was **not** verified; no API key or paid request was
used.

Standard listed prices per million tokens at review time: Astra short-context
input/output $10/$50 (long-context $20/$75); Image 2.5 Sunburst and Flare
text input/image input/image output $5/$8/$30; older Image 2 $2.50/$4/$15;
Mini TTS text input/audio output $0.60/$12. Discounts, caching, service tiers,
and regional processing may change realized cost. Recheck before pricing plans.

`estimatedImageCost` now uses the corresponding 2.5 or 2 price table and
conservatively treats unclassified input as image tokens. Contradictory
text/image counts are discarded as a breakdown, so they cannot discount
input incorrectly. The saved usage also records `costEstimateBasis`:
`itemized` when both input modalities sum to the reported total,
`conservative_input` when total input/output are present but the breakdown is
missing, partial, or contradictory, and `unavailable` when a total or known
price table is missing. Numeric zero is still a compatibility placeholder,
not a measured cost, when the basis is unavailable. This number is
diagnostic provider telemetry, **not** the customer's debit. Image requests
currently reserve one `image_credits` entitlement per generation; the app
now records `measurementStatus` in the image job's usage JSON as `complete`,
`partial`, or `unavailable`. An absent provider usage object still produces
zero token/cost placeholders for the existing numeric AI-run columns, but
`unavailable` explicitly means **unknown provider spend, not free generation**.
Partial token receipts may understate actual cost; even `itemized` is only an
estimate at the listed standard rates, not an invoice. Reconcile against provider
organization usage before financial reporting or publishing a retail price.
Image API usage availability should be verified with a bounded live request:
the provider's guide describes usage data, while the API reference documents
optional usage with narrower model wording. The app must still establish a
funded, versioned customer offer and validate
worst-case cost by size, quality, references, and model before public sales.
Speech endpoint responses do not provide a token receipt; Bookworm's audio
cost is explicitly a word-rate estimate awaiting organization-usage
reconciliation. Do not represent estimated image or speech cost as an exact
provider invoice.

Image dispatch also has an uncertainty boundary: the SDK must not retry an
ambiguous provider response. If a response is lost, Bookworm retains the
running job and its reserved operational credit, blocks a second request by
that author/workspace, and requires operator review. A missing completion
receipt does not prove that OpenAI did no work. This prevents a mistaken
"free retry" claim, but it is not a provider-usage reconciliation workflow.

Local evidence for this slice: API TypeScript and all 297 API tests pass;
Graphify updated. No hosted migration, payment, deployment, Google OAuth
configuration, or live generation occurred.
