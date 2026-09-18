"""Barnes & Noble Press rules verified against first-party help on 2026-09-18."""
from preflight import Finding, Rule
from rules._channel import (check_print_pdf_geometry, make_ruleset,
                            metadata_rules, print_pdf_page_count)

VERSION = "barnesnoble-1.2.0"
EFFECTIVE_DATE = "2026-09-18"
SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/46990297345691-B-N-Press-ePub-Formatting-Guide-for-eBooks"
ISBN_SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/5358254743963-ISBN-FAQs"
PRINT_SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/5359031189787-Cover-Interior-Not-Accepted"
INTERIOR_GUIDE_REF = "https://www2.nookassets.com/npassets-spb/pod/resources/interior-file-preparation-quick-guide-v1.pdf"


def check_bn_isbn(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print" and not ctx["book"].get("metadata", {}).get("isbn13"):
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


RULESET = make_ruleset("barnesnoble", VERSION, metadata_rules(
    "barnesnoble", "BN", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("BN-PRINT-001", "warning", "channel", "B&N print ISBN choice", check_bn_isbn,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=ISBN_SOURCE_REF),
    Rule("BN-PRINT-002", "error", "channel", "B&N actual interior geometry", check_print_pdf_geometry,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=INTERIOR_GUIDE_REF),
    Rule("BN-PRINT-003", "error", "channel", "B&N actual print page range", check_bn_page_count,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=PRINT_SOURCE_REF),
    Rule("BN-PRINT-004", "error", "channel", "B&N interior margins", check_bn_margins,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=INTERIOR_GUIDE_REF),
])
