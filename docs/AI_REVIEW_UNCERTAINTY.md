# Paid AI review: uncertain provider outcomes

Writer, proofreader, copyeditor and consistency requests reserve paid text
capacity when queued. The worker now records `provider_dispatched_at` in the
database **before** making the HTTP request to the AI service. Once set, an
expired worker lease is not eligible for automatic redispatch. This can hold
a job even if the process dies between the marker and the actual call; that
is the conservative boundary needed to avoid charging OpenAI twice.

The OpenAI Responses client disables SDK retries. An API transport/status
error propagates as an uncertain paid outcome rather than a normal failed
agent result. If the worker loses the service reply, receives a non-success
or invalid response, or cannot confirm database completion, it tries to mark
the running job `ai_provider_outcome_unconfirmed`. That clears its lease but
keeps its `running` status and operational credit hold. It creates a private
dead-letter incident. No customer usage event is written on that path. A
lost marker reply stops before the provider call; the database marker, if it
was written, still blocks lease-based redispatch.

The author sees a request-specific warning in the AI panel. Support can
inspect the existing admin AI job list and incident queue. Do **not** reset
the marker, lease, job status, or receipt by age alone; age does not prove the
provider did no work. This slice does not yet provide an operator resolution
RPC or durable generic review-result receipt. A supervised recovery/release
workflow, provider organization-usage reconciliation and native hosted
acceptance remain open before selling this as fully hands-off generation.

The additive migration `20260924190000_ai_review_uncertain_hold.sql` is
source-only. It has not been applied to the hosted Supabase project; deploying
the worker before that migration would leave dispatch marking unavailable
and must fail before provider execution. This change does not enable Book
Bible candidate generation or change retail pricing.
