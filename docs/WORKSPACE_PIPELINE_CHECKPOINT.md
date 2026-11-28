# Workspace execution pipeline

The workspace dashboard now includes the four durable execution queues:
manuscript imports, AI generation, publishing, and Google Play audiobook
exports. Narration/translation segment jobs are already AI jobs, so their
project rows are not counted a second time. Provider token-counting quote
preparation remains in each book's individual studio; this is an execution
ledger, not a claim to show all background processes.

Each queue has exact queued/running and failed totals over saved history. The
dashboard shows the newest twelve execution jobs, merging a bounded twelve-job
sample per queue with deterministic timestamp/kind/ID ordering. Recent history
is not an exhaustive list of older active work. Missing counts, malformed rows,
incomplete library scope, or unavailable queues fail visibly instead of becoming
false zeroes. Every queue read uses the caller's RLS client; the existing service
client remains confined to paid usage/entitlement/own-ledger reads.

Only safe job identifiers, status, timestamps and allowlisted labels/destinations
are returned. Publishing action is projected with `request_json->>action`; no
full request, input, output, snapshot, raw error, checksum or private storage path
is fetched for these summaries. Real `validate` and legacy `preflight` both read
as channel preflight; unknown actions never become an invented render. Actual
`bookbible` and `story_blueprint` agent names route to their correct studios.

The same label/destination helper serves the per-book desk, which now includes
audiobook export history. One shared frontend link builder produces only local,
UUID-scoped destinations. AI writing/review links carry the exact saved `aiJob`
ID; import links open the saved editor; artwork links retain workspace scope.
Opening a link never retries generation, adopts a proposal or spends credits.
Dashboard navigation refuses a job pointer for a book outside its loaded scope.

The existing editorial black/serif identity remains. A compact definition-list
queue ledger sits above recent jobs, with keyboard-visible focus and 44px job
links. Package counts are explicitly historical: neither a saved package nor a
succeeded preflight establishes current bytes, retailer approval, sales or
physical-print acceptance. There are no fake progress percentages.

## Verification gates

Use a reviewed clean source export so shared mobile/Next/Stripe drafts do not
enter acceptance accidentally. Relevant commands:

```text
npm run verify
node --test apps/web/tests/analytics-admin-mounted.mjs apps/web/tests/book-overview-mounted.mjs apps/web/tests/book-workspace-navigation-mounted.mjs
node node_modules/next/dist/bin/next build apps/web
```

The native author/files CI workflow also runs the mounted workspace checks,
then uses real SSR/BFF cookies, RLS, import/publishing jobs and service-side
exact counts to verify the four-queue dashboard. It checks actual `validate`
labels, mobile containment and read-only navigation to the saved imported
manuscript. Isolated fixtures cover failed/queued imports and audiobook exports
without funding an audiobook or granting production allowances. Native zero
counts are real zeroes, not evidence of funded audiobook acceptance.

Exact source, terminal verification receipts, current runtime ownership and
continuation steps belong in the shared Codex session note. A build or a green
local fixture alone does not establish hosted/provider/retailer acceptance.

Mobile remains parked and Stripe deferred. This change adds no dependency,
migration, hosted deployment, provider key, purchase enablement or paid call.
The full publishing product remains incomplete until its funded, hosted,
recovery and retailer/physical-print requirements are independently accepted.
