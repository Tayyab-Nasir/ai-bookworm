import io
import json
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

RENDERING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RENDERING))
from editions import PrintEdition
from pdf_renderer import render_pdf
from preflight import run_preflight
from rules import load_ruleset

BOOK = json.loads((RENDERING.parents[1] / "tests/fixtures/books/valid_book.json").read_text())


@pytest.mark.parametrize("edges,bleed,width", [("outer", 0.125, 6.125), ("all", 0.125, 6.25), ("outer", 0, 6), ("all", 0, 6)])
def test_actual_page_geometry_and_mirrored_trim_relative_text(edges, bleed, width):
    edition = PrintEdition(bleed_edges=edges, bleed_in=bleed)
    output = render_pdf(BOOK, edition)
    assert render_pdf(BOOK, edition) == output
    reader = PdfReader(io.BytesIO(output[0]))
    assert len(reader.pages) >= 2
    for index, page in enumerate(reader.pages):
        assert float(page.mediabox.width) == pytest.approx(width * 72)
        assert float(page.mediabox.height) == pytest.approx((9 + 2 * bleed) * 72)
        positions = []
        def visit(text, cm, tm, font, size):
            if text.strip():
                positions.append((text.strip(), tm[4] * cm[0] + tm[5] * cm[2] + cm[4], tm[4] * cm[1] + tm[5] * cm[3] + cm[5]))
        page.extract_text(visitor_text=visit)
        heading = BOOK["metadata"]["title"] if index == 0 else BOOK["chapters"][index - 1]["title"]
        location = next(value for value in positions if value[0] == heading)
        odd = index % 2 == 0
        expected = 0.75 + (bleed if edges == "all" else 0) if odd else 0.5 + bleed
        assert location[1] == pytest.approx(expected * 72)
        footer = next(value for value in positions if value[0] == str(index + 1))
        assert footer[2] == pytest.approx((bleed + 0.45) * 72)


def test_retailers_reject_other_printers_bleed_and_stale_actual_dimensions():
    def findings(channel, config, artifact=None):
        return {f.code for f in run_preflight({"book": BOOK, "edition": config,
            "channel": channel, "package_bytes": artifact}, load_ruleset(channel))}
    kdp = {"kind": "print", "bleed_in": 0.125, "bleed_edges": "outer"}
    lulu = {**kdp, "bleed_edges": "all"}
    kdp_pdf = render_pdf(BOOK, PrintEdition.model_validate(kdp))[0]
    lulu_pdf = render_pdf(BOOK, PrintEdition.model_validate(lulu))[0]
    assert "KDP-PRINT-BLEED" in findings("kdp", lulu)
    assert "LULU-BLEED" in findings("lulu", kdp)
    assert "PRINT-PAGE-GEOMETRY" not in findings("kdp", kdp, kdp_pdf)
    assert "PRINT-PAGE-GEOMETRY" not in findings("lulu", lulu, lulu_pdf)
    assert "PRINT-PAGE-GEOMETRY" in findings("kdp", kdp, lulu_pdf)
    assert "PRINT-PAGE-GEOMETRY" in findings("lulu", lulu, kdp_pdf)
    writer = PdfWriter()
    page = PdfReader(io.BytesIO(kdp_pdf)).pages[0]
    page.cropbox.lower_left = (9, 9)
    writer.add_page(page)
    cropped = io.BytesIO()
    writer.write(cropped)
    assert "PRINT-PAGE-GEOMETRY" in findings("kdp", kdp, cropped.getvalue())
    assert "PRINT-PAGE-GEOMETRY" in findings("kdp", kdp, b"invalid PDF")
