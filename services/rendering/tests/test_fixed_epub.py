"""Real paginated fixed EPUB, using the locally installed Poppler executable."""
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import EbookEdition
from epub_renderer import render_epub

BOOK = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/books/valid_book.json").read_text())
NS = {"o": "http://www.idpf.org/2007/opf", "x": "http://www.w3.org/1999/xhtml"}


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="native Poppler is required")
def test_fixed_layout_custom_trim_changes_real_page_geometry_and_typography():
    def pages(layout):
        data, _ = render_epub(BOOK, EbookEdition(flow="fixed", navigation="none", fixed_layout=layout))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            images = [archive.read(name) for name in archive.namelist() if name.startswith("OEBPS/images/page")]
        with Image.open(io.BytesIO(images[0])) as bitmap:
            dimensions = bitmap.size
        return images, dimensions

    regular, dimensions = pages({"trim_size": "7x10"})
    assert dimensions == (1260, 1800)
    changed, changed_dimensions = pages({"trim_size": "7x10", "margins": {"top": 1.5, "inner": 1.5},
                                         "typography": {"body_font": "Courier", "body_size_pt": 20, "leading": 28}})
    assert changed_dimensions == dimensions
    assert changed != regular
    assert len(changed) >= len(regular)


def test_fixed_layout_model_roundtrip_and_validation():
    edition = EbookEdition(flow="fixed")
    assert edition.fixed_layout.typography.body_font == "BookwormVera"
    assert EbookEdition.model_validate(edition.model_dump()) == edition
    for layout in [{"trim_size": "wrong"}, {"typography": {"body_font": "wrong"}},
                   {"typography": {"body_size_pt": 20, "leading": 10}}]:
        with pytest.raises(ValueError):
            EbookEdition(flow="fixed", fixed_layout=layout)


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="native Poppler is required")
@pytest.mark.parametrize("title_page", [True, False])
def test_fixed_epub_has_real_pages_dimensions_and_chapter_destinations(title_page):
    edition = EbookEdition(flow="fixed", include_title_page=title_page, navigation="toc+landmarks",
                          front_matter={"publisher": "Harbor Press"})
    first = render_epub(BOOK, edition)
    assert render_epub(BOOK, edition) == first
    with zipfile.ZipFile(io.BytesIO(first[0])) as archive:
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        assert any(item.attrib.get("property") == "rendition:layout" and item.text == "pre-paginated"
                   for item in opf.findall("o:metadata/o:meta", NS))
        manifest = {item.attrib["id"]: item.attrib["href"] for item in opf.findall("o:manifest/o:item", NS)}
        spine = opf.findall("o:spine/o:itemref", NS)
        page_refs = [item.attrib["idref"] for item in spine if item.attrib["idref"] != "nav"]
        assert len(page_refs) >= len(BOOK["chapters"]) + 1 + int(title_page)
        alternatives = []
        for ref in page_refs:
            page = ET.fromstring(archive.read("OEBPS/" + manifest[ref]))
            image = page.find("x:body/x:img", NS)
            alternatives.append(image.attrib["alt"])
            with Image.open(io.BytesIO(archive.read("OEBPS/" + image.attrib["src"]))) as bitmap:
                assert bitmap.format == "PNG"
                assert bitmap.width == int(image.attrib["width"])
                assert bitmap.height == int(image.attrib["height"])
                assert max(bitmap.size) == 1800
            assert page.find("x:head/x:meta", NS).attrib["name"] == "viewport"
        assert "Harbor Press" in " ".join(alternatives)
        nav = ET.fromstring(archive.read("OEBPS/nav.xhtml"))
        toc = nav.find("x:body/x:nav", NS)
        links = toc.findall(".//x:a", NS)
        assert len(links) == len(BOOK["chapters"])
        for link in links:
            page = ET.fromstring(archive.read("OEBPS/" + link.attrib["href"]))
            assert link.text in page.find("x:body/x:img", NS).attrib["alt"]


def test_fixed_epub_missing_converter_is_actionable_and_reflowable_unaffected(monkeypatch):
    monkeypatch.setenv("BOOKWORM_PDFTOPPM", "bookworm-no-such-converter")
    with pytest.raises(ValueError, match="requires local Poppler"):
        render_epub(BOOK, EbookEdition(flow="fixed"))
    assert render_epub(BOOK, EbookEdition())[0].startswith(b"PK")


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="native Poppler is required")
def test_fixed_cover_landmarks_and_reading_order():
    art = io.BytesIO()
    Image.new("RGB", (1200, 1800), "#284f65").save(art, "PNG")
    edition = EbookEdition(flow="fixed", include_title_page=True, navigation="toc+landmarks",
                          front_matter={"publisher": "Harbor Press"})
    data, _ = render_epub(BOOK, edition, art.getvalue())
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        spine = [el.attrib["idref"] for el in opf.findall("o:spine/o:itemref", NS)]
        assert spine[:4] == ["page0000", "page0001", "page0002", "nav"]
        nav = ET.fromstring(archive.read("OEBPS/nav.xhtml"))
        links = {el.attrib.get("{http://www.idpf.org/2007/ops}type"): el.attrib["href"]
                 for el in nav.findall(".//x:a", NS)}
        assert links["cover"] == "page0000.xhtml"
        assert links["titlepage"] == "page0001.xhtml"
        assert links["copyright-page"] == "page0002.xhtml"
        assert links["bodymatter"] == "page0003.xhtml"
        assert archive.read("OEBPS/images/page0000.png") == art.getvalue()


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="native Poppler is required")
def test_fixed_converter_failure_is_safe_and_temporary_files_are_removed(monkeypatch):
    import fixed_epub
    seen = []
    def fail(arguments, **kwargs):
        seen.append(Path(arguments[-1]))
        assert seen[-1].is_file()
        class Result:
            returncode = 1
            stdout = b""
            stderr = b"private worker diagnostics"
        return Result()
    monkeypatch.setattr(fixed_epub.subprocess, "run", fail)
    with pytest.raises(ValueError, match="returned an invalid image") as error:
        render_epub(BOOK, EbookEdition(flow="fixed"))
    assert "private" not in str(error.value)
    assert seen and not seen[0].exists()
