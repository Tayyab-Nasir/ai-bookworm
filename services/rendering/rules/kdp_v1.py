"""KDP channel rules verified against first-party KDP help."""
from contextlib import contextmanager
from io import BytesIO

from PIL import Image

from preflight import Finding, Rule, _meta
from kdp_print import kdp_page_count, kdp_page_range
from rules._channel import (check_print_pdf_geometry, make_ruleset,
                            metadata_rules, print_pdf_page_count)

VERSION = "kdp-1.6.0"
EFFECTIVE_DATE = "2026-09-18"
SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G202145060"
ISBN_SOURCE_REF = "https://kdp.amazon.com/en_US/help/topic/G201834170"

KDP_MAX_MANUSCRIPT_BYTES = 650 * 1024 * 1024
GEOMETRY_SOURCE = "https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6"
EBOOK_COVER_SOURCE = "https://kdp.amazon.com/en_US/help/topic/G200645690"
LANGUAGE_SOURCE = "https://kdp.amazon.com/en_US/help/topic/G200673300"
KDP_MARKETING_COVER_BYTES = 50_000_000
MAX_COVER_PIXELS = 40_000_000


@contextmanager
def open_kdp_ebook_cover(blob: bytes):
    """Decode the saved, composed PNG proof without changing its artwork."""
    try:
        with Image.open(BytesIO(blob), formats=["PNG"]) as cover:
            width, height = cover.size
            if not 625 <= width <= 10_000 or not 1000 <= height <= 10_000:
                raise ValueError("KDP needs an ebook cover between 625 × 1000 and 10,000 × 10,000 pixels. Render the cover again.")
            if width * height > MAX_COVER_PIXELS:
                raise ValueError("The saved cover exceeds Bookworm's image decoding limit. Render the cover again.")
            if cover.mode != "RGB" or "transparency" in cover.info or cover.n_frames != 1:
                raise ValueError("The saved cover needs to be a single opaque RGB image. Render the cover again.")
            cover.load()
            yield cover
    except (OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise ValueError("The saved cover PNG cannot be decoded. Render the cover again.") from error


def check_kdp_ebook_cover_missing(ctx):
    if (ctx.get("edition") or {}).get("kind") == "ebook" and ctx.get("cover_bytes") is None:
        return [Finding(code="KDP-EBOOK-COVER-MISSING",
                        message="Add a saved cover to include a JPEG in the ZIP, or create a cover in KDP Cover Creator before publishing.",
                        location="edition.cover")]
    return []


def check_kdp_ebook_cover(ctx):
    cover = ctx.get("cover_bytes")
    if (ctx.get("edition") or {}).get("kind") != "ebook" or cover is None:
        return []
    try:
        with open_kdp_ebook_cover(cover):
            pass
    except ValueError as error:
        return [Finding(code="KDP-EBOOK-COVER-INVALID", message=str(error),
                        location="edition.cover")]
    return []


def check_kdp_bleed(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print":
        bleed = edition.get("bleed_in", 0)
        if bleed and (bleed != 0.125 or edition.get("bleed_edges", "all") != "outer"):
            return [Finding(code="KDP-PRINT-BLEED", message="KDP interior bleed must be 0.125in on top, bottom and outer edge only; select outer-edge bleed and render again", location="edition.bleed_edges")]
    return []


def check_kdp_print_language(ctx):
    if (ctx.get("edition") or {}).get("kind") != "print":
        return []
    language = str(_meta(ctx).get("language") or "").lower().replace("_", "-").split("-")[0]
    if language in {"ar", "fa"}:
        return [Finding(code="KDP-PRINT-LANGUAGE", location="book.metadata.language",
                        message="KDP accepts Arabic and Persian in ebooks. Create a reflowable EPUB for KDP or download the print proof for another printer.")]
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
    if edition.get("kind") == "print" and not _meta(ctx).get("isbn13"):
        return [Finding(code="KDP-PRINT-ISBN",
                        message="Choose a free KDP ISBN or add your own ISBN during print title setup",
                        location="book.metadata.isbn13")]
    return []


def check_kdp_page_count(ctx):
    count = print_pdf_page_count(ctx)
    if count is None:
        return []
    edition = ctx.get("edition") or {}
    profile = (edition.get("wrap_cover") or {}).get("profile", "kdp-white")
    minimum, maximum = kdp_page_range(profile, edition.get("trim_size", "6x9"))
    effective = kdp_page_count(count)
    if not minimum <= effective <= maximum:
        label = profile.removeprefix("kdp-").replace("-", " ")
        return [Finding(
            code="KDP-PRINT-PAGE-COUNT",
            message=(f"KDP {label} at {edition.get('trim_size', '6x9')} requires "
                     f"{minimum}-{maximum} pages; the rendered interior has {count} "
                     f"({effective} after KDP's even-page rounding)"),
            location="interior.pages",
        )]
    return []


def check_kdp_profile_known(ctx):
    edition = ctx.get("edition") or {}
    profile = (edition.get("wrap_cover") or {}).get("profile", "kdp-white")
    if edition.get("kind") == "print" and profile == "custom":
        return [Finding(
            code="KDP-PRINT-PROFILE-UNKNOWN",
            message="Select the matching KDP ink/paper profile to validate its exact page range and generated spine",
            location="edition.wrap_cover.profile",
        )]
    return []


def check_kdp_margins(ctx):
    count = print_pdf_page_count(ctx)
    if count is None:
        return []
    edition = ctx.get("edition") or {}
    margins = edition.get("margins") or {}
    effective = kdp_page_count(count)
    inside = next((required for upper, required in (
        (150, 0.375), (300, 0.5), (500, 0.625), (700, 0.75), (828, 0.875)
    ) if effective <= upper), 0.875)
    outside = 0.375 if edition.get("bleed_in", 0) else 0.25
    failures = []
    if margins.get("inner", 0.75) < inside:
        failures.append(f"inner {margins.get('inner', 0.75):g}in (minimum {inside:g}in)")
    for edge in ("top", "bottom", "outer"):
        actual = margins.get(edge, 0.75 if edge != "outer" else 0.5)
        if actual < outside:
            failures.append(f"{edge} {actual:g}in (minimum {outside:g}in)")
    if failures:
        return [Finding(
            code="KDP-PRINT-MARGINS",
            message=f"KDP margins are too small for the rendered {count}-page interior: " + ", ".join(failures),
            location="edition.margins",
        )]
    return []


def check_kdp_rounded_count(ctx):
    count = print_pdf_page_count(ctx)
    wrap = ((ctx.get("edition") or {}).get("wrap_cover") or {})
    if count is not None and count % 2 and wrap.get("enabled") and wrap.get("profile", "kdp-white") != "custom":
        return [Finding(
            code="KDP-PRINT-ROUNDED-COUNT",
            message=(f"KDP counts this {count}-page interior as {count + 1} pages. "
                     f"The generated cover uses {count + 1} pages for its spine; use that count in KDP's template calculator."),
            location="interior.pages",
        )]
    return []


RULESET = make_ruleset("kdp", VERSION, metadata_rules(
    "kdp", "KDP", ["title", "author", "language", "description"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("KDP-EBOOK-001", "warning", "channel", "KDP ebook marketing cover choice", check_kdp_ebook_cover_missing,
         channels=("kdp",), effective_date="2026-11-19", source_ref=EBOOK_COVER_SOURCE),
    Rule("KDP-EBOOK-002", "error", "channel", "KDP ebook marketing cover input", check_kdp_ebook_cover,
         channels=("kdp",), effective_date="2026-11-19", source_ref=EBOOK_COVER_SOURCE),
    Rule("KDP-PKG-001", "error", "channel", "KDP package size", check_kdp_package,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=SOURCE_REF),
    Rule("KDP-PRINT-001", "warning", "channel", "KDP print ISBN choice", check_kdp_isbn,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=ISBN_SOURCE_REF),
    Rule("KDP-PRINT-002", "error", "channel", "KDP interior bleed edges", check_kdp_bleed,
         channels=("kdp",), effective_date="2026-09-18", source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-003", "error", "channel", "KDP actual interior geometry", check_print_pdf_geometry,
         channels=("kdp",), effective_date="2026-09-18", source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-004", "error", "channel", "KDP actual paperback page range", check_kdp_page_count,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-005", "error", "channel", "KDP page-count-dependent margins", check_kdp_margins,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-006", "info", "channel", "KDP manufacturing page count", check_kdp_rounded_count,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-007", "warning", "channel", "KDP stock profile selection", check_kdp_profile_known,
         channels=("kdp",), effective_date=EFFECTIVE_DATE, source_ref=GEOMETRY_SOURCE),
    Rule("KDP-PRINT-008", "error", "channel", "KDP Arabic and Persian format", check_kdp_print_language,
         channels=("kdp",), effective_date="2026-11-20", source_ref=LANGUAGE_SOURCE),
])
