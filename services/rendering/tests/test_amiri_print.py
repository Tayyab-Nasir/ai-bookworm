import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys

from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
import pypdfium2 as pdfium
import pytest

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))

from editions import PrintEdition
from pdf_renderer import render_pdf
from print_fonts import print_font_issues
from preflight import run_preflight
from rules import load_ruleset

ASSET = "11111111-1111-4111-8111-111111111111"
TITLE = "مَرافِئُ النور"
CHAPTER = "الفصل الأول"
MIXED = "قالت ليلى: قرأتُ Bookworm 2.5 (2026) عند المرفأ."
CONFIG = {"kind": "print", "typography": {"body_font": "BookwormAmiri", "heading_font": "BookwormAmiri-Bold"}}


def book(nodes=None, language="ar"):
    source = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text(encoding="utf-8"))
    source["metadata"].update({"title": TITLE, "subtitle": "رواية قصيرة", "author": "ليلى منصور", "language": language})
    source["chapters"] = [{**source["chapters"][0], "title": CHAPTER,
                           "nodes": nodes if nodes is not None else [{"id": "arabic", "type": "paragraph", "text": MIXED}]}]
    return source


def test_amiri_mixed_pdf_is_deterministic_and_embeds_fonts_and_chapter_outline():
    model = book([
        {"id": "rich", "type": "paragraph", "text": MIXED, "attributes": {"richText": [
            {"type": "text", "text": "قالت ليلى: ", "marks": [{"type": "bold"}]},
            {"type": "text", "text": MIXED[len("قالت ليلى: "):], "marks": [{"type": "italic"}]},
        ]}},
        {"id": "table", "type": "table", "rows": [["المدينة", "العام"], ["بيروت", "2026"]],
         "attributes": {"tableHeaderRows": 1}},
        {"id": "item1", "type": "listItem", "text": "زيارة المرفأ", "attributes": {"listStyle": "ordered", "listStart": 4}},
        {"id": "item2", "type": "listItem", "text": "قراءة الكتاب", "attributes": {"listStyle": "ordered"}},
        {"id": "quote", "type": "quote", "text": "كانت النوافذ مفتوحةً على البحر."},
        {"id": "literal", "type": "paragraph", "text": '#read("private-data")'},
    ])
    assert not print_font_issues(model, CONFIG)
    edition = PrintEdition.model_validate({**CONFIG, "include_table_of_contents": True,
        "front_matter": {"publisher": "دار المرافئ"}, "isbn13": "9781234567897",
        "page_numbering": {"style": "roman", "start_at": 7, "position": "bottom-outer"}})
    result = render_pdf(model, edition)
    assert render_pdf(model, edition) == result
    assert result[1] == hashlib.sha256(result[0]).hexdigest()
    reader = PdfReader(io.BytesIO(result[0]))
    assert reader.metadata.title == TITLE
    assert "/StructTreeRoot" in reader.trailer["/Root"]
    assert len(reader.pages) == 4
    assert [(entry.title, reader.get_destination_page_number(entry)) for entry in reader.outline] == [(CHAPTER, 3)]
    assert tuple(reader.pages[-1].mediabox) == (0, 0, 432, 648)
    assert "9781234567897" in reader.pages[1].extract_text()
    assert "Bookworm 2.5 (2026)" in reader.pages[-1].extract_text()
    assert "private-data" in reader.pages[-1].extract_text()
    for font in reader.pages[-1]["/Resources"]["/Font"].values():
        font = font.get_object()
        assert "/ToUnicode" in font
        descriptor = font["/DescendantFonts"][0].get_object()["/FontDescriptor"]
        assert "/FontFile2" in descriptor


