"""Prevent unshaped mixed RTL output; this is not RTL rendering support."""
import copy
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))
from cover_renderer import compose_front_cover
from editions import EbookEdition, PrintEdition
from epub_renderer import render_epub
from pdf_renderer import render_pdf
from print_fonts import print_font_issues
from rtl_text import cover_rtl_issues, requires_bidi_layout
from wrap_cover import render_wrap_cover

BOOK = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text())
COVER = "11111111-1111-4111-8111-111111111111"
PRINT = {"kind": "print", "typography": {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"}}


def book_with(node):
    book = copy.deepcopy(BOOK)
    book["metadata"]["language"] = "en"
    book["chapters"][0]["nodes"] = [{"id": "mixed", **node}]
    return book


@pytest.mark.parametrize("node", [
    {"type": "paragraph", "text": "سلام", "attributes": {"richText": [
        {"type": "text", "text": "سلام", "marks": [{"type": "code"}]}]}},
    {"type": "paragraph", "text": "English שלום 123"},
    {"type": "heading", "text": "Preface \u2067note\u2069"},
    {"type": "table", "rows": [["English سلام"]]},
    {"type": "image", "caption": "Scene سلام"},
])
def test_print_rejects_actual_rtl_text_even_under_latin_language(node):
    book = book_with(node)
    issues = print_font_issues(book, PRINT)
    assert any("node:mixed" in item["location"] and "bidirectional shaping" in item["message"] for item in issues)
    with pytest.raises(ValueError, match="bidirectional shaping"):
        render_pdf(book, PrintEdition.model_validate(PRINT))


def test_fixed_epub_rejects_before_poppler_and_reflowable_remains_available(monkeypatch):
    import fixed_epub
    monkeypatch.setattr(fixed_epub.shutil, "which", lambda _: "synthetic-poppler")
    book = book_with({"type": "paragraph", "text": "سلام", "attributes": {"richText": [
        {"type": "text", "text": "سلام", "marks": [{"type": "code"}]}]}})
    assert print_font_issues(book, EbookEdition(flow="fixed").model_dump())
    with pytest.raises(ValueError, match="bidirectional shaping"):
        render_epub(book, EbookEdition(flow="fixed"))
    assert not print_font_issues(book, EbookEdition(flow="reflowable").model_dump())
    data, _ = render_epub(book, EbookEdition(flow="reflowable"))
    assert data.startswith(b"PK")


@pytest.mark.parametrize("flow", ["print", "fixed"])
def test_preflight_reports_source_location_and_render_fails_before_artifact(flow, monkeypatch):
    spec = importlib.util.spec_from_file_location("bookworm_mixed_rtl_main", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "synthetic-render-token")
    book = book_with({"type": "paragraph", "text": "سلام", "attributes": {"richText": [
        {"type": "text", "text": "سلام", "marks": [{"type": "code"}]}]}})
    config = PRINT if flow == "print" else {"kind": "ebook", "flow": "fixed"}
    with TestClient(module.app) as client:
        headers = {"x-service-token": "synthetic-render-token"}
        preflight = client.post("/preflight", headers=headers, json={"bookModel": book, "editionConfig": config,
            "channel": "kdp", "includeArtifact": True})
        assert preflight.status_code == 200
        assert any(item["code"] == "RTL_TEXT_UNSUPPORTED" and "node:mixed" in item["location"]
                   and "bidirectional shaping" in item["message"] for item in preflight.json()["findings"])
        rendered = client.post("/render", headers=headers, json={"bookModel": book, "editionConfig": config})
        assert rendered.status_code == 422 and "bidirectional shaping" in rendered.text


def test_cover_only_checks_text_actually_painted_and_reports_qr_and_wrap_locations():
    image = io.BytesIO(); Image.new("RGB", (100, 150), "white").save(image, format="PNG")
    book = copy.deepcopy(BOOK); book["metadata"].update({"language": "en", "title": "Story שלום"})
    cover = {"asset_id": COVER, "title_on_cover": False, "subtitle_on_cover": False, "author_on_cover": False}
    assert not cover_rtl_issues(book["metadata"], {"kind": "ebook", "cover": cover})
    assert compose_front_cover(image.getvalue(), book, EbookEdition(cover=cover))[0]
    cover["title_on_cover"] = True
    with pytest.raises(ValueError, match="bidirectional shaping"):
        compose_front_cover(image.getvalue(), book, EbookEdition(cover=cover))
    cover["title_on_cover"] = False
    cover["qr_code"] = {"enabled": True, "url": "https://example.test", "label": "سلام"}
    issues = cover_rtl_issues(book["metadata"], {"kind": "ebook", "cover": cover})
    assert issues[0]["location"] == "edition.cover.qr_code.label"
    with pytest.raises(ValueError, match="bidirectional shaping"):
        compose_front_cover(image.getvalue(), book, EbookEdition(cover=cover))
    wrap = {"kind": "print", "cover": {"asset_id": COVER}, "wrap_cover": {"enabled": True, "profile": "custom",
            "expected_page_count": 1, "back_text": "Hello سلام"}}
    assert any(item["location"] == "edition.wrap_cover.back_text" for item in cover_rtl_issues(book["metadata"], wrap))
    writer = PdfWriter(); writer.add_blank_page(width=432, height=648); output = io.BytesIO(); writer.write(output)
    with pytest.raises(ValueError, match="bidirectional shaping"):
        render_wrap_cover(image.getvalue(), output.getvalue(), PrintEdition.model_validate(wrap))


def test_direction_controls_fail_closed_without_echoing_text():
    assert requires_bidi_layout("left \u2067right\u2069")
    assert requires_bidi_layout("שלום") and requires_bidi_layout("سلام")
    assert not requires_bidi_layout("ordinary English 123")


def test_fixed_edition_override_and_cover_preflight_are_checked_before_painting(monkeypatch):
    book = copy.deepcopy(BOOK); book["metadata"]["language"] = "en"
    fixed = EbookEdition(flow="fixed", metadata_overrides={"title": "A سلام"})
    assert any(item["location"] == "book.metadata.title" and item.get("code") == "RTL_TEXT_UNSUPPORTED"
               for item in print_font_issues(book, fixed.model_dump()))
    spec = importlib.util.spec_from_file_location("bookworm_mixed_cover_main", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "synthetic-render-token")
    edition = {"kind": "ebook", "cover": {"asset_id": COVER,
        "qr_code": {"enabled": True, "url": "https://example.test", "label": "שלום"}}}
    with TestClient(module.app) as client:
        result = client.post("/preflight", headers={"x-service-token": "synthetic-render-token"},
            json={"bookModel": book, "editionConfig": edition, "channel": "kdp", "includeArtifact": True})
    assert result.status_code == 200
    assert any(item["code"] == "RTL_COVER_TEXT_UNSUPPORTED" and item["location"] == "edition.cover.qr_code.label"
               for item in result.json()["findings"])
    assert "שלום" not in result.text
