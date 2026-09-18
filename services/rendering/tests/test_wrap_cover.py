import base64
import copy
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader, PdfWriter

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))
from editions import PrintEdition
from wrap_cover import render_wrap_cover, validate_wrap_pdf, wrap_geometry
from preflight import run_preflight
from rules import load_ruleset

BOOK = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text())
COVER_ID = "77777777-7777-4777-8777-777777777777"


def interior(count=100):
    writer = PdfWriter()
    for _ in range(count):
        writer.add_blank_page(432, 648)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def artwork():
    output = io.BytesIO()
    Image.new("RGB", (1800, 2700), "#235763").save(output, "PNG")
    return output.getvalue()


def edition(**settings):
    return PrintEdition.model_validate({"kind": "print", "cover": {"asset_id": COVER_ID},
        "wrap_cover": {"enabled": True, "back_text": "A story about caf\u00e9s & friendship.", **settings}})


def test_wrap_dimensions_fonts_color_text_and_checksum():
    config = edition(profile="kdp-cream", spine_text="The Fixture")
    pdf, checksum = render_wrap_cover(artwork(), interior(), config)
    assert render_wrap_cover(artwork(), interior(), config) == (pdf, checksum)
    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) == 1 and not reader.is_encrypted
    page = reader.pages[0]
    assert float(page.mediabox.width) == pytest.approx((12 + 0.25 + 0.25) * 72)
    assert float(page.mediabox.height) == pytest.approx(9.25 * 72)
    assert "caf\u00e9s & friendship" in page.extract_text()
    assert "The Fixture" in page.extract_text()
    for ref in page["/Resources"]["/Font"].values():
        assert "/FontFile2" in ref.get_object()["/FontDescriptor"]
    for ref in page["/Resources"]["/XObject"].values():
        assert ref.get_object()["/ColorSpace"] == "/DeviceCMYK"
    validate_wrap_pdf(pdf, interior(), config)


def test_page_count_controls_spine_and_custom_template_cannot_go_stale():
    assert wrap_geometry(edition(profile="kdp-white"), 100)[2] == pytest.approx(0.2252)
    assert wrap_geometry(edition(profile="kdp-premium-color"), 200)[2] == pytest.approx(0.4694)
    custom = edition(profile="custom", expected_page_count=100, spine_width_in=0.4)
    assert wrap_geometry(custom, 100)[2] == 0.4
    with pytest.raises(ValueError, match="expects 100 pages"):
        wrap_geometry(custom, 102)
    with pytest.raises(ValueError, match="at least 24"):
        wrap_geometry(edition(), 10)
    with pytest.raises(ValueError, match="template page count"):
        edition(profile="custom")


@pytest.mark.parametrize("settings, message", [
    ({"spine_text": "Title", "profile": "custom", "expected_page_count": 100, "spine_width_in": 0.05}, "too narrow"),
    ({"back_text": "word " * 600}, "does not fit"),
    ({"back_text": "\u6f22"}, "unsupported"),
])
def test_layout_refuses_unreadable_or_overflowing_text(settings, message):
    with pytest.raises(ValueError, match=message):
        render_wrap_cover(artwork(), interior(), edition(**settings))


def test_stale_wrong_size_rotated_or_multi_page_cover_cannot_validate():
    config = edition()
    cover, _ = render_wrap_cover(artwork(), interior(), config)
    with pytest.raises(ValueError, match="dimensions"):
        validate_wrap_pdf(cover, interior(120), config)
    with pytest.raises(ValueError, match="one unencrypted page"):
        validate_wrap_pdf(interior(2), interior(), config)
    writer = PdfWriter()
    page = PdfReader(io.BytesIO(cover)).pages[0]
    page.rotate(90)
    writer.add_page(page)
    rotated = io.BytesIO()
    writer.write(rotated)
    with pytest.raises(ValueError, match="dimensions"):
        validate_wrap_pdf(rotated.getvalue(), interior(), config)
    writer = PdfWriter()
    page = PdfReader(io.BytesIO(cover)).pages[0]
    page.cropbox.lower_left = (10, 10)
    writer.add_page(page)
    cropped = io.BytesIO()
    writer.write(cropped)
    with pytest.raises(ValueError, match="crop box"):
        validate_wrap_pdf(cropped.getvalue(), interior(), config)


def test_retail_preflight_requires_full_cover_and_matching_printer():
    ctx = {"book": BOOK, "edition": {"kind": "print"}, "channel": "kdp"}
    assert "PRINT_WRAP_REQUIRED" in {f.code for f in run_preflight(ctx, load_ruleset("kdp"))}
    ctx["edition"] = edition().model_dump()
    ctx["channel"] = "barnesnoble"
    assert "PRINT_WRAP_PROFILE" in {f.code for f in run_preflight(ctx, load_ruleset("barnesnoble"))}


def test_front_cover_checks_only_visible_glyphs_and_uses_print_resolution():
    from cover_renderer import compose_front_cover
    config = edition()
    book = copy.deepcopy(BOOK)
    book["metadata"]["title"] = "\u6f22"
    with pytest.raises(ValueError, match="unsupported"):
        compose_front_cover(artwork(), book, config)
    config.cover.title_on_cover = False
    rendered, _ = compose_front_cover(artwork(), book, config)
    with Image.open(io.BytesIO(rendered)) as image:
        assert image.size == (round(6.125 * 300), round(9.25 * 300))


def test_render_service_returns_pdf_cover_and_preflight_returns_template_mismatch(monkeypatch):
    spec = importlib.util.spec_from_file_location("bookworm_wrap_service", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "fixture-wrap-token")
    config = edition(profile="custom", expected_page_count=3).model_dump()
    from pdf_renderer import render_pdf
    actual = len(PdfReader(io.BytesIO(render_pdf(BOOK, PrintEdition.model_validate(config))[0])).pages)
    config["wrap_cover"]["expected_page_count"] = actual
    payload = {"bookModel": BOOK, "editionConfig": config, "coverBase64": base64.b64encode(artwork()).decode()}
    with TestClient(module.app) as client:
        response = client.post("/render", headers={"x-service-token": "fixture-wrap-token"}, json=payload)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["coverFormat"] == "pdf"
        validate_wrap_pdf(base64.b64decode(result["coverArtifactBase64"]), base64.b64decode(result["artifactBase64"]), PrintEdition.model_validate(config))
        config["wrap_cover"]["expected_page_count"] += 1
        preflight = client.post("/preflight", headers={"x-service-token": "fixture-wrap-token"}, json=payload)
        assert preflight.status_code == 200, preflight.text
        assert "PRINT_WRAP_LAYOUT" in {f["code"] for f in preflight.json()["findings"]}
