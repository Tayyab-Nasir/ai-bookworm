"""KDP channel rules v1. PLACEHOLDER — verify against current official KDP docs at release:
https://kdp.amazon.com/en_US/help/topic/G200634390 (eBook) / G201834180 (paperback).
effective_date marks when this placeholder was authored, not when verified.
"""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "kdp-1.0.0"
EFFECTIVE_DATE = "2026-08-10"  # placeholder authored; NOT yet verified
SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G200634390"  # verify at release

# PLACEHOLDER thresholds (verify before release)
KDP_MAX_IMAGE_BYTES = 5 * 1024 * 1024
KDP_MAX_EPUB_BYTES = 650 * 1024 * 1024


def check_kdp_package(ctx):
    blob = ctx.get("artifact")
    if blob and len(blob) > KDP_MAX_EPUB_BYTES:
        return [Finding(code="KDP-PKG-SIZE",
                        message=f"package exceeds KDP placeholder max {KDP_MAX_EPUB_BYTES} bytes",
                        location="artifact")]
    return []


def check_kdp_isbn(ctx):
    """Print editions: KDP paperback requires ISBN (placeholder rule)."""
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print" and not (ctx["book"].get("metadata", {}).get("isbn13")):
        return [Finding(code="KDP-PRINT-ISBN",
                        message="KDP print requires an ISBN (verify: free KDP ISBN or own)",
                        location="book.metadata.isbn13")]
    return []


RULESET = make_ruleset("kdp", VERSION, metadata_rules(
    "kdp", "KDP", ["title", "author", "language", "description"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("KDP-PKG-001", "error", "channel", "KDP package size", check_kdp_package,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("KDP-PRINT-001", "error", "channel", "KDP print ISBN", check_kdp_isbn,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
])
