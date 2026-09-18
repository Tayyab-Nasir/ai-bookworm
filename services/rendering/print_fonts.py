"""Fixed font inventory and glyph checks for deterministic print output.

Bitstream Vera ships with ReportLab, including its redistribution license.
DejaVu Sans Mono is vendored with its license for embedded-edition inline code.
No machine fonts or author-supplied font paths are loaded.
"""
from pathlib import Path

import reportlab
from reportlab.lib.fonts import ps2tt, tt2ps
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from manuscript import inline_runs, table_rows

BASE_FONTS = {"Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"}
EMBEDDED_FONTS = {"BookwormVera", "BookwormVera-Bold"}
_FONT_DIR = Path(reportlab.__file__).resolve().parent / "fonts"
for _name, _file in (
    ("BookwormVera", "Vera.ttf"), ("BookwormVera-Bold", "VeraBd.ttf"),
    ("BookwormVera-Italic", "VeraIt.ttf"), ("BookwormVera-BoldItalic", "VeraBI.ttf"),
):
    pdfmetrics.registerFont(TTFont(_name, str(_FONT_DIR / _file)))
pdfmetrics.registerFontFamily("BookwormVera", normal="BookwormVera", bold="BookwormVera-Bold",
                              italic="BookwormVera-Italic", boldItalic="BookwormVera-BoldItalic")
for _name, _file in (
    ("BookwormDejaVuSansMono", "DejaVuSansMono.ttf"),
    ("BookwormDejaVuSansMono-Bold", "DejaVuSansMono-Bold.ttf"),
    ("BookwormDejaVuSansMono-Italic", "DejaVuSansMono-Oblique.ttf"),
    ("BookwormDejaVuSansMono-BoldItalic", "DejaVuSansMono-BoldOblique.ttf"),
):
    pdfmetrics.registerFont(TTFont(_name, str(Path(__file__).resolve().parent / "fonts" / _file)))
pdfmetrics.registerFontFamily("BookwormDejaVuSansMono", normal="BookwormDejaVuSansMono",
    bold="BookwormDejaVuSansMono-Bold", italic="BookwormDejaVuSansMono-Italic",
    boldItalic="BookwormDejaVuSansMono-BoldItalic")


def code_font(base: str) -> str:
    """Vera editions use actual embedded monospace; legacy choices stay Courier."""
    return "BookwormDejaVuSansMono" if base in EMBEDDED_FONTS else "Courier"


def page_number_font(body: str, heading: str) -> str:
    return "BookwormVera" if {body, heading} <= EMBEDDED_FONTS else "Helvetica"


def _run_font(base: str, marks: list[str]) -> str:
    if "code" in marks:
        base = code_font(base)
    family, bold, italic = ps2tt(base)
    return tt2ps(family, bold or "bold" in marks, italic or "italic" in marks)


def _missing(text: str, font_name: str) -> list[str]:
    font = pdfmetrics.getFont(font_name)
    missing = []
    for char in sorted(set(text) - {"\r", "\n", "\t"}):
        if hasattr(font.face, "charToGlyph"):
            supported = bool(font.face.charToGlyph.get(ord(char)))
        else:
            try:
                encoded = char.encode(font.encName)
                supported = len(encoded) == 1 and font.encoding.vector[encoded[0]] in font.face.glyphWidths
            except UnicodeEncodeError:
                supported = False
        if not supported:
            missing.append(f"U+{ord(char):04X}")
    return missing


def print_font_issues(book: dict, edition: dict) -> list[dict[str, str]]:
    """Check only text the print renderer emits, using its effective marked font."""
    if edition.get("kind") != "print":
        return []
    typography = edition.get("typography") or {}
    body = typography.get("body_font", "Times-Roman")
    heading = typography.get("heading_font", "Helvetica-Bold")
    if body not in BASE_FONTS | EMBEDDED_FONTS or heading not in BASE_FONTS | EMBEDDED_FONTS:
        return []  # Invalid font names are handled by config validation/preflight.
    issues = []

    def check(text, font, location):
        missing = _missing(text or "", font)
        if missing:
            codes = ", ".join(missing[:8]) + (" …" if len(missing) > 8 else "")
            issues.append({"location": location, "message":
                f"{font} cannot print {codes}. Choose a font covering these characters or use EPUB."})

    check((book.get("metadata") or {}).get("title"), heading, "book.metadata.title")
    for chapter in book.get("chapters", []):
        location = f"chapter:{chapter['id']}"
        check(chapter.get("title"), heading, location)
        for node in chapter.get("nodes", []):
            node_location = f"{location} node:{node['id']}"
            kind = node.get("type")
            if kind == "image":
                check(node.get("caption"), body, node_location)
            elif kind == "table" and table_rows(node):
                for row in table_rows(node):
                    for cell in row:
                        check(cell, body, node_location)
            elif kind in {"heading", "paragraph", "quote", "footnote", "caption", "listItem", "table"}:
                for run in inline_runs(node):
                    check(run["text"], _run_font(heading if kind == "heading" else body, run["marks"]), node_location)
    # Multiple marked runs/cells can share the same missing glyph and location.
    return [dict(item) for item in dict.fromkeys(tuple(issue.items()) for issue in issues)]
