# Publishing Studio scope and recovery checkpoint

Date: 2026-10-05. This is a verified local implementation checkpoint, not
whole-product or hosted release acceptance.

## Author-facing changes

Publishing actions now capture the confirmed book and view epoch. Changing
book, selecting/creating an edition or unmounting invalidates their replies.
Save, render, preflight, retailer-package creation/history, narration history,
Google Play export/cancellation/history and background export polling cannot
write an old result, error, success notice or loading-state reset into a new
view. An obsolete save also cannot begin follow-on audio-history requests.
Navigation does not cancel work already accepted by the server or trigger
replacement generation; its original durable history remains recoverable.

A save can legitimately adopt its own newly created edition identity and load
that edition's history. Current-view errors remain visible and allow explicit
retry. Google Play export retries retain their original idempotency key;
an old export's reply cannot erase a newer view's uncertain attempt key.
This adds no provider request, payment, token allowance or retailer submission.

The previous book's form, error and unsaved-change warning are cleared while
the new identity loads. Controls stay locked until that identity is confirmed,
including after a failed load. A keyboard-accessible "Retry loading this book"
button retries the read-only identity/settings/history requests. Switching
audio editions clears the previous edition's export identifier, cover choice
and success notice. Read-only members may view history but cannot cancel exports.

## Executed verification

The original mounted save regression failed with
`save released another view's loading lock`. A second regression confirmed that
the previous book's error remained visible during a new identity load. A
current-view export-history retry also exposed an error that survived successful
refresh. The implementation fixes these causes rather than relaxing assertions.

`node --test apps/web/tests/narration-quote-mounted.mjs` passes all 43 tests.
They mount the actual React parent/child components using in-memory transports;
no Next listener, provider or live Storage request is involved. New cases cover
success/failure before and after new-book loading, every pending publishing
action, edition changes, unmount, save's second-stage history, current-view
success/error/retry, creation of a new audiobook edition, read-only controls,
identity retry and export-attempt key ownership. Existing narration paid
consent/recovery and component CSS/focus/reduced-motion tests remain passing.
The harness is not full Next navigation, production Tailwind, hosted Auth or
private-byte/retailer acceptance.

The current complete `npm run verify` also passes: all eight workspace type
checks, launcher/model/validation checks, 633 API and 158 web tests, 105
disposable migrations/67 SQL assertion files and linked fixtures, seven serial
narration gates, 425 Python service tests, 12 E2E, 44 security plus two subtests,
50-request load smoke without 5xx and six deterministic evals (5/5 must-find,
zero false positives). Live provider evaluation was forcibly disabled only in
the verification subprocess; the operator's environment was not changed.
No global coverage percentage or configured lint execution is claimed.

Detailed local logs, isolated production-build identity, Git checkpoint and
next steps are retained in the shared Obsidian note:
`Codex Sessions/2026-10/2026-10-05-publishing-scope-recovery.md`.

## Separate native and release boundaries

Narration's extended SQL harness is committed at
`a5a5dbae1a0260515983c2131ceb8a41f1b53bdb`; native PostgreSQL run
[37305407312](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/37305407312)
actually passed all 36 narration lock-wait schedules and seven serial gates.
See [narration checkpoint](NARRATION_TRANSPORT_CHECKPOINT.md) for exact evidence.
Native fixture schemas and synthetic receipts are not hosted GoTrue/PostgREST,
real Storage/scanner/provider/supervised-worker or audio fidelity/QC acceptance.

Continue the complete author/editor/Book Bible/canon/illustration/cover/QR,
layout/preflight, metadata, translation, analytics, mobile, international-script,
hosted/operator, backup/observability and retailer release requirements. Keep
commercial catalogs and purchase gates closed until operator-approved rates
and live acceptance. Do not bypass the denied Next test-listener launch or
infer deployment, migration, provider/payment spending or publishing authority
from this checkpoint. The full product goal remains active and incomplete.
