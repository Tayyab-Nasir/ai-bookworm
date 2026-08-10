"""Lulu channel rules v1. PLACEHOLDER — verify against current official docs at release:
https://developers.lulu.com/ (Lulu Print API) and Lulu xPress publishing guides.
"""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "lulu-1.0.0"
EFFECTIVE_DATE = "2026-08-10"  # placeholder authored; NOT yet verified
SOURCE_REF = "https://developers.lulu.com/"  # verify at release


def check_lulu_bleed(ctx):
    """Lulu print: bleed 0.125in for full-bleed interiors (placeholder)."""
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print":
        bleed = edition.get("bleed_in", 0.0)
        if bleed not in (0.0, 0.125):
            return [Finding(code="LULU-BLEED",
                            message=f"Lulu placeholder: bleed should be 0 or 0.125in, got {bleed}",
                            location="edition.bleed_in")]
    return []


RULESET = make_ruleset("lulu", VERSION, metadata_rules(
    "lulu", "LULU", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("LULU-PRINT-001", "warning", "channel", "Lulu bleed value", check_lulu_bleed,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
])
