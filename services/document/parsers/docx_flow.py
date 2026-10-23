"""Resolve explicit Word paragraph flow without treating cached layout as intent."""
import re

from docx.oxml.ns import qn

from . import ParseError


def paragraph_styles(paragraph):
    """Nearest style first, bounded even for a malformed basedOn cycle."""
    style, seen = paragraph.style, set()
    while style is not None and style.style_id not in seen:
        seen.add(style.style_id)
        yield style
        style = style.base_style


def heading_level(paragraph, warnings):
    styles = list(paragraph_styles(paragraph))
    properties = [paragraph._p.pPr, *(style.element.pPr for style in styles)]
    for item in properties:
        outline = item.find(qn("w:outlineLvl")) if item is not None else None
        if outline is None:
            continue
        raw = outline.get(qn("w:val"), "").strip()
        value = int(raw) if len(raw) <= 10 and re.fullmatch(r"[+-]?[0-9]+", raw) else -1
        if not 0 <= value <= 9:
            raise ParseError("DOCX outline level must be an integer from 0 to 9; review paragraph styles in the original")
        if value == 9:
            return None  # Explicit body text overrides even a Heading style.
        if value > 5:
            warning = "DOCX heading levels beyond six were reduced to level six; review the outline against the original."
            if warning not in warnings:
                warnings.append(warning)
        return min(value + 1, 6)
    # A stripped-down DOCX may name a built-in heading without its definition.
    for style in styles:
        name = (style.name or "").casefold()
        if name in {f"heading {level}" for level in range(1, 7)}:
            return int(name[-1])
    return None


def page_break_before(paragraph):
    for item in (paragraph, *paragraph_styles(paragraph)):
        value = item.paragraph_format.page_break_before
        if value is not None:
            return value  # False is an override, not permission to inherit.
    return False


def run_content(run, warnings):
    """Yield text, authored page breaks and drawings in their original order.

    python-docx's string projection drops page/column breaks. Read only the
    same allowlisted direct children, with explicit handling for those breaks.
    Never follow links, field instructions, relationships or cached pagination.
    """
    buffer = []
    text_tags = {qn("w:" + tag) for tag in ("t", "tab", "ptab", "cr", "noBreakHyphen")}
    for item in run._r:
        if item.tag in text_tags:
            buffer.append(str(item))
        elif item.tag == qn("w:br"):
            kind = item.get(qn("w:type"), "textWrapping")
            if kind != "page":
                buffer.append("\n")
                if kind == "column":
                    warning = "DOCX column breaks were preserved as line breaks; multi-column page layout requires review against the original."
                    if warning not in warnings:
                        warnings.append(warning)
                elif kind != "textWrapping":
                    raise ParseError("DOCX contains an unsupported break type; review page layout in the original")
                continue
            if buffer:
                yield "".join(buffer)
                buffer.clear()
            yield {"type": "pageBreak"}
        elif item.tag == qn("w:drawing"):
            if buffer:
                yield "".join(buffer)
                buffer.clear()
            yield {"type": "drawing", "element": item}
    if buffer:
        yield "".join(buffer)
