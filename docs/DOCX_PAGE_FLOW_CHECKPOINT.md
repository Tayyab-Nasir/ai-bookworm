# DOCX page-flow checkpoint — 2026-10-23

Status: locally verified import/editor/export fix. This is not full product,
hosted-worker, funded-provider, printer or retailer acceptance.

## Behavior

- Authored Word page breaks now survive DOCX import as canonical `pageBreak`
  nodes, including breaks within a run and intentional consecutive breaks.
  Text, supported marks, tabs and soft line breaks keep their order.
- Paragraph `pageBreakBefore` follows the nearest style definition; an explicit
  false value overrides inheritance. A boundary already supplied by a chapter
  or preceding page break does not create an extra blank page.
- Custom paragraph styles based on heading styles, and direct `outlineLvl`,
  are recognized. Outline level 9 explicitly means body text; levels beyond
  the editor's six levels are clamped with a review warning. Invalid levels
  fail with an actionable import error. Cyclic style inheritance is bounded.
- Cached `lastRenderedPageBreak` markers are not authored breaks. Hyperlink
  labels are preserved without following URLs or importing field instructions.
  Column breaks retain separated text and produce a layout-review warning.
- PDF renderer `pdf-1.18.0` preserves each explicit break. Its automatic
  chapter boundary reuses a preceding authored break, rather than inserting
  an accidental blank page. An author's deliberate blank page remains.

No schema migration, paid AI call, entitlement change, external file fetch,
runtime restart, or production deployment is part of this change.

## Verification

The new parser regression suite was red before implementation and green after
the fix. The composed export proof reproduced collapsed blank pages before
the renderer fix.

Current local results:

- All workspace TypeScript typechecks passed.
- Python service suites: **737 passed**.
- Python end-to-end suite: **18 passed**.
- Separate security suite: **48 passed**, including two subtests.
- Focused existing web editor/table tests: **12 passed**.
- New DOCX page-flow unit cases: **15**, included in the service total.
- New composed journeys: **2**, included in the end-to-end total, with and
  without a print table of contents.

The composed journeys use a synthetic DOCX, the real authenticated in-process
document endpoint, the real web editor serializers and Book Model schema, and
the real EPUB/PDF renderer. They verify block/chapter identity, text uniqueness,
page placement, deterministic repeated rendering, artifact hashes, source-file
immutability, EPUB semantic re-import, and actual **EPUBCheck 5.4.0** with zero
errors and warnings. They do not simulate a hosted browser or saved Storage
transaction. The services and end-to-end suites run in separate processes, as
the repository scripts intend, to keep their authentication fixtures isolated.

Existing warnings: one deliberate duplicate-ZIP-member fixture in the service
suite; two BeautifulSoup XML-as-HTML warnings on the composed EPUB re-imports.
These warnings are reported, not suppressed.

Synthetic evidence is kept outside tracked source at
`.git/bookworm-tracking/page-flow-proof-20261023/`:

- `no-toc/`: six-page PDF, four authored breaks; PDF SHA-256
  `60d7abc620d230f66795b42d637877b54547f435a9863b3e03958704001b0912`.
- `with-toc/`: seven-page PDF, four authored breaks; PDF SHA-256
  `8318498405aaaba733fc037fbeba141a12772f5d6a3453151e48fca9dafdda31`.
- Each directory contains the source DOCX, EPUB, PDF and receipt. The two
  contact sheets were visually inspected: deliberate blank page present,
  chapters correctly placed, no duplicate heading or extra boundary page.

## Scope and continuation

This is body-paragraph/page-flow fidelity, not a promise of pixel-identical
Word reproduction. Word section layouts, multiple columns, headers/footers,
footnotes, tracked changes and OCR are not established by these tests. Readers
can paginate reflowable EPUB differently; the canonical structure survives.

The live database upgrade is separately recorded in
`docs/evidence/supabase-upgrade-applied-2026-10-23.json`: 110 migrations applied.
Do not rerun the earlier pending-migration plan. That upgrade used a verified
application-only recovery snapshot, not a full Auth/Storage/settings backup.

Next: run native author/files CI on the exact saved commit, then finish the
private local/hosted services setup and verify the real author journey. Redis,
service configuration, fresh Google-login confirmation, funded OpenAI/catalog
acceptance and full operational recovery are separate launch gates. Mobile is
parked; Stripe remains deferred; paid-AI credit gates stay enforced.

The shared Obsidian continuation is
`Codex Sessions/2026-10/2026-10-23-docx-page-flow.md`. Graphify was used to trace
the parser/editor/renderer ownership; its AST-only refresh is local context,
not production acceptance.

Primary implementation references:
[Word breaks](https://python-docx.readthedocs.io/en/latest/dev/analysis/features/text/breaks.html),
[paragraph formatting](https://python-docx.readthedocs.io/en/latest/dev/analysis/features/text/paragraph-format.html),
and [python-docx text API](https://python-docx.readthedocs.io/en/latest/api/text.html).
