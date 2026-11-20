"""Barnes & Noble Press ebook and print checks."""
from epubcheck_runner import EpubCheckResult, run_epubcheck
from preflight import Finding, Rule, _meta, _open_epub
from rules._channel import (check_print_pdf_geometry, make_ruleset,
                            metadata_rules, print_pdf_page_count)

VERSION = "barnesnoble-1.3.0"
EFFECTIVE_DATE = "2026-09-18"
EPUB_CHECK_DATE = "2026-11-20"
EPUB_LIMIT_BYTES = 20_000_000
SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/46990297345691-B-N-Press-ePub-Formatting-Guide-for-eBooks"
SIZE_SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/31534821208859-Maximum-File-Size"
ISBN_SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/5358254743963-ISBN-FAQs"
PRINT_SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/5359031189787-Cover-Interior-Not-Accepted"
INTERIOR_GUIDE_REF = "https://www2.nookassets.com/npassets-spb/pod/resources/interior-file-preparation-quick-guide-v1.pdf"


def check_bn_isbn(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print" and not _meta(ctx).get("isbn13"):
        return [Finding(code="BN-PRINT-ISBN",
                        message="Choose a free B&N Press ISBN or add a matching ISBN for this print edition",
                        location="book.metadata.isbn13")]
    return []


def check_bn_page_count(ctx):
    count = print_pdf_page_count(ctx)
    if count is not None and not 18 <= count <= 800:
        return [Finding(code="BN-PRINT-PAGE-COUNT",
                        message=f"B&N Press requires 18-800 interior pages; the rendered PDF has {count}",
                        location="interior.pages")]
    return []


def check_bn_margins(ctx):
    if print_pdf_page_count(ctx) is None:
        return []
    margins = ((ctx.get("edition") or {}).get("margins") or {})
    required = {"top": 0.5, "bottom": 0.5, "outer": 0.5, "inner": 0.75}
    failures = [f"{edge} {margins.get(edge, default):g}in (minimum {minimum:g}in)"
                for edge, minimum in required.items()
                for default in [0.75 if edge != "outer" else 0.5]
                if margins.get(edge, default) < minimum]
    if failures:
        return [Finding(code="BN-PRINT-MARGINS",
                        message="B&N Press interior margins are too small: " + ", ".join(failures),
                        location="edition.margins")]
    return []


def _ebook(ctx):
    return (ctx.get("edition") or {}).get("kind") == "ebook"


def check_bn_epub_size(ctx):
    if _ebook(ctx) and len(ctx.get("artifact") or b"") >= EPUB_LIMIT_BYTES:
        return [Finding(code="BN-EPUB-SIZE",
                        message="B&N Press requires the EPUB to be smaller than 20 MB. Reduce image sizes and render again.",
                        location="artifact")]
    return []


def _epubcheck_result(ctx) -> EpubCheckResult | None:
    artifact = ctx.get("artifact")
    if not _ebook(ctx) or not artifact or len(artifact) >= EPUB_LIMIT_BYTES:
        return None
    archive = _open_epub(ctx)
    if archive is None:
        return None  # Core preflight reports an unreadable archive.
    archive.close()
    if "_bn_epubcheck_result" not in ctx:
        ctx["_bn_epubcheck_result"] = run_epubcheck(artifact)
    return ctx["_bn_epubcheck_result"]


def check_bn_epub_errors(ctx):
    result = _epubcheck_result(ctx)
    if result is None or result.status == "valid":
        return []
    if result.status == "unavailable":
        return [Finding(code="BN-EPUBCHECK-UNAVAILABLE",
                        message="EPUBCheck is unavailable. Retry preflight when the validator is ready.",
                        location="artifact")]
    return [Finding(code="BN-EPUBCHECK-ERROR",
                    message=f"EPUBCheck found {result.errors} error(s) in this EPUB. Repair the issues and render again.",
                    location="artifact")]


def check_bn_epub_warnings(ctx):
    if _ebook(ctx) and not ctx.get("artifact"):
        return [Finding(code="BN-EPUBCHECK-NO-ARTIFACT",
                        message="Choose a saved EPUB to check the actual file before packaging.",
                        location="artifact")]
    result = _epubcheck_result(ctx)
    if result is None or not result.warnings:
        return []
    return [Finding(code="BN-EPUBCHECK-WARNING",
                    message=f"EPUBCheck reported {result.warnings} warning(s). Review the saved EPUB before B&N Press upload.",
                    location="artifact")]


RULESET = make_ruleset("barnesnoble", VERSION, metadata_rules(
    "barnesnoble", "BN", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("BN-EPUB-001", "error", "package_integrity", "B&N ebook byte limit", check_bn_epub_size,
         channels=("barnesnoble",), effective_date=EPUB_CHECK_DATE, source_ref=SIZE_SOURCE_REF),
    Rule("BN-EPUB-002", "error", "epub_structure", "W3C EPUBCheck conformance", check_bn_epub_errors,
         channels=("barnesnoble",), effective_date=EPUB_CHECK_DATE, source_ref=SOURCE_REF),
    Rule("BN-EPUB-003", "warning", "epub_structure", "W3C EPUBCheck warnings", check_bn_epub_warnings,
         channels=("barnesnoble",), effective_date=EPUB_CHECK_DATE, source_ref=SOURCE_REF),
    Rule("BN-PRINT-001", "warning", "channel", "B&N print ISBN choice", check_bn_isbn,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=ISBN_SOURCE_REF),
    Rule("BN-PRINT-002", "error", "channel", "B&N actual interior geometry", check_print_pdf_geometry,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=INTERIOR_GUIDE_REF),
    Rule("BN-PRINT-003", "error", "channel", "B&N actual print page range", check_bn_page_count,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=PRINT_SOURCE_REF),
    Rule("BN-PRINT-004", "error", "channel", "B&N interior margins", check_bn_margins,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=INTERIOR_GUIDE_REF),
])
