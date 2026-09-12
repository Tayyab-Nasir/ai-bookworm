"""Apple Books rules verified against Asset Guide 5.3.1 on 2026-09-03."""
from io import BytesIO

from PIL import Image, UnidentifiedImageError
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "apple-1.1.0"
EFFECTIVE_DATE = "2026-09-03"
SOURCE_REF = "https://help.apple.com/itc/booksassetguide/en.lproj/static.html"
COVER_SOURCE_REF = "https://help.apple.com/itc/booksassetguide/en.lproj/itc1bda991ba.html"


def check_apple_identifier(ctx):
    md = ctx["book"].get("metadata", {})
    if not md.get("isbn13"):
        return [Finding(code="APPLE-VENDOR-ID",
                        message="ISBN is optional, but Apple Books requires a permanent Vendor ID at submission",
                        location="book.metadata.isbn13")]
    return []


def check_apple_description(ctx):
    description = str(ctx["book"].get("metadata", {}).get("description") or "")
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


RULESET = make_ruleset("apple", VERSION, metadata_rules(
    "apple", "APPLE", ["title", "author", "language", "description", "categories"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("APPLE-META-002", "warning", "channel", "Apple Vendor ID readiness", check_apple_identifier,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("APPLE-META-003", "error", "channel", "Apple description length", check_apple_description,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("APPLE-COVER-001", "error", "channel", "Apple cover art", check_apple_cover,
         channels=("apple",), effective_date=EFFECTIVE_DATE, source_ref=COVER_SOURCE_REF),
])
