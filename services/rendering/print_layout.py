"""Shared print body and pagination geometry, measured from finished trim."""
from math import ceil

from reportlab.pdfbase import pdfmetrics

from editions import PrintEdition
from print_fonts import page_number_font

NUMBER_SIZE_PT = 9
NUMBER_TRIM_INSET_IN = 0.5
NUMBER_BODY_GAP_PT = 6


def number_metrics(edition: PrintEdition) -> tuple[str, float, float]:
    font = page_number_font(edition.typography.body_font, edition.typography.heading_font)
    ascent, descent = pdfmetrics.getAscentDescent(font, NUMBER_SIZE_PT)
    return font, ascent, descent


def print_layout_issues(edition: PrintEdition) -> list[dict[str, str]]:
    width, height = edition.trim_in
    margins = edition.margins
    issues = []
    if width <= margins.inner + margins.outer or height <= margins.top + margins.bottom:
        issues.append({"code": "PRINT_BODY_AREA", "location": "edition.margins",
                       "message": "Margins leave no printable body area. Reduce the margins or choose a larger trim size."})
    if edition.page_numbering.style != "none":
        _, ascent, descent = number_metrics(edition)
        minimum = ceil((NUMBER_TRIM_INSET_IN + (ascent - descent + NUMBER_BODY_GAP_PT) / 72) * 100) / 100
        edge = "top" if edition.page_numbering.position == "top-center" else "bottom"
        if getattr(margins, edge) < minimum:
            issues.append({"code": "PRINT_NUMBER_MARGIN", "location": f"edition.margins.{edge}",
                "message": (f"Page numbers need a {edge} margin of at least {minimum:g}in for this font. "
                            f"Increase the {edge} margin, move numbering to the other edge, or choose no page numbers.")})
    return issues
