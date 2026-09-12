"""KDP channel rules verified against first-party KDP help on 2026-09-03."""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "kdp-1.1.0"
EFFECTIVE_DATE = "2026-09-03"
SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G202145060"
ISBN_SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G201834170"

KDP_MAX_MANUSCRIPT_BYTES = 650 * 1024 * 1024


def check_kdp_package(ctx):
    blob = ctx.get("package_bytes", ctx.get("artifact"))
    if blob and len(blob) > KDP_MAX_MANUSCRIPT_BYTES:
        return [Finding(code="KDP-PKG-SIZE",
                        message=f"manuscript exceeds KDP's {KDP_MAX_MANUSCRIPT_BYTES}-byte conversion limit",
                        location="artifact")]
    return []


def check_kdp_isbn(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print" and not (ctx["book"].get("metadata", {}).get("isbn13")):
        return [Finding(code="KDP-PRINT-ISBN",
                        message="Choose a free KDP ISBN or add your own ISBN during print title setup",
                        location="book.metadata.isbn13")]
    return []


RULESET = make_ruleset("kdp", VERSION, metadata_rules(
    "kdp", "KDP", ["title", "author", "language", "description"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("KDP-PKG-001", "error", "channel", "KDP package size", check_kdp_package,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("KDP-PRINT-001", "warning", "channel", "KDP print ISBN choice", check_kdp_isbn,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=ISBN_SOURCE_REF),
])
