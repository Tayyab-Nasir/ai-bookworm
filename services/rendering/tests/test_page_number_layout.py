import copy
import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from reportlab.pdfbase import pdfmetrics

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))
from editions import PrintEdition
from pdf_renderer import render_pdf

BOOK = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text())


@pytest.mark.parametrize("position", ["bottom-center", "bottom-outer", "top-center"])
@pytest.mark.parametrize("embedded", [False, True])
@pytest.mark.parametrize("bleed,edges", [(0, "outer"), (0.125, "outer"), (0.125, "all")])
def test_actual_number_font_boxes_stay_inside_trim_and_outside_dense_body(position, embedded, bleed, edges):
    book = copy.deepcopy(BOOK)
    # Short paragraphs fill multiple pages while each has an explicit text
    # matrix. pypdf's visitor multiplies multi-line T* leading by font size,
    # so its reported coordinates for a single long paragraph are unreliable.
    book["chapters"][0]["nodes"] = [{"id": f"dense-{i}", "type": "paragraph",
                                    "text": f"Dense manuscript line {i}."} for i in range(200)]
    config = {"bleed_in": bleed, "bleed_edges": edges,
              "page_numbering": {"position": position, "start_at": 123},
              "margins": {"inner": 1.1, "outer": 0.6}}
    if embedded:
        config["typography"] = {"body_font": "BookwormVera", "heading_font": "BookwormVera-Bold"}
    edition = PrintEdition.model_validate(config)
    pdf, checksum = render_pdf(book, edition)
    assert render_pdf(book, edition) == (pdf, checksum)
    pages = PdfReader(io.BytesIO(pdf)).pages
    assert len(pages) >= 5
    for index, page in enumerate(pages):
        spans = []
        def visit(text, cm, tm, font, size):
            if text.strip():
                spans.append((text.strip(), tm[4] * cm[0] + tm[5] * cm[2] + cm[4],
                              tm[4] * cm[1] + tm[5] * cm[3] + cm[5], size))
        page.extract_text(visitor_text=visit)
        label, x, baseline, size = spans[-1]
        assert label == str(index + 123) and size == 9
        font = "BookwormVera" if embedded else "Helvetica"
        ascent, descent = pdfmetrics.getAscentDescent(font, size)
        width = pdfmetrics.stringWidth(label, font, size)
        left = bleed if edges == "all" or index % 2 else 0
        # Assert the physical text box, not the baseline or saved margin value.
        assert x >= (left + 0.5) * 72 - 0.001
        assert x + width <= (left + 6 - 0.5) * 72 + 0.001
        assert baseline + descent >= (bleed + 0.5) * 72 - 0.001
        assert baseline + ascent <= (bleed + 9 - 0.5) * 72 + 0.001
        if position == "top-center":
            assert baseline + descent >= (bleed + 9 - 0.75) * 72 + 6 - 0.001
            assert all(y < baseline + descent for _, _, y, _ in spans[:-1])
        else:
            assert baseline + ascent <= (bleed + 0.75) * 72 - 6 + 0.001
            assert all(y > baseline + ascent for _, _, y, _ in spans[:-1])
        if position == "bottom-outer":
            if index % 2 == 0:
                assert x + width == pytest.approx((left + 6 - 0.6) * 72, abs=0.001)
            else:
                assert x == pytest.approx((left + 0.6) * 72, abs=0.001)


@pytest.mark.parametrize("position,edge", [("bottom-center", "bottom"), ("top-center", "top")])
def test_small_number_margin_has_actionable_preflight_and_render_error(monkeypatch, position, edge):
    spec = importlib.util.spec_from_file_location("bookworm_number_service", RENDERING / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RENDERING_SERVICE_TOKEN", "number-layout-fixture")
    config = {"kind": "print", "margins": {edge: 0.25}, "page_numbering": {"position": position}}
    payload = {"bookModel": BOOK, "editionConfig": config}
    with TestClient(module.app) as client:
        headers = {"x-service-token": "number-layout-fixture"}
        response = client.post("/preflight", headers=headers, json=payload)
        assert response.status_code == 200, response.text
        issue = next(f for f in response.json()["findings"] if f["code"] == "PRINT_NUMBER_MARGIN")
        assert issue["location"] == f"edition.margins.{edge}"
        assert issue["severity"] == "error" and "no page numbers" in issue["message"]
        response = client.post("/render", headers=headers, json=payload)
        assert response.status_code == 422 and "margin" in response.json()["detail"]
        # The author can retain a tight body margin by disabling numbering.
        config["page_numbering"]["style"] = "none"
        assert client.post("/render", headers=headers, json=payload).status_code == 200


def test_impossible_body_area_is_rejected_before_reportlab_layout():
    config = PrintEdition(margins={"inner": 5, "outer": 2})
    with pytest.raises(ValueError, match="no printable body area"):
        render_pdf(BOOK, config)


def test_long_roman_number_cannot_cross_the_numbering_area():
    config = PrintEdition(trim_size="5x8", margins={"inner": 2, "outer": 2},
                          page_numbering={"style": "roman", "start_at": 10_000})
    with pytest.raises(ValueError, match="Page number does not fit"):
        render_pdf(BOOK, config)


@pytest.mark.parametrize("start", [0, -1, 10_001])
def test_numbering_start_matches_api_bounds(start):
    with pytest.raises(ValueError):
        PrintEdition(page_numbering={"start_at": start})
