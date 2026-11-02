"""The package reading direction must match the author-selected reflowable EPUB."""
import copy
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import EbookEdition
from epub_renderer import _opf, render_epub, RENDERER_VERSION

BOOK = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/books/valid_book.json").read_text())
NS = {"o": "http://www.idpf.org/2007/opf"}


@pytest.mark.parametrize("language, preference, override, direction", [
    ("en", "auto", None, "ltr"),
    ("ar", "auto", None, "rtl"),
    ("en", "auto", "fa-Arab", "rtl"),
    ("en", "rtl", None, "rtl"),
    ("ar", "ltr", None, "ltr"),
    ("ar", "auto", "en", "ltr"),
])
def test_package_page_progression_follows_effective_language_and_explicit_preference(language, preference, override, direction):
    book = copy.deepcopy(BOOK)
    book["metadata"]["language"] = language
    before = copy.deepcopy(book)
    edition = EbookEdition(text_direction=preference, metadata_overrides={"language": override} if override else {})
    output = render_epub(book, edition)
    assert render_epub(book, edition) == output
    assert book == before
    with zipfile.ZipFile(io.BytesIO(output[0])) as archive:
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        nav = ET.fromstring(archive.read("OEBPS/nav.xhtml"))
        chapter = ET.fromstring(archive.read("OEBPS/ch0000.xhtml"))
        assert opf.find("o:spine", NS).get("page-progression-direction") == direction
        assert nav.get("dir") == direction
        assert chapter.get("dir") == direction
        assert opf.find("o:spine/o:itemref", NS) is not None


def test_fixed_layout_package_direction_is_unchanged():
    edition = EbookEdition(flow="fixed", text_direction="rtl")
    opf = ET.fromstring(_opf(BOOK, edition, [], "ar", None, []))
    assert opf.find("o:spine", NS).get("page-progression-direction") is None


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="native Poppler is required")
def test_real_fixed_layout_output_retains_spine_direction_and_records_renderer_version():
    # Fixed output uses _opf through the real PDF and Poppler pipeline.
    output, digest = render_epub(BOOK, EbookEdition(flow="fixed", text_direction="ltr"))
    assert len(digest) == 64
    with zipfile.ZipFile(io.BytesIO(output)) as archive:
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        assert opf.find("o:spine", NS).get("page-progression-direction") is None
        meta = opf.find("o:metadata/o:meta[@property='bookworm:renderer']", NS)
        assert meta is not None and meta.text == RENDERER_VERSION == "epub-1.14.0"
        assert any(name.startswith("OEBPS/images/page") for name in archive.namelist())
