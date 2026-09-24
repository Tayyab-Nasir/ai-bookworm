# Table header fidelity — 2026-09-24

Bookworm preserves explicitly designated leading column-header rows when a
manuscript table comes from DOCX or EPUB. A DOCX row must carry Word's
`w:tblHeader` flag; an EPUB row must be inside its own table's `<thead>` or
consist entirely of `<th>` cells that are not marked as row headers. The
canonical table keeps the original text grid and records the number of
leading header rows as `attributes.tableHeaderRows`.

The author can mark the first row as headers, or remove the marking, in the
manuscript table editor. EPUB export emits `<thead>` and scoped `<th>` cells.
Print PDF export differentiates the header visually and repeats it when the
table flows onto another page. Invalid header metadata is ignored; an edit
that makes the saved grid stale continues to show the latest canonical text
instead of resurrecting old cells.

This is deliberately limited to leading column-header rows. Merged cells,
row-header associations, nested tables, complex Word table formatting and
full accessible-table certification are not supported yet. Authors should
compare complex tables against the original before publishing. The source
DOCX/EPUB remains available as the import reference; no source file is
silently rewritten.

Local evidence: DOCX → Book Model → EPUB → Book Model round-trip tests,
multi-page print PDF header repetition, editor model tests, and real
EPUBCheck 5.4.0 validation of a header-bearing EPUB. Hosted import/Storage
and retailer acceptance remain separate release gates.
