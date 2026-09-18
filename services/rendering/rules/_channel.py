"""Shared helpers for channel rule modules."""
from io import BytesIO

from pypdf import PdfReader

from preflight import Finding, Rule, RuleSet, _meta


def print_pdf_page_count(ctx) -> int | None:
    """Return the actual rendered page count, or ``None`` when it is unavailable.

    Channel page limits must be evaluated against the artifact a retailer will
    receive. Invalid PDFs are reported by ``check_print_pdf_geometry`` so count
    rules intentionally stay quiet instead of emitting misleading follow-ons.
    """
    config = ctx.get("edition") or {}
    blob = ctx.get("package_bytes")
    if config.get("kind") != "print" or not blob:
        return None
    try:
        reader = PdfReader(BytesIO(blob))
        if reader.is_encrypted or not 1 <= len(reader.pages) <= 2000:
            return None
        return len(reader.pages)
    except Exception:
        return None


def check_print_pdf_geometry(ctx):
    """Check the uploaded artifact, not just its saved settings."""
    config = ctx.get("edition") or {}
    blob = ctx.get("package_bytes")
    if config.get("kind") != "print" or not blob:
        return []
    from editions import PrintEdition
    try:
        edition = PrintEdition.model_validate(config)
        width, height = edition.trim_in
        width += edition.bleed_in * (2 if edition.bleed_edges == "all" else 1)
        height += 2 * edition.bleed_in
        reader = PdfReader(BytesIO(blob))
        if reader.is_encrypted or not 1 <= len(reader.pages) <= 2000:
            raise ValueError("unreadable page count")
        for index, page in enumerate(reader.pages):
            if (page.rotation or abs(float(page.mediabox.width) - width * 72) > 0.01
                    or abs(float(page.mediabox.height) - height * 72) > 0.01
                    or any(abs(float(a) - float(b)) > 0.01 for a, b in zip(page.cropbox, page.mediabox))):
                return [Finding(code="PRINT-PAGE-GEOMETRY", message="Interior page dimensions, crop box or rotation do not match saved trim and bleed settings; render again", location=f"interior.pages[{index}]")]
    except Exception:
        return [Finding(code="PRINT-PAGE-GEOMETRY", message="Interior must be a readable, unencrypted PDF with valid print settings", location="interior")]
    return []


def metadata_rules(channel: str, prefix: str, required: list[str], effective_date: str,
                   source_ref: str) -> list[Rule]:
    def check(ctx, _required=required):
        md = _meta(ctx)
        def missing(value):
            return value is None or (isinstance(value, str) and not value.strip()) or (isinstance(value, list) and not value)
        return [
            Finding(code=f"{prefix}-META-MISSING",
                    message=f"{channel} requires metadata.{key}",
                    location=f"book.metadata.{key}")
            for key in _required
            if missing(md.get(key))
        ]

    return [Rule(f"{prefix}-META-001", "error", "channel",
                 f"{channel} required metadata", check,
                 channels=(channel,), effective_date=effective_date, source_ref=source_ref)]


def make_ruleset(channel: str, version: str, rules: list) -> RuleSet:
    return RuleSet(name=channel, version=version, rules=rules)
