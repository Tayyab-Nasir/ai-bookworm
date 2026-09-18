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


def _blank_print_pdf(config: dict, count: int) -> bytes:
    edition = PrintEdition.model_validate(config)
    width, height = edition.trim_in
    width += edition.bleed_in * (2 if edition.bleed_edges == "all" else 1)
    height += edition.bleed_in * 2
    writer = PdfWriter()
    for _ in range(count):
        writer.add_blank_page(width=width * 72, height=height * 72)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _channel_findings(channel: str, config: dict, artifact: bytes):
    return run_preflight({"book": BOOK, "edition": config, "channel": channel,
                          "package_bytes": artifact}, load_ruleset(channel))


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


@pytest.mark.parametrize(("channel", "config", "count", "expected_code"), [
    ("kdp", {"kind": "print", "bleed_in": 0, "bleed_edges": "outer"}, 22, "KDP-PRINT-PAGE-COUNT"),
    ("barnesnoble", {"kind": "print", "bleed_in": 0, "bleed_edges": "all"}, 17, "BN-PRINT-PAGE-COUNT"),
    ("lulu", {"kind": "print", "bleed_in": 0.125, "bleed_edges": "all"}, 31, "LULU-PRINT-PAGE-COUNT"),
])
def test_channel_page_minimums_use_actual_rendered_pdf(channel, config, count, expected_code):
    findings = _channel_findings(channel, config, _blank_print_pdf(config, count))
    finding = next(item for item in findings if item.code == expected_code)
    assert finding.severity == "error"
    assert str(count) in finding.message


@pytest.mark.parametrize(("channel", "config", "count", "unexpected_code"), [
    # KDP calculates an odd manuscript as the next even page count.
    ("kdp", {"kind": "print", "bleed_in": 0, "bleed_edges": "outer"}, 23, "KDP-PRINT-PAGE-COUNT"),
    ("barnesnoble", {"kind": "print", "bleed_in": 0, "bleed_edges": "all"}, 18, "BN-PRINT-PAGE-COUNT"),
    ("lulu", {"kind": "print", "bleed_in": 0.125, "bleed_edges": "all"}, 32, "LULU-PRINT-PAGE-COUNT"),
])
def test_channel_page_minimum_boundaries(channel, config, count, unexpected_code):
    codes = {item.code for item in _channel_findings(channel, config, _blank_print_pdf(config, count))}
    assert unexpected_code not in codes


def test_retailer_margin_rules_report_exact_actionable_edges():
    kdp = {"kind": "print", "bleed_in": 0.125, "bleed_edges": "outer",
           "margins": {"top": 0.25, "bottom": 0.25, "inner": 0.3, "outer": 0.25}}
    kdp_findings = _channel_findings("kdp", kdp, _blank_print_pdf(kdp, 24))
    kdp_margin = next(item for item in kdp_findings if item.code == "KDP-PRINT-MARGINS")
    assert "inner 0.3in (minimum 0.375in)" in kdp_margin.message
    assert "outer 0.25in (minimum 0.375in)" in kdp_margin.message

    bn = {"kind": "print", "bleed_in": 0, "bleed_edges": "all",
          "margins": {"top": 0.4, "bottom": 0.5, "inner": 0.7, "outer": 0.5}}
    bn_margin = next(item for item in _channel_findings("barnesnoble", bn, _blank_print_pdf(bn, 18))
                     if item.code == "BN-PRINT-MARGINS")
    assert "top 0.4in (minimum 0.5in)" in bn_margin.message
    assert "inner 0.7in (minimum 0.75in)" in bn_margin.message

    lulu = {"kind": "print", "bleed_in": 0.125, "bleed_edges": "all",
            "margins": {"top": 0.4, "bottom": 0.5, "inner": 0.5, "outer": 0.5}}
    lulu_margin = next(item for item in _channel_findings("lulu", lulu, _blank_print_pdf(lulu, 32))
                       if item.code == "LULU-PRINT-SAFE-MARGIN")
    assert lulu_margin.severity == "warning"
    assert "top 0.4in" in lulu_margin.message


def test_kdp_profile_limits_and_page_count_gutter_tiers(monkeypatch):
    import rules.kdp_v1 as kdp_rules

    config = {"kind": "print", "trim_size": "8.5x11", "bleed_in": 0,
              "wrap_cover": {"profile": "kdp-cream"},
              "margins": {"top": 0.5, "bottom": 0.5, "inner": 0.75, "outer": 0.5}}
    monkeypatch.setattr(kdp_rules, "print_pdf_page_count", lambda _ctx: 551)
    count = kdp_rules.check_kdp_page_count({"edition": config})[0]
    assert "24-550" in count.message and "552 after" in count.message

    config["trim_size"] = "6x9"
    monkeypatch.setattr(kdp_rules, "print_pdf_page_count", lambda _ctx: 701)
    margin = kdp_rules.check_kdp_margins({"edition": config})[0]
    assert "minimum 0.875in" in margin.message

    config["wrap_cover"]["profile"] = "custom"
    profile = kdp_rules.check_kdp_profile_known({"edition": config})[0]
    assert profile.code == "KDP-PRINT-PROFILE-UNKNOWN"
    assert "exact page range" in profile.message


def test_kdp_blocks_odd_interior_when_generated_cover_would_use_wrong_spine(monkeypatch):
    import rules.kdp_v1 as kdp_rules

    monkeypatch.setattr(kdp_rules, "print_pdf_page_count", lambda _ctx: 25)
    findings = kdp_rules.check_kdp_odd_wrap_count({"edition": {
        "kind": "print", "wrap_cover": {"enabled": True}}})
    assert findings[0].code == "KDP-PRINT-EVEN-COVER"
    assert "26" in findings[0].message
