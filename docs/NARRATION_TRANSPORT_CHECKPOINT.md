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

## Funded worker integration — 2026-10-05

The uncommitted integration now includes immutable segment/whole-chapter
offers, private quote review/recovery, atomic all-segment exact-credit/AI-voice
funding, legacy generation retirement, current writer/source-fenced dispatch,
service leases, original dispatch-lease PCM receipts, private encoded MP3
receipts and database-derived measured atomic completion. The actual
`narration-quotes` worker verifies private bytes/hashes, original strict usage
and transcript agreement, renews/aborts on lease loss and recovers lost
upload/receipt/completion replies without fresh generation or caller billing.
Missing/corrupt/unsupported original evidence stays held/unknown for review.
No post-dispatch refund or redispatch is inferred from a timeout or lost reply.

The private native encoder uses bounded fixed-profile PCM-to-MP3 conversion.
Its TypeScript adapter checks returned checksum/profile/duration and caps the
body. The worker's real Supabase SDK transport now disables SDK retries, bounds
headers and body consumption to 60 seconds, rejects redirects, caps Storage at
12 MiB / metadata at 16 MiB and aborts on shutdown. SDK body failures can reject
after headers rather than return an error object; tested recovery preserves
original evidence in either case. Fourteen launcher roles exist; the fleet
excludes the retired unquoted narrator. See `docs/WORKER_RUNTIME.md`.

Executed current-source evidence: `narration-completion-recovery-sql-second-20261005.log`
passes 105 migrations/67 SQL assertion files and all paid/segmentation/offer/
funded fixtures, including Unicode normalization, expired encoded leases,
replacement-worker recovery and an actual late after-settlement rollback.
This supersedes the JavaScript Unicode-escape parser failure, not native race
acceptance. `narration-network-worker-coverage-20261005.log` passes 27 focused
adapter/worker/real-SDK-with-injected-fetch tests; scoped aggregate coverage is
98.19% lines / 85.00% branches / 80.56% functions. The adapter alone has 62.50%
function coverage and the shared transport 71.43%; these are not global coverage.

`narration-network-full-verify-20261005.log` completed with exit 0 using explicit
project Python: all workspace types, three launcher checks, 617 API/155 web
tests, 105 disposable migrations/67 SQL suites and linked fixtures, 425 Python
services/12 E2E/40 security, 50-request no-5xx load smoke and six deterministic
evals. Live-provider evals were skipped. This is historical network-phase
evidence, superseded for the author bundle by the executed checks below.

## Paid author acceptance and history

Whole-chapter acceptance/status HTTP, client and strict OpenAPI contracts now
exist. New purchases require the default-closed operator gate, a matching
approved catalog, current writing access, exact original maximum token credits
and separate AI-voice/generation consents. Single-part purchases are unsupported.
Read-only recovery does not need current prices or new acceptance. The author
checkpoint stores only scoped opaque offer/retry identities and persists an
attempt marker before POST. Uncertain replies remain recover-only across reloads,
without automatic re-POST, replacement offers or private billing/source copies.

Publishing Studio refreshes history on confirmed acceptance, fencing late data,
error and finally callbacks by book/edition/view. API/client history exposes
quoted versus operational billing; only an absent legacy mode falls back.
Unknown/null modes fail before segment reads or signing. Quoted history displays
the original maximum token-credit budget, not measured charges; legacy units
are labeled separately. Existing private audio/QC/download/export is retained.
History/detail now have documented strict public project/download contracts,
including mandatory AI disclosure, legacy voices/speeds and 300-second links.
Malformed IDs return private/no-store 404s before client/database access.

The earlier author integration passes 53 focused checks and 24 mounted browser
checks (cold accepted/read-only, lost/uncertain replies, storage failure, late
book/edition/unmount, parent/manual history and 375/768/1440px consent/focus).
Saved actual narrow/desktop screenshots were inspected; fixtures are not a
hosted/full Next author journey. Its isolated 812-file source snapshot builds
22/22 static pages; manifest and exact limitations are in the vault checkpoint.

## Native race preparation and latest verification

`tests/security/native-narration-lifecycle.mjs` uses production quote arithmetic
and real complete-chapter save/fund/lease/dispatch/release RPCs. Both disposable
runners execute four serial fixture gates: all-child funding and replay with
competing-wallet rollback, pre-dispatch release, stale-lease reclaim and one-way
post-dispatch recovery/no refund. No provider or Storage evidence is fabricated.
The native runner additionally wires sixteen real multi-session schedules:
three acceptance/wallet/replay orders, eight member/source change and rollback
orders, and five dispatch/release/reclaim orders. These require actual observed
PostgreSQL lock waits; serial success is not execution of those schedules.
`psql` and Docker are absent locally. Native CI acceptance remains pending.

`narration-native-contract-full-verify-20261005.log` completed with exit 0:
all workspace types, 633 API/158 web tests, 105 disposable migrations/67 SQL
suites plus four new serial fixture gates, 425 Python services/12 E2E/43 security,
50-request no-5xx load smoke and six deterministic evals. Live-provider evals
were explicitly skipped in the verification process, not globally disabled.
Focused history/UUID tests pass 13/13 and contract tests pass 13/13. No configured
workspace lint gate or whole-product coverage percentage is claimed.

The exact-current-source isolated build completed with exit 0: Next 15.5.25,
22/22 static pages and completed traces. Its manifest captured 813 source files
at `2026-10-05T10:53:57.877Z`, digest
`a8a91907c3c27172a75b784a865f839dcccbbfee3c60e76db2c57f82ed0397f5`;
all source fingerprints were independently rechecked before this documentation
update. All eight workspace aliases resolve inside the snapshot. Only the
candidate's generated `next-env.d.ts` changed; the shared generated files were
not adopted. The AST refresh also completed with exit 0: 6,020 nodes, 11,270
edges, 495 communities and zero dangling endpoints. Two Gradle partial-extraction
warnings remain indexing limitations, not app-build failures. Neither result is
native concurrency, provider, hosted runtime or full-product acceptance.

GitHub readback shows the preceding commit's native run failed before database
testing because `tsx` was not installed. The reviewed workflow fix installs
locked Node dependencies before invoking the existing disposable PostgreSQL 16
runner. Fresh native execution is still required; no success is inferred from
the workflow change. The build branch's Vercel Git deployment guard keeps a
source checkpoint separate from hosting.

Next: selective reviewed secret-free Git checkpoint and an exact staged-tree
build; actually execute and inspect native race/Storage/provider/worker
acceptance. Native bounded PCM-to-MP3 already exists; finish real speech source
fidelity, pronunciation/mastering/listening-QC and retailer audio acceptance.
Continue the full authoring, Bible/canon, illustration/cover/QR, layout/preflight,
translation, dashboard, hosted/operator and retailer release requirements. No
catalog/purchase activation, deployment, migration or provider/payment spending
is authorized by this document. Do not work around the denied test-server launch.

Official sources checked for the workload-specific migration:
[OpenAI TTS deprecations](https://developers.openai.com/api/docs/deprecations),
[Realtime Mini model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
and [out-of-band/custom-input responses](https://developers.openai.com/api/docs/guides/realtime-conversations).

Continuation: `docs/AGENT_HANDOFF.md` and the shared vault's
`Codex Sessions/2026-10/2026-10-05-narration-transport-checkpoint.md`.
