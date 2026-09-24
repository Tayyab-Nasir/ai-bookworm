"""Google Play Books single-title EPUB checks, reviewed 2026-09-24.

The Partner Center Content tab accepts a single-book EPUB without an ISBN in
the filename, but the EPUB must contain its front cover. The exact EPUB must
pass EPUBCheck before packaging; submission remains a separate human step.
"""
from io import BytesIO
from pathlib import PurePosixPath
from xml.etree import ElementTree
from zipfile import BadZipFile

from PIL import Image, UnidentifiedImageError
from epubcheck_runner import EpubCheckResult, run_epubcheck
from preflight import Finding, Rule, _open_epub
from rules._channel import make_ruleset, metadata_rules

VERSION = "google-play-1.1.0"
EFFECTIVE_DATE = "2026-09-24"
SOURCE_REF = "https://support.google.com/books/partner/answer/3424254?hl=en"


def check_google_epub_cover(ctx):
    if (ctx.get("edition") or {}).get("kind") != "ebook":
        return [Finding(code="GOOGLE-EPUB-ONLY", message="Google Play Books export currently supports EPUB editions only", location="edition.kind")]
    archive = _open_epub(ctx)
    if archive is None:
        return []  # Core EPUB rules report missing or unreadable artifacts.
    try:
        if archive.getinfo("OEBPS/content.opf").file_size > 1_000_000:
            raise ValueError("EPUB package document is too large")
        opf = ElementTree.fromstring(archive.read("OEBPS/content.opf"))
        manifest = opf.find("{http://www.idpf.org/2007/opf}manifest")
        cover_items = [] if manifest is None else [item for item in manifest
            if "cover-image" in item.attrib.get("properties", "").split()]
        if len(cover_items) != 1:
            raise ValueError("missing or ambiguous EPUB cover-image item")
        href = cover_items[0].attrib.get("href", "")
        path = PurePosixPath("OEBPS") / href
        if not href or ".." in path.parts or str(path) not in archive.namelist():
            raise ValueError("EPUB cover image is not packaged")
        if archive.getinfo(str(path)).file_size > 25 * 1024 * 1024:
            raise ValueError("EPUB cover is too large to inspect")
        with Image.open(BytesIO(archive.read(str(path)))) as image:
            if image.format not in ("PNG", "JPEG"):
                raise ValueError("EPUB cover must be PNG or JPEG")
            if min(image.size) < 640 or max(image.size) > 7200:
                raise ValueError("EPUB cover must be at least 640 pixels and at most 7200 pixels per side")
            image.load()
    except (KeyError, ValueError, BadZipFile, ElementTree.ParseError, OSError, UnidentifiedImageError):
        return [Finding(code="GOOGLE-EPUB-COVER", message="Google Play Books requires a readable embedded front cover in the complete EPUB (640–7200 pixels per side)", location="edition.cover")]
    return []


def _check_result(ctx) -> EpubCheckResult | None:
    if (ctx.get("edition") or {}).get("kind") != "ebook" or not ctx.get("artifact"):
        return None
    if "_google_epubcheck_result" not in ctx:
        ctx["_google_epubcheck_result"] = run_epubcheck(ctx["artifact"])
    return ctx["_google_epubcheck_result"]


def check_google_epubcheck_errors(ctx):
    result = _check_result(ctx)
    if result is None or result.status == "valid":
        return []
    if result.status == "unavailable":
        return [Finding(code="GOOGLE-EPUBCHECK-UNAVAILABLE", message="EPUBCheck 5.4.0 is unavailable; Google Play packaging is blocked until the exact EPUB can be validated", location="artifact")]
    return [Finding(code="GOOGLE-EPUBCHECK-ERROR", message=f"EPUBCheck 5.4.0 found {result.errors} error(s) in the exact EPUB; repair and render again", location="artifact")]


def check_google_epubcheck_warnings(ctx):
    result = _check_result(ctx)
    if result is None or result.warnings == 0:
        return []
    return [Finding(code="GOOGLE-EPUBCHECK-WARNING", message=f"EPUBCheck 5.4.0 reported {result.warnings} warning(s); review them before Partner Center upload", location="artifact")]


RULESET = make_ruleset("googleplay", VERSION, metadata_rules(
    "googleplay", "GOOGLE", ["title", "author", "language"], EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("GOOGLE-EPUB-001", "error", "channel", "Google Play Books EPUB front cover",
         check_google_epub_cover, channels=("googleplay",), effective_date=EFFECTIVE_DATE,
         source_ref=SOURCE_REF),
    Rule("GOOGLE-EPUB-002", "error", "epub_structure", "W3C EPUBCheck conformance",
         check_google_epubcheck_errors, channels=("googleplay",), effective_date=EFFECTIVE_DATE,
         source_ref="https://github.com/w3c/epubcheck"),
    Rule("GOOGLE-EPUB-003", "warning", "epub_structure", "W3C EPUBCheck warnings",
         check_google_epubcheck_warnings, channels=("googleplay",), effective_date=EFFECTIVE_DATE,
         source_ref="https://github.com/w3c/epubcheck"),
])
