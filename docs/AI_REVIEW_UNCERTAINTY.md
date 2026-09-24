# Paid AI review: uncertain provider outcomes

Writer, proofreader, copyeditor and consistency requests reserve paid text
capacity when queued. The worker now records `provider_dispatched_at` in the
database **before** making the HTTP request to the AI service. Once set, an
expired worker lease is not eligible for automatic redispatch. This can hold
a job even if the process dies between the marker and the actual call; that
is the conservative boundary needed to avoid charging OpenAI twice.

The AI service now reserves each paid review job in a private, durable
`ai_review_service_receipts` table before provider execution and saves the
response before returning it. A matching replay returns the saved result;
an unresolved reservation refuses another provider call. The service's
read-only job lookup can recover a saved result after a lost worker reply.
This does not itself settle a held job: operator-controlled reconciliation
and a safe completion/release route remain necessary.

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
RPC. A supervised recovery/release
workflow, provider organization-usage reconciliation and native hosted
acceptance remain open before selling this as fully hands-off generation.

The additive migrations `20260924190000_ai_review_uncertain_hold.sql` and
`20260924200000_ai_review_service_receipts.sql` are source-only. They have
not been applied to the hosted Supabase project; deploying the worker before
them would leave dispatch marking or receipt reservation unavailable and
must fail before provider execution. This change does not enable Book Bible
candidate generation or change retail pricing.
