"""Lulu print rules verified against first-party help on 2026-09-18."""
from preflight import Finding, Rule
from rules._channel import (check_print_pdf_geometry, make_ruleset,
                            metadata_rules, print_pdf_page_count)

VERSION = "lulu-1.3.0"
EFFECTIVE_DATE = "2026-09-18"
SOURCE_REF = "https://help.lulu.com/en/support/solutions/articles/64000255584"
PAGE_SOURCE_REF = "https://help.lulu.com/en/support/solutions/articles/64000255583"
MARGIN_SOURCE_REF = "https://help.lulu.com/en/support/solutions/articles/64000255590-interior-formatting-the-basics"


def check_lulu_bleed(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print":
        bleed = edition.get("bleed_in", 0.0)
        if bleed != 0.125 or edition.get("bleed_edges", "all") != "all":
            return [Finding(code="LULU-BLEED",
                            message="Lulu print-ready PDFs require 0.125in bleed on all four edges; select all-edge bleed and render again",
                            location="edition.bleed_in")]
    return []


def check_lulu_page_count(ctx):
    count = print_pdf_page_count(ctx)
    if count is not None and not 32 <= count <= 800:
        return [Finding(code="LULU-PRINT-PAGE-COUNT",
                        message=f"Lulu perfect-bound paperbacks require 32-800 pages; the rendered PDF has {count}",
                        location="interior.pages")]
    return []


def check_lulu_safe_margins(ctx):
    if print_pdf_page_count(ctx) is None:
        return []
    margins = ((ctx.get("edition") or {}).get("margins") or {})
    failures = []
    for edge in ("top", "bottom", "inner", "outer"):
        actual = margins.get(edge, 0.75 if edge != "outer" else 0.5)
        if actual < 0.5:
            failures.append(f"{edge} {actual:g}in")
    if failures:
        return [Finding(code="LULU-PRINT-SAFE-MARGIN",
                        message="Lulu recommends keeping important text and images at least 0.5in from trim; increase " + ", ".join(failures),
                        location="edition.margins")]
    return []


def check_lulu_recommended_gutter(ctx):
    count = print_pdf_page_count(ctx)
    if count is None or count > 600:
        return []
    recommended = 0.5 if count <= 60 else 0.625 if count <= 150 else 1.0 if count <= 400 else 1.125
    inner = (((ctx.get("edition") or {}).get("margins") or {}).get("inner", 0.75))
    if inner < recommended:
        return [Finding(code="LULU-PRINT-GUTTER-RECOMMENDED",
                        message=(f"Lulu recommends a {recommended:g}in inner margin for a {count}-page book; "
                                 f"the edition uses {inner:g}in"),
                        location="edition.margins.inner")]
    return []


RULESET = make_ruleset("lulu", VERSION, metadata_rules(
    "lulu", "LULU", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("LULU-PRINT-001", "error", "channel", "Lulu bleed value", check_lulu_bleed,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("LULU-PRINT-002", "error", "channel", "Lulu actual interior geometry", check_print_pdf_geometry,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("LULU-PRINT-003", "error", "channel", "Lulu perfect-bound page range", check_lulu_page_count,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=PAGE_SOURCE_REF),
    Rule("LULU-PRINT-004", "warning", "channel", "Lulu print-safe margins", check_lulu_safe_margins,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=MARGIN_SOURCE_REF),
    Rule("LULU-PRINT-005", "warning", "channel", "Lulu recommended gutter", check_lulu_recommended_gutter,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=MARGIN_SOURCE_REF),
])
