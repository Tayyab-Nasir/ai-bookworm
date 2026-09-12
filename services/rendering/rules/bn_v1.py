"""Barnes & Noble Press rules verified against first-party help on 2026-09-03."""
from preflight import Finding, Rule
from rules._channel import make_ruleset, metadata_rules

VERSION = "barnesnoble-1.1.0"
EFFECTIVE_DATE = "2026-09-03"
SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/46990297345691-B-N-Press-ePub-Formatting-Guide-for-eBooks"
ISBN_SOURCE_REF = "https://help-press.barnesandnoble.com/hc/en-us/articles/5358254743963-ISBN-FAQs"


def check_bn_isbn(ctx):
    edition = ctx.get("edition") or {}
    if edition.get("kind") == "print" and not ctx["book"].get("metadata", {}).get("isbn13"):
        return [Finding(code="BN-PRINT-ISBN",
                        message="Choose a free B&N Press ISBN or add a matching ISBN for this print edition",
                        location="book.metadata.isbn13")]
    return []


RULESET = make_ruleset("barnesnoble", VERSION, metadata_rules(
    "barnesnoble", "BN", ["title", "author", "language"],
    EFFECTIVE_DATE, SOURCE_REF) + [
    Rule("BN-PRINT-001", "warning", "channel", "B&N print ISBN choice", check_bn_isbn,
         channels=("barnesnoble",), effective_date=EFFECTIVE_DATE, source_ref=ISBN_SOURCE_REF),
])
