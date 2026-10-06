"""Render the exact saved manuscript from the mounted editor, not parallel fixtures.

Requires EPUBCHECK_JAR for independent EPUBCheck 5.4.0 acceptance.
No provider, listening service, hosted Storage or publishing requests.
"""
import io
import json
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/rendering"))
sys.path.insert(0, str(ROOT / "services/document"))
from editions import EbookEdition, PrintEdition
from epub_renderer import render_epub
from epubcheck_runner import run_epubcheck
from pdf_renderer import render_pdf
from parsers.epub_parser import parse_epub
from pypdf import PdfReader


def main():
    nodes = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    items = [n for n in nodes if n["type"] == "listItem"]
    assert [(n["id"], n["attributes"]["listStart"]) for n in items] == [("first", 12), ("child", 3), ("next", 13), ("restart", 2)]
    assert items[0]["text"].endswith(" edited")
    book = json.loads((ROOT / "tests/fixtures/books/valid_book.json").read_text())
    book["chapters"] = [{**book["chapters"][0], "nodes": nodes}]
    book["assets"] = []
    epub, epub_hash = render_epub(book, EbookEdition())
    pdf, pdf_hash = render_pdf(book, PrintEdition(typography={"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"}))
    assert render_epub(book, EbookEdition())[1] == epub_hash
    with ZipFile(io.BytesIO(epub)) as archive:
        root = ET.fromstring(archive.read("OEBPS/ch0000.xhtml"))
    lists = root.findall(".//{http://www.w3.org/1999/xhtml}ol")
    assert [(el.get("start"), el.get("type")) for el in lists] == [("12", "A"), ("3", "A"), ("2", "1")]
    restored, _ = parse_epub(epub)
    again = [n for ch in restored["chapters"] for n in ch["nodes"] if n["type"] == "listItem"]
    assert [(n["text"], n["attributes"]["listStart"], n["attributes"]["listNumberStyle"]) for n in again] == [
        (n["text"], n["attributes"]["listStart"], n["attributes"]["listNumberStyle"]) for n in items]
    reader = PdfReader(io.BytesIO(pdf))
    text = "\n".join(page.extract_text() for page in reader.pages)
    for label in ("L.", "C.", "M.", "2."):
        assert label in text
    for item in items:
        assert text.count(item["text"]) == 1
    for page in reader.pages:
        for ref in page["/Resources"]["/Font"].values():
            font = ref.get_object()
            descriptor = font.get("/FontDescriptor")
            assert descriptor and "/FontFile2" in descriptor.get_object(), "Print label/text font is not embedded"
    result = run_epubcheck(epub)
    assert result.status == "valid" and result.errors == 0 and result.warnings == 0, result
    output = Path(tempfile.mkdtemp(prefix="bookworm-edited-numbering-proof-"))
    (output / "book.epub").write_bytes(epub)
    (output / "book.pdf").write_bytes(pdf)
    print(json.dumps({"status": "passed", "epubcheck": asdict(result), "epubSha256": epub_hash,
                      "pdfSha256": pdf_hash, "output": str(output)}))


if __name__ == "__main__":
    main()
