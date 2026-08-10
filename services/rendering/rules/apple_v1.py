"""Apple Books channel rules v1. PLACEHOLDER — verify against current official docs at release:
https://help.apple.com/itc/booksassetguide/ (Apple Books Asset Guide).
"""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "apple-1.0.0"
EFFECTIVE_DATE = "2026-08-10"  # placeholder authored; NOT yet verified
SOURCE_REF = "https://help.apple.com/itc/booksassetguide/"  # verify at release


def check_apple_isbn_or_vendor_id(ctx):
    """Apple Books requires ISBN for paid books (placeholder)."""
    md = ctx["book"].get("metadata", {})
    if not md.get("isbn13"):
        return [Finding(code="APPLE-ISBN",
                        message="Apple Books placeholder: ISBN/vendor id required for paid titles",
                        location="book.metadata.isbn13")]
    return []


RULESET = make_ruleset("apple", VERSION, metadata_rules(
    "apple", "APPLE", ["title", "author", "language", "description", "categories"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("APPLE-META-002", "warning", "channel", "Apple ISBN/vendor id", check_apple_isbn_or_vendor_id,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
])
