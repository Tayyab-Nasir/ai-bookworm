# Manuscript numbering and unsaved-draft fidelity

Started 2026-10-05; author-page recovery verified 2026-10-06 (Asia/Karachi).
This is an implementation checkpoint, not product or retailer acceptance.

## Author behavior

Real DOCX paragraph numbering now reads direct and inherited Word properties,
abstract definitions, level/start overrides, suppression and counter restarts.
EPUB import preserves list starts, per-item value changes, nested styles and
reversed lists. Canonical `BookNode.attributes` retains each item's ordinal,
one of five safe marker styles, depth and optional reversed direction.
The editor and renderers split genuinely restarted or discontinuous lists.
Existing unnumbered/bullet documents remain compatible; converting to bullets
or paragraphs removes stale numbering metadata.

The actual Tiptap editor uses its installed native ordered-list extension and
attributes. Authors can choose decimal, upper/lower alphabetic or Roman
markers, change the start and reverse direction. Keyboard input remains
focused. Overflow/underflow is rejected before the save callback, with a
visible correction message. No new dependency or schema migration is needed.

A real mounted author-page regression exposed an additional data-loss gap:
invalid visible edits were not reported to the parent as unsaved. Validation
state now participates in its existing unload/link/chapter/create/restore
guards, disables normal and shortcut saves, and marks the AI assistant dirty.
The current invalid text can be downloaded; the installed native serializer
also retains text from preserved canonical blocks such as tables. Correcting
numbering clears validation and allows a versioned save. This download is
plain text, not a formatting-preserving book export.

Invalid visible text also supplies the displayed word count, so the counter
and draft-text download describe the same current draft. Native inside list
markers stay on the cream manuscript canvas at 375px and desktop widths,
while nested lists and subsequent continuation paragraphs remain separate.
No clipping, new dependency or custom marker painter is used.

## Deterministic output and limits

`epub-1.13.0` emits semantic ordered-list start/type/reversed attributes.
`pdf-1.17.0` writes literal markers and measures their width so alphabetic
numbering continues Z, AA, AB rather than ReportLab's native wrap to A.
Native PDF inspection checks actual text markers and embedded font streams.

Ordinals are bounded to 1–1,000,000. Roman print numbering above 3,999 is
rejected with a correction instruction. Missing/unsupported Word definitions
and compound/custom prefixes or suffixes produce explicit review warnings;
they are not claimed exact. Seven canonical nesting levels remain the limit.
Automatic numbered-heading fidelity, complex Word layout/headers/footers,
custom bullets, OCR and full international-script/RTL print remain separate
import/rendering acceptance work. This change does not certify those features.

## Verification

The initial real-archive regression failed four Python checks and the editor
restart check. Final focused evidence is 59 Python/8 editor-model tests.
A subsequent actual author-page RED failed its unsaved-unload assertion while
the five editor-only checks passed. Separate regressions then reproduced
long-marker paint outside the mobile canvas and a stale invalid-draft word
counter. The final eight mounted checks pass with
compiled project Tailwind, actual editor/author-page/chapter/history code,
in-memory API transports and an AI prop observer. The observer proves the
parent's dirty contract, not real paid AI execution.

The initially faint table screenshot was a test-fixture defect, not a proven
application defect. Its missing doctype put the table into quirks mode.
The fixture now matches the application's standards-mode HTML and asserts
both `CSS1Compat` and actual composited-background contrast of at least 4.5:1.
`ManuscriptTable.tsx` remains unchanged. Desktop/mobile screenshots also
verify contained markers, continuation paragraphs and the current word count.

Independent proof consumes the exact mounted editor's saved canonical JSON,
not a parallel fixture. EPUBCheck reports valid/zero errors/zero warnings;
EPUB reimport preserves the edited list text/start/style, and PDF text/font
inspection preserves L/C/M/2 markers with all font streams embedded.
EPUB SHA-256: `fb29b3e5abbff035ac24eedbce7fe33d42ebb069e4109963c05b05807060d21f`.
PDF SHA-256: `07b34169ce99cb0cb60df840ffcc1cf6df9ef95cf99bb31e1ed96e8fbfd48b3a`.
The manual proof is `tests/e2e/editor-numbering-export-proof.py`, not a
collected `test_*.py`; it must not be conflated with the regular E2E suite.

Durable local logs are under `.git/bookworm-tracking/`:
`manuscript-numbering-mounted-20261005-draft-guard-red.log`,
`manuscript-numbering-mounted-20261005-canvas-red.log`,
`manuscript-numbering-mounted-20261005-word-count-red.log`,
`manuscript-numbering-mounted-20261005-checkpoint-final.log`,
`manuscript-numbering-proof-20261005-checkpoint-final.log` and
`manuscript-numbering-verify-20261005-checkpoint-final.log`.
Final full verification exits 0: eight workspace typechecks, 633 API/161 web,
105 disposable migrations/67 SQL suites/seven narration serial gates,
437 services/12 E2E/44 security plus two subtests, no-5xx load smoke and six
deterministic evaluations. Live-provider evaluation is disabled only in that
subprocess. No independent global lint or coverage acceptance is claimed.

Production-build acceptance requires an isolated export of the exact reviewed
Git index, with all eight workspace aliases resolving inside that snapshot.
Build/tree/commit identities and final artifacts are recorded in the shared
vault's `Codex Sessions/2026-10/2026-10-06-manuscript-numbering-fidelity.md`;
a successful local build is not deployment or product acceptance.

## Reviewed scope and continuation

Own scope: `RichBookEditor.tsx`, `BookEditorClient.tsx`,
`book-editor-model.ts`, `editor-model.test.ts`,
`editor-numbering-mounted.mjs`, DOCX/EPUB parsers, `docx_numbering.py`,
`test_list_numbering.py`, `manuscript.py`, EPUB/PDF renderers, the manual
export proof and this checkpoint. Preserve unrelated dirty Next/config,
handoff/operations/release and generated graph work.

No live migration, customer/provider/payment action, commercial activation,
worker deployment, retailer submission or hosting is performed here.
Native narration proof remains pinned to its earlier SQL/harness commit;
it is not hosted Auth/Storage/provider acceptance for these editor changes.
Continue the full author/editor/Bible/canon/artwork/cover/QR/layout/metadata/
translation/analytics/mobile/design/runtime and release requirements.
Operator OAuth, approved rates, native private-byte/provider/worker recovery,
speech quality/mastering, backups/observability and real author/retailer
acceptance remain open. Full goal stays active.