def test_amiri_full_bleed_keeps_focal_crop_and_standalone_page():
    model = book([
        {"id": "before", "type": "paragraph", "text": "Before the picture."},
        {"id": "art", "type": "image", "assetId": ASSET, "altText": "Two color bands",
         "attributes": {"printPlacement": "fullBleed", "printFocalX": 100, "printFocalY": 50}},
        {"id": "after", "type": "paragraph", "text": "After the picture."},
    ])
    source = Image.new("RGB", (3800, 2775), "#ee524f")
    source.paste("#205eae", (1950, 0, 3800, 2775))
    image = io.BytesIO(); source.save(image, "PNG")
    edition = PrintEdition.model_validate({**CONFIG, "bleed_in": 0.125, "bleed_edges": "outer"})
    pdf, _ = render_pdf(model, edition, {ASSET: image.getvalue()})
    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) == 4
    assert "Before the picture." in reader.pages[1].extract_text()
    assert not reader.pages[2].extract_text().strip()
    assert "After the picture." in reader.pages[3].extract_text()
    assert tuple(reader.pages[2].mediabox) == (0, 0, 441, 666)
    with pdfium.PdfDocument(pdf) as document:
        page = document[2]
        bitmap = page.render(scale=0.5)
        try:
            raster = bitmap.to_pil()
            assert raster.getpixel((5, 5))[:3] == (32, 94, 174)
            assert raster.getpixel((raster.width - 5, raster.height - 5))[:3] == (32, 94, 174)
        finally:
            bitmap.close()
            page.close()


def test_amiri_preflight_keeps_glyph_controls_and_retailer_requirements():
    model = book()
    ctx = {"book": model, "edition": CONFIG}
    assert not [f for f in run_preflight(ctx, load_ruleset()) if f.severity == "error"]
    assert any(f.code == "KDP-PRINT-LANGUAGE" for f in run_preflight({**ctx, "channel": "kdp"}, load_ruleset("kdp")))
    assert any(f.code == "LULU-RTL-PAGE-ORDER" for f in run_preflight({**ctx, "channel": "lulu"}, load_ruleset("lulu")))
    assert not any(f.code == "KDP-PRINT-LANGUAGE" for f in run_preflight({**ctx, "edition": {"kind": "ebook"}, "channel": "kdp"}, load_ruleset("kdp")))
    assert any(f.code == "RTL_WRAP_BINDING_UNSUPPORTED" for f in run_preflight({**ctx,
        "edition": {**CONFIG, "wrap_cover": {"enabled": True}}}, load_ruleset()))
    issues = print_font_issues(book([{"id": "mixed", "type": "paragraph", "text": "سلام שלום \u2067"}]), CONFIG)
    assert any(issue.get("code") == "PRINT_DIRECTION_CONTROL_UNSUPPORTED" for issue in issues)
    assert any("U+05" in issue["message"] for issue in issues)
    with pytest.raises(ValueError, match="Choose Amiri for both"):
        PrintEdition(typography={"body_font": "BookwormAmiri", "heading_font": "BookwormVera-Bold"})


def test_normal_render_route_returns_amiri_version_and_actual_bytes(monkeypatch):
    spec = importlib.util.spec_from_file_location("bookworm_amiri_rendering_main", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "synthetic-amiri-proof")
    headers = {"x-service-token": "synthetic-amiri-proof"}
    payload = {"bookModel": book(), "editionConfig": CONFIG}
    with TestClient(module.app) as client:
        preflight = client.post("/preflight", headers=headers, json={**payload, "includeArtifact": True})
        assert preflight.status_code == 200 and preflight.json()["errors"] == 0, preflight.text
        response = client.post("/render", headers=headers, json=payload)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["rendererVersion"] == "pdf-1.21.0-amiri"
        pdf = base64.b64decode(result["artifactBase64"], validate=True)
        assert hashlib.sha256(pdf).hexdigest() == result["sha256"]
        assert PdfReader(io.BytesIO(pdf)).metadata.title == TITLE
        fixed = {"kind": "ebook", "flow": "fixed", "fixed_layout": {"typography": CONFIG["typography"]}}
        assert client.post("/render", headers=headers, json={**payload, "editionConfig": fixed}).status_code == 422
