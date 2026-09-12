"""Lulu print rules verified against first-party help on 2026-09-03."""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "lulu-1.1.0"
EFFECTIVE_DATE = "2026-09-03"
SOURCE_REF = "https://help.lulu.com/en/support/solutions/articles/64000255584"


def check_lulu_bleed(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print":
        bleed = edition.get("bleed_in", 0.0)
        if bleed != 0.125:
            return [Finding(code="LULU-BLEED",
                            message=f"Lulu print-ready PDFs require 0.125in bleed on every side; got {bleed}",
                            location="edition.bleed_in")]
    return []


RULESET = make_ruleset("lulu", VERSION, metadata_rules(
    "lulu", "LULU", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("LULU-PRINT-001", "error", "channel", "Lulu bleed value", check_lulu_bleed,
         channels=("lulu",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
])
