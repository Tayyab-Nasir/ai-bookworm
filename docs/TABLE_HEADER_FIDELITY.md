# Table header and rectangular merge fidelity — 2026-09-30

Bookworm preserves explicitly designated leading column-header rows when a
manuscript table comes from DOCX or EPUB. A DOCX row must carry Word's
`w:tblHeader` flag; an EPUB row must be inside its own table's `<thead>` or
consist entirely of `<th>` cells that are not marked as row headers. The
canonical table keeps the original text grid and records the number of
leading header rows as `attributes.tableHeaderRows`.

Simple rectangular merged cells now retain a top-left anchor and empty
covered grid positions. DOCX grid identity and EPUB `rowspan`/`colspan` map to
`attributes.tableSpans`; EPUB export writes the same spans, and print PDF uses
merged table cells. A hash of the imported grid is stored with the spans so
author edits to table text invalidate old merge layout rather than applying
it to new content. The EPUB importer caps the table at 2,000 rows and 100
columns before expanding spans. Renderer fingerprints are `epub-1.10.0` and
`pdf-1.14.0` for this changed output.

The author can mark the first row as headers, or remove the marking, in the
manuscript table editor. EPUB export emits `<thead>` and scoped `<th>` cells.
Print PDF export differentiates the header visually and repeats it when the
table flows onto another page. Invalid header metadata is ignored; an edit
that makes the saved grid stale continues to show the latest canonical text
instead of resurrecting old cells.

This is still limited to leading column-header rows and simple rectangular
spans. Row-header associations, nested tables, irregular merges, complex
Word table formatting, visual merge editing in the author UI, and full
accessible-table certification are not supported yet. The author grid editor
shows covered positions as blanks; editing its text discards span layout on
the next export. Authors should compare complex tables against the original
before publishing. The source DOCX/EPUB remains available as the import
reference; no source file is silently rewritten.

Local evidence: DOCX → Book Model → EPUB → Book Model round-trip tests,
multi-page print PDF header repetition, editor model tests, and real
EPUBCheck 5.4.0 validation of a header-bearing EPUB. Native isolated
processing-container [run 35958694353](https://github.com/Tayyab-Nasir/ai-bookworm/actions/runs/35958694353)
also passed the generated DOCX header through Google EPUB packaging. Hosted import/Storage
and retailer acceptance remain separate release gates.

The 2026-09-30 merge extension has local parser/renderer tests only; the
older EPUBCheck and container run above predate it and must not be treated as
validation of merged-cell output.
