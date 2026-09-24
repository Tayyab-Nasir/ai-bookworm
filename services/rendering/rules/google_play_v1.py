"""Google Play Books single-title EPUB checks, reviewed 2026-09-24.

The Partner Center Content tab accepts a single-book EPUB without an ISBN in
the filename, but the EPUB must contain its front cover. Submission and
EpubCheck remain separate human-controlled release steps.
"""
from io import BytesIO
from pathlib import PurePosixPath
from xml.etree import ElementTree
from zipfile import BadZipFile

from PIL import Image, UnidentifiedImageError
from preflight import Finding, Rule, _open_epub
from rules._channel import make_ruleset, metadata_rules

VERSION = "google-play-1.0.0"
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


RULESET = make_ruleset("googleplay", VERSION, metadata_rules(
    "googleplay", "GOOGLE", ["title", "author", "language"], EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("GOOGLE-EPUB-001", "error", "channel", "Google Play Books EPUB front cover",
         check_google_epub_cover, channels=("googleplay",), effective_date=EFFECTIVE_DATE,
         source_ref=SOURCE_REF),
])
