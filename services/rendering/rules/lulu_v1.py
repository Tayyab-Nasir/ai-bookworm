"""Lulu print rules verified against first-party help on 2026-09-03."""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules, check_print_pdf_geometry

VERSION = "lulu-1.2.0"
EFFECTIVE_DATE = "2026-09-18"
SOURCE_REF = "https://help.lulu.com/en/support/solutions/articles/64000255584"


def check_lulu_bleed(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print":
        bleed = edition.get("bleed_in", 0.0)
        if bleed != 0.125 or edition.get("bleed_edges", "all") != "all":
            return [Finding(code="LULU-BLEED",
                            message="Lulu print-ready PDFs require 0.125in bleed on all four edges; select all-edge bleed and render again",
                            location="edition.bleed_in")]
    return []


RULESET = make_ruleset("lulu", VERSION, metadata_rules(
    "lulu", "LULU", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("LULU-PRINT-001", "error", "channel", "Lulu bleed value", check_lulu_bleed,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("LULU-PRINT-002", "error", "channel", "Lulu actual interior geometry", check_print_pdf_geometry,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
])
