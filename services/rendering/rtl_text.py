"""Fail closed for directional text in renderers without bidi/shaping.

This is not an implementation of Unicode bidi or script shaping. Reflowable
EPUB manuscript content remains delegated to the reader's text layout engine.
"""
from unicodedata import bidirectional

from editions import resolve_text_direction

_DIRECTION_CONTROLS = frozenset("\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def has_direction_controls(text: object) -> bool:
    return isinstance(text, str) and any(char in _DIRECTION_CONTROLS for char in text)


def requires_bidi_layout(text: object) -> bool:
    return isinstance(text, str) and any(bidirectional(char) in ("R", "AL") or char in _DIRECTION_CONTROLS for char in text)


def cover_rtl_issues(metadata: dict, edition: dict) -> list[dict[str, str]]:
    """Only inspect text that the current cover renderer will actually paint."""
    wrap = edition.get("wrap_cover") or {}
    if edition.get("kind") == "print" and wrap.get("source_pdf_version") is not None:
        return []
    cover = edition.get("cover") or {}
    issues = []
    if edition.get("kind") == "print" and wrap.get("enabled") and resolve_text_direction(
        metadata.get("language"), edition.get("text_direction"),
    ) == "rtl":
        issues.append({"code": "RTL_WRAP_BINDING_UNSUPPORTED", "location": "edition.wrap_cover",
                       "message": "Upload a right-bound full cover PDF or turn off the full cover to render an interior proof."})
    if cover.get("asset_id"):
        for enabled, key in (("title_on_cover", "title"), ("subtitle_on_cover", "subtitle"),
                             ("author_on_cover", "author")):
            if cover.get(enabled, True) and requires_bidi_layout(metadata.get(key)):
                issues.append({"location": f"edition.cover.{key}", "message": "Cover text requires bidirectional shaping, which is not available."})
        qr = cover.get("qr_code") or {}
        if qr.get("enabled") and qr.get("url") and requires_bidi_layout(qr.get("label")):
            issues.append({"location": "edition.cover.qr_code.label", "message": "QR label requires bidirectional shaping, which is not available."})
    if edition.get("kind") == "print" and wrap.get("enabled"):
        for key in ("back_text", "spine_text"):
            if requires_bidi_layout(wrap.get(key)):
                issues.append({"location": f"edition.wrap_cover.{key}", "message": "Wrap cover text requires bidirectional shaping, which is not available."})
    return issues
