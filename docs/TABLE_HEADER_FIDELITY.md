# Table header and rectangular merge fidelity — 2026-10-03

Bookworm preserves explicitly designated leading column-header rows when a
manuscript table comes from DOCX or EPUB. A DOCX row must carry Word's
`w:tblHeader` flag; an EPUB row must be inside its own table's `<thead>` or
consist entirely of `<th>` cells that are not marked as row headers. The
canonical table keeps the original text grid and records the number of
leading header rows as `attributes.tableHeaderRows`.

Simple rectangular merged cells now retain a top-left anchor and empty
covered grid positions. DOCX grid identity and EPUB `rowspan`/`colspan` map to
`attributes.tableSpans`; EPUB export writes the same spans, and print PDF uses
merged table cells. A structural hash of the grid is stored with the spans.
The dedicated table editor preserves valid merges while updating text and
the hash together; out-of-band edits invalidate stale layout rather than
applying it to different content. The EPUB importer caps the table at 2,000 rows and 100
columns before expanding spans. This output was introduced with renderer
fingerprints `epub-1.10.0` and `pdf-1.14.0`; later renderer versions also
retain this support.

The author can mark the first row as headers, or remove the marking, in the
manuscript table editor. The editor previews imported merges and supports
rectangular selection, merge and split. Merging joins text in reading order;
splitting keeps that text in the top-left cell. Structural actions have
separate Undo boundaries, so undoing a merge does not undo adjacent typing.
Partial merges and spans crossing the header/body boundary are rejected.
Read-only members see the table without edit controls. EPUB export emits
`<thead>` and scoped `<th>` cells.
Print PDF export differentiates the header visually and repeats it when the
table flows onto another page. Invalid header metadata is ignored; an edit
that makes the saved grid stale continues to show the latest canonical text
instead of resurrecting old cells.

This is still limited to leading column-header rows and simple rectangular
spans. Row-header associations, nested tables, irregular merges, complex
Word table formatting, and full accessible-table certification are not
supported yet. Authors should compare complex tables against the original
before publishing. The source DOCX/EPUB remains available as the import
reference; no source file is silently rewritten.

Local evidence: DOCX → Book Model → EPUB → Book Model round-trip tests,
multi-page print PDF header repetition, editor model tests, and real
EPUBCheck 5.4.0 validation of a header-bearing EPUB. Native isolated
processing-container [run 35958694353](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/35958694353)
also passed the generated DOCX header through Google EPUB packaging. Hosted import/Storage
and retailer acceptance remain separate release gates.

The 2026-09-30 merge extension additionally passed the official,
checksum-pinned [EPUBCheck 5.4.0](https://github.com/w3c/epubcheck/releases/tag/v5.4.0)
against an exact local DOCX → merged-header/body EPUB proof: zero errors
and zero warnings. The EPUB SHA-256 is
`a443c56c485628cd45c04efb53a50212a4c0c0e82e747b148959e8382d3deef9`.
The older container run above predates this change. This one synthetic
proof does not establish accessible-table certification, every imported
layout, hosted Storage behavior or retailer acceptance.

## Editor and cross-runtime proof

The editor's v2 stamp is `v2:` plus SHA-256 of compact UTF-8 JSON rows. This
binds cell boundaries even when cells contain tabs/newlines. Python import
and render use the same representation; legacy text-only stamps still read.
This requires renderer versions `epub-1.12.0` / `pdf-1.16.0` or newer.

On 2026-10-03 the isolated browser journey passed imported merge preview,
typing, merge, Undo, split, invalid header crossing, save/reload, 390 px
mobile containment and read-only access. The exact browser-saved node was
rendered by Python and re-imported from EPUB with identical rows and spans.
PDF text extraction retained each expected cell value once. EPUBCheck 5.4.0
returned valid with zero errors/warnings; EPUB SHA-256:
`06bf0629e7d62765cbb1bbe2acc6175aa399561ed92527f6bce3c153b173a41f`.
Auth/API persistence in this journey is synthetic, not hosted acceptance.

Reproduce against an isolated Next app and `auth-browser-fixture.mjs`:

```powershell
$env:BROWSER_TEST_ORIGIN = 'http://localhost:4498'
$env:BROWSER_TEST_FIXTURE_ORIGIN = 'http://127.0.0.1:4499'
$env:BROWSER_TEST_TABLE_JSON = Join-Path $env:TEMP 'bookworm-browser-saved-table.json'
node tests/e2e/manuscript-table-browser.mjs
# Set EPUBCHECK_JAR to the reviewed EPUBCheck 5.4.0 JAR before this step.
node scripts/run-python.mjs tests/e2e/manuscript-table-export-proof.py $env:BROWSER_TEST_TABLE_JSON
```

The proof writes PDF/EPUB artifacts to a new temporary directory and prints
their hashes. It fails if the exact EPUB cannot be validated; it does not
download a validator, call providers, publish or use hosted data.
