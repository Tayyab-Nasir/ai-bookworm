# Native author pipeline checkpoint — 2026-10-06

This is a local integration checkpoint, not full-product or hosted acceptance.

## Implemented

- The shared canonical edit engine rejects UTF-16 ranges that bisect surrogate
  pairs, invalid replacement Unicode, and invalid offsets before changing data.
  Human and AI replacements/splits share this validation. Valid astral text,
  rich formatting, immutable input and split/merge fidelity remain supported.
- Python service E2E now applies typed operations through the actual TypeScript
  engine used by the API; it no longer substitutes Python string slicing.
- A one-book DOCX journey exercises real parsing and formatting, review-only
  proofreading and explicit Apply, version/hash-grounded Book Bible candidates,
  explicit canon approval, grounded metadata and explicit metadata approval,
  version-pinned illustration placement, cover/QR rendering, native EPUB/PDF,
  deterministic preflight and checksum-identical retailer packages.
- Forged Book Bible hashes and foreign metadata references are rejected without
  canon/metadata writes. Model/provider outputs and human approvals remain
  deterministic fixtures; no paid dispatch or hosted persistence is implied.
- Verification CI now configures Java and EPUBCheck 5.4.0 using the same official
  release URL and SHA-256 pin as the existing processing container. CI permissions
  are read-only. A workflow edit is not an executed hosted CI result.

## Runnable verification

Install the existing workspace/service dependencies and Java, then point
`EPUBCHECK_JAR` at the reviewed EPUBCheck 5.4.0 distribution's `epubcheck.jar`.
No OpenAI key or hosted credentials are needed for these tests.

```text
npm test -w @bookworm/book-model
npm run typecheck
node scripts/run-python.mjs -m pytest tests/e2e -q -s
npm run verify
```

The one-book matrix covers reflowable ebook packages for KDP, Apple, Barnes &
Noble and Google Play, outer-bleed paperbacks for KDP/Barnes & Noble and all-edge
bleed for Lulu. Checks inspect semantic XHTML and OPF metadata, actual illustration
pixels in EPUB/PDF, exact QR modules and composed cover pixels, 36 interior pages,
32 chapter bookmarks, exact render bytes inside packages and deterministic replay.
Final artifact directories are generated under `bookworm-native-author-pipeline-*`;
they are test content, never customer books or a proof of retailer submission.

## Current evidence and remaining work

Initial regression: 29/30 model tests passed and the surrogate-boundary rejection
failed. After the shared engine repair, 30/30 model tests and model types pass.
The first native attempt caught a test-side raw-HTML versus rich-run semantic
text assertion. The second exposed an unconfigured checker, not a valid EPUB
result. Both failed attempts remain recorded; neither was relabeled as a pass.
With the reviewed native checker configured, the preceding two-layout matrix
and existing E2E suite passed 15/15 with no skipped test. The expanded three-layout
matrix and full verifier are terminal exit 0: model 30/30, workspace types,
launcher/unit, 633 API/161 web, 105 disposable migrations/67 SQL assertion files,
seven narration gates, 437 service tests, 16 E2E tests, 44 security tests plus two
subtests, 50-request load without 5xx and six deterministic evaluation cases pass.
EPUBCheck reports valid with zero errors/warnings on the composed ebook. The
validation child excludes operator secrets; its skipped live evaluation does
not establish whether the operator has configured an API key. No independent
lint or coverage percentage is claimed. Isolated production-build/browser
confirmation and selective Git state are tracked in the shared phase; only
their terminal evidence satisfies those additional checkpoint gates.

No hosted Auth/PostgREST/RLS/private Storage/scanner, real provider generation,
funded ledger/lease recovery, Google OAuth operator setup, retailer acceptance,
production observability/backups, audio, international print/RTL or mobile/device
acceptance is established by this checkpoint. No live migration, deployment,
payment, provider spend or publishing submission is performed. Continue the
complete author UI/runtime journey and those release gates; do not substitute
these private-service tests or ZIP exports for the requested publishing OS.

Exact retained logs, candidate/Git state and next steps are in the shared vault:
`Codex Sessions/2026-10/2026-10-06-native-author-pipeline.md`.
