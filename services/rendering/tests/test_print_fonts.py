"""Validate font streams and readable text in the actual generated PDF."""
import copy
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))
from editions import PrintEdition
from pdf_renderer import render_pdf
from preflight import run_preflight
from print_fonts import print_font_issues
from rules import load_ruleset

BOOK = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text())
CONFIG = {"kind": "print", "typography": {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"}}


def test_embedded_family_preserves_accents_and_all_marked_faces_deterministically():
    book = copy.deepcopy(BOOK)
    book["metadata"]["title"] = "Caf\u00e9, No\u00ebl & cr\u00e8me"
    nodes = []
    for index, marks in enumerate([[], ["bold"], ["italic"], ["bold", "italic"]]):
        text = f"Caf\u00e9 {index}"
        nodes.append({"id": f"p{index}", "type": "paragraph", "text": text,
                      "attributes": {"richText": [{"type": "text", "text": text,
                                                    "marks": [{"type": mark} for mark in marks]}]}})
    book["chapters"][0]["nodes"] = nodes
    edition = PrintEdition.model_validate(CONFIG)
    data, checksum = render_pdf(book, edition)
    assert render_pdf(book, edition) == (data, checksum)
    reader = PdfReader(io.BytesIO(data))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert book["metadata"]["title"] in text
    assert all(f"Caf\u00e9 {index}" in text for index in range(4))
    embedded = {}
    for page in reader.pages:
        for ref in page["/Resources"]["/Font"].values():
            font = ref.get_object()
            if "BitstreamVera" in font.get("/BaseFont", ""):
                descriptor = font["/FontDescriptor"]
                embedded[str(font["/BaseFont"])] = descriptor["/FontFile2"].get_data()
                assert "/ToUnicode" in font
    assert len(embedded) == 4
    assert all(len(font) > 1000 for font in embedded.values())
    assert not print_font_issues(book, CONFIG)


@pytest.mark.parametrize("node", [
    {"type": "paragraph", "text": "Missing \u6f22"},
    {"type": "heading", "text": "Missing \u6f22"},
    {"type": "table", "rows": [["Missing \u6f22"]]},
    {"type": "image", "caption": "Missing \u6f22"},
    {"type": "listItem", "text": "Missing \u6f22"},
])
def test_missing_glyph_is_located_and_direct_render_refuses_it(node):
    book = copy.deepcopy(BOOK)
    book["chapters"][0]["nodes"] = [{"id": "unsupported", **node}]
    issues = print_font_issues(book, CONFIG)
    assert len(issues) == 1
    assert "node:unsupported" in issues[0]["location"]
    assert "U+6F22" in issues[0]["message"]
    with pytest.raises(ValueError, match="U\\+6F22"):
        render_pdf(book, PrintEdition.model_validate(CONFIG))


def test_inline_code_and_stale_table_use_the_actual_printed_text_and_font():
    book = copy.deepcopy(BOOK)
    book["chapters"][0]["nodes"] = [
        {"id": "code", "type": "paragraph", "text": "\u6f22", "attributes": {"richText": [
            {"type": "text", "text": "\u6f22", "marks": [{"type": "code"}]}]}},
        {"id": "table", "type": "table", "text": "Corrected", "rows": [["\u6f22"]]},
    ]
    issues = print_font_issues(book, CONFIG)
    assert len(issues) == 1 and "BookwormDejaVuSansMono" in issues[0]["message"]
    assert "node:code" in issues[0]["location"]
    assert not print_font_issues(book, {"kind": "ebook"})


def test_preflight_reports_glyph_failure_without_trying_to_render(monkeypatch):
    spec = importlib.util.spec_from_file_location("bookworm_glyph_service", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-font-token")
    book = copy.deepcopy(BOOK)
    book["metadata"]["title"] = "Unsupported \u6f22"
    with TestClient(module.app) as client:
        payload = {"bookModel": book, "editionConfig": CONFIG}
        headers = {"x-service-token": "fixture-font-token"}
        preflight = client.post("/preflight", headers=headers, json=payload)
        render = client.post("/render", headers=headers, json=payload)
    assert preflight.status_code == 200
    findings = [f for f in preflight.json()["findings"] if f["code"] == "PRINT_GLYPH_UNSUPPORTED"]
    assert findings and findings[0]["severity"] == "error"
    assert findings[0]["location"] == "book.metadata.title"
    assert render.status_code == 422 and "U+6F22" in render.json()["detail"]


def test_bundled_and_supported_base_fonts_are_not_flagged_as_missing():
    for font in ("BookwormVera", "BookwormVera-Bold", "Courier-Bold"):
        findings = run_preflight({"book": BOOK, "edition": {"kind": "print", "typography": {
            "body_font": font, "heading_font": font}}}, load_ruleset())
        assert not [f for f in findings if f.code in {"FONT_NOT_EMBEDDED", "PRINT_GLYPH_UNSUPPORTED"}]
