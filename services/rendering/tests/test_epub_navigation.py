"""Saved EPUB navigation choices must change actual reading order and landmarks."""
import io
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editions import EbookEdition
from epub_renderer import render_epub

BOOK = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/books/valid_book.json").read_text())
NS = {"x": "http://www.w3.org/1999/xhtml", "o": "http://www.idpf.org/2007/opf"}
TYPE = "{http://www.idpf.org/2007/ops}type"


@pytest.mark.parametrize("navigation", ["toc", "toc+landmarks", "none"])
@pytest.mark.parametrize("front", [False, True])
def test_navigation_mode_has_valid_targets_and_correct_reading_order(navigation, front):
    config = {"navigation": navigation, "include_title_page": front, "text_direction": "rtl",
              "metadata_overrides": {"title": "A & B <Journey>"}}
    if front:
        config["cover"] = {"asset_id": "cover-fixture"}
        config["front_matter"] = {"publisher": "Harbor Press"}
    edition = EbookEdition(**config)
    result = render_epub(BOOK, edition, b"fixture-cover" if front else None)
    assert render_epub(BOOK, edition, b"fixture-cover" if front else None) == result
    with zipfile.ZipFile(io.BytesIO(result[0])) as archive:
        nav = ET.fromstring(archive.read("OEBPS/nav.xhtml"))
        opf = ET.fromstring(archive.read("OEBPS/content.opf"))
        assert nav.attrib["dir"] == "rtl"
        assert "A & B <Journey>" in "".join(nav.itertext())
        toc = next(el for el in nav.findall(".//x:nav", NS) if el.attrib.get(TYPE) == "toc")
        assert ("hidden" in toc.attrib) == (navigation == "none")
        assert len(toc.findall(".//x:a", NS)) == len(BOOK["chapters"])
        spine = [item.attrib["idref"] for item in opf.findall("o:spine/o:itemref", NS)]
        assert ("nav" in spine) == (navigation != "none")
        if navigation != "none":
            assert spine.index("nav") < spine.index("ch0000")
            if front:
                assert spine.index("copyright-page") < spine.index("nav")
        landmarks = [el for el in nav.findall(".//x:nav", NS) if el.attrib.get(TYPE) == "landmarks"]
        assert len(landmarks) == (1 if navigation == "toc+landmarks" else 0)
        if landmarks:
            types = {el.attrib[TYPE] for el in landmarks[0].findall(".//x:a", NS)}
            assert types == ({"toc", "bodymatter", "cover", "titlepage", "copyright-page"} if front else {"toc", "bodymatter"})
        for link in nav.findall(".//x:a", NS):
            path, _, fragment = link.attrib["href"].partition("#")
            assert "OEBPS/" + path in archive.namelist()
            if fragment:
                target = ET.fromstring(archive.read("OEBPS/" + path))
                assert any(el.attrib.get("id") == fragment for el in target.iter())
