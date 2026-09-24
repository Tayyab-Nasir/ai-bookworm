# OpenAI model and pricing checkpoint — 2026-09-24

This is a source-code and documentation review, **not** a live provider or
billing acceptance test. Official sources consulted:

- Model catalog: https://developers.openai.com/api/docs/models
- Standard token prices: https://developers.openai.com/api/docs/pricing
- Image generation and token-cost guidance: https://developers.openai.com/api/docs/guides/image-generation
- Text-to-speech model and endpoint: https://developers.openai.com/api/docs/guides/text-to-speech
- TTS model token prices: https://developers.openai.com/api/docs/models/gpt-4o-mini-tts

The configured defaults remain `gpt-6-astra` for text, `gpt-image-2.5-sunburst`
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
conservatively treats unclassified input as image tokens. This number is
diagnostic provider telemetry, **not** the customer's debit. Image requests
currently reserve one `image_credits` entitlement per generation; the app
now records `measurementStatus` in the image job's usage JSON as `complete`,
`partial`, or `unavailable`. An absent provider usage object still produces
zero token/cost placeholders for the existing numeric AI-run columns, but
`unavailable` explicitly means **unknown provider spend, not free generation**.
Partial token receipts may understate actual cost; reconcile against provider
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
