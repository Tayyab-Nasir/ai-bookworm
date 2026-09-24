# Unconfirmed image hold: operator release

An OpenAI image request can time out after the provider accepted it. Bookworm
does not automatically retry, mark that job failed, or assume the provider
did no work. The author sees a pending request and its operational image
credit stays reserved. The provider may have billed Bookworm even though no
image reached the author.

`20260924150000_image_manual_hold_release.sql` adds an operator-only,
atomic release for an aged `running` illustration/cover job without a saved
completion receipt, usage debit, AI run or output reference. It marks the
job failed **without charging the author** and inserts the incident audit in
the same transaction. A late `complete_image_job` then rejects the failed
job. It does not delete storage or provider artifacts, make a provider call,
or attest that OpenAI did not bill Bookworm. The function is executable only
by service role, and the API route also requires a configured platform admin.

Before releasing a hold:

1. Confirm the request is at least 15 minutes old and still `running`.
   Refresh job status, asset history and any private completion receipt.
2. Inspect the private storage inventory for this job's workspace and
   generated-image path. If an image or receipt exists, recover/finalize it
   instead of releasing the hold. Do not use an uploaded file's absence in
   the public UI as proof that private storage is empty.
3. Review OpenAI organization usage or provider support for the time window.
   Record any provider cost as Bookworm's operational incident cost, not an
   author debit; a missing per-request receipt may prevent precise matching.
4. Open a secret-free internal incident with an uppercase reference such as
   `INC-123456`. In Admin → Jobs → AI generation → running image job,
   provide the reference and confirm both review checks. The database
   rechecks eligibility and writes an audit row atomically.
5. Refresh the admin job and audit record, then have the author refresh image
   history. The old idempotency key remains failed and cannot regenerate;
   the author may explicitly start a new request when ready.

Do **not** release on a timer alone. The checkboxes are operator attestations,
not automated proof. An uncertain provider charge is a platform reconciliation
issue; this flow only ends an unserviceable customer hold. If the RPC reply
is lost, inspect job status and audit before retrying. Hosted migration,
native multi-connection races, provider usage review, storage inventory and
admin/browser acceptance remain release gates.
