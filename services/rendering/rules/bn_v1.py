"""Barnes & Noble Press channel rules v1. PLACEHOLDER — verify against current official
docs at release: https://www.barnesandnoble.com/h/publish (B&N Press guidelines).
"""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "barnesnoble-1.0.0"
EFFECTIVE_DATE = "2026-08-10"  # placeholder authored; NOT yet verified
SOURCE_REF = "https://www.barnesandnoble.com/h/publish"  # verify at release


def check_bn_isbn(ctx):
    """B&N Press: ISBN required for print (placeholder)."""
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print" and not ctx["book"].get("metadata", {}).get("isbn13"):
        return [Finding(code="BN-PRINT-ISBN",
                        message="B&N Press print requires an ISBN (placeholder — verify)",
                        location="book.metadata.isbn13")]
    return []


RULESET = make_ruleset("barnesnoble", VERSION, metadata_rules(
    "barnesnoble", "BN", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("BN-PRINT-001", "error", "channel", "B&N print ISBN", check_bn_isbn,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
])
