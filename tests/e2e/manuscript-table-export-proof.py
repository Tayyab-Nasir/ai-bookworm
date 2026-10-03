"""Render the exact table captured by manuscript-table-browser.mjs; no hosted calls.

Usage: node scripts/run-python.mjs tests/e2e/manuscript-table-export-proof.py TABLE_JSON
Requires EPUBCHECK_JAR pointing to the reviewed EPUBCheck 5.4.0 JAR.
"""
import io
import json
import sys
import tempfile
import zipfile
from dataclasses import asdict
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "rendering"))
sys.path.insert(0, str(ROOT / "services" / "document"))
from editions import EbookEdition, PrintEdition
from epub_renderer import render_epub
from epubcheck_runner import run_epubcheck
from manuscript import table_spans
from parsers.epub_parser import parse_epub
from pdf_renderer import render_pdf
from pypdf import PdfReader


def main():
    table = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    assert table["attributes"]["tableSpanSource"].startswith("v2:")
    assert table_spans(table, table["rows"]) == table["attributes"]["tableSpans"]
    book = json.loads((ROOT / "tests/fixtures/books/valid_book.json").read_text())
    book["chapters"] = [{**book["chapters"][0], "nodes": [table]}]
    book["assets"] = []
    epub, epub_hash = render_epub(book, EbookEdition(kind="ebook"))
    pdf, pdf_hash = render_pdf(book, PrintEdition(kind="print", trim_size="6x9"))
    with zipfile.ZipFile(io.BytesIO(epub)) as archive:
        root = ET.fromstring(archive.read("OEBPS/ch0000.xhtml"))
        ns = {"h": "http://www.w3.org/1999/xhtml"}
        assert root.find('.//h:thead/h:tr/h:th[@colspan="2"]', ns) is not None
        assert root.find('.//h:tbody/h:tr/h:td[@rowspan="2"]', ns) is not None
    imported, _ = parse_epub(epub)
    restored = next(n for ch in imported["chapters"] for n in ch["nodes"] if n["type"] == "table")
    assert restored["rows"] == table["rows"], "EPUB roundtrip changed table text"
    assert restored["attributes"]["tableSpans"] == table["attributes"]["tableSpans"]
    pdf_text = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)
    for text in ("Mira revised", "Captain", "Harbor", "Navigator", "Sea"):
        assert pdf_text.count(text) == 1, f"PDF missing or duplicating {text!r}"
    result = run_epubcheck(epub)
    assert result.status == "valid" and result.errors == 0 and result.warnings == 0, result
    output = Path(tempfile.mkdtemp(prefix="bookworm-edited-table-proof-"))
    (output / "book.epub").write_bytes(epub)
    (output / "book.pdf").write_bytes(pdf)
    print(json.dumps({"status": "passed", "epubcheck": asdict(result), "epubSha256": epub_hash,
                      "pdfSha256": pdf_hash, "output": str(output)}))


if __name__ == "__main__":
    main()
