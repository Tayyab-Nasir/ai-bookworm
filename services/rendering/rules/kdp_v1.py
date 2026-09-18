"""KDP channel rules verified against first-party KDP help on 2026-09-03."""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules, check_print_pdf_geometry

VERSION = "kdp-1.2.0"
EFFECTIVE_DATE = "2026-09-03"
SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G202145060"
ISBN_SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G201834170"

KDP_MAX_MANUSCRIPT_BYTES = 650 * 1024 * 1024
GEOMETRY_SOURCE = "https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6"


def check_kdp_bleed(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print":
        bleed = edition.get("bleed_in", 0)
        if bleed and (bleed != 0.125 or edition.get("bleed_edges", "all") != "outer"):
            return [Finding(code="KDP-PRINT-BLEED", message="KDP interior bleed must be 0.125in on top, bottom and outer edge only; select outer-edge bleed and render again", location="edition.bleed_edges")]
    return []


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
    Rule("KDP-PRINT-002", "error", "channel", "KDP interior bleed edges", check_kdp_bleed,
         channels=("kdp",), effective_date="2026-09-18", source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-003", "error", "channel", "KDP actual interior geometry", check_print_pdf_geometry,
         channels=("kdp",), effective_date="2026-09-18", source_ref=GEOMETRY_SOURCE),
])
