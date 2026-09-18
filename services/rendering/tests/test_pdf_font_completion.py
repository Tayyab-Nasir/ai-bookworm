"""Prove complete embedded-edition PDF resources, including incidental fonts."""
import copy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys

import pytest
from pypdf import PdfReader
from reportlab.pdfbase import pdfmetrics

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))
from editions import PrintEdition
from pdf_renderer import render_pdf
from print_fonts import code_font, print_font_issues

BOOK = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text())
CONFIG = {"kind": "print", "typography": {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"}}


def _marked(index, marks, kind="paragraph"):
    text = f"Caf\u00e9 code {index}"
    return {"id": f"n{index}", "type": kind, "text": text, "attributes": {"richText": [
        {"type": "text", "text": text, "marks": [{"type": mark} for mark in marks]}]}}


def _fonts(reader):
    return {str(font["/BaseFont"]): font for page in reader.pages
            for ref in page["/Resources"]["/Font"].values() for font in [ref.get_object()]}


@pytest.mark.parametrize("numbering", ["arabic", "roman", "none"])
def test_embedded_edition_has_no_base_fonts_including_code_tables_lists_and_numbering(numbering):
    book = copy.deepcopy(BOOK)
    book["chapters"][0]["nodes"] = [
        _marked(index, marks) for index, marks in enumerate([
            [], ["bold"], ["italic"], ["bold", "italic"], ["code"],
            ["code", "bold"], ["code", "italic"], ["code", "bold", "italic"],
        ])
    ] + [_marked(8, ["code"], "listItem"),
         {"id": "nested", "type": "listItem", "text": "Nested", "attributes": {"listDepth": 1, "listStyle": "ordered"}},
         {"id": "grid", "type": "table", "rows": [["Caf\u00e9", "Table"]]},
         {"id": "caption", "type": "caption", "text": "Caf\u00e9 caption"}]
    edition = PrintEdition.model_validate({**CONFIG, "page_numbering": {"style": numbering}})
    data, digest = render_pdf(book, edition)
    assert render_pdf(book, edition) == (data, digest)
    reader = PdfReader(BytesIO(data))
    fonts = _fonts(reader)
    assert len(fonts) == 8, list(fonts)
    for name, font in fonts.items():
        assert "BitstreamVera" in name or "DejaVuSansMono" in name
        assert len(font["/FontDescriptor"]["/FontFile2"].get_data()) > 1000
        assert "/ToUnicode" in font
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert all(f"Caf\u00e9 code {index}" in text for index in range(9))
    assert "Nested" in text and "Caf\u00e9 caption" in text and "Table" in text
    assert not print_font_issues(book, CONFIG)
    actual_faces = {}
    for page in reader.pages:
        def capture(value, cm, tm, font, size):
            if value.strip().startswith("Caf\u00e9 code"):
                actual_faces[value.strip()] = str(font["/BaseFont"])
        page.extract_text(visitor_text=capture)
    for index, expected in enumerate(("DejaVuSansMono", "DejaVuSansMono-Bold",
                                      "DejaVuSansMono-Oblique", "DejaVuSansMono-BoldOblique"), 4):
        assert actual_faces[f"Caf\u00e9 code {index}"].endswith("+" + expected)
    for suffix in ("", "-Bold", "-Italic", "-BoldItalic"):
        font = "BookwormDejaVuSansMono" + suffix
        assert pdfmetrics.stringWidth("iii", font, 11) == pdfmetrics.stringWidth("WWW", font, 11)


def test_legacy_font_choices_are_not_silently_substituted():
    book = copy.deepcopy(BOOK)
    book["chapters"][0]["nodes"] = [_marked(0, ["code"]), _marked(1, ["italic"])]
    data, _ = render_pdf(book, PrintEdition())
    fonts = _fonts(PdfReader(BytesIO(data)))
    assert {"/Times-Roman", "/Times-Italic", "/Helvetica", "/Helvetica-Bold", "/Courier"} <= set(fonts)
    assert not any("DejaVu" in font or "Bitstream" in font for font in fonts)
    assert code_font("Times-Roman") == "Courier"


@pytest.mark.parametrize("body,heading", [
    ("BookwormVera-Bold", "BookwormVera"),
    ("BookwormVera-Bold", "BookwormVera-Bold"),
])
def test_bold_embedded_settings_keep_all_resources_embedded(body, heading):
    book = copy.deepcopy(BOOK)
    book["chapters"][0]["nodes"] = [_marked(0, ["code"], "heading"),
                                   _marked(1, ["code", "italic"])]
    config = {"kind": "print", "typography": {"body_font": body, "heading_font": heading}}
    data, digest = render_pdf(book, PrintEdition.model_validate(config))
    assert render_pdf(book, PrintEdition.model_validate(config)) == (data, digest)
    for font in _fonts(PdfReader(BytesIO(data))).values():
        assert "/FontFile2" in font["/FontDescriptor"]
    assert not print_font_issues(book, config)


def test_embedded_code_glyph_check_matches_the_font_actually_printed():
    book = copy.deepcopy(BOOK)
    node = _marked(0, ["code", "bold", "italic"])
    node["text"] = node["attributes"]["richText"][0]["text"] = "\u6f22"
    book["chapters"][0]["nodes"] = [node]
    issues = print_font_issues(book, CONFIG)
    assert len(issues) == 1 and "BookwormDejaVuSansMono-BoldItalic" in issues[0]["message"]
    with pytest.raises(ValueError, match="U\\+6F22"):
        render_pdf(book, PrintEdition.model_validate(CONFIG))


def test_vendored_fonts_match_official_release_bytes_and_keep_license():
    expected = {
        "DejaVuSansMono.ttf": "b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582",
        "DejaVuSansMono-Bold.ttf": "bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769",
        "DejaVuSansMono-Oblique.ttf": "742097840c541870e8d6dc5c9b37bb1ceeea6c0dedd1d475faf903ef9df734b0",
        "DejaVuSansMono-BoldOblique.ttf": "91713a71d550bba22c2a6b2bb2a9ad8f9a159e12e4e9f0a5b2677998ba21213e",
    }
    for filename, digest in expected.items():
        assert hashlib.sha256((RENDERING / "fonts" / filename).read_bytes()).hexdigest() == digest
    license_text = (RENDERING / "fonts/LICENSE-DejaVu.txt").read_text(encoding="utf-8")
    assert "Bitstream, Inc." in license_text and "Tavmjong Bah" in license_text
