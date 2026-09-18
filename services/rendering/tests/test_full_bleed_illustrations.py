import io
import base64
import importlib.util
import sys
from pathlib import Path

import pytest
from PIL import Image
from pypdf import PdfReader

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))

from editions import PrintEdition
from pdf_renderer import _FullBleedImage, render_pdf
from preflight import run_preflight
from rules import load_ruleset

ASSET = "11111111-1111-4111-8111-111111111111"
CHAPTER = "22222222-2222-4222-8222-222222222222"


def artwork(width=1838, height=2775):
    output = io.BytesIO()
    Image.new("RGB", (width, height), "#306f83").save(output, "PNG", compress_level=9)
    return output.getvalue()


def book(placement="fullBleed"):
    return {
        "schemaVersion": "1.0",
        "bookId": "33333333-3333-4333-8333-333333333333",
        "metadata": {"title": "The blue crossing", "author": "Ada Author", "language": "en"},
        "styleGuide": {}, "bookBible": {"entities": []},
        "assets": [{"id": ASSET, "role": "illustration", "altText": "A blue crossing"}],
        "chapters": [{"id": CHAPTER, "order": 0, "title": "Arrival", "nodes": [
            {"id": "before", "type": "paragraph", "text": "Before the picture."},
            {"id": "art", "type": "image", "assetId": ASSET, "altText": "A blue crossing",
             "attributes": {"printPlacement": placement, "printFocalX": 50, "printFocalY": 50}},
            {"id": "after", "type": "paragraph", "text": "After the picture."},
        ]}],
    }


def test_full_bleed_artwork_owns_a_dedicated_physical_page_deterministically():
    edition = PrintEdition(bleed_in=0.125, bleed_edges="outer")
    first = render_pdf(book(), edition, {ASSET: artwork()})
    assert render_pdf(book(), edition, {ASSET: artwork()}) == first
    pages = PdfReader(io.BytesIO(first[0])).pages
    assert len(pages) == 4
    assert "Before the picture." in pages[1].extract_text()
    assert not pages[2].extract_text().strip()  # page number is painted first, then covered by artwork
    assert "After the picture." in pages[3].extract_text()
    content = pages[2].get_contents().get_data()
    assert b"/FormXob" in content and b" Do" in content
    assert float(pages[2].mediabox.width) == pytest.approx(6.125 * 72)
    assert float(pages[2].mediabox.height) == pytest.approx(9.25 * 72)


def test_full_bleed_crop_focus_is_bounded_and_directional():
    horizontal = _FullBleedImage(artwork(400, 200), (100, 100), (1, 0.5))
    assert (horizontal.draw_x, horizontal.draw_y, horizontal.draw_w, horizontal.draw_h) == pytest.approx((-100, 0, 200, 100))
    top = _FullBleedImage(artwork(200, 400), (100, 100), (0.5, 0))
    bottom = _FullBleedImage(artwork(200, 400), (100, 100), (0.5, 1))
    assert top.draw_y == pytest.approx(-100)
    assert bottom.draw_y == pytest.approx(0)


def test_full_bleed_requires_bleed_and_300_dpi_source_in_render_and_preflight():
    no_bleed = PrintEdition(bleed_in=0)
    with pytest.raises(ValueError, match="requires a print edition with bleed enabled"):
        render_pdf(book(), no_bleed, {ASSET: artwork()})
    low = artwork(600, 900)
    edition = PrintEdition(bleed_in=0.125, bleed_edges="outer")
    with pytest.raises(ValueError, match="at least 1838 x 2775 pixels"):
        render_pdf(book(), edition, {ASSET: low})
    findings = run_preflight({"book": book(), "edition": edition.model_dump(), "image_bytes": {ASSET: low},
                              "artifact": None, "package_bytes": None, "channel": None}, load_ruleset())
    assert {finding.code for finding in findings} >= {"PRINT_FULL_BLEED_RESOLUTION"}
    assert all(finding.rule_version == "core-1.0.5" for finding in findings)


def test_inline_artwork_remains_inside_the_text_flow_without_bleed_requirement():
    output = render_pdf(book("inline"), PrintEdition(), {ASSET: artwork(600, 900)})
    pages = PdfReader(io.BytesIO(output[0])).pages
    assert len(pages) == 2
    assert "Before the picture." in pages[1].extract_text()
    assert "After the picture." in pages[1].extract_text()


def test_explicit_page_break_before_full_bleed_does_not_create_a_blank_page():
    model = book()
    model["chapters"][0]["nodes"].insert(1, {"id": "manual-break", "type": "pageBreak"})
    pages = PdfReader(io.BytesIO(render_pdf(model, PrintEdition(bleed_in=0.125, bleed_edges="outer"), {ASSET: artwork()})[0])).pages
    assert len(pages) == 4
    assert not pages[2].extract_text().strip()
    assert "After the picture." in pages[3].extract_text()


def test_service_returns_actionable_full_bleed_preflight_and_render_errors(monkeypatch):
    from fastapi.testclient import TestClient

    spec = importlib.util.spec_from_file_location("bookworm_full_bleed_endpoint", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-render-token")
    payload = {
        "bookModel": book(),
        "editionConfig": {"kind": "print", "bleed_in": 0.125, "bleed_edges": "outer"},
        "assetImagesBase64": {ASSET: base64.b64encode(artwork(600, 900)).decode()},
    }
    with TestClient(module.app) as client:
        preflight = client.post("/preflight", headers={"x-service-token": "fixture-render-token"}, json=payload)
        rendered = client.post("/render", headers={"x-service-token": "fixture-render-token"}, json=payload)
    assert preflight.status_code == 200
    assert "PRINT_FULL_BLEED_RESOLUTION" in {item["code"] for item in preflight.json()["findings"]}
    assert rendered.status_code == 422
    assert "at least 1838 x 2775 pixels" in rendered.json()["detail"]
