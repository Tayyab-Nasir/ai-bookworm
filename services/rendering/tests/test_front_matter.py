"""Actual front-matter artifacts, escaping, bounds and font safety."""
import copy
import io
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import parse_edition
from epub_renderer import render_epub
from pdf_renderer import render_pdf
from print_fonts import print_font_issues

BOOK = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/books/valid_book.json").read_text())
FRONT = {"copyright_notice": "Copyright 2026 Ada & Co.\n<permission required>", "publisher": "Finch & Fox"}


@pytest.mark.parametrize("kind", ["print", "ebook"])
def test_front_matter_artifacts(kind):
    book = copy.deepcopy(BOOK)
    book["metadata"].update(title="A & B", subtitle="A <journey>", author="Ada Finch", isbn13="9780306406157")
    config = {"kind": kind, "front_matter": FRONT}
    if kind == "ebook":
        config.update(include_title_page=True, metadata_overrides={"author": "Edition Author"})
    edition = parse_edition(config)
    render = render_pdf if kind == "print" else render_epub
    data, checksum = render(book, edition)
    assert render(book, edition) == (data, checksum)
    if kind == "print":
        pages = PdfReader(io.BytesIO(data)).pages
        first, second = pages[0].extract_text(), pages[1].extract_text()
        assert all(text in first for text in ("A & B", "A <journey>", "Ada Finch"))
        assert all(text in second for text in (*FRONT["copyright_notice"].splitlines(), FRONT["publisher"], "9780306406157"))
        assert len(pages) == len(PdfReader(io.BytesIO(render(book, parse_edition({"kind": kind}))[0])).pages) + 1
    else:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            title = ET.fromstring(archive.read("OEBPS/title-page.xhtml"))
            rights = ET.fromstring(archive.read("OEBPS/copyright-page.xhtml"))
            assert "Edition Author" in "".join(title.itertext())
            assert "A <journey>" in "".join(title.itertext())
            assert "<permission required>" in "".join(rights.itertext())
            assert not rights.findall(".//permission")
            opf = ET.fromstring(archive.read("OEBPS/content.opf"))
            ns = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
            assert [item.attrib["idref"] for item in opf.findall("o:spine/o:itemref", ns)][:3] == ["title-page", "copyright-page", "ch0000"]
            assert opf.find("o:metadata/dc:publisher", ns).text == FRONT["publisher"]
            assert opf.find("o:metadata/dc:rights", ns).text == FRONT["copyright_notice"]
            for item in opf.findall("o:manifest/o:item", ns):
                assert "OEBPS/" + item.attrib["href"] in archive.namelist()


def test_empty_front_matter_preserves_legacy_epub_and_does_not_invent_rights():
    data, _ = render_epub(BOOK, parse_edition({"kind": "ebook"}))
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert "OEBPS/copyright-page.xhtml" not in archive.namelist()
        assert "OEBPS/title-page.xhtml" not in archive.namelist()
        assert b"dc:rights" not in archive.read("OEBPS/content.opf")


@pytest.mark.parametrize("field,limit", [("copyright_notice", 3000), ("publisher", 200)])
@pytest.mark.parametrize("kind", ["print", "ebook"])
def test_front_matter_bounds(field, limit, kind):
    parse_edition({"kind": kind, "front_matter": {field: "x" * limit}})
    with pytest.raises(ValueError):
        parse_edition({"kind": kind, "front_matter": {field: "x" * (limit + 1)}})


def test_print_front_matter_glyphs_fail_with_located_findings():
    config = {"kind": "print", "front_matter": {"publisher": "出版"}}
    assert any(item["location"] == "edition.front_matter.publisher" for item in print_font_issues(BOOK, config))
    with pytest.raises(ValueError):
        render_pdf(BOOK, parse_edition(config))
