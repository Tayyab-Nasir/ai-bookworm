"""Apple Books rules verified against Asset Guide 5.3.1 on 2026-09-03."""
from io import BytesIO

from PIL import Image, UnidentifiedImageError
from epubcheck_runner import EpubCheckResult, run_epubcheck
from preflight import Finding, Rule, _meta
from rules._channel import make_ruleset, metadata_rules

VERSION = "apple-1.2.0"
EFFECTIVE_DATE = "2026-10-28"
SOURCE_REF = "https://help.apple.com/itc/booksassetguide/en.lproj/static.html"
COVER_SOURCE_REF = "https://help.apple.com/itc/booksassetguide/en.lproj/itc1bda991ba.html"


def check_apple_identifier(ctx):
    md = _meta(ctx)
    if not md.get("isbn13"):
        return [Finding(code="APPLE-VENDOR-ID",
                        message="ISBN is optional, but Apple Books requires a permanent Vendor ID at submission",
                        location="book.metadata.isbn13")]
    return []


def check_apple_description(ctx):
    description = str(_meta(ctx).get("description") or "")
    if description and len(description) < 50:
        return [Finding(code="APPLE-DESCRIPTION-LENGTH",
                        message="Apple Books descriptions must contain at least 50 characters",
                        location="book.metadata.description")]
    return []


def check_apple_cover(ctx):
    cover = ctx.get("cover_bytes")
    if not cover:
        return []
    try:
        with Image.open(BytesIO(cover)) as image:
            image.load()
            if image.format not in ("JPEG", "PNG") or image.mode != "RGB":
                return [Finding(code="APPLE-COVER-FORMAT",
                                message="Apple Books cover art must be RGB JPEG or PNG",
                                location="edition.cover")]
            if min(image.size) < 1400:
                return [Finding(code="APPLE-COVER-SIZE",
                                message="Apple Books cover art must be at least 1400 pixels on its shorter axis",
                                location="edition.cover")]
    except (UnidentifiedImageError, OSError, ValueError):
        return [Finding(code="APPLE-COVER-FORMAT", message="Apple Books cover art must be RGB JPEG or PNG",
                        location="edition.cover")]
    return []


def _check_result(ctx) -> EpubCheckResult | None:
    if (ctx.get("edition") or {}).get("kind") != "ebook" or not ctx.get("artifact"):
        return None
    if "_apple_epubcheck_result" not in ctx:
        ctx["_apple_epubcheck_result"] = run_epubcheck(ctx["artifact"])
    return ctx["_apple_epubcheck_result"]


def check_apple_epubcheck_errors(ctx):
    result = _check_result(ctx)
    if result is None or result.status == "valid":
        return []
    if result.status == "unavailable":
        return [Finding(code="APPLE-EPUBCHECK-UNAVAILABLE", message="EPUBCheck 5.4.0 is unavailable; Apple Books packaging is blocked until the exact EPUB can be validated", location="artifact")]
    return [Finding(code="APPLE-EPUBCHECK-ERROR", message=f"EPUBCheck 5.4.0 found {result.errors} error(s) in the exact EPUB; repair and render again", location="artifact")]


def check_apple_epubcheck_warnings(ctx):
    if (ctx.get("edition") or {}).get("kind") == "ebook" and not ctx.get("artifact"):
        return [Finding(code="APPLE-EPUBCHECK-NO-ARTIFACT", message="This preliminary check has no EPUB; validate the saved EPUB before packaging", location="artifact")]
    result = _check_result(ctx)
    if result is None or not result.warnings:
        return []
    return [Finding(code="APPLE-EPUBCHECK-WARNING", message=f"EPUBCheck 5.4.0 reported {result.warnings} warning(s); review them before Apple Books upload", location="artifact")]


RULESET = make_ruleset("apple", VERSION, metadata_rules(
    "apple", "APPLE", ["title", "author", "language", "description", "categories"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("APPLE-META-002", "warning", "channel", "Apple Vendor ID readiness", check_apple_identifier,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("APPLE-META-003", "error", "channel", "Apple description length", check_apple_description,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("APPLE-COVER-001", "error", "channel", "Apple cover art", check_apple_cover,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=COVER_SOURCE_REF),
    Rule("APPLE-EPUB-001", "error", "epub_structure", "W3C EPUBCheck conformance", check_apple_epubcheck_errors,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref="https://itunespartner.apple.com/books/support/9-prepare-book"),
    Rule("APPLE-EPUB-002", "warning", "epub_structure", "W3C EPUBCheck warnings", check_apple_epubcheck_warnings,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref="https://itunespartner.apple.com/books/support/9-prepare-book"),
])
